/**
 * Caching, catalog mapping, and fallback for Kiro model discovery.
 *
 * Builds on the pure `listAvailableModels` (list-models.ts):
 *  - `getAvailableModels` adds a per-profileArn TTL cache + in-flight de-dup;
 *    failures are never cached.
 *  - `toKiroModelCatalog` maps live `DiscoveredModel[]` into this repo's existing
 *    `KiroModelCatalog` shape (consumed by `mapCatalogToModelInfo` /
 *    `cloneKiroModelCatalog`).
 *  - `MINIMAL_FALLBACK_CATALOG` is the safe fallback (only `auto`), honoring
 *    AGENTS.md §4: no unconfirmed wire id is shipped to the chat path.
 *  - `buildDiscoveryFailurePlaceholder` + `formatDiscoveryError` surface a
 *    failure in the picker and in a toast/logger line.
 */
import { getModelContextLimit } from '../../constants.js'
import { buildVariants, type KiroModelCatalog, type KiroModelDefinition } from '../model-catalog.js'
import { type ModelEffort, parseEffortLevels } from './effort.js'
import {
  type DiscoveredModel,
  type KiroManagementAuth,
  listAvailableModels,
  type ListAvailableModelsDeps,
  ModelDiscoveryError
} from './list-models.js'

/** Cache TTL for a successful discovery, per profile ARN. */
export const CATALOG_CACHE_MS = 5 * 60 * 1000

const DEFAULT_CONTEXT_LIMIT = 200000
const DEFAULT_OUTPUT_LIMIT = 64000
const INPUT_MODALITIES = ['text', 'image', 'pdf'] as const

/** Non-functional placeholder id shown in the picker when discovery fails. */
export const DISCOVERY_FAILURE_PLACEHOLDER_ID = 'kiro-discovery-failed'

/** The always-valid `auto` entry, shared by the fallback and the live catalog. */
function makeAutoEntry(): KiroModelDefinition {
  return {
    name: 'Auto (1.0x)',
    limit: { context: getModelContextLimit('auto'), output: DEFAULT_OUTPUT_LIMIT },
    modalities: { input: [...INPUT_MODALITIES], output: ['text'] }
  }
}

/** The minimal safe catalog: only the always-valid `auto` route. */
export const MINIMAL_FALLBACK_CATALOG: KiroModelCatalog = {
  auto: makeAutoEntry()
}

/** Acronyms/brand spellings Kiro uses, keyed by lowercase id segment. */
const NAME_ACRONYMS: Record<string, string> = {
  gpt: 'GPT',
  glm: 'GLM',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek'
}

function titleCase(segment: string): string {
  if (segment.length === 0) return segment
  const known = NAME_ACRONYMS[segment.toLowerCase()]
  if (known !== undefined) return known
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

/** "1" → "1.0", "1.3" → "1.3", "0.06" → "0.06" (Kiro credit-multiplier style). */
function formatMultiplier(value: number): string {
  const text = String(value)
  return text.includes('.') ? text : `${text}.0`
}

/**
 * Derive a human display name from a model's name or id, appending the credit
 * multiplier exactly as Kiro shows it ("Claude Sonnet 4.5 (1.3x)"). The
 * multiplier comes from the live `rateMultiplier`; when absent the name is left
 * unchanged.
 */
function displayName(model: DiscoveredModel): string {
  const explicit = model.modelName?.trim()
  // The management API returns `modelName` equal to the raw id (e.g.
  // "claude-opus-5.5"), which is not what Kiro's picker shows. Prettify the id
  // in that case; trust a genuinely different explicit name.
  const isRawId = explicit === undefined || explicit.length === 0 || explicit === model.modelId
  const base = isRawId
    ? model.modelId
        .split(/[-_]/)
        .filter((part) => part.length > 0)
        .map(titleCase)
        .join(' ')
    : explicit
  const multiplier = model.rateMultiplier
  if (multiplier === undefined || /\d+x\)$/.test(base)) return base
  return `${base} (${formatMultiplier(multiplier)}x)`
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback
}

