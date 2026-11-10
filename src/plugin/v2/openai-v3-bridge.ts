/**
 * Pure, deterministic converters between the AI-SDK v3 language-model contract
 * (`@ai-sdk/provider`) and the OpenAI-chat JSON contract spoken by the existing
 * Kiro request pipeline (`RequestHandler.handle`).
 *
 * This module is intentionally I/O-free and holds no module-level mutable state:
 * the streaming response converter threads an explicit `state` object so the
 * v2 `LanguageModelV3` wiring (ticket 05) can drive it chunk-by-chunk.
 *
 * Ground-truth type shapes come from `@ai-sdk/provider`'s v3 types and from the
 * OpenAI-chat shapes this codebase already produces/consumes:
 *  - request body: `src/plugin/request.ts` (messages / tools / content parts)
 *  - streaming chunks: `src/plugin/streaming/openai-converter.ts`
 *  - non-streaming completion: `src/core/request/response-handler.ts`
 */
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3DataContent,
  LanguageModelV3FilePart,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart,
  LanguageModelV3StreamPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
  LanguageModelV3Usage
} from '@ai-sdk/provider'

/** Content-part unions per message role (the v3 Message union does not export these). */
type V3UserContentPart = LanguageModelV3TextPart | LanguageModelV3FilePart
type V3AssistantContentPart =
  | LanguageModelV3TextPart
  | LanguageModelV3FilePart
  | LanguageModelV3ReasoningPart
  | LanguageModelV3ToolCallPart
  | LanguageModelV3ToolResultPart

/* -------------------------------------------------------------------------- */
/* OpenAI-chat shapes (local interfaces — this is a plain JSON contract).      */
/* -------------------------------------------------------------------------- */

export interface OpenAIChatTextContentPart {
  type: 'text'
  text: string
}

export interface OpenAIChatImageContentPart {
  type: 'image_url'
  image_url: { url: string }
}

export type OpenAIChatContentPart = OpenAIChatTextContentPart | OpenAIChatImageContentPart

export interface OpenAIChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAIChatSystemMessage {
  role: 'system'
  content: string
}

export interface OpenAIChatUserMessage {
  role: 'user'
  content: string | OpenAIChatContentPart[]
}

export interface OpenAIChatAssistantMessage {
  role: 'assistant'
  content: string | OpenAIChatContentPart[]
  reasoning_content?: string
  tool_calls?: OpenAIChatToolCall[]
}

export interface OpenAIChatToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type OpenAIChatMessage =
  | OpenAIChatSystemMessage
  | OpenAIChatUserMessage
  | OpenAIChatAssistantMessage
  | OpenAIChatToolMessage

export interface OpenAIChatTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: unknown
  }
}

export interface OpenAIChatBody {
  model?: string
  messages: OpenAIChatMessage[]
  tools?: OpenAIChatTool[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
  frequency_penalty?: number
  presence_penalty?: number
  seed?: number
}

/** Streaming OpenAI chunk (`chat.completion.chunk`). */
export interface OpenAIChunkToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export interface OpenAIChunkDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAIChunkToolCallDelta[]
}

export interface OpenAIChunkChoice {
  index?: number
  delta?: OpenAIChunkDelta
  finish_reason?: string | null
}

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface OpenAIChatChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: OpenAIChunkChoice[]
  usage?: OpenAIUsage
}

/** Non-streaming OpenAI completion (`chat.completion`). */
export interface OpenAICompletionMessage {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAIChatToolCall[]
}

export interface OpenAICompletionChoice {
  index?: number
  message?: OpenAICompletionMessage
  finish_reason?: string | null
}

export interface OpenAIChatCompletion {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: OpenAICompletionChoice[]
  usage?: OpenAIUsage
}

/* -------------------------------------------------------------------------- */
/* Request side: AI-SDK v3 call options -> OpenAI-chat body.                   */
/* -------------------------------------------------------------------------- */

const DATA_URL_PREFIX = 'data:'

/** Convert `LanguageModelV3DataContent` into a URL string usable by OpenAI image_url. */
function dataContentToUrl(data: LanguageModelV3DataContent, mediaType: string): string {
  if (data instanceof URL) return data.toString()
  if (typeof data === 'string') {
    // Already a URL (http/https/data) → pass through; otherwise assume base64
    // and wrap it in a data URL using the declared media type.
    if (
      data.startsWith('http://') ||
      data.startsWith('https://') ||
      data.startsWith(DATA_URL_PREFIX)
    ) {
      return data
    }
    return `${DATA_URL_PREFIX}${mediaType};base64,${data}`
  }
  // Uint8Array → base64 data URL. Deterministic, no I/O.
  const base64 = uint8ArrayToBase64(data)
  return `${DATA_URL_PREFIX}${mediaType};base64,${base64}`
}

