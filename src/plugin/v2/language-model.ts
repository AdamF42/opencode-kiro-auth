/**
 * AI-SDK v3 `LanguageModelV3` adapter for Kiro on OpenCode v2.
 *
 * This is the v2 interception point. Instead of the v1 custom `fetch` installed
 * on the auth `loader`, OpenCode v2 asks the plugin to supply a `LanguageModelV3`
 * via `ctx.aisdk.hook('language', …)`. We hand it this adapter, whose
 * `doGenerate` / `doStream` reuse the existing, battle-tested
 * `RequestHandler.handle()` pipeline (OpenAI-chat Request in → OpenAI SSE
 * Response out, with all stream-recovery / usage-sync / attempt-epoch behavior
 * intact) and convert at the edges with the pure functions in `openai-v3-bridge`.
 *
 * The synthesized request mirrors exactly what the v1 fetch produced:
 *  - URL `https://runtime.{region}.kiro.dev/.../models/{modelId}/...` so
 *    `handle()` matches `KIRO_API_PATTERN` and extracts the model id;
 *  - an OpenAI-chat JSON body from `v3PromptToOpenAIChatBody`;
 *  - the five private request-kind / diagnostic headers (so `handle()` is
 *    unchanged), with the compaction request-kind derived from the v2 call
 *    `kind` rather than the v1 `agent === 'compaction'` check;
 *  - the caller `abortSignal` threaded into `init.signal`.
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'
import {
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_MESSAGE_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_REQUEST_KIND_HEADER,
  hashDiagnosticIdentity
} from '../../core/request/request-kind.js'
import {
  createOpenAIToV3StreamState,
  finalizeOpenAIToV3Stream,
  openAIChunkToV3Parts,
  v3PromptToOpenAIChatBody,
  type OpenAIChatChunk
} from './openai-v3-bridge.js'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

/** Minimal structural view of the Kiro request pipeline the adapter depends on. */
export interface KiroRequestPipeline {
  handle(input: unknown, init: unknown, showToast: ToastFunction): Promise<Response>
}

/** Per-call signals passed in-process (not over the private header channel). */
export interface KiroLanguageModelCallContext {
  /** v2 session request kind; `'compaction'` maps to the compaction request-kind. */
  readonly kind?: string
  /** Opaque session id for diagnostic correlation (hashed, never transmitted raw). */
  readonly sessionID?: string
  /** Agent name for diagnostic correlation. */
  readonly agent?: string
  /** Message id for diagnostic correlation. */
  readonly messageID?: string
}

export interface KiroLanguageModelDeps {
  /** Provider id OpenCode registered this model under (`kiro-auth`). */
  readonly providerID: string
  /** Wire model id (e.g. `claude-sonnet-5`). */
  readonly modelID: string
  /** Base URL `https://runtime.{region}.kiro.dev` (no trailing path). */
  readonly baseURL: string
  /** Shared Kiro pipeline (the `RequestHandler`). */
  readonly pipeline: KiroRequestPipeline
  /** Toast surface; a logger on v2. */
  readonly showToast: ToastFunction
  /**
   * Optional per-call context resolver. When the host exposes session kind /
   * identity to the aisdk hook, pass it here so the adapter can set the
   * request-kind + diagnostic headers that `handle()` consumes. Defaults to
   * empty context (request-kind `normal`, no diagnostics).
   */
  readonly resolveCallContext?: (
    options: LanguageModelV3CallOptions
  ) => KiroLanguageModelCallContext
}

const DONE_SENTINEL = '[DONE]'

/** Build the synthesized Kiro API URL `handle()` recognizes and extracts the model from. */
function buildKiroUrl(baseURL: string, modelID: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  const encoded = encodeURIComponent(modelID)
  return `${trimmed}/models/${encoded}/generateAssistantResponse`
}

/**
 * Compose the private request-kind + diagnostic headers for a call. These are
 * the exact header names `consumeKiroRequestMetadata` reads and strips, so the
 * pipeline stays unchanged. The compaction request-kind is derived from the v2
 * call kind, not the v1 agent check.
 *
 * Exported so the v2 `setup()` `model.request` hook and the in-process adapter
 * both stamp the identical five-header channel from one implementation (the
 * host and in-process paths must not diverge). Diagnostic identity headers are
 * only emitted when `emitDiagnostics` is true, mirroring v1's
 * `diagnostic_log_level` gate; the compaction request-kind header is always
 * emitted when the kind is compaction, independent of diagnostics.
 */