function normalizeInputModalities(types: readonly string[] | undefined): string[] {
  if (types === undefined || types.length === 0) return [...INPUT_MODALITIES]
  const normalized = new Set<string>()
  for (const type of types) {
    const lower = type.toLowerCase()
    if (lower.includes('image')) normalized.add('image')
    else if (lower.includes('pdf') || lower.includes('document')) normalized.add('pdf')
    else if (lower.includes('text')) normalized.add('text')
  }
  if (!normalized.has('text')) normalized.add('text')
  return [...normalized]
}

/**
 * Map a live model to the existing catalog entry shape. When the model's
 * advertised schema carries an effort enum, surface those levels as OpenCode
 * `variants` so the single model entry can cycle effort via `variant_cycle`
 * instead of registering a separate entry per effort level.
 */
function toCatalogEntry(model: DiscoveredModel): KiroModelDefinition {
  const entry: KiroModelDefinition = {
    name: displayName(model),
    limit: {
      // Prefer the API-advertised limit; when it is omitted, fall back to the
      // per-model static table (getModelContextLimit) rather than a flat 200k so
      // a discovered long-context model (e.g. a 1M Claude) keeps its true limit.
      // getModelContextLimit itself defaults to 200k for ids it does not know.
      context: positiveLimit(
        model.tokenLimits?.maxInputTokens,
        getModelContextLimit(model.modelId)
      ),
      output: positiveLimit(model.tokenLimits?.maxOutputTokens, DEFAULT_OUTPUT_LIMIT)
    },
    modalities: {
      input: normalizeInputModalities(model.supportedInputTypes),
      output: ['text']
    }
  }
  const effort = parseEffortLevels(model.additionalModelRequestFieldsSchema)
  if (effort !== undefined && effort.levels.length > 0) {
    entry.variants = buildVariants(effort.levels)
  }
  return entry
}

/**
 * Map discovered models into the catalog shape. `auto` is always present so the
 * always-valid route stays selectable even when the live list omits it.
 */
export function toKiroModelCatalog(models: readonly DiscoveredModel[]): KiroModelCatalog {
  const autoEntry = makeAutoEntry()
  const discoveredAuto = models.find((model) => model.modelId === 'auto')
  if (discoveredAuto?.tokenLimits?.maxInputTokens !== undefined) {
    // The live list advertises `auto` with its true window (currently 1M).
    // Keep the stable display name but honor the API limit.
    autoEntry.limit.context = positiveLimit(
      discoveredAuto.tokenLimits.maxInputTokens,
      autoEntry.limit.context
    )
  }
  const catalog: KiroModelCatalog = { auto: autoEntry }
  for (const model of models) {
    if (model.modelId === 'auto') continue
    catalog[model.modelId] = toCatalogEntry(model)
  }
  return catalog
}

/**
 * Registry of discovered wire ids. These are the raw `modelId` strings the
 * management API advertised, which `toKiroModelCatalog` registers verbatim as
 * catalog keys. The chat-path resolver (`resolveKiroModel`) consults this set so
 * a discovered id that is not a static `MODEL_MAPPING` key — including a model
 * the plugin has never hardcoded — still routes as an already-resolved wire id
 * instead of throwing `Unsupported model`. This is the mechanism that makes
 * live discovery end-to-end functional on the chat path (Option A).
 *
 * Advisory and additive only: it never overrides a static mapping (the resolver
 * checks `MODEL_MAPPING` first) and never ships an unconfirmed id to the chat
 * path on its own — an id is only present here because the API returned it.
 */
const moduleDiscoveredWireIds = new Set<string>()

