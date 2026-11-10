import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'
import {
  createOpenAIToV3StreamState,
  finalizeOpenAIToV3Stream,
  mapFinishReason,
  mapUsage,
  openAIChunksToV3Parts,
  openAIChunkToV3Parts,
  openAICompletionToV3Content,
  openAISseToV3Stream,
  v3PromptToOpenAIChatBody,
  type OpenAIChatAssistantMessage,
  type OpenAIChatBody,
  type OpenAIChatChunk,
  type OpenAIChatContentPart,
  type OpenAIChatToolMessage,
  type OpenAIChatUserMessage
} from '../plugin/v2/openai-v3-bridge.js'

/* -------------------------------------------------------------------------- */
/* Request side                                                               */
/* -------------------------------------------------------------------------- */

describe('v3PromptToOpenAIChatBody — roles & parts', () => {
  test('system message maps to {role:system, content:string}', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'You are helpful.' }]
    })
    expect(body.messages).toEqual([{ role: 'system', content: 'You are helpful.' }])
  })

  test('user text-only message collapses to a string content', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' }
          ]
        }
      ]
    })
    const msg = body.messages[0] as OpenAIChatUserMessage
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Hello world')
  })

  test('user image file (base64) maps to image_url data URL content part', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look:' },
            { type: 'file', mediaType: 'image/png', data: 'QUJD' }
          ]
        }
      ]
    })
    const msg = body.messages[0] as OpenAIChatUserMessage
    expect(Array.isArray(msg.content)).toBe(true)
    const parts = msg.content as OpenAIChatContentPart[]
    expect(parts[0]).toEqual({ type: 'text', text: 'look:' })
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,QUJD' }
    })
  })

  test('user image file (Uint8Array) is base64-encoded into a data URL', () => {
    const bytes = new Uint8Array([65, 66, 67]) // "ABC"
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/jpeg', data: bytes }] }]
    })
    const parts = (body.messages[0] as OpenAIChatUserMessage).content as OpenAIChatContentPart[]
    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,QUJD' }
    })
  })

  test('user image file (URL) passes the URL through unchanged', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'file', mediaType: 'image/png', data: new URL('https://x.test/a.png') }]
        }
      ]
    })
    const parts = (body.messages[0] as OpenAIChatUserMessage).content as OpenAIChatContentPart[]
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: 'https://x.test/a.png' } })
  })

  test('user image file (http string) passes through without data-url wrapping', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'file', mediaType: 'image/png', data: 'https://x.test/b.png' }]
        }
      ]
    })
    const parts = (body.messages[0] as OpenAIChatUserMessage).content as OpenAIChatContentPart[]
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: 'https://x.test/b.png' } })
  })

  test('non-image file becomes a best-effort text note', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'application/pdf', data: 'QUJD', filename: 'doc.pdf' }
          ]
        }
      ]
    })
    const parts = (body.messages[0] as OpenAIChatUserMessage).content as OpenAIChatContentPart[]
    expect(parts[0]).toEqual({ type: 'text', text: '[file doc.pdf (application/pdf)]' })
  })

  test('assistant text + reasoning + tool-call maps to tool_calls with stringified args', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking...' },
            { type: 'text', text: 'Calling tool.' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'get_weather',
              input: { city: 'NYC' }
            }
          ]
        }
      ]
    })
    const msg = body.messages[0] as OpenAIChatAssistantMessage
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('Calling tool.')
    expect(msg.reasoning_content).toBe('thinking...')
    expect(msg.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' }
      }
    ])
  })

  test('assistant tool-call with string input is passed through verbatim', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c', toolName: 't', input: '{"already":"json"}' }
          ]
        }
      ]
    })
    const msg = body.messages[0] as OpenAIChatAssistantMessage
    expect(msg.tool_calls?.[0]?.function.arguments).toBe('{"already":"json"}')
  })

  test('tool role tool-result parts become {role:tool} messages (text + json + error)', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 't',
              output: { type: 'text', value: 'plain text' }
            },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 't',
              output: { type: 'json', value: { ok: true } }
            },
            {
              type: 'tool-result',
              toolCallId: 'c3',
              toolName: 't',
              output: { type: 'error-text', value: 'boom' }
            },
            {
              type: 'tool-result',
              toolCallId: 'c4',
              toolName: 't',
              output: { type: 'error-json', value: { code: 500 } }
            }
          ]
        }
      ]
    })
    const msgs = body.messages as OpenAIChatToolMessage[]
    expect(msgs).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'plain text' },
      { role: 'tool', tool_call_id: 'c2', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c3', content: 'boom' },
      { role: 'tool', tool_call_id: 'c4', content: '{"code":500}' }
    ])
  })

  test('tool-result content array flattens text + file blocks', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c',
              toolName: 't',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'line1' },
                  { type: 'file-url', url: 'https://f.test/x' }
                ]
              }
            }
          ]
        }
      ]
    })
    const msg = body.messages[0] as OpenAIChatToolMessage
    expect(msg.content).toBe('line1\n[file: https://f.test/x]')
  })
})