export function buildPrivateHeaders(
  context: KiroLanguageModelCallContext,
  emitDiagnostics = true
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (context.kind === 'compaction') {
    headers[KIRO_REQUEST_KIND_HEADER] = 'compaction'
  }

  if (!emitDiagnostics) return headers

  const trace = globalThis.crypto?.randomUUID?.()
  if (trace !== undefined) headers[KIRO_DIAGNOSTIC_TRACE_HEADER] = trace

  const sessionHash = hashDiagnosticIdentity(context.sessionID)
  if (sessionHash !== undefined) headers[KIRO_DIAGNOSTIC_SESSION_HEADER] = sessionHash
  const agentHash = hashDiagnosticIdentity(context.agent)
  if (agentHash !== undefined) headers[KIRO_DIAGNOSTIC_AGENT_HEADER] = agentHash
  const messageHash = hashDiagnosticIdentity(context.messageID)
  if (messageHash !== undefined) headers[KIRO_DIAGNOSTIC_MESSAGE_HEADER] = messageHash

  return headers
}

/**
 * Parse an OpenAI SSE byte stream (`data: {json}\n\n`, no `[DONE]` sentinel
 * emitted by this pipeline but tolerated) into a stream of parsed chunks.
 * Robust to chunk boundaries that split SSE events mid-line.
 */
async function* parseSseChunks(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIChatChunk, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE events are separated by a blank line.
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        const chunk = parseSseEvent(rawEvent)
        if (chunk !== undefined) yield chunk
        separatorIndex = buffer.indexOf('\n\n')
      }
    }
    // Flush any trailing event without a terminating blank line.
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail.length > 0) {
      const chunk = parseSseEvent(tail)
      if (chunk !== undefined) yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

/** Parse a single SSE event block into an OpenAI chunk, or `undefined` to skip. */
function parseSseEvent(rawEvent: string): OpenAIChatChunk | undefined {
  // An event may contain multiple `data:` lines; concatenate their payloads.
  let payload = ''
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    payload += trimmed.slice('data:'.length).trimStart()
  }
  if (payload.length === 0) return undefined
  if (payload === DONE_SENTINEL) return undefined
  try {
    return JSON.parse(payload) as OpenAIChatChunk
  } catch {
    // Non-JSON data lines are not part of this pipeline's contract; skip them.
    return undefined
  }
}

/** Private header names the host may already have stamped via `model.request`. */
const PRIVATE_HEADER_NAMES = [
  KIRO_REQUEST_KIND_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_MESSAGE_HEADER
] as const

/**
 * Resolve the private request-kind / diagnostic headers for a call.
 *
 * Two in-process signaling paths are supported, in priority order:
 *  1. An explicit `resolveCallContext` (host wires session kind/identity to the
 *     aisdk hook) → the headers are freshly built via {@link buildPrivateHeaders}.
 *  2. Private headers already present on `options.headers` — e.g. stamped by a
 *     `ctx.session.hook('model.request')` that the host forwards into the call
 *     options. These are passed through verbatim (names + hashed values are
 *     already correct), so `handle()` sees the exact v1 header channel.
 * When neither path yields anything, the call is a normal request with no
 * diagnostics (identical to v1 when `diagnostic_log_level === 'off'`).
 */
function resolvePrivateHeaders(
  options: LanguageModelV3CallOptions,
  resolveCallContext: KiroLanguageModelDeps['resolveCallContext']
): Record<string, string> {
  const context = resolveCallContext?.(options)
  if (context !== undefined) {
    return buildPrivateHeaders(context)
  }
  // Fall back to any private headers the host already placed on the call.
  const headers: Record<string, string> = {}
  const incoming = options.headers
  if (incoming !== undefined) {
    for (const name of PRIVATE_HEADER_NAMES) {
      const value = incoming[name]
      if (typeof value === 'string' && value.length > 0) headers[name] = value
    }
  }
  return headers
}

/**
 * Create a `LanguageModelV3` that routes through the existing Kiro pipeline.
 */
