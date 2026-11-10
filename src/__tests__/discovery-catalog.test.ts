import { describe, expect, mock, test } from 'bun:test'
import {
  buildDiscoveryFailurePlaceholder,
  CATALOG_CACHE_MS,
  DISCOVERY_FAILURE_PLACEHOLDER_ID,
  formatDiscoveryError,
  getAvailableModels,
  getDiscoveredEffort,
  MINIMAL_FALLBACK_CATALOG,
  recordDiscoveredEffort,
  toKiroModelCatalog,
  type GetAvailableModelsDeps
} from '../plugin/discovery/catalog.js'
import type { ModelEffort } from '../plugin/discovery/effort.js'
import {
  ModelDiscoveryError,
  type DiscoveredModel,
  type KiroManagementAuth
} from '../plugin/discovery/list-models.js'
import type { KiroModelDefinition } from '../plugin/model-catalog.js'
import { mapCatalogToModelInfo } from '../plugin/v2/model-mapper.js'

const AUTH: KiroManagementAuth = {
  access: 'access-token',
  profileArn: 'arn:aws:codewhisperer:us-east-1:111122223333:profile/ABC',
  region: 'us-east-1'
}

const neverTimeout = (): AbortSignal => new AbortController().signal

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function freshDeps(overrides: Partial<GetAvailableModelsDeps> = {}): GetAvailableModelsDeps {
  return {
    cache: new Map(),
    inFlight: new Map(),
    timeoutSignal: neverTimeout,
    ...overrides
  }
}

const MODELS_PAGE = {
  models: [
    {
      modelId: 'claude-sonnet-5',
      modelName: 'Claude Sonnet 5',
      tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
      supportedInputTypes: ['text', 'image']
    }
  ]
}

