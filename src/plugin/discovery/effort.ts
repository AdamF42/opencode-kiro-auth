/**
 * Dynamic per-model reasoning effort, read from each model's advertised JSON
 * Schema during discovery (`DiscoveredModel.additionalModelRequestFieldsSchema`).
 *
 * Kiro advertises a model's effort knob in one of two shapes:
 *   Claude: { properties: { output_config: { properties: { effort: { enum, default } } } } }
 *   GPT:    { properties: { reasoning:     { properties: { effort: { enum, default } } } } }
 *
 * This module is PURE: it parses the schema, clamps a requested level to what a
 * model actually supports, and builds the `additionalModelRequestFields` payload
 * — mirroring kiro-cli's own behavior. It performs no I/O and holds no state.
 *
 * The level ordering and the two request-field shapes are taken verbatim from
 * kiro-cli so the wire payload matches what the backend expects. These are NOT
 * chat-path invariants owned by this repo; they are the management-plane
 * contract observed from the discovery schema.
 */

/** Which advertised schema path carries the effort enum. */
export type EffortSchemaPath = 'output_config' | 'reasoning'

export interface ModelEffort {
  /** Levels the model accepts, in the order Kiro lists them (weakest first). */
  readonly levels: string[]
  readonly schemaPath: EffortSchemaPath
  /** Level the backend applies when the field is omitted. */
  readonly defaultLevel?: string
}

/** Union ordering so unknown level names still rank sensibly (weakest first). */
const KNOWN_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract the `effort` field node for a given schema path, if present. */
function extractEffortField(
  schema: Record<string, unknown>,
  path: EffortSchemaPath
): Record<string, unknown> | undefined {
  const properties = schema.properties
  if (!isRecord(properties)) return undefined
  const container = properties[path]
  if (!isRecord(container)) return undefined
  const containerProps = container.properties
  if (!isRecord(containerProps)) return undefined
  const effort = containerProps.effort
  return isRecord(effort) ? effort : undefined
}

/**
 * Pull the effort levels + request-field path out of a model's advertised JSON
 * Schema. Order matters: `output_config` wins over `reasoning`, exactly like
 * kiro-cli. Returns undefined when the model advertises no effort knob.
 */
export function parseEffortLevels(schema: unknown): ModelEffort | undefined {
  if (!isRecord(schema)) return undefined
  const paths: EffortSchemaPath[] = ['output_config', 'reasoning']
  for (const path of paths) {
    const field = extractEffortField(schema, path)
    if (field === undefined) continue
    const { enum: enumValue, default: defaultValue } = field
    if (!Array.isArray(enumValue) || enumValue.length === 0) continue
    const levels = enumValue.filter((level): level is string => typeof level === 'string')
    if (levels.length === 0) continue
    return {
      levels,
      schemaPath: path,
      defaultLevel: typeof defaultValue === 'string' ? defaultValue : undefined
    }
  }
  return undefined
}

/**
 * Clamp a requested effort level to the closest supported level at or below the
 * request, using Kiro's own ordering. If the requested level sits below every
 * level on offer, the weakest supported level is used. Returns undefined when
 * the requested level is unknown or the model lists no rankable levels, so a
 * caller can skip the field entirely rather than send something invalid.
 */
export function resolveEffortLevel(effort: ModelEffort, requested: string): string | undefined {
  if (effort.levels.includes(requested)) return requested
  if (effort.levels.length === 0) return undefined

  const rank = (level: string): number => KNOWN_ORDER.indexOf(level as (typeof KNOWN_ORDER)[number])
  const wanted = rank(requested)
  if (wanted === -1) return undefined

  const ranked = effort.levels
    .map((level) => ({ level, rank: rank(level) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank)
  if (ranked.length === 0) return undefined

  let best = ranked[0]?.level
  for (const entry of ranked) {
    if (entry.rank <= wanted) best = entry.level
    else break
  }
  return best
}

/**
 * Build the `additionalModelRequestFields` payload for a resolved level,
 * mirroring kiro-cli's `buildEffortRequestFields`. The Claude path ships the
 * adaptive `thinking` block alongside `output_config`, exactly as kiro-cli does.
 */
export function buildEffortRequestFields(
  level: string,
  schemaPath: EffortSchemaPath
): Record<string, unknown> {
  switch (schemaPath) {
    case 'output_config':
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: level }
      }
    case 'reasoning':
      return { reasoning: { effort: level } }
  }
}
