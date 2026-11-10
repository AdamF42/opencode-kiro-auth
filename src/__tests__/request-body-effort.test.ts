import { describe, expect, test } from 'bun:test'
import { extractBodyEffort } from '../core/request/request-handler.js'
import { buildEffortRequestFields } from '../plugin/effort.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types'

const fakeAuth: KiroAuthDetails = {
  refresh: 'fake-refresh',
  access: 'fake-access',
  expires: Date.now() + 3_600_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const minimalBody = { messages: [{ role: 'user', content: 'hi' }] }

describe('extractBodyEffort', () => {
  test('reads reasoningEffort (camelCase)', () => {
    expect(extractBodyEffort({ reasoningEffort: 'high' })).toBe('high')
  })

  test('falls back to reasoning_effort (snake_case)', () => {
    expect(extractBodyEffort({ reasoning_effort: 'xhigh' })).toBe('xhigh')
  })

  test('prefers camelCase over snake_case when both present', () => {
    expect(extractBodyEffort({ reasoningEffort: 'low', reasoning_effort: 'max' })).toBe('low')
  })

  test('accepts every valid effort level', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(extractBodyEffort({ reasoningEffort: level })).toBe(level)
    }
  })

  test('rejects unknown or malformed values', () => {
    expect(extractBodyEffort({ reasoningEffort: 'ultra' })).toBeUndefined()
    expect(extractBodyEffort({ reasoningEffort: 42 })).toBeUndefined()
    expect(extractBodyEffort({ reasoningEffort: '' })).toBeUndefined()
    expect(extractBodyEffort({})).toBeUndefined()
    expect(extractBodyEffort(undefined)).toBeUndefined()
    expect(extractBodyEffort(null)).toBeUndefined()
  })
})

describe('request path — body-sourced effort flows through transformToSdkRequest', () => {
  // The request handler extracts body effort and threads it through as
  // options.effort. These assertions simulate that by passing options.effort,
  // confirming a cycled variant (body reasoningEffort) resolves correctly for
  // the chosen base model id with no effort suffix.
  test('body effort applies to a Claude base id (no suffix)', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'claude-opus-5',
      fakeAuth,
      false,
      20000,
      undefined,
      { effort: extractBodyEffort({ reasoningEffort: 'xhigh' }) }
    )
    expect(req.effort).toBe('xhigh')
    expect(req.effectiveModel).toBe('claude-opus-5')
  })

  test('body effort clamps xhigh -> max on a non-xhigh Claude base (sonnet 4.6)', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'claude-sonnet-4-6',
      fakeAuth,
      false,
      20000,
      undefined,
      { effort: extractBodyEffort({ reasoningEffort: 'xhigh' }) }
    )
    expect(req.effort).toBe('max')
    expect(req.effectiveModel).toBe('claude-sonnet-4.6')
  })

  test('body effort applies to a GPT base id', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'gpt-5.6-sol',
      fakeAuth,
      false,
      20000,
      undefined,
      { effort: extractBodyEffort({ reasoningEffort: 'high' }) }
    )
    expect(req.effort).toBe('high')
    expect(req.effectiveModel).toBe('gpt-5.6-sol')
  })

  test('model-id effort suffix overrides body effort (suffix > body)', () => {
    const req = transformToSdkRequest(
      minimalBody,
      'claude-opus-5-low',
      fakeAuth,
      false,
      20000,
      undefined,
      { effort: extractBodyEffort({ reasoningEffort: 'max' }) }
    )
    expect(req.effort).toBe('low')
    expect(req.effectiveModel).toBe('claude-opus-5')
  })
})

describe('resolved effort routes to the correct CodeWhisperer wire field', () => {
  test('Claude wire id -> adaptive thinking block + output_config.effort', () => {
    expect(buildEffortRequestFields('claude-opus-5', 'xhigh')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' }
    })
  })

  test('GPT wire id -> reasoning.effort', () => {
    expect(buildEffortRequestFields('gpt-5.6-sol', 'high')).toEqual({
      reasoning: { effort: 'high' }
    })
  })
})
