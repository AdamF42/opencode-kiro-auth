import { describe, expect, mock, test } from 'bun:test'

type InitCall = { showToast?: (m: string, v: string) => void; opts?: { syncKiroCli?: boolean } }

/**
 * The TUI entry (`src/tui.ts`) is the only v2 surface with a real toast. These
 * tests mock the shared core so we can assert the wiring without opening a DB:
 * showToast must forward to ctx.ui.toast.show, and initialize must be called
 * with { syncKiroCli: false } so the server entry stays the sole sync owner.
 */
function loadTuiEntry() {
  const initCalls: InitCall[] = []
  let disposeCount = 0
  const createCalls: Array<{ directory: string }> = []

  mock.module('../plugin/core.js', () => ({
    createKiroCore: async (directory: string, _opts: unknown) => {
      createCalls.push({ directory })
      return {
        authHandler: {
          initialize: (
            showToast?: (m: string, v: string) => void,
            opts?: { syncKiroCli?: boolean }
          ) => {
            initCalls.push({ showToast, opts })
          }
        }
      }
    },
    disposeActiveKeepAliveController: () => {
      disposeCount++
    }
  }))

  return { initCalls, createCalls, dispose: () => disposeCount }
}

describe('tui entry', () => {
  test('wires showToast to ctx.ui.toast.show and skips kiro-cli sync', async () => {
    const { initCalls, createCalls } = loadTuiEntry()
    const mod = await import('../tui.js')
    const definition = mod.default

    expect(definition.id).toBe('kiro-auth-tui')

    const shown: Array<{ message: string; variant?: string }> = []
    const ctx = {
      location: { directory: '/tmp/project' },
      ui: {
        toast: {
          show: (options: { message: string; variant?: string }) => {
            shown.push(options)
          }
        }
      }
    }

    const cleanup = await definition.setup(ctx as never)

    expect(createCalls).toEqual([{ directory: '/tmp/project' }])
    expect(initCalls).toHaveLength(1)
    expect(initCalls[0]?.opts).toEqual({ syncKiroCli: false })

    // The showToast passed into initialize must forward to the TUI toast.
    initCalls[0]?.showToast?.('Kiro usage (x@y): 1/10 (10%)', 'info')
    expect(shown).toEqual([{ message: 'Kiro usage (x@y): 1/10 (10%)', variant: 'info' }])

    expect(typeof cleanup).toBe('function')
  })

  test('returns without building a core when location is undefined', async () => {
    const { initCalls, createCalls } = loadTuiEntry()
    const mod = await import('../tui.js')
    const definition = mod.default

    const ctx = {
      location: undefined,
      ui: { toast: { show: () => {} } }
    }

    const cleanup = await definition.setup(ctx as never)

    expect(createCalls).toEqual([])
    expect(initCalls).toEqual([])
    expect(cleanup).toBeUndefined()
  })
})