describe('v3PromptToOpenAIChatBody — tools & sampling', () => {
  const tool: LanguageModelV3FunctionTool = {
    type: 'function',
    name: 'get_weather',
    description: 'Get weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }

  test('function tool definition maps to OpenAI tools[]', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'x' }],
      tools: [tool]
    })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: tool.inputSchema
        }
      }
    ])
  })

  test('provider tools are skipped, no empty tools array emitted', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'x' }],
      tools: [
        {
          type: 'provider-defined',
          id: 'openai.web_search',
          name: 'web_search',
          args: {}
        } as unknown as LanguageModelV3FunctionTool
      ]
    })
    expect(body.tools).toBeUndefined()
  })

  test('sampling options are mapped to OpenAI names', () => {
    const options: Partial<LanguageModelV3CallOptions> = {
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 256,
      stopSequences: ['STOP', 'END'],
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 42
    }
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'x' }],
      ...options
    })
    const expected: Partial<OpenAIChatBody> = {
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 256,
      stop: ['STOP', 'END'],
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      seed: 42
    }
    expect(body).toMatchObject(expected)
  })

  test('empty stopSequences does not emit a stop field', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'x' }],
      stopSequences: []
    })
    expect(body.stop).toBeUndefined()
  })

  test('model id is included when provided', () => {
    const body = v3PromptToOpenAIChatBody({
      prompt: [{ role: 'system', content: 'x' }],
      model: 'claude-sonnet-5'
    })
    expect(body.model).toBe('claude-sonnet-5')
  })
})

/* -------------------------------------------------------------------------- */
/* Finish reason + usage mapping                                              */
/* -------------------------------------------------------------------------- */

describe('mapFinishReason', () => {
  test('stop', () => expect(mapFinishReason('stop')).toEqual({ unified: 'stop', raw: 'stop' }))
  test('length', () =>
    expect(mapFinishReason('length')).toEqual({ unified: 'length', raw: 'length' }))
  test('tool_calls -> tool-calls', () =>
    expect(mapFinishReason('tool_calls')).toEqual({ unified: 'tool-calls', raw: 'tool_calls' }))
  test('content_filter -> content-filter', () =>
    expect(mapFinishReason('content_filter')).toEqual({
      unified: 'content-filter',
      raw: 'content_filter'
    }))
  test('null -> other with undefined raw', () =>
    expect(mapFinishReason(null)).toEqual({ unified: 'other', raw: undefined }))
  test('undefined -> other with undefined raw', () =>
    expect(mapFinishReason(undefined)).toEqual({ unified: 'other', raw: undefined }))
  test('unknown string -> other preserving raw', () =>
    expect(mapFinishReason('weird')).toEqual({ unified: 'other', raw: 'weird' }))
})

