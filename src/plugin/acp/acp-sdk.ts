import type { AcpDriverEvent, AcpRequest } from './acp'
import { runAcpSession } from './acp'

/**
 * Minimal structural view of the AI-SDK LanguageModelV3 contract we implement.
 * The opencode wrapper types most of this as `any`, so we keep our own narrow
 * shapes for the pieces we actually touch and avoid a hard dependency on the
 * @ai-sdk/provider package at runtime.
 */
type V3TextPart = { type: 'text'; text: string }
type V3ReasoningPart = { type: 'reasoning'; text: string }
type V3FilePart = { type: 'file'; data: unknown; mediaType: string; filename?: string }
type V3ToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
type V3ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: unknown
}
type V3MessagePart = V3TextPart | V3ReasoningPart | V3FilePart | V3ToolCallPart | V3ToolResultPart

type V3Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: Array<V3TextPart | V3FilePart> }
  | { role: 'assistant'; content: V3MessagePart[] }
  | { role: 'tool'; content: Array<V3ToolResultPart | { type: string; [k: string]: unknown }> }

export type V3CallOptions = {
  prompt: V3Message[]
  tools?: Array<{ type: string; name?: string; description?: string; inputSchema?: unknown }>
  toolChoice?: { type: 'auto' | 'none' | 'required' | 'tool'; toolName?: string }
  abortSignal?: AbortSignal
  providerOptions?: Record<string, Record<string, unknown>>
}

type V3StreamPart =
  | { type: 'stream-start'; warnings: unknown[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | {
      type: 'finish'
      usage: {
        inputTokens: {
          total: number | undefined
          noCache: number | undefined
          cacheRead: number | undefined
          cacheWrite: number | undefined
        }
        outputTokens: {
          total: number | undefined
          text: number | undefined
          reasoning: number | undefined
        }
      }
      finishReason: {
        unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
        raw: string | undefined
      }
    }
  | { type: 'error'; error: unknown }

type Block = Record<string, any>

/** Map a data-content value (Uint8Array | base64 string | URL) to a base64 string. */
function toBase64(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof URL) return undefined
  return undefined
}

/** Convert one AI-SDK message part to an Anthropic-style content block that
 *  acp.ts's `extractText` / `imageContent` already understand. */
function toBlock(part: V3MessagePart): Block | undefined {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'reasoning':
      return { type: 'text', text: part.text }
    case 'file': {
      const b64 = toBase64(part.data)
      if (b64 && part.mediaType.startsWith('image/')) {
        return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: b64 } }
      }
      return { type: 'text', text: '[file attached]' }
    }
    case 'tool-call':
      return { type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input ?? {} }
    case 'tool-result': {
      const output = part.output as any
      const text =
        output?.type === 'text' || output?.type === 'error-text'
          ? String(output.value ?? '')
          : JSON.stringify(output?.value ?? output ?? {})
      return { type: 'tool_result', tool_use_id: part.toolCallId, content: text }
    }
  }
}

/** Map AI-SDK call options into the AcpRequest shape acp.ts consumes. */
export function v3PromptToAcpRequest(options: V3CallOptions, model: string): AcpRequest {
  let system: string | undefined
  const messages: AcpRequest['messages'] = []

  for (const message of options.prompt) {
    if (message.role === 'system') {
      system = system ? `${system}\n\n${message.content}` : message.content
      continue
    }
    const parts = Array.isArray(message.content) ? message.content : []
    const blocks = parts
      .map((part) => toBlock(part as V3MessagePart))
      .filter((block): block is Block => block !== undefined)
    const role = message.role === 'tool' ? 'user' : message.role
    messages.push({ role, content: blocks })
  }

  const tools = (options.tools ?? [])
    .filter((tool) => tool.type === 'function' && typeof tool.name === 'string')
    .map((tool) => ({
      name: tool.name as string,
      description: tool.description,
      input_schema: tool.inputSchema
    }))

  return {
    model,
    system,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: options.toolChoice?.type
  }
}

const EMPTY_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined }
}

/**
 * Build a LanguageModelV3-compatible model whose `doStream` drives `kiro-cli acp`
 * over stdio (via the shared {@link runAcpSession} driver) and emits AI-SDK v3
 * stream parts. This is what makes ACP work natively on opencode 2.0 through
 * `ctx.aisdk.hook("language", …)` — no HTTP request is involved.
 */