/** Deterministic base64 encoding without relying on a global Buffer/btoa shim. */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64')
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    result += alphabet[(triple >> 18) & 0x3f]
    result += alphabet[(triple >> 12) & 0x3f]
    result += i + 1 < bytes.length ? alphabet[(triple >> 6) & 0x3f] : '='
    result += i + 2 < bytes.length ? alphabet[triple & 0x3f] : '='
  }
  return result
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith('image/')
}

/** Serialize a v3 tool-result output union to a string for the OpenAI tool message. */
function toolResultOutputToString(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'execution-denied':
      return output.reason !== undefined
        ? `[tool execution denied: ${output.reason}]`
        : '[tool execution denied]'
    case 'content': {
      // Flatten the content array to a best-effort text representation. Non-text
      // blocks (files/images) are summarized rather than dropped silently.
      const parts: string[] = []
      for (const block of output.value) {
        if (block.type === 'text') {
          parts.push(block.text)
        } else if (block.type === 'file-url') {
          parts.push(`[file: ${block.url}]`)
        } else if (block.type === 'file-data') {
          parts.push(`[file: ${block.mediaType}]`)
        } else if (block.type === 'file-id') {
          const id = typeof block.fileId === 'string' ? block.fileId : JSON.stringify(block.fileId)
          parts.push(`[file-id: ${id}]`)
        } else {
          parts.push('[file]')
        }
      }
      return parts.join('\n')
    }
    default: {
      // Exhaustiveness guard — unknown future variants serialize generically.
      return JSON.stringify(output)
    }
  }
}

/** Map a v3 user message content array to an OpenAI user content (string or parts). */
function userContentToOpenAI(
  content: readonly V3UserContentPart[]
): string | OpenAIChatContentPart[] {
  const parts: OpenAIChatContentPart[] = []
  let onlyText = true
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'file') {
      onlyText = false
      parts.push(filePartToOpenAI(part))
    }
  }
  // If the message was purely text parts, collapse to a single string so the
  // pipeline's `getContentText` fast-path keeps working.
  if (onlyText) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  }
  return parts
}

function filePartToOpenAI(part: LanguageModelV3FilePart): OpenAIChatContentPart {
  if (isImageMediaType(part.mediaType)) {
    return { type: 'image_url', image_url: { url: dataContentToUrl(part.data, part.mediaType) } }
  }
  // Non-image files have no first-class OpenAI chat representation; emit a
  // best-effort text note so downstream context is not silently lost.
  const label = part.filename !== undefined ? ` ${part.filename}` : ''
  return { type: 'text', text: `[file${label} (${part.mediaType})]` }
}

function assistantContentToOpenAI(content: readonly V3AssistantContentPart[]): {
  text: string
  reasoning: string
  toolCalls: OpenAIChatToolCall[]
} {
  let text = ''
  let reasoning = ''
  const toolCalls: OpenAIChatToolCall[] = []
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text
    } else if (part.type === 'reasoning') {
      reasoning += part.text
    } else if (part.type === 'tool-call') {
      toolCalls.push(toolCallPartToOpenAI(part))
    } else if (part.type === 'file') {
      // Assistant-authored files are rare; note them in text to avoid loss.
      text += `\n[file (${part.mediaType})]`
    } else if (part.type === 'tool-result') {
      // Rare: an assistant turn carrying a provider-executed tool result. The
      // OpenAI assistant message has no slot for this, so append as text.
      text += `\n${toolResultOutputToString(part.output)}`
    }
  }
  return { text, reasoning, toolCalls }
}

function toolCallPartToOpenAI(part: LanguageModelV3ToolCallPart): OpenAIChatToolCall {
  // v3 ToolCallPart.input is an already-parsed object; OpenAI expects a JSON string.
  const argumentsString =
    typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {})
  return {
    id: part.toolCallId,
    type: 'function',
    function: { name: part.toolName, arguments: argumentsString }
  }
}

function toolResultPartToOpenAI(part: LanguageModelV3ToolResultPart): OpenAIChatToolMessage {
  return {
    role: 'tool',
    tool_call_id: part.toolCallId,
    content: toolResultOutputToString(part.output)
  }
}