describe('mapUsage', () => {
  test('full usage with cached tokens', () => {
    const usage = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 }
    })
    expect(usage.inputTokens).toEqual({
      total: 100,
      noCache: 70,
      cacheRead: 30,
      cacheWrite: undefined
    })
    expect(usage.outputTokens).toEqual({ total: 40, text: 40, reasoning: undefined })
  })

  test('reasoning tokens mapped when present', () => {
    const usage = mapUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 }
    })
    expect(usage.outputTokens.reasoning).toBe(5)
  })

  test('no cached tokens -> noCache equals total', () => {
    const usage = mapUsage({ prompt_tokens: 50, completion_tokens: 10 })
    expect(usage.inputTokens).toEqual({
      total: 50,
      noCache: 50,
      cacheRead: undefined,
      cacheWrite: undefined
    })
  })

  test('undefined usage -> all fields undefined', () => {
    const usage = mapUsage(undefined)
    expect(usage.inputTokens).toEqual({
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined
    })
    expect(usage.outputTokens).toEqual({ total: undefined, text: undefined, reasoning: undefined })
  })
})

/* -------------------------------------------------------------------------- */
/* Response side — streaming                                                  */
/* -------------------------------------------------------------------------- */

function types(parts: LanguageModelV3StreamPart[]): string[] {
  return parts.map((p) => p.type)
}

describe('openAIChunkToV3Parts — incremental', () => {
  test('first chunk emits stream-start before anything else', () => {
    const state = createOpenAIToV3StreamState()
    const parts = openAIChunkToV3Parts(
      { choices: [{ index: 0, delta: { role: 'assistant' } }] },
      state
    )
    expect(parts[0]).toEqual({ type: 'stream-start', warnings: [] })
  })

  test('text deltas emit start once then deltas, finalize closes', () => {
    const state = createOpenAIToV3StreamState()
    const out: LanguageModelV3StreamPart[] = []
    out.push(...openAIChunkToV3Parts({ choices: [{ delta: { content: 'Hel' } }] }, state))
    out.push(...openAIChunkToV3Parts({ choices: [{ delta: { content: 'lo' } }] }, state))
    out.push(...finalizeOpenAIToV3Stream(state))

    expect(types(out)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish'
    ])
    const startId = (out[1] as { id: string }).id
    expect((out[2] as { id: string; delta: string }).delta).toBe('Hel')
    expect((out[4] as { id: string }).id).toBe(startId)
  })

  test('reasoning deltas emit reasoning start/delta/end', () => {
    const state = createOpenAIToV3StreamState()
    const out: LanguageModelV3StreamPart[] = []
    out.push(
      ...openAIChunkToV3Parts({ choices: [{ delta: { reasoning_content: 'because' } }] }, state)
    )
    out.push(...finalizeOpenAIToV3Stream(state))
    expect(types(out)).toEqual([
      'stream-start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'finish'
    ])
    expect((out[2] as { delta: string }).delta).toBe('because')
  })

  test('empty/null content and reasoning deltas are ignored', () => {
    const state = createOpenAIToV3StreamState()
    const out = openAIChunkToV3Parts(
      { choices: [{ delta: { content: '', reasoning_content: null } }] },
      state
    )
    // Only the stream-start; no text/reasoning starts for empty deltas.
    expect(types(out)).toEqual(['stream-start'])
  })

  test('tool call accumulates across deltas and finalizes to a stringified tool-call', () => {
    const state = createOpenAIToV3StreamState()
    const out: LanguageModelV3StreamPart[] = []
    out.push(
      ...openAIChunkToV3Parts(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'search', arguments: '' }
                  }
                ]
              }
            }
          ]
        },
        state
      )
    )
    out.push(
      ...openAIChunkToV3Parts(
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
        state
      )
    )
    out.push(
      ...openAIChunkToV3Parts(
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }] },
        state
      )
    )
    out.push(
      ...openAIChunkToV3Parts({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, state)
    )
    out.push(...finalizeOpenAIToV3Stream(state))

    expect(types(out)).toEqual([
      'stream-start',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'finish'
    ])
    const toolStart = out[1] as { id: string; toolName: string }
    expect(toolStart).toEqual({
      type: 'tool-input-start',
      id: 'call_a',
      toolName: 'search'
    } as never)
    const toolCall = out[5] as { toolCallId: string; toolName: string; input: string }
    expect(toolCall.toolCallId).toBe('call_a')
    expect(toolCall.toolName).toBe('search')
    expect(toolCall.input).toBe('{"q":"hi"}')
    const finish = out[6] as { finishReason: { unified: string } }
    expect(finish.finishReason.unified).toBe('tool-calls')
  })

  test('finish part carries usage from the usage-bearing chunk', () => {
    const state = createOpenAIToV3StreamState()
    openAIChunkToV3Parts({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, state)
    openAIChunkToV3Parts(
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
      state
    )
    const tail = finalizeOpenAIToV3Stream(state)
    const finish = tail[tail.length - 1] as {
      type: 'finish'
      usage: { inputTokens: { total: number | undefined } }
      finishReason: { unified: string }
    }
    expect(finish.type).toBe('finish')
    expect(finish.usage.inputTokens.total).toBe(7)
    expect(finish.finishReason.unified).toBe('stop')
  })

  test('empty stream still emits stream-start then finish via finalize', () => {
    const state = createOpenAIToV3StreamState()
    const out = finalizeOpenAIToV3Stream(state)
    expect(types(out)).toEqual(['stream-start', 'finish'])
    expect((out[1] as { finishReason: { unified: string } }).finishReason.unified).toBe('stop')
  })

  test('finalize is idempotent', () => {
    const state = createOpenAIToV3StreamState()
    finalizeOpenAIToV3Stream(state)
    expect(finalizeOpenAIToV3Stream(state)).toEqual([])
  })
})

