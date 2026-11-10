import { MODEL_MAPPING, SUPPORTED_MODELS, getModelContextLimit } from '../constants'
import { getDiscoveredContextLimit, isDiscoveredWireId } from './discovery/catalog.js'
import type { Effort } from './types'

/** Wire ids the static mapping can already produce (MODEL_MAPPING values). */
const KNOWN_WIRE_IDS = new Set<string>(Object.values(MODEL_MAPPING))

/**
 * Resolve a plugin model id into its Kiro wire id.
 *
 * Resolution order:
 *  1. Static `MODEL_MAPPING` key → its mapped wire id (unchanged behavior).
 *  2. Already a known wire id (a `MODEL_MAPPING` value) → pass through. Live
 *     discovery registers catalog entries keyed on raw wire ids, so the id that
 *     comes back on send is frequently a wire id, not a plugin key.
 *  3. A wire id advertised by a prior successful discovery → pass through, so a
 *     model the plugin has never hardcoded still routes (Option A). The id is
 *     only trusted because the management API returned it.
 *  4. Otherwise throw `Unsupported model` (unchanged for genuinely unknown ids).
 */
export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (resolved) return resolved
  if (KNOWN_WIRE_IDS.has(model) || isDiscoveredWireId(model)) return model
  throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
}

const VARIANT_BASE_ALLOWLIST = new Set<string>([
  'claude-opus-5-5',
  'claude-opus-5.5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5.5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
  'claude-haiku-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
])

const EFFORT_SUFFIXES: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface ResolvedModelVariant {
  wireId: string
  effort?: Effort
}

/**
 * Resolve a (possibly effort-variant) model id into its Kiro wire id plus an
 * optional parsed effort level.
 *
 * Parse rule (unambiguous, single source of truth):
 * An id is an effort variant ONLY IF it ends with `-<suffix>` for some suffix
 * in EFFORT_SUFFIXES AND the id with that `-<suffix>` removed is in
 * VARIANT_BASE_ALLOWLIST. In that case the wire id is derived SOLELY from the
 * base via MODEL_MAPPING and the effort SOLELY from the parsed suffix.
 *
 * This guarantees ids like `claude-opus-4-8-thinking`, `claude-sonnet-4-5-1m`,
 * and the plain bases (`claude-opus-4-8`) are NEVER parsed as effort variants.
 * Non-variant ids fall through to `resolveKiroModel` (existing behavior/throw)
 * with `effort` left undefined.
 */
export function resolveModelVariant(model: string): ResolvedModelVariant {
  for (const suffix of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`
    if (model.endsWith(marker)) {
      const base = model.slice(0, -marker.length)
      if (VARIANT_BASE_ALLOWLIST.has(base)) {
        return { wireId: resolveKiroModel(base), effort: suffix }
      }
    }
  }
  return { wireId: resolveKiroModel(model), effort: undefined }
}

export function stripModelSuffix(model: string): string {
  for (const suffix of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`
    if (model.endsWith(marker)) {
      const base = model.slice(0, -marker.length)
      if (VARIANT_BASE_ALLOWLIST.has(base)) {
        return base
      }
    }
  }
  if (model.endsWith('-thinking')) {
    const base = model.slice(0, -'-thinking'.length)
    if (MODEL_MAPPING[base]) {
      return base
    }
  }
  return model
}

/**
 * Resolve the context window used for token accounting.
 *
 * Live discovery wins over the static table: the catalog registered with
 * OpenCode carries `tokenLimits.maxInputTokens` from the management API, so the
 * percentage-derived `prompt_tokens` reported back must use that same window or
 * OpenCode under-counts usage and never compacts. Static table is the fallback
 * for ids discovery has not seen (and for offline/test runs).
 */
export function getContextWindowSize(model: string): number {
  const base = stripModelSuffix(model)
  const discovered = getDiscoveredContextLimit(model) ?? getDiscoveredContextLimit(base)
  if (discovered !== undefined) return discovered
  return getModelContextLimit(base)
}