function v3MessageToOpenAI(message: LanguageModelV3Message): OpenAIChatMessage[] {
  switch (message.role) {
    case 'system':
      return [{ role: 'system', content: message.content }]
    case 'user':
      return [{ role: 'user', content: userContentToOpenAI(message.content) }]
    case 'assistant': {
      const { text, reasoning, toolCalls } = assistantContentToOpenAI(message.content)
      const assistant: OpenAIChatAssistantMessage = { role: 'assistant', content: text }
      if (reasoning.length > 0) assistant.reasoning_content = reasoning
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      return [assistant]
    }
    case 'tool': {
      // Each tool-result part becomes its own OpenAI `{role:'tool'}` message.
      // Approval-response parts have no OpenAI equivalent and are dropped.
      const out: OpenAIChatMessage[] = []
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          out.push(toolResultPartToOpenAI(part))
        }
      }
      return out
    }
    default: {
      // Unreachable with the current union; keep exhaustive for safety.
      return []
    }
  }
}

/** Map a v3 function tool to the OpenAI `tools[]` shape. Provider tools are skipped. */
function v3ToolToOpenAI(tool: LanguageModelV3FunctionTool): OpenAIChatTool {
  const fn: OpenAIChatTool['function'] = {
    name: tool.name,
    parameters: tool.inputSchema
  }
  if (tool.description !== undefined) fn.description = tool.description
  return { type: 'function', function: fn }
}

/**
 * Convert AI-SDK v3 call options into an OpenAI-chat request body object that the
 * existing Kiro pipeline (`RequestHandler.handle`) can consume.
 */
export function v3PromptToOpenAIChatBody(
  options: Pick<
    LanguageModelV3CallOptions,
    | 'prompt'
    | 'tools'
    | 'temperature'
    | 'topP'
    | 'maxOutputTokens'
    | 'stopSequences'
    | 'frequencyPenalty'
    | 'presencePenalty'
    | 'seed'
  > & { model?: string }
): OpenAIChatBody {
  const messages: OpenAIChatMessage[] = []
  for (const message of options.prompt) {
    messages.push(...v3MessageToOpenAI(message))
  }

  const body: OpenAIChatBody = { messages }
  if (options.model !== undefined) body.model = options.model

  if (options.tools !== undefined) {
    const functionTools: OpenAIChatTool[] = []
    for (const tool of options.tools) {
      // Only function tools map to OpenAI `tools[]`; provider tools are ignored.
      if (tool.type === 'function') {
        functionTools.push(v3ToolToOpenAI(tool))
      }
    }
    if (functionTools.length > 0) body.tools = functionTools
  }

  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.topP !== undefined) body.top_p = options.topP
  if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens
  if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
    body.stop = options.stopSequences
  }
  if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty
  if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty
  if (options.seed !== undefined) body.seed = options.seed

  return body
}

/* -------------------------------------------------------------------------- */
/* Finish-reason + usage mapping (shared by streaming and non-streaming).      */
/* -------------------------------------------------------------------------- */

/**
 * Map an OpenAI `finish_reason` string to the v3 finish-reason object.
 * `raw` preserves the original provider value (undefined when null/absent).
 */
export function mapFinishReason(reason: string | null | undefined): LanguageModelV3FinishReason {
  const raw = reason ?? undefined
  switch (reason) {
    case 'stop':
      return { unified: 'stop', raw }
    case 'length':
      return { unified: 'length', raw }
    case 'tool_calls':
      return { unified: 'tool-calls', raw }
    case 'content_filter':
      return { unified: 'content-filter', raw }
    case null:
    case undefined:
      return { unified: 'other', raw: undefined }
    default:
      return { unified: 'other', raw }
  }
}