/** Record the wire ids from a discovery result as valid chat-path pass-throughs. */
export function recordDiscoveredWireIds(
  models: readonly DiscoveredModel[],
  registry: Set<string> = moduleDiscoveredWireIds
): void {
  for (const model of models) {
    if (model.modelId === 'auto') continue
    registry.add(model.modelId)
  }
}

/** Whether a wire id was advertised by a prior discovery (chat-path pass-through). */
export function isDiscoveredWireId(
  modelId: string,
  registry: Set<string> = moduleDiscoveredWireIds
): boolean {
  return registry.has(modelId)
}

/** Clear the discovered wire-id registry (tests + explicit refresh). */
export function clearDiscoveredWireIds(registry: Set<string> = moduleDiscoveredWireIds): void {
  registry.clear()
}

/**
 * Discovered per-model effort capability, keyed by wire modelId.
 *
 * The static `effort.ts` tables cover the probe-confirmed models. Discovery can
 * surface additional models whose effort schema we learn at runtime; this
 * registry lets the request path consult the live schema for those models
 * WITHOUT widening the static tables (which must stay probe-confirmed per
 * AGENTS.md §4). It is advisory only: when a model is absent here the request
 * path falls back to the static `buildEffortRequestFields`.
 */
const moduleDiscoveredEffort = new Map<string, ModelEffort>()

/** Record the effort capabilities parsed from a discovery result. */
export function recordDiscoveredEffort(
  models: readonly DiscoveredModel[],
  registry: Map<string, ModelEffort> = moduleDiscoveredEffort
): void {
  for (const model of models) {
    if (model.modelId === 'auto') continue
    const effort = parseEffortLevels(model.additionalModelRequestFieldsSchema)
    if (effort !== undefined) registry.set(model.modelId, effort)
  }
}

/** Look up the discovered effort capability for a wire modelId, if any. */
export function getDiscoveredEffort(
  modelId: string,
  registry: Map<string, ModelEffort> = moduleDiscoveredEffort
): ModelEffort | undefined {
  return registry.get(modelId)
}

/** Clear the discovered-effort registry (used by tests + explicit refresh). */
export function clearDiscoveredEffort(
  registry: Map<string, ModelEffort> = moduleDiscoveredEffort
): void {
  registry.clear()
}

/**
 * Discovered per-model context windows, keyed by wire modelId.
 *
 * The static `MODEL_CONTEXT_LIMITS` table is a fallback: the management API is
 * authoritative (today `auto` and the 5.5 models advertise 1M, gpt-5.6 986k,
 * MiniMax 196k). The token-usage path MUST use the same number the plugin
 * advertises to OpenCode (`limit.context` in the registered catalog), otherwise
 * OpenCode under-counts usage and skips auto-compaction until Kiro hard-rejects
 * the request.
 */
const moduleDiscoveredContextLimits = new Map<string, number>()

/** Record the context windows advertised by a discovery result. */
export function recordDiscoveredContextLimits(
  models: readonly DiscoveredModel[],
  registry: Map<string, number> = moduleDiscoveredContextLimits
): void {
  for (const model of models) {
    const limit = model.tokenLimits?.maxInputTokens
    if (typeof limit === 'number' && limit > 0) registry.set(model.modelId, limit)
  }
}

/** Look up the discovered context window for a wire modelId, if any. */
export function getDiscoveredContextLimit(
  modelId: string,
  registry: Map<string, number> = moduleDiscoveredContextLimits
): number | undefined {
  return registry.get(modelId)
}

/** Clear the discovered-context registry (used by tests + explicit refresh). */
export function clearDiscoveredContextLimits(
  registry: Map<string, number> = moduleDiscoveredContextLimits
): void {
  registry.clear()
}

/** A short failure tag used in the placeholder name + formatted message. */
function failureTag(error: ModelDiscoveryError): string {
  switch (error.kind) {
    case 'no-account':
      return 'no accounts'
    case 'auth':
      return error.status !== undefined ? `auth, HTTP ${error.status}` : 'auth'
    case 'http':
      return error.status !== undefined ? `HTTP ${error.status}` : 'http error'
    case 'network':
      return 'network error'
    case 'empty':
      return 'empty list'
  }
}

