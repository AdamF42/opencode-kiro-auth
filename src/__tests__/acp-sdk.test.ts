import { describe, expect, test } from 'bun:test'
import { v3PromptToAcpRequest, type V3CallOptions } from '../plugin/acp/acp-sdk.js'
import { KiroConfigSchema } from '../plugin/config/schema.js'

// These tests exercise the pure request-shaping function and the config
// transport defaults. They never spawn `kiro-cli acp`, so they are fully
// deterministic.

describe('v3PromptToAcpRequest', () => {
  test('folds system messages and maps content blocks', () => {
    const options: V3CallOptions = {
      prompt: [
        { role: 'system', content: 'be concise' },
        { role: 'system', content: 'and correct' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      ]
    }
    const req = v3PromptToAcpRequest(options, 'claude-opus-4.8')
    expect(req.model).toBe('claude-opus-4.8')
    expect(req.system).toBe('be concise\n\nand correct')
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  test('maps function tools to {name, description, input_schema} and tool_choice', () => {
    const options: V3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'reads a file',
          inputSchema: { type: 'object' }
        },
        { type: 'provider-defined', name: 'ignored' }
      ],
      toolChoice: { type: 'required' }
    }
    const req = v3PromptToAcpRequest(options, 'auto')
    expect(req.tools).toEqual([
      { name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }
    ])
    expect(req.tool_choice).toBe('required')
  })

  test('tool-role messages become user messages with tool_result blocks', () => {
    const options: V3CallOptions = {
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'read_file',
              output: { type: 'text', value: 'file body' }
            }
          ]
        }
      ]
    }
    const req = v3PromptToAcpRequest(options, 'auto')
    expect(req.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body' }]
      }
    ])
  })
})

describe('KiroConfigSchema transport defaults', () => {
  test('defaults transport to http and trust_acp_tools to false', () => {
    const config = KiroConfigSchema.parse({})
    expect(config.transport).toBe('http')
    expect(config.trust_acp_tools).toBe(false)
  })

  test('accepts the acp transport', () => {
    const config = KiroConfigSchema.parse({ transport: 'acp', trust_acp_tools: true })
    expect(config.transport).toBe('acp')
    expect(config.trust_acp_tools).toBe(true)
  })

  test('rejects an unknown transport', () => {
    expect(() => KiroConfigSchema.parse({ transport: 'grpc' })).toThrow()
  })
})
