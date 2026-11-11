import { describe, expect, test } from 'bun:test'
import { KIRO_MODEL_CATALOG } from '../plugin/model-catalog.js'
import { buildKiroProviderInfo, mapCatalogToModelInfo } from '../plugin/v2/model-mapper.js'

const PROVIDER_ID = 'kiro-auth'

describe('mapCatalogToModelInfo', () => {
  const models = mapCatalogToModelInfo(PROVIDER_ID)
  const byId = new Map(models.map((m) => [String(m.id), m]))

  test('maps every catalog entry', () => {
    expect(models.length).toBe(Object.keys(KIRO_MODEL_CATALOG).length)
  })

  test('sets id, modelID, providerID from catalog key', () => {
    const m = byId.get('claude-sonnet-5')
    expect(m).toBeDefined()
    expect(String(m!.id)).toBe('claude-sonnet-5')
    expect(String(m!.modelID)).toBe('claude-sonnet-5')
    expect(String(m!.providerID)).toBe(PROVIDER_ID)
  })

  test('preserves name and limits', () => {
    const m = byId.get('claude-sonnet-5')!
    expect(m.name).toBe('Claude Sonnet 5 (1.3x)')
    expect(m.limit.context).toBe(1_000_000)
    expect(m.limit.output).toBe(64_000)
  })

  test('preserves pdf input modality on claude families and auto', () => {
    for (const id of ['auto', 'claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-5']) {
      expect(byId.get(id)!.capabilities.input).toContain('pdf')
    }
  })

  test('haiku has text+image but no pdf', () => {
    const m = byId.get('claude-haiku-4-5')!
    expect(m.capabilities.input).toEqual(['text', 'image'])
  })

  test('open-weight models are text-only input', () => {
    for (const id of [
      'deepseek-3.2',
      'glm-5',
      'minimax-m2.5',
      'minimax-m2.1',
      'qwen3-coder-next'
    ]) {
      expect(byId.get(id)!.capabilities.input).toEqual(['text'])
    }
  })

  test('gpt families are text+image input', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(byId.get(id)!.capabilities.input).toEqual(['text', 'image'])
    }
  })

  test('effort-capable models are mapped as single base entries (no suffix ids)', () => {
    for (const id of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'gpt-5.6-sol',
      'gpt-5.6-luna'
    ]) {
      expect(byId.get(id)).toBeDefined()
    }
    // Exploded effort-suffix ids no longer exist in the catalog.
    for (const id of [
      'claude-sonnet-5-high',
      'claude-opus-5-max',
      'claude-opus-4-8-thinking',
      'gpt-5.6-sol-xhigh'
    ]) {
      expect(byId.get(id)).toBeUndefined()
    }
  })

  test('output modality is text and tools capability is true', () => {
    for (const m of models) {
      expect(m.capabilities.output).toEqual(['text'])
      expect(m.capabilities.tools).toBe(true)
    }
  })

  test('capability arrays are fresh copies, not aliased to the catalog', () => {
    const m = byId.get('claude-sonnet-5')!
    expect(m.capabilities.input).not.toBe(KIRO_MODEL_CATALOG['claude-sonnet-5']!.modalities.input)
  })

  test('maps effort levels to variants with reasoningEffort body overlay', () => {
    const m = byId.get('claude-opus-5')!
    expect(m.variants.map((v) => String(v.id))).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const v of m.variants) {
      expect(v.body).toEqual({ reasoningEffort: String(v.id) })
    }
  })

  test('4-level effort model omits xhigh variant', () => {
    const m = byId.get('claude-sonnet-4-6')!
    expect(m.variants.map((v) => String(v.id))).toEqual(['low', 'medium', 'high', 'max'])
  })

  test('models without catalog variants have no variants', () => {
    for (const id of ['auto', 'glm-5', 'claude-sonnet-4-5', 'deepseek-3.2']) {
      expect(byId.get(id)!.variants).toEqual([])
    }
  })
})

describe('buildKiroProviderInfo', () => {
  test('builds enabled Kiro provider with aisdk-prefixed openai-compatible package + baseURL', () => {
    const info = buildKiroProviderInfo(PROVIDER_ID, 'https://q.us-east-1.amazonaws.com')
    expect(String(info.id)).toBe(PROVIDER_ID)
    expect(info.name).toBe('Kiro')
    expect(info.activation).toBe('enabled')
    expect(info.package).toBe('aisdk:@ai-sdk/openai-compatible')
    expect(info.settings).toEqual({ baseURL: 'https://q.us-east-1.amazonaws.com' })
  })
})
