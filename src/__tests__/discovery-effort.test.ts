import { describe, expect, test } from 'bun:test'
import {
  buildEffortRequestFields,
  parseEffortLevels,
  resolveEffortLevel,
  type ModelEffort
} from '../plugin/discovery/effort.js'

const claudeSchema = {
  properties: {
    output_config: {
      properties: {
        effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }
      }
    }
  }
}

const gptSchema = {
  properties: {
    reasoning: {
      properties: {
        effort: { enum: ['none', 'minimal', 'low', 'medium', 'high'], default: 'medium' }
      }
    }
  }
}

describe('parseEffortLevels', () => {
  test('reads the Claude output_config.effort path', () => {
    const effort = parseEffortLevels(claudeSchema)
    expect(effort).toBeDefined()
    expect(effort?.schemaPath).toBe('output_config')
    expect(effort?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effort?.defaultLevel).toBe('high')
  })

  test('reads the GPT reasoning.effort path', () => {
    const effort = parseEffortLevels(gptSchema)
    expect(effort?.schemaPath).toBe('reasoning')
    expect(effort?.levels).toEqual(['none', 'minimal', 'low', 'medium', 'high'])
    expect(effort?.defaultLevel).toBe('medium')
  })

  test('output_config wins over reasoning when both are present', () => {
    const both = {
      properties: {
        output_config: { properties: { effort: { enum: ['high', 'max'] } } },
        reasoning: { properties: { effort: { enum: ['low', 'medium'] } } }
      }
    }
    expect(parseEffortLevels(both)?.schemaPath).toBe('output_config')
  })

  test('returns undefined for a schema without an effort knob', () => {
    expect(parseEffortLevels({ properties: { foo: { properties: {} } } })).toBeUndefined()
    expect(parseEffortLevels(undefined)).toBeUndefined()
    expect(parseEffortLevels('nope')).toBeUndefined()
    expect(
      parseEffortLevels({ properties: { output_config: { properties: { effort: { enum: [] } } } } })
    ).toBeUndefined()
  })

  test('drops non-string enum members', () => {
    const schema = {
      properties: { reasoning: { properties: { effort: { enum: ['low', 3, null, 'high'] } } } }
    }
    expect(parseEffortLevels(schema)?.levels).toEqual(['low', 'high'])
  })
})

describe('resolveEffortLevel', () => {
  const claude: ModelEffort = {
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    schemaPath: 'output_config'
  }
  const noXhigh: ModelEffort = {
    levels: ['low', 'medium', 'high', 'max'],
    schemaPath: 'output_config'
  }

  test('passes through a directly supported level', () => {
    expect(resolveEffortLevel(claude, 'high')).toBe('high')
  })

  test('clamps down to the closest supported level at or below the request', () => {
    // xhigh not supported -> closest <= xhigh is high (max ranks above xhigh)
    expect(resolveEffortLevel(noXhigh, 'xhigh')).toBe('high')
  })

  test('uses the weakest level when the request is below everything', () => {
    const strongOnly: ModelEffort = { levels: ['high', 'max'], schemaPath: 'output_config' }
    expect(resolveEffortLevel(strongOnly, 'low')).toBe('high')
  })

  test('returns undefined for an unknown requested level', () => {
    expect(resolveEffortLevel(claude, 'turbo')).toBeUndefined()
  })

  test('returns undefined when the model lists no levels', () => {
    expect(resolveEffortLevel({ levels: [], schemaPath: 'reasoning' }, 'high')).toBeUndefined()
  })
})

describe('buildEffortRequestFields', () => {
  test('output_config ships the adaptive thinking block', () => {
    expect(buildEffortRequestFields('high', 'output_config')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' }
    })
  })

  test('reasoning ships only the reasoning effort', () => {
    expect(buildEffortRequestFields('medium', 'reasoning')).toEqual({
      reasoning: { effort: 'medium' }
    })
  })
})
