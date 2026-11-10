import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'
import {
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_REQUEST_KIND_HEADER
} from '../core/request/request-kind.js'
import {
  buildPrivateHeaders,
  createKiroLanguageModel,
  type KiroRequestPipeline
} from '../plugin/v2/language-model.js'

const noopToast = (): void => {}

interface CapturedCall {
  url: string
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
}

/** A fake pipeline that records the synthesized request and returns a scripted Response. */
function fakePipeline(responseFactory: () => Response): {
  pipeline: KiroRequestPipeline
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const pipeline: KiroRequestPipeline = {
    async handle(input: unknown, init: unknown): Promise<Response> {
      calls.push({ url: String(input), init: (init ?? {}) as CapturedCall['init'] })
      return responseFactory()
    }
  }
  return { pipeline, calls }
}

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

const baseOptions: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
}

async function collect(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) parts.push(value)
  }
  return parts
}

describe('createKiroLanguageModel', () => {
  test('exposes v3 identity fields', () => {
    const { pipeline } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    expect(model.specificationVersion).toBe('v3')
    expect(model.provider).toBe('kiro-auth')
    expect(model.modelId).toBe('claude-sonnet-5')
    expect(model.supportedUrls).toEqual({})
  })

  test('synthesizes a Kiro API URL and OpenAI-chat body that handle() recognizes', async () => {
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    await model.doStream(baseOptions).then((r) => collect(r.stream))
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(
      'https://q.us-east-1.amazonaws.com/models/claude-sonnet-5/generateAssistantResponse'
    )
    expect(call.init.method).toBe('POST')
    const body = JSON.parse(call.init.body ?? '{}')
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('derives the compaction request-kind header from the v2 call kind', async () => {
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast,
      resolveCallContext: () => ({ kind: 'compaction', sessionID: 'sess-123' })
    })
    await model.doStream(baseOptions).then((r) => collect(r.stream))
    const headers = calls[0]!.init.headers ?? {}
    expect(headers[KIRO_REQUEST_KIND_HEADER]).toBe('compaction')
    // Diagnostic trace + session hash are present (session hash is a 16-hex slice, not raw).
    expect(headers[KIRO_DIAGNOSTIC_TRACE_HEADER]).toBeDefined()
    expect(headers[KIRO_DIAGNOSTIC_SESSION_HEADER]).toMatch(/^[0-9a-f]{16}$/)
    expect(headers[KIRO_DIAGNOSTIC_SESSION_HEADER]).not.toBe('sess-123')
  })

  test('omits the compaction header for a normal (primary) call', async () => {
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast,
      resolveCallContext: () => ({ kind: 'primary' })
    })
    await model.doStream(baseOptions).then((r) => collect(r.stream))
    const headers = calls[0]!.init.headers ?? {}
    expect(headers[KIRO_REQUEST_KIND_HEADER]).toBeUndefined()
  })

  test('re-emits host-forwarded private headers verbatim (model.request bridge)', async () => {
    // Simulate the v2 split-surface bridge: the `model.request` hook stamps the
    // private header channel via buildPrivateHeaders, the host forwards those
    // onto the call options' headers, and the adapter (with no resolveCallContext)
    // must re-emit the identical channel into the synthesized request so handle()
    // sees the exact v1 headers.
    const hookHeaders = buildPrivateHeaders(
      { kind: 'compaction', sessionID: 'sess-abc', agent: 'build' },
      true
    )
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
      // no resolveCallContext — exercise the header-forwarding fallback path
    })
    await model.doStream({ ...baseOptions, headers: hookHeaders }).then((r) => collect(r.stream))
    const headers = calls[0]!.init.headers ?? {}
    expect(headers[KIRO_REQUEST_KIND_HEADER]).toBe('compaction')
    expect(headers[KIRO_DIAGNOSTIC_TRACE_HEADER]).toBe(hookHeaders[KIRO_DIAGNOSTIC_TRACE_HEADER])
    expect(headers[KIRO_DIAGNOSTIC_SESSION_HEADER]).toBe(
      hookHeaders[KIRO_DIAGNOSTIC_SESSION_HEADER]
    )
    expect(headers[KIRO_DIAGNOSTIC_AGENT_HEADER]).toBe(hookHeaders[KIRO_DIAGNOSTIC_AGENT_HEADER])
    // Values are hashed, never raw identity.
    expect(headers[KIRO_DIAGNOSTIC_SESSION_HEADER]).not.toBe('sess-abc')
    expect(headers[KIRO_DIAGNOSTIC_AGENT_HEADER]).not.toBe('build')
  })

  test('ignores non-private host headers on the fallback path', async () => {
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    await model
      .doStream({ ...baseOptions, headers: { 'x-unrelated': 'nope' } })
      .then((r) => collect(r.stream))
    const headers = calls[0]!.init.headers ?? {}
    expect(headers['x-unrelated']).toBeUndefined()
    expect(headers[KIRO_REQUEST_KIND_HEADER]).toBeUndefined()
  })

  test('threads the caller abort signal into the pipeline init', async () => {
    const { pipeline, calls } = fakePipeline(() => sseResponse([]))
    const controller = new AbortController()
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    await model
      .doStream({ ...baseOptions, abortSignal: controller.signal })
      .then((r) => collect(r.stream))
    expect(calls[0]!.init.signal).toBe(controller.signal)
  })

  test('buildPrivateHeaders gates diagnostics but always emits the compaction kind', () => {
    // emitDiagnostics=false mirrors v1 diagnostic_log_level==='off': only the
    // request-kind header survives, never the identity/trace headers.
    const gated = buildPrivateHeaders(
      { kind: 'compaction', sessionID: 'sess', agent: 'build', messageID: 'm1' },
      false
    )
    expect(gated).toEqual({ [KIRO_REQUEST_KIND_HEADER]: 'compaction' })

    // A primary call with diagnostics off emits nothing at all.
    expect(buildPrivateHeaders({ kind: 'primary' }, false)).toEqual({})

    // With diagnostics on, trace + hashed identity headers appear.
    const full = buildPrivateHeaders({ kind: 'primary', sessionID: 'sess', agent: 'build' }, true)
    expect(full[KIRO_DIAGNOSTIC_TRACE_HEADER]).toBeDefined()
    expect(full[KIRO_DIAGNOSTIC_SESSION_HEADER]).toMatch(/^[0-9a-f]{16}$/)
    expect(full[KIRO_DIAGNOSTIC_AGENT_HEADER]).toMatch(/^[0-9a-f]{16}$/)
    expect(full[KIRO_REQUEST_KIND_HEADER]).toBeUndefined()
  })

  test('doStream converts an OpenAI SSE response into v3 stream parts', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      }
    ]
    const { pipeline } = fakePipeline(() => sseResponse(chunks))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    const { stream } = await model.doStream(baseOptions)
    const parts = await collect(stream)
    const types = parts.map((p) => p.type)
    expect(types[0]).toBe('stream-start')
    expect(types).toContain('text-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('text-end')
    expect(types[types.length - 1]).toBe('finish')
    const text = parts
      .filter(
        (p): p is Extract<LanguageModelV3StreamPart, { type: 'text-delta' }> =>
          p.type === 'text-delta'
      )
      .map((p) => p.delta)
      .join('')
    expect(text).toBe('Hello')
    const finish = parts.find((p) => p.type === 'finish')
    expect(finish && finish.type === 'finish' && finish.finishReason.unified).toBe('stop')
  })

  test('doStream handles a null body with a well-formed terminal sequence', async () => {
    const { pipeline } = fakePipeline(() => new Response(null, { status: 204 }))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    const { stream } = await model.doStream(baseOptions)
    const parts = await collect(stream)
    expect(parts[0]!.type).toBe('stream-start')
    expect(parts[parts.length - 1]!.type).toBe('finish')
  })

  test('doGenerate folds the SSE stream into ordered content + finishReason + usage', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 }
      }
    ]
    const { pipeline } = fakePipeline(() => sseResponse(chunks))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    const result = await model.doGenerate(baseOptions)
    expect(result.content[0]).toEqual({ type: 'reasoning', text: 'think' })
    expect(result.content[1]).toEqual({ type: 'text', text: 'answer' })
    expect(result.finishReason.unified).toBe('stop')
    expect(result.usage.inputTokens.total).toBe(10)
    expect(result.usage.outputTokens.total).toBe(3)
    expect(result.warnings).toEqual([])
  })

  test('doGenerate surfaces tool calls as content', async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'get_weather', arguments: '{"city":"NYC"}' }
                }
              ]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]
    const { pipeline } = fakePipeline(() => sseResponse(chunks))
    const model = createKiroLanguageModel({
      providerID: 'kiro-auth',
      modelID: 'claude-sonnet-5',
      baseURL: 'https://q.us-east-1.amazonaws.com',
      pipeline,
      showToast: noopToast
    })
    const result = await model.doGenerate(baseOptions)
    const toolCall = result.content.find((c) => c.type === 'tool-call')
    expect(toolCall).toEqual({
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'get_weather',
      input: '{"city":"NYC"}'
    })
    expect(result.finishReason.unified).toBe('tool-calls')
  })
})