export function createKiroAcpLanguageModel(params: {
  providerID: string
  modelID: string
  effort: string | undefined
  cwd: string
  trustTools: boolean
}) {
  const { providerID, modelID, effort, cwd, trustTools } = params

  async function doStream(options: V3CallOptions) {
    const body = v3PromptToAcpRequest(options, modelID)
    let blockId = 0

    const stream = new ReadableStream<V3StreamPart>({
      async start(controller) {
        let open: { kind: 'text' | 'reasoning'; id: string } | undefined
        let closed = false
        const enqueue = (part: V3StreamPart) => {
          if (!closed) controller.enqueue(part)
        }
        const closeOpen = () => {
          if (!open) return
          enqueue(
            open.kind === 'text'
              ? { type: 'text-end', id: open.id }
              : { type: 'reasoning-end', id: open.id }
          )
          open = undefined
        }
        const writeDelta = (kind: 'text' | 'reasoning', delta: string) => {
          if (!delta) return
          if (!open || open.kind !== kind) {
            closeOpen()
            const id = `b${blockId++}`
            open = { kind, id }
            enqueue(kind === 'text' ? { type: 'text-start', id } : { type: 'reasoning-start', id })
          }
          enqueue(
            kind === 'text'
              ? { type: 'text-delta', id: open.id, delta }
              : { type: 'reasoning-delta', id: open.id, delta }
          )
        }

        enqueue({ type: 'stream-start', warnings: [] })

        const onEvent = (event: AcpDriverEvent) => {
          switch (event.type) {
            case 'thinking':
              writeDelta('reasoning', event.text)
              break
            case 'text':
              writeDelta('text', event.text)
              break
            case 'tool-calls':
              closeOpen()
              for (const call of event.calls) {
                enqueue({
                  type: 'tool-call',
                  toolCallId: call.id,
                  toolName: call.name,
                  input: JSON.stringify(call.input ?? {})
                })
              }
              break
            case 'finish':
              closeOpen()
              enqueue({
                type: 'finish',
                usage: {
                  inputTokens: {
                    ...EMPTY_USAGE.inputTokens,
                    total: event.inputTokens,
                    noCache: event.inputTokens
                  },
                  outputTokens: {
                    ...EMPTY_USAGE.outputTokens,
                    total: Math.ceil(event.outputChars / 4),
                    text: Math.ceil(event.outputChars / 4)
                  }
                },
                finishReason: {
                  unified: event.reason === 'tool_use' ? 'tool-calls' : 'stop',
                  raw: event.reason
                }
              })
              break
            case 'error':
              closeOpen()
              enqueue({ type: 'error', error: new Error(event.message) })
              enqueue({
                type: 'finish',
                usage: EMPTY_USAGE,
                finishReason: { unified: 'error', raw: 'error' }
              })
              break
          }
        }

        await runAcpSession(
          { body, model: modelID, effort, cwd, trustTools, signal: options.abortSignal },
          onEvent
        )

        closed = true
        controller.close()
      }
    })

    return { stream }
  }

  async function doGenerate(options: V3CallOptions) {
    const { stream } = await doStream(options)
    const reader = stream.getReader()
    let text = ''
    let reasoning = ''
    const toolCalls: Array<{
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: string
    }> = []
    let usage = EMPTY_USAGE
    let finishReason: V3StreamPart & { type: 'finish' } extends infer _ ? any : never = {
      unified: 'stop',
      raw: 'stop'
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'reasoning-delta') reasoning += value.delta
      else if (value.type === 'tool-call') toolCalls.push(value)
      else if (value.type === 'finish') {
        usage = value.usage as typeof EMPTY_USAGE
        finishReason = value.finishReason
      }
    }

    const content: Block[] = []
    if (reasoning) content.push({ type: 'reasoning', text: reasoning })
    if (text) content.push({ type: 'text', text })
    for (const call of toolCalls) {
      content.push({
        type: 'tool-call',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input
      })
    }

    return { content, usage, finishReason, warnings: [] as unknown[] }
  }

  return {
    specificationVersion: 'v3' as const,
    provider: providerID,
    modelId: modelID,
    supportedUrls: {} as Record<string, RegExp[]>,
    doStream,
    doGenerate
  }
}
