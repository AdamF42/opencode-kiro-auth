/**
 * Pure Kiro model-discovery core: calls the management-plane
 * `AmazonCodeWhispererService.ListAvailableModels` operation and parses the
 * response into `DiscoveredModel[]`.
 *
 * This module is intentionally free of caching, auth resolution, and any
 * OpenCode plugin import so it can be unit-tested with `fetch` mocked. Caching
 * and fallback live in `catalog.ts` (ticket 02); auth resolution lives in
 * `auth.ts` (ticket 03).
 *
 * Wire facts come from `KIRO_MANAGEMENT` in `src/constants.ts` — never inline a
 * management literal here.
 */
import { buildUrl, KIRO_MANAGEMENT, normalizeRegion } from '../../constants.js'

/** Auth material the discovery call needs. */
export interface KiroManagementAuth {
  /** Bearer access token. */
  readonly access: string
  /** Profile ARN sent in the request body. */
  readonly profileArn: string
  /** Region used to template the management endpoint. */
  readonly region: string
}

/** Raw per-model fields retained for downstream mapping + effort parsing. */
export interface DiscoveredModel {
  readonly modelId: string
  readonly modelName?: string
  readonly description?: string
  readonly tokenLimits?: {
    readonly maxInputTokens?: number
    readonly maxOutputTokens?: number
  }
  /** Credit multiplier Kiro shows next to the model (e.g. 1.3 → "1.3x"). */
  readonly rateMultiplier?: number
  readonly supportedInputTypes?: readonly string[]
  /** JSON Schema advertising effort levels; parsed in ticket 06. */
  readonly additionalModelRequestFieldsSchema?: unknown
}

/** Discriminated failure classes a discovery attempt can produce. */
export type ModelDiscoveryErrorKind = 'no-account' | 'auth' | 'network' | 'empty' | 'http'

/** Typed discovery failure so callers can format a precise message per kind. */
export class ModelDiscoveryError extends Error {
  readonly kind: ModelDiscoveryErrorKind
  readonly status?: number
  readonly requestId?: string

  constructor(
    kind: ModelDiscoveryErrorKind,
    message: string,
    options?: { status?: number; requestId?: string; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ModelDiscoveryError'
    this.kind = kind
    if (options?.status !== undefined) this.status = options.status
    if (options?.requestId !== undefined) this.requestId = options.requestId
  }
}

/** Narrow unknown JSON to an indexable object without using `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ListModelsResponse {
  readonly models: DiscoveredModel[]
  readonly nextToken?: string
}

function parseModel(raw: unknown): DiscoveredModel | undefined {
  if (!isRecord(raw)) return undefined
  const modelId = raw.modelId
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined

  const model: {
    modelId: string
    modelName?: string
    description?: string
    tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number }
    rateMultiplier?: number
    supportedInputTypes?: readonly string[]
    additionalModelRequestFieldsSchema?: unknown
  } = { modelId }

  if (typeof raw.modelName === 'string') model.modelName = raw.modelName
  if (typeof raw.description === 'string') model.description = raw.description
  if (typeof raw.rateMultiplier === 'number' && raw.rateMultiplier > 0) {
    model.rateMultiplier = raw.rateMultiplier
  }
  if (isRecord(raw.tokenLimits)) {
    const limits: { maxInputTokens?: number; maxOutputTokens?: number } = {}
    if (typeof raw.tokenLimits.maxInputTokens === 'number')
      limits.maxInputTokens = raw.tokenLimits.maxInputTokens
    if (typeof raw.tokenLimits.maxOutputTokens === 'number')
      limits.maxOutputTokens = raw.tokenLimits.maxOutputTokens
    model.tokenLimits = limits
  }
  if (Array.isArray(raw.supportedInputTypes)) {
    model.supportedInputTypes = raw.supportedInputTypes.filter(
      (t): t is string => typeof t === 'string'
    )
  }
  if ('additionalModelRequestFieldsSchema' in raw) {
    model.additionalModelRequestFieldsSchema = raw.additionalModelRequestFieldsSchema
  }
  return model
}

function parsePage(payload: unknown): ListModelsResponse {
  if (!isRecord(payload)) return { models: [] }
  const rawModels = Array.isArray(payload.models) ? payload.models : []
  const models: DiscoveredModel[] = []
  for (const raw of rawModels) {
    const parsed = parseModel(raw)
    if (parsed !== undefined) models.push(parsed)
  }
  const result: ListModelsResponse = { models }
  if (typeof payload.nextToken === 'string' && payload.nextToken.length > 0) {
    return { models, nextToken: payload.nextToken }
  }
  return result
}

/** Overridable collaborators for tests (fetch + timer). */
export interface ListAvailableModelsDeps {
  readonly fetch?: typeof fetch
  /** Build an abort signal for the per-request timeout; injectable for tests. */
  readonly timeoutSignal?: (ms: number) => AbortSignal
}

const defaultTimeoutSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms)

/**
 * Fetch the full live model list from the Kiro management plane, following
 * `nextToken` pagination up to `KIRO_MANAGEMENT.MAX_PAGES`. Throws a
 * `ModelDiscoveryError` on auth failure, non-ok HTTP, network error, or an
 * empty result.
 */
export async function listAvailableModels(
  auth: KiroManagementAuth,
  deps: ListAvailableModelsDeps = {}
): Promise<DiscoveredModel[]> {
  const doFetch = deps.fetch ?? fetch
  const timeoutSignal = deps.timeoutSignal ?? defaultTimeoutSignal
  const url = buildUrl(KIRO_MANAGEMENT.URL, normalizeRegion(auth.region))

  const byId = new Map<string, DiscoveredModel>()
  let nextToken: string | undefined

  for (let page = 0; page < KIRO_MANAGEMENT.MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      origin: KIRO_MANAGEMENT.ORIGIN,
      profileArn: auth.profileArn
    }
    if (nextToken !== undefined) body.nextToken = nextToken

    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.access}`,
          'content-type': KIRO_MANAGEMENT.CONTENT_TYPE,
          'x-amz-target': KIRO_MANAGEMENT.LIST_MODELS_TARGET,
          'user-agent': KIRO_MANAGEMENT.USER_AGENT,
          'x-amz-user-agent': KIRO_MANAGEMENT.USER_AGENT
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(KIRO_MANAGEMENT.TIMEOUT_MS)
      })
    } catch (cause) {
      throw new ModelDiscoveryError('network', 'ListAvailableModels request failed', { cause })
    }

    if (!response.ok) {
      const requestId = response.headers.get('x-amzn-requestid') ?? undefined
      const kind: ModelDiscoveryErrorKind =
        response.status === 401 || response.status === 403 ? 'auth' : 'http'
      throw new ModelDiscoveryError(
        kind,
        `ListAvailableModels failed (HTTP ${response.status})`,
        requestId !== undefined
          ? { status: response.status, requestId }
          : { status: response.status }
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new ModelDiscoveryError('network', 'ListAvailableModels returned invalid JSON', {
        cause
      })
    }

    const parsed = parsePage(payload)
    for (const model of parsed.models) byId.set(model.modelId, model)
    nextToken = parsed.nextToken
    if (nextToken === undefined) break
  }

  if (byId.size === 0) {
    throw new ModelDiscoveryError('empty', 'ListAvailableModels returned no models')
  }
  return [...byId.values()]
}
