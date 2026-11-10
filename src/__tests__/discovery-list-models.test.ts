import { describe, expect, test } from 'bun:test'
import {
  listAvailableModels,
  ModelDiscoveryError,
  type DiscoveredModel,
  type KiroManagementAuth
} from '../plugin/discovery/list-models.js'

const AUTH: KiroManagementAuth = {
  access: 'access-token',
  profileArn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/ABCDEF',
  region: 'us-east-1'
}

function jsonResponse(body: unknown, init?: { status?: number; requestId?: string }): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (init?.requestId !== undefined) headers.set('x-amzn-requestid', init.requestId)
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers })
}

function neverTimeout(): AbortSignal {
  return new AbortController().signal
}

describe('listAvailableModels', () => {
  test('returns parsed models from a single page', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Headers }> = []
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers)
      })
      return jsonResponse({
        models: [
          {
            modelId: 'claude-opus-5',
            modelName: 'Claude Opus 5',
            tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
            supportedInputTypes: ['TEXT', 'IMAGE'],
            additionalModelRequestFieldsSchema: { properties: {} }
          }
        ]
      })
    }) as unknown as typeof fetch

    const models = await listAvailableModels(AUTH, {
      fetch: fakeFetch,
      timeoutSignal: neverTimeout
    })

    expect(models).toHaveLength(1)
    expect(models[0]?.modelId).toBe('claude-opus-5')
    expect(models[0]?.tokenLimits?.maxInputTokens).toBe(1000000)
    // Request wiring: management host, KIRO_CLI origin body, Bearer + target headers.
    expect(calls[0]?.url).toBe('https://management.us-east-1.kiro.dev/')
    expect(calls[0]?.body).toEqual({
      origin: 'KIRO_CLI',
      profileArn: AUTH.profileArn
    })
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer access-token')
    expect(calls[0]?.headers.get('x-amz-target')).toBe(
      'AmazonCodeWhispererService.ListAvailableModels'
    )
    expect(calls[0]?.headers.get('content-type')).toBe('application/x-amz-json-1.0')
  })

  test('follows nextToken pagination and de-dupes by modelId', async () => {
    const pages: unknown[] = [
      { models: [{ modelId: 'a' }, { modelId: 'b' }], nextToken: 'page2' },
      { models: [{ modelId: 'b' }, { modelId: 'c' }] }
    ]
    const sentTokens: Array<string | undefined> = []
    let i = 0
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { nextToken?: string }
      sentTokens.push(body.nextToken)
      return jsonResponse(pages[i++])
    }) as unknown as typeof fetch

    const models = await listAvailableModels(AUTH, {
      fetch: fakeFetch,
      timeoutSignal: neverTimeout
    })
    expect(models.map((m) => m.modelId)).toEqual(['a', 'b', 'c'])
    expect(sentTokens).toEqual([undefined, 'page2'])
  })

  test('stops at MAX_PAGES even if nextToken never clears', async () => {
    let calls = 0
    const fakeFetch = (async () => {
      calls++
      return jsonResponse({ models: [{ modelId: `m${calls}` }], nextToken: 'always' })
    }) as unknown as typeof fetch

    const models = await listAvailableModels(AUTH, {
      fetch: fakeFetch,
      timeoutSignal: neverTimeout
    })
    expect(calls).toBe(10)
    expect(models).toHaveLength(10)
  })

  test('maps 403 to an auth error with status + requestId', async () => {
    const fakeFetch = (async () =>
      jsonResponse(
        { message: 'forbidden' },
        { status: 403, requestId: 'req-403' }
      )) as unknown as typeof fetch
    try {
      await listAvailableModels(AUTH, { fetch: fakeFetch, timeoutSignal: neverTimeout })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ModelDiscoveryError)
      const err = e as ModelDiscoveryError
      expect(err.kind).toBe('auth')
      expect(err.status).toBe(403)
      expect(err.requestId).toBe('req-403')
    }
  })

  test('maps 500 to an http error', async () => {
    const fakeFetch = (async () =>
      jsonResponse({ message: 'boom' }, { status: 500 })) as unknown as typeof fetch
    try {
      await listAvailableModels(AUTH, { fetch: fakeFetch, timeoutSignal: neverTimeout })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as ModelDiscoveryError
      expect(err.kind).toBe('http')
      expect(err.status).toBe(500)
    }
  })

  test('maps a fetch throw to a network error', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    try {
      await listAvailableModels(AUTH, { fetch: fakeFetch, timeoutSignal: neverTimeout })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as ModelDiscoveryError
      expect(err.kind).toBe('network')
    }
  })

  test('maps an all-empty result to an empty error', async () => {
    const fakeFetch = (async () => jsonResponse({ models: [] })) as unknown as typeof fetch
    try {
      await listAvailableModels(AUTH, { fetch: fakeFetch, timeoutSignal: neverTimeout })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as ModelDiscoveryError
      expect(err.kind).toBe('empty')
    }
  })

  test('drops entries without a modelId', async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        models: [{ modelName: 'no id' }, { modelId: 'keeper' }]
      })) as unknown as typeof fetch
    const models: DiscoveredModel[] = await listAvailableModels(AUTH, {
      fetch: fakeFetch,
      timeoutSignal: neverTimeout
    })
    expect(models.map((m) => m.modelId)).toEqual(['keeper'])
  })
})