/** Map OpenAI usage to the v3 usage object. Missing fields become `undefined`. */
export function mapUsage(usage: OpenAIUsage | undefined): LanguageModelV3Usage {
  const promptTotal = usage?.prompt_tokens
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens
  // noCache = total - cached when both known; otherwise fall back sensibly.
  let noCache: number | undefined
  if (promptTotal !== undefined) {
    noCache = cacheRead !== undefined ? promptTotal - cacheRead : promptTotal
  } else {
    noCache = undefined
  }
  const completionTotal = usage?.completion_tokens
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens

  return {
    inputTokens: {
      total: promptTotal,
      noCache,
      cacheRead,
      // OpenAI does not report cache-write tokens.
      cacheWrite: undefined
    },
    outputTokens: {
      total: completionTotal,
      // No separate text-token count from OpenAI; mirror the total.
      text: completionTotal,
      reasoning: reasoningTokens
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Response side (streaming): OpenAI chunks -> v3 stream parts.                */
/* -------------------------------------------------------------------------- */

interface ToolCallAccumulator {
  /** v3 stream-part id (tool call id) for this index. */
  id: string
  name: string
  /** Accumulated stringified JSON arguments. */
  arguments: string
  started: boolean
}

/**
 * Explicit mutable state threaded through `openAIChunkToV3Parts`. Create one per
 * logical stream and feed chunks in order; it tracks the open text/reasoning
 * blocks and the per-index tool-call accumulators so ticket 05 can drive the
 * conversion incrementally.
 */
export interface OpenAIToV3StreamState {
  streamStarted: boolean
  textId: string | undefined
  reasoningId: string | undefined
  /** keyed by chunk tool_call index */
  toolCalls: Map<number, ToolCallAccumulator>
  finishReason: LanguageModelV3FinishReason | undefined
  usage: OpenAIUsage | undefined
  finished: boolean
  /** Monotonic counter for synthesizing deterministic ids when needed. */
  nextId: number
}

export function createOpenAIToV3StreamState(): OpenAIToV3StreamState {
  return {
    streamStarted: false,
    textId: undefined,
    reasoningId: undefined,
    toolCalls: new Map<number, ToolCallAccumulator>(),
    finishReason: undefined,
    usage: undefined,
    finished: false,
    nextId: 0
  }
}

function synthId(state: OpenAIToV3StreamState, prefix: string): string {
  const id = `${prefix}-${state.nextId}`
  state.nextId += 1
  return id
}

/**
 * Convert a single OpenAI `chat.completion.chunk` into zero or more v3 stream
 * parts, mutating `state`. Emits `stream-start` lazily on the first chunk.
 *
 * It does NOT emit the terminal `finish` part — a `finish_reason` only records
 * the pending finish on `state`. Call {@link finalizeOpenAIToV3Stream} once the
 * chunk source is exhausted to flush open blocks and emit `finish`.
 */
export function openAIChunkToV3Parts(
  chunk: OpenAIChatChunk,
  state: OpenAIToV3StreamState
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = []

  if (!state.streamStarted) {
    state.streamStarted = true
    parts.push({ type: 'stream-start', warnings: [] })
  }

  if (chunk.usage !== undefined) {
    state.usage = chunk.usage
  }

  const choice = chunk.choices?.[0]
  if (choice === undefined) return parts

  const delta = choice.delta

  // Reasoning deltas.
  const reasoningDelta = delta?.reasoning_content
  if (reasoningDelta !== undefined && reasoningDelta !== null && reasoningDelta.length > 0) {
    if (state.reasoningId === undefined) {
      state.reasoningId = synthId(state, 'reasoning')
      parts.push({ type: 'reasoning-start', id: state.reasoningId })
    }
    parts.push({ type: 'reasoning-delta', id: state.reasoningId, delta: reasoningDelta })
  }

  // Text deltas.
  const textDelta = delta?.content
  if (textDelta !== undefined && textDelta !== null && textDelta.length > 0) {
    if (state.textId === undefined) {
      state.textId = synthId(state, 'text')
      parts.push({ type: 'text-start', id: state.textId })
    }
    parts.push({ type: 'text-delta', id: state.textId, delta: textDelta })
  }

  // Tool-call deltas.
  if (delta?.tool_calls !== undefined) {
    for (const tc of delta.tool_calls) {
      const index = tc.index
      let acc = state.toolCalls.get(index)
      if (acc === undefined) {
        acc = {
          id: tc.id ?? synthId(state, 'tool'),
          name: tc.function?.name ?? '',
          arguments: '',
          started: false
        }
        state.toolCalls.set(index, acc)
      } else {
        if (tc.id !== undefined) acc.id = tc.id
        if (tc.function?.name !== undefined && tc.function.name.length > 0) {
          acc.name = tc.function.name
        }
      }

      // Open the tool-input block as soon as we know its name/id.
      if (!acc.started && acc.name.length > 0) {
        acc.started = true
        parts.push({ type: 'tool-input-start', id: acc.id, toolName: acc.name })
      }

      const argDelta = tc.function?.arguments
      if (argDelta !== undefined && argDelta.length > 0) {
        acc.arguments += argDelta
        if (acc.started) {
          parts.push({ type: 'tool-input-delta', id: acc.id, delta: argDelta })
        }
      }
    }
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.finishReason = mapFinishReason(choice.finish_reason)
  }

  return parts
}

/**
 * Flush any open text/reasoning blocks, close & emit all accumulated tool calls,
 * then emit the terminal `finish` part. Idempotent: subsequent calls return [].
 */
export function finalizeOpenAIToV3Stream(
  state: OpenAIToV3StreamState
): LanguageModelV3StreamPart[] {
  if (state.finished) return []
  state.finished = true

  const parts: LanguageModelV3StreamPart[] = []

  // Guarantee stream-start even for an entirely empty stream.
  if (!state.streamStarted) {
    state.streamStarted = true
    parts.push({ type: 'stream-start', warnings: [] })
  }

  if (state.textId !== undefined) {
    parts.push({ type: 'text-end', id: state.textId })
  }
  if (state.reasoningId !== undefined) {
    parts.push({ type: 'reasoning-end', id: state.reasoningId })
  }

  // Close tool-input blocks and emit the final tool-call parts in index order.
  const indices = Array.from(state.toolCalls.keys()).sort((a, b) => a - b)
  let sawToolCall = false
  for (const index of indices) {
    const acc = state.toolCalls.get(index)
    if (acc === undefined) continue
    sawToolCall = true
    // A tool-call whose name never arrived still needs a start before its end.
    if (!acc.started) {
      acc.started = true
      parts.push({ type: 'tool-input-start', id: acc.id, toolName: acc.name })
      if (acc.arguments.length > 0) {
        parts.push({ type: 'tool-input-delta', id: acc.id, delta: acc.arguments })
      }
    }
    parts.push({ type: 'tool-input-end', id: acc.id })
    parts.push({
      type: 'tool-call',
      toolCallId: acc.id,
      toolName: acc.name,
      // v3 ToolCall.input is a stringified JSON string.
      input: acc.arguments.length > 0 ? acc.arguments : '{}'
    })
  }

  const finishReason =
    state.finishReason ??
    (sawToolCall ? { unified: 'tool-calls', raw: undefined } : { unified: 'stop', raw: undefined })

  parts.push({
    type: 'finish',
    finishReason,
    usage: mapUsage(state.usage)
  })

  return parts
}

/**
 * Convenience: run an entire OpenAI chunk sequence through the incremental
 * converter and yield every v3 stream part (including the terminal `finish`).
 */
export async function* openAISseToV3Stream(
  chunks: AsyncIterable<OpenAIChatChunk> | Iterable<OpenAIChatChunk>
): AsyncGenerator<LanguageModelV3StreamPart, void, unknown> {
  const state = createOpenAIToV3StreamState()
  for await (const chunk of chunks) {
    for (const part of openAIChunkToV3Parts(chunk, state)) {
      yield part
    }
  }
  for (const part of finalizeOpenAIToV3Stream(state)) {
    yield part
  }
}

/** Synchronous convenience variant over a materialized chunk array. */
export function openAIChunksToV3Parts(chunks: OpenAIChatChunk[]): LanguageModelV3StreamPart[] {
  const state = createOpenAIToV3StreamState()
  const parts: LanguageModelV3StreamPart[] = []
  for (const chunk of chunks) {
    parts.push(...openAIChunkToV3Parts(chunk, state))
  }
  parts.push(...finalizeOpenAIToV3Stream(state))
  return parts
}

/* -------------------------------------------------------------------------- */
/* Response side (non-streaming): OpenAI completion -> v3 generate result.     */
/* -------------------------------------------------------------------------- */

/**
 * Map a non-streaming OpenAI `chat.completion` object to the v3 generate-result
 * fields: ordered `content`, `finishReason`, `usage`, and empty `warnings`.
 */
export function openAICompletionToV3Content(
  completion: OpenAIChatCompletion
): Pick<LanguageModelV3GenerateResult, 'content' | 'finishReason' | 'usage' | 'warnings'> {
  const choice = completion.choices?.[0]
  const message = choice?.message
  const content: LanguageModelV3Content[] = []

  // Order: reasoning, then text, then tool calls — matches the natural stream order.
  const reasoning = message?.reasoning_content
  if (reasoning !== undefined && reasoning !== null && reasoning.length > 0) {
    content.push({ type: 'reasoning', text: reasoning })
  }

  const text = message?.content
  if (text !== undefined && text !== null && text.length > 0) {
    content.push({ type: 'text', text })
  }

  if (message?.tool_calls !== undefined) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        // v3 ToolCall.input is a stringified JSON string.
        input: tc.function.arguments.length > 0 ? tc.function.arguments : '{}'
      })
    }
  }

  return {
    content,
    finishReason: mapFinishReason(choice?.finish_reason),
    usage: mapUsage(completion.usage),
    warnings: []
  }
}
