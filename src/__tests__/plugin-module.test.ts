import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro-auth provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro-auth')
  })

  test('exposes a v2 setup function', () => {
    expect(typeof pluginModule.setup).toBe('function')
  })

  test('exposes a v1 server capability alongside the v2 setup', () => {
    expect(typeof pluginModule.server).toBe('function')
  })
})