/**
 * A non-functional picker entry whose name encodes the failure. Separate from
 * `auto` (which stays selectable); selecting this does not route a real request.
 */
export function buildDiscoveryFailurePlaceholder(error: ModelDiscoveryError): {
  id: string
  entry: KiroModelDefinition
} {
  return {
    id: DISCOVERY_FAILURE_PLACEHOLDER_ID,
    entry: {
      name: `Kiro: model discovery failed (${failureTag(error)})`,
      limit: { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
      modalities: { input: ['text'], output: ['text'] }
    }
  }
}

/** A clear one-line message per failure kind for the toast/logger. */
export function formatDiscoveryError(error: ModelDiscoveryError): string {
  const suffix = error.requestId !== undefined ? ` (request id ${error.requestId})` : ''
  switch (error.kind) {
    case 'no-account':
      return 'Kiro model discovery skipped: no authenticated account. Sign in to list models.'
    case 'auth':
      return `Kiro model discovery failed: authentication rejected${
        error.status !== undefined ? ` (HTTP ${error.status})` : ''
      }. Re-authenticate your Kiro account.${suffix}`
    case 'http':
      return `Kiro model discovery failed: the management API returned HTTP ${
        error.status ?? 'error'
      }.${suffix}`
    case 'network':
      return 'Kiro model discovery failed: could not reach the management API (network error).'
    case 'empty':
      return 'Kiro model discovery returned no models; using the minimal fallback catalog.'
  }
}

interface CacheEntry {
  readonly models: DiscoveredModel[]
  readonly expiresAt: number
}

/** Injectable collaborators for `getAvailableModels` (clock + cache + fetch). */
export interface GetAvailableModelsDeps extends ListAvailableModelsDeps {
  readonly now?: () => number
  /** Shared cache map; defaults to the module-level cache. */
  readonly cache?: Map<string, CacheEntry>
  /** Shared in-flight map; defaults to the module-level map. */
  readonly inFlight?: Map<string, Promise<DiscoveredModel[]>>
}

const moduleCache = new Map<string, CacheEntry>()
const moduleInFlight = new Map<string, Promise<DiscoveredModel[]>>()

/**
 * Discover models with a per-profileArn TTL cache and in-flight de-duplication.
 * A thrown `ModelDiscoveryError` is never cached, so the next call re-attempts.
 */
export async function getAvailableModels(
  auth: KiroManagementAuth,
  deps: GetAvailableModelsDeps = {}
): Promise<DiscoveredModel[]> {
  const now = deps.now ?? Date.now
  const cache = deps.cache ?? moduleCache
  const inFlight = deps.inFlight ?? moduleInFlight
  const key = auth.profileArn

  // The cache + in-flight maps key on profileArn. An empty profileArn is not a
  // stable identity (distinct no-profile accounts would collide on one slot),
  // so skip both and always fetch fresh for that case.
  if (key.length === 0) {
    return listAvailableModels(auth, deps)
  }

  const cached = cache.get(key)
  if (cached !== undefined && cached.expiresAt > now()) {
    return cached.models
  }

  const existing = inFlight.get(key)
  if (existing !== undefined) return existing

  const attempt = (async (): Promise<DiscoveredModel[]> => {
    const models = await listAvailableModels(auth, deps)
    cache.set(key, { models, expiresAt: now() + CATALOG_CACHE_MS })
    return models
  })()

  inFlight.set(key, attempt)
  try {
    return await attempt
  } finally {
    inFlight.delete(key)
  }
}

/** Clear the module-level discovery cache (used by tests + explicit refresh). */
export function clearDiscoveryCache(): void {
  moduleCache.clear()
  moduleInFlight.clear()
}