export function createKiroLanguageModel(deps: KiroLanguageModelDeps): LanguageModelV3 {
  const { providerID, modelID, baseURL, pipeline, showToast, resolveCallContext } = deps
  const url = buildKiroUrl(baseURL, modelID)

  const sendRequest = async (options: LanguageModelV3CallOptions): Promise<Response> => {
    const body = v3PromptToOpenAIChatBody({
      prompt: options.prompt,
      tools: options.tools,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      stopSequences: options.stopSequences,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      model: modelID
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...resolvePrivateHeaders(options, resolveCallContext)
    }

    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
    if (options.abortSignal !== undefined) init.signal = options.abortSignal

    return pipeline.handle(url, init, showToast)
  }

  return {
    specificationVersion: 'v3',
    provider: providerID,
    modelId: modelID,
    // The Kiro pipeline fetches binary file content itself; no URL is natively
    // supported by this language model, so advertise none.
    supportedUrls: {},

    async doStream(
      options: LanguageModelV3CallOptions
    ): Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }> {
      const response = await sendRequest(options)
      const sseBody = response.body

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          const state = createOpenAIToV3StreamState()
          try {
            if (sseBody === null) {
              // No body at all — still emit a well-formed terminal sequence.
              for (const part of finalizeOpenAIToV3Stream(state)) controller.enqueue(part)
              controller.close()
              return
            }
            for await (const chunk of parseSseChunks(sseBody)) {
              for (const part of openAIChunkToV3Parts(chunk, state)) {
                controller.enqueue(part)
              }
            }
            for (const part of finalizeOpenAIToV3Stream(state)) controller.enqueue(part)
            controller.close()
          } catch (error) {
            // Surface as a v3 error part, then still emit the terminal finish so
            // the consumer's stream is well-formed.
            controller.enqueue({ type: 'error', error })
            for (const part of finalizeOpenAIToV3Stream(state)) controller.enqueue(part)
            controller.close()
          }
        }
      })

      return { stream }
    },

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      // The pipeline is always streaming; aggregate the SSE stream into the v3
      // content/usage/finishReason via the same incremental converter used by
      // doStream, then flatten the resulting parts into a generate result.
      const response = await sendRequest(options)
      const sseBody = response.body

      const parts: LanguageModelV3StreamPart[] = []
      const state = createOpenAIToV3StreamState()
      if (sseBody !== null) {
        for await (const chunk of parseSseChunks(sseBody)) {
          parts.push(...openAIChunkToV3Parts(chunk, state))
        }
      }
      parts.push(...finalizeOpenAIToV3Stream(state))

      return foldStreamPartsToGenerateResult(parts)
    }
  }
}

/** Fold a complete v3 stream-part sequence into a `doGenerate` result. */
function foldStreamPartsToGenerateResult(
  parts: readonly LanguageModelV3StreamPart[]
): LanguageModelV3GenerateResult {
  const content: LanguageModelV3GenerateResult['content'] = []
  let text = ''
  let reasoning = ''
  let finishReason: LanguageModelV3GenerateResult['finishReason'] = {
    unified: 'stop',
    raw: undefined
  }
  let usage: LanguageModelV3GenerateResult['usage'] = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined }
  }
  const errors: unknown[] = []

  for (const part of parts) {
    switch (part.type) {
      case 'text-delta':
        text += part.delta
        break
      case 'reasoning-delta':
        reasoning += part.delta
        break
      case 'tool-call':
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input
        })
        break
      case 'finish':
        finishReason = part.finishReason
        usage = part.usage
        break
      case 'error':
        errors.push(part.error)
        break
      default:
        break
    }
  }

  // Order: reasoning, then text, then tool calls (already pushed above). To keep
  // the natural order, splice reasoning/text to the front in that order.
  const prefix: LanguageModelV3GenerateResult['content'] = []
  if (reasoning.length > 0) prefix.push({ type: 'reasoning', text: reasoning })
  if (text.length > 0) prefix.push({ type: 'text', text })

  if (errors.length > 0) {
    // A pipeline error during aggregation is terminal; rethrow the first.
    throw errors[0]
  }

  return {
    content: [...prefix, ...content],
    finishReason,
    usage,
    warnings: []
  }
}