describe('openAIChunksToV3Parts / openAISseToV3Stream convenience', () => {
  const chunks: OpenAIChatChunk[] = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { reasoning_content: 'hmm' } }] },
    { choices: [{ delta: { content: 'Hi' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ]

  test('sync array variant produces a full ordered sequence', () => {
    const parts = openAIChunksToV3Parts(chunks)
    expect(types(parts)).toEqual([
      'stream-start',
      'reasoning-start',
      'reasoning-delta',
      'text-start',
      'text-delta',
      'text-end',
      'reasoning-end',
      'finish'
    ])
  })

  test('async generator variant matches sync variant', async () => {
    const collected: LanguageModelV3StreamPart[] = []
    for await (const part of openAISseToV3Stream(chunks)) {
      collected.push(part)
    }
    expect(types(collected)).toEqual(types(openAIChunksToV3Parts(chunks)))
  })
})

/* -------------------------------------------------------------------------- */
/* Response side — non-streaming                                              */
/* -------------------------------------------------------------------------- */

describe('openAICompletionToV3Content', () => {
  test('text + reasoning + tool-calls map to ordered content', () => {
    const result = openAICompletionToV3Content({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'auto',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Here you go.',
            reasoning_content: 'let me think',
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'calc', arguments: '{"a":1}' } }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 2 }
      }
    })

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'Here you go.' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'calc', input: '{"a":1}' }
    ])
    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool_calls' })
    expect(result.usage.inputTokens).toEqual({
      total: 12,
      noCache: 10,
      cacheRead: 2,
      cacheWrite: undefined
    })
    expect(result.usage.outputTokens.total).toBe(8)
    expect(result.warnings).toEqual([])
  })

  test('text-only completion with stop finish reason', () => {
    const result = openAICompletionToV3Content({
      choices: [{ message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }]
    })
    expect(result.content).toEqual([{ type: 'text', text: 'plain' }])
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' })
  })

  test('empty content with no choices yields empty content array and other finish', () => {
    const result = openAICompletionToV3Content({})
    expect(result.content).toEqual([])
    expect(result.finishReason).toEqual({ unified: 'other', raw: undefined })
    expect(result.usage.inputTokens.total).toBeUndefined()
  })

  test('tool-call with empty arguments string becomes {}', () => {
    const result = openAICompletionToV3Content({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'z', type: 'function', function: { name: 'noop', arguments: '' } }]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })
    expect(result.content).toEqual([
      { type: 'tool-call', toolCallId: 'z', toolName: 'noop', input: '{}' }
    ])
  })
})
