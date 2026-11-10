import { describe, expect, test } from 'bun:test'
import {
  cloneKiroModelCatalog,
  KIRO_MODEL_CATALOG,
  type KiroModelDefinition
} from '../plugin/model-catalog.js'

describe('KIRO_MODEL_CATALOG', () => {
  test('contains one base entry per model (no exploded effort-suffix entries)', () => {
    const ids = Object.keys(KIRO_MODEL_CATALOG)
    // Base entries across every family remain.
    expect(ids).toContain('auto')
    expect(ids).toContain('claude-sonnet-4-5')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-sonnet-5')
    expect(ids).toContain('claude-haiku-4-5')
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-5')
    expect(ids).toContain('deepseek-3.2')
    expect(ids).toContain('glm-5')
    expect(ids).toContain('minimax-m2.5')
    expect(ids).toContain('minimax-m2.1')
    expect(ids).toContain('qwen3-coder-next')
    expect(ids).toContain('gpt-5.6-sol')
    expect(ids).toContain('gpt-5.6-terra')
    expect(ids).toContain('gpt-5.6-luna')
  })

  test('effort levels are expressed as variants, never as separate model ids', () => {
    const ids = Object.keys(KIRO_MODEL_CATALOG)
    const suffixed = ids.filter((id) => /-(low|medium|high|xhigh|max)$/.test(id))
    expect(suffixed).toEqual([])
    // The thinking suffix entry was dropped too.
    expect(ids).not.toContain('claude-opus-4-8-thinking')
  })

  test('effort-capable models carry the correct variant ladders', () => {
    // Sonnet 4.6 has no xhigh.
    expect(Object.keys(KIRO_MODEL_CATALOG['claude-sonnet-4-6']!.variants!)).toEqual([
      'low',
      'medium',
      'high',
      'max'
    ])
    // xhigh-capable models carry the full five-level ladder.
    for (const id of [
      'claude-sonnet-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ]) {
      expect(Object.keys(KIRO_MODEL_CATALOG[id]!.variants!)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max'
      ])
    }
    // Each variant carries its reasoningEffort option verbatim.
    expect(KIRO_MODEL_CATALOG['claude-opus-5']!.variants!.xhigh).toEqual({
      reasoningEffort: 'xhigh'
    })
  })

  test('non-effort models carry no variants', () => {
    for (const id of ['auto', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'deepseek-3.2', 'glm-5']) {
      expect(KIRO_MODEL_CATALOG[id]!.variants).toBeUndefined()
    }
  })

  test('every entry has a name, limit, and modalities', () => {
    for (const [id, def] of Object.entries(KIRO_MODEL_CATALOG)) {
      expect(typeof def.name, `${id}.name`).toBe('string')
      expect(def.name.length, `${id}.name non-empty`).toBeGreaterThan(0)
      expect(typeof def.limit.context, `${id}.limit.context`).toBe('number')
      expect(def.limit.output, `${id}.limit.output`).toBe(64000)
      expect(Array.isArray(def.modalities.input), `${id}.modalities.input`).toBe(true)
      expect(def.modalities.output, `${id}.modalities.output`).toEqual(['text'])
    }
  })

  test('preserves pdf input modality where documented', () => {
    expect(KIRO_MODEL_CATALOG['auto']!.modalities.input).toEqual(['text', 'image', 'pdf'])
    expect(KIRO_MODEL_CATALOG['claude-opus-5']!.modalities.input).toEqual(['text', 'image', 'pdf'])
    // Haiku is image but not pdf; open-weight + gpt are narrower.
    expect(KIRO_MODEL_CATALOG['claude-haiku-4-5']!.modalities.input).toEqual(['text', 'image'])
    expect(KIRO_MODEL_CATALOG['deepseek-3.2']!.modalities.input).toEqual(['text'])
    expect(KIRO_MODEL_CATALOG['gpt-5.6-sol']!.modalities.input).toEqual(['text', 'image'])
  })

  test('every model name carries the Kiro credit multiplier', () => {
    expect(KIRO_MODEL_CATALOG['gpt-5.6-luna']!.name).toBe('GPT 5.6 Luna (0.6x)')
    expect(KIRO_MODEL_CATALOG['claude-opus-5-5']!.name).toBe('Claude Opus 5.5 (2.0x)')
    expect(KIRO_MODEL_CATALOG['claude-haiku-5-5']!.name).toBe('Claude Haiku 5.5 (0.06x)')
    for (const [id, def] of Object.entries(KIRO_MODEL_CATALOG)) {
      expect({ id, hasMultiplier: /\(\d+(?:\.\d+)?x\)$/.test(def.name) }).toEqual({
        id,
        hasMultiplier: true
      })
    }
  })
})

describe('cloneKiroModelCatalog', () => {
  test('returns a deep copy equal in value to the source', () => {
    const clone = cloneKiroModelCatalog()
    expect(clone).toEqual(KIRO_MODEL_CATALOG)
  })

  test('mutating the clone does not corrupt the shared constant', () => {
    const clone = cloneKiroModelCatalog()
    const entry = clone['auto'] as KiroModelDefinition
    entry.name = 'MUTATED'
    entry.modalities.input.push('video')
    entry.limit.context = 1

    expect(KIRO_MODEL_CATALOG['auto']!.name).toBe('Auto (1.0x)')
    expect(KIRO_MODEL_CATALOG['auto']!.modalities.input).toEqual(['text', 'image', 'pdf'])
    expect(KIRO_MODEL_CATALOG['auto']!.limit.context).toBe(1000000)
  })

  test('two clones are independent of each other', () => {
    const a = cloneKiroModelCatalog()
    const b = cloneKiroModelCatalog()
    a['auto']!.name = 'A'
    expect(b['auto']!.name).toBe('Auto (1.0x)')
  })

  test('deep-copies variants so mutating a clone cannot corrupt the source', () => {
    const clone = cloneKiroModelCatalog()
    const opus5 = clone['claude-opus-5'] as KiroModelDefinition
    expect(opus5.variants).toBeDefined()
    opus5.variants!.xhigh!.reasoningEffort = 'MUTATED'
    delete opus5.variants!.max

    expect(KIRO_MODEL_CATALOG['claude-opus-5']!.variants!.xhigh).toEqual({
      reasoningEffort: 'xhigh'
    })
    expect(KIRO_MODEL_CATALOG['claude-opus-5']!.variants!.max).toEqual({ reasoningEffort: 'max' })
  })
})