describe('getAvailableModels cache', () => {
  test('caches per profileArn with a 5-min TTL and de-dupes in-flight calls', async () => {
    let clock = 1_000_000
    const now = () => clock
    const fetchMock = mock(async () => jsonResponse(MODELS_PAGE))
    const deps = freshDeps({ fetch: fetchMock as unknown as typeof fetch, now })

    // Two concurrent calls share one fetch (in-flight de-dup).
    const [a, b] = await Promise.all([
      getAvailableModels(AUTH, deps),
      getAvailableModels(AUTH, deps)
    ])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Within TTL: served from cache, no new fetch.
    clock += CATALOG_CACHE_MS - 1
    await getAvailableModels(AUTH, deps)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('TTL expiry triggers a refetch', async () => {
    let clock = 0
    const now = () => clock
    const fetchMock = mock(async () => jsonResponse(MODELS_PAGE))
    const deps = freshDeps({ fetch: fetchMock as unknown as typeof fetch, now })

    await getAvailableModels(AUTH, deps)
    clock += CATALOG_CACHE_MS + 1
    await getAvailableModels(AUTH, deps)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a discovery failure is not cached; the next call retries', async () => {
    let call = 0
    const fetchMock = mock(async () => {
      call += 1
      if (call === 1) return new Response('nope', { status: 403 })
      return jsonResponse(MODELS_PAGE)
    })
    const deps = freshDeps({ fetch: fetchMock as unknown as typeof fetch })

    await expect(getAvailableModels(AUTH, deps)).rejects.toBeInstanceOf(ModelDiscoveryError)
    // Second call must re-attempt (failure not cached) and succeed.
    const models = await getAvailableModels(AUTH, deps)
    expect(models).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('an empty profileArn is never cached (distinct no-profile accounts must not collide)', async () => {
    const fetchMock = mock(async () => jsonResponse(MODELS_PAGE))
    const cache = new Map()
    const deps = freshDeps({ fetch: fetchMock as unknown as typeof fetch, cache })
    const noProfileAuth: KiroManagementAuth = { ...AUTH, profileArn: '' }

    await getAvailableModels(noProfileAuth, deps)
    await getAvailableModels(noProfileAuth, deps)
    // No cache entry under the empty key, so each call fetches fresh.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })
})

describe('toKiroModelCatalog', () => {
  test('produces entries shaped like the static catalog (verified via mapCatalogToModelInfo)', () => {
    const models: DiscoveredModel[] = [
      {
        modelId: 'claude-sonnet-5',
        modelName: 'Claude Sonnet 5',
        tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
        supportedInputTypes: ['text', 'image']
      }
    ]
    const catalog = toKiroModelCatalog(models)
    expect(catalog.auto).toBeDefined()
    expect(catalog['claude-sonnet-5']).toEqual<KiroModelDefinition>({
      name: 'Claude Sonnet 5',
      limit: { context: 1000000, output: 64000 },
      modalities: { input: ['text', 'image'], output: ['text'] }
    })
    // Must be consumable by the v2 mapper without throwing.
    const infos = mapCatalogToModelInfo('kiro-auth', catalog)
    expect(infos.length).toBe(2)
  })

  test('derives a display name from the id when modelName is absent', () => {
    const catalog = toKiroModelCatalog([{ modelId: 'claude-opus-5' }])
    expect(catalog['claude-opus-5']?.name).toBe('Claude Opus 5')
  })

  test('falls back to default limits/modalities when fields are missing', () => {
    const catalog = toKiroModelCatalog([{ modelId: 'mystery-model' }])
    const entry = catalog['mystery-model']
    expect(entry).toBeDefined()
    expect(entry?.limit).toEqual({ context: 200000, output: 64000 })
    // No supportedInputTypes => full default input modalities.
    expect(entry?.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] })
  })

  test('a known long-context id with no advertised tokenLimits keeps its static limit', () => {
    // The management API omitted tokenLimits; rather than a flat 200k, the
    // per-model static table supplies the true 1M context for this Claude.
    const catalog = toKiroModelCatalog([{ modelId: 'claude-sonnet-5' }])
    expect(catalog['claude-sonnet-5']?.limit).toEqual({ context: 1000000, output: 64000 })
  })

  test('an advertised tokenLimit still wins over the static table', () => {
    const catalog = toKiroModelCatalog([
      {
        modelId: 'claude-sonnet-5',
        tokenLimits: { maxInputTokens: 500000, maxOutputTokens: 32000 }
      }
    ])
    expect(catalog['claude-sonnet-5']?.limit).toEqual({ context: 500000, output: 32000 })
  })

  test('attaches a variants map from a Claude (output_config) effort schema', () => {
    const catalog = toKiroModelCatalog([
      {
        modelId: 'claude-opus-5',
        additionalModelRequestFieldsSchema: {
          properties: {
            output_config: {
              properties: {
                effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }
              }
            }
          }
        }
      }
    ])
    expect(catalog['claude-opus-5']?.variants).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
      max: { reasoningEffort: 'max' }
    })
  })

  test('attaches a variants map from a GPT (reasoning) effort schema', () => {
    const catalog = toKiroModelCatalog([
      {
        modelId: 'gpt-5.6-sol',
        additionalModelRequestFieldsSchema: {
          properties: {
            reasoning: {
              properties: {
                effort: { enum: ['low', 'high'], default: 'low' }
              }
            }
          }
        }
      }
    ])
    expect(catalog['gpt-5.6-sol']?.variants).toEqual({
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' }
    })
  })

  test('omits variants when the model advertises no effort schema', () => {
    const catalog = toKiroModelCatalog([
      {
        modelId: 'claude-sonnet-5',
        tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
        supportedInputTypes: ['text', 'image']
      }
    ])
    expect(catalog['claude-sonnet-5']?.variants).toBeUndefined()
  })
})

describe('MINIMAL_FALLBACK_CATALOG', () => {
  test('contains only auto', () => {
    expect(Object.keys(MINIMAL_FALLBACK_CATALOG)).toEqual(['auto'])
  })
})

describe('buildDiscoveryFailurePlaceholder', () => {
  test('returns a distinct non-functional entry whose name encodes the failure', () => {
    const placeholder = buildDiscoveryFailurePlaceholder(
      new ModelDiscoveryError('http', 'boom', { status: 403 })
    )
    expect(placeholder.id).toBe(DISCOVERY_FAILURE_PLACEHOLDER_ID)
    expect(placeholder.id).not.toBe('auto')
    expect(placeholder.entry.name).toBe('Kiro: model discovery failed (HTTP 403)')
  })

  test('encodes each failure kind distinctly', () => {
    const names = (['no-account', 'auth', 'network', 'empty'] as const).map(
      (kind) => buildDiscoveryFailurePlaceholder(new ModelDiscoveryError(kind, 'x')).entry.name
    )
    expect(new Set(names).size).toBe(4)
  })
})

describe('formatDiscoveryError', () => {
  test('returns a distinct message per kind', () => {
    const messages = (['no-account', 'auth', 'http', 'network', 'empty'] as const).map((kind) =>
      formatDiscoveryError(new ModelDiscoveryError(kind, 'x', { status: 500 }))
    )
    expect(new Set(messages).size).toBe(5)
  })

  test('includes the request id when present', () => {
    const message = formatDiscoveryError(
      new ModelDiscoveryError('auth', 'x', { status: 403, requestId: 'req-123' })
    )
    expect(message).toContain('req-123')
    expect(message).toContain('403')
  })
})

describe('discovered-effort registry (injectable)', () => {
  test('records and reads back parsed effort via an injected registry (no module bleed)', () => {
    const registry = new Map<string, ModelEffort>()
    recordDiscoveredEffort(
      [
        {
          modelId: 'claude-sonnet-5',
          additionalModelRequestFieldsSchema: {
            properties: {
              output_config: {
                properties: {
                  effort: { enum: ['low', 'medium', 'high'], default: 'medium' }
                }
              }
            }
          }
        }
      ],
      registry
    )
    const effort = getDiscoveredEffort('claude-sonnet-5', registry)
    expect(effort?.schemaPath).toBe('output_config')
    expect(effort?.levels).toEqual(['low', 'medium', 'high'])
    // The module-level registry is untouched by the injected one.
    expect(getDiscoveredEffort('claude-sonnet-5')).toBeUndefined()
  })
})
