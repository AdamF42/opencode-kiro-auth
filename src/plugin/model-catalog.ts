export interface KiroModelVariant {
  reasoningEffort: string
}

export interface KiroModelDefinition {
  name: string
  limit: { context: number; output: number }
  modalities: { input: string[]; output: string[] }
  variants?: Record<string, KiroModelVariant>
}

export type KiroModelCatalog = Record<string, KiroModelDefinition>

/**
 * Build an OpenCode `variants` map from an ordered list of effort levels. Each
 * variant carries the `reasoningEffort` option the openai-compatible provider
 * forwards in the request body when that variant is selected via `variant_cycle`.
 */
export function buildVariants(levels: readonly string[]): Record<string, KiroModelVariant> {
  const variants: Record<string, KiroModelVariant> = {}
  for (const level of levels) {
    variants[level] = { reasoningEffort: level }
  }
  return variants
}

/** Effort levels for Claude Sonnet 4.6 (no xhigh). */
const SONNET_4_6_LEVELS = ['low', 'medium', 'high', 'max'] as const
/** Full five-level effort ladder for xhigh-capable models. */
const FULL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const KIRO_MODEL_CATALOG: KiroModelCatalog = {
  auto: {
    name: 'Auto (1.0x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  // Claude Sonnet
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0 (1.3x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5 (1.3x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (1.3x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: buildVariants(SONNET_4_6_LEVELS)
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5 (1.3x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5 (1.3x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  // Claude Haiku
  'claude-haiku-5-5': {
    name: 'Claude Haiku 5.5 (0.06x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5 (0.4x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] }
  },
  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5 (2.2x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'claude-opus-5': {
    name: 'Claude Opus 5 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5 (2.0x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2 (0.25x)',
    limit: { context: 128000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'glm-5': {
    name: 'GLM-5 (0.5x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'minimax-m2.5': {
    name: 'MiniMax M2.5 (0.25x)',
    limit: { context: 196000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1 (0.15x)',
    limit: { context: 196000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next (0.05x)',
    limit: { context: 256000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'gpt-5.6-sol': {
    name: 'GPT 5.6 Sol (4.4x)',
    limit: { context: 986000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'gpt-5.6-terra': {
    name: 'GPT 5.6 Terra (2.2x)',
    limit: { context: 986000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  },
  'gpt-5.6-luna': {
    name: 'GPT 5.6 Luna (0.6x)',
    limit: { context: 986000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: buildVariants(FULL_EFFORT_LEVELS)
  }
}

/**
 * Returns a fresh deep copy of the static model catalog so callers can mutate
 * the result (e.g. OpenCode's config hook assigns it into provider.models)
 * without corrupting the shared constant.
 */
export function cloneKiroModelCatalog(): KiroModelCatalog {
  const clone: KiroModelCatalog = {}
  for (const [modelID, def] of Object.entries(KIRO_MODEL_CATALOG)) {
    const cloned: KiroModelDefinition = {
      name: def.name,
      limit: { context: def.limit.context, output: def.limit.output },
      modalities: {
        input: [...def.modalities.input],
        output: [...def.modalities.output]
      }
    }
    if (def.variants) {
      const variants: Record<string, KiroModelVariant> = {}
      for (const [level, variant] of Object.entries(def.variants)) {
        variants[level] = { reasoningEffort: variant.reasoningEffort }
      }
      cloned.variants = variants
    }
    clone[modelID] = cloned
  }
  return clone
}
