import { afterEach, describe, expect, test } from 'bun:test'
import {
  hashDiagnosticIdentity,
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_MESSAGE_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_REQUEST_KIND_HEADER
} from '../core/request/request-kind.js'
import { __getActiveKeepAliveControllerForTest, createKiroPlugin } from '../plugin.js'

const PROVIDER_ID = 'kiro-auth'

function makeFakeClient() {
  const toasts: Array<{ message: string; variant: string }> = []
  return {
    toasts,
    client: {
      tui: {
        showToast: async (arg: any) => {
          toasts.push({ message: arg.body.message, variant: arg.body.variant })
          return { data: {} }
        }
      }
    }
  }
}

afterEach(() => {
  __getActiveKeepAliveControllerForTest()?.dispose()
})

async function initPlugin() {
  const { client } = makeFakeClient()
  const plugin = await createKiroPlugin(PROVIDER_ID)({ client, directory: process.cwd() })
  return plugin
}

describe('config hook', () => {
  test('sets npm to @ai-sdk/openai-compatible and api to the region base URL', async () => {
    const plugin = await initPlugin()
    const input: any = {}
    await plugin.config(input)

    expect(input.provider[PROVIDER_ID].npm).toBe('@ai-sdk/openai-compatible')
    expect(input.provider[PROVIDER_ID].api).toBe('https://runtime.us-east-1.kiro.dev')
  })

  test('never advertises the full static catalog and always keeps auto selectable', async () => {
    // Live discovery runs against the shared account layer / kiro.db singleton,
    // whose state is NOT deterministic across the suite (AGENTS.md §5), so we do
    // NOT assert on the discovery outcome (live vs minimal vs placeholder) here.
    // The invariant that must hold regardless of DB state: the config hook never
    // falls back to the full static catalog (no unconfirmed wire id leaks), and
    // `auto` is always present and selectable (not renamed). The deterministic
    // no-account / failure-severity behavior is covered by the pure seam in
    // discovery-resolve-catalog.test.ts.
    const plugin = await initPlugin()
    const input: any = {}
    await plugin.config(input)

    const models = input.provider[PROVIDER_ID].models
    const auto = models.auto
    expect(auto).toBeDefined()
    expect(auto.name).toBe('Auto (1.0x)')
    expect(auto.limit).toEqual({ context: 1000000, output: 64000 })
    // The static catalog's hardcoded ids must NEVER leak into the registered map.
    expect(models['claude-sonnet-4-5']).toBeUndefined()
    expect(models['claude-opus-5']).toBeUndefined()
  })

  test('only ever surfaces a discovery toast, never an uncategorized failure', async () => {
    // Again DB-state-independent: whatever discovery does, the config hook must
    // not throw and must leave a usable provider block. If a toast fires it is a
    // discovery warning/error (kind-dependent severity is unit-tested at the
    // pure seam); the hook must never crash startup.
    const { client } = makeFakeClient()
    const plugin = await createKiroPlugin(PROVIDER_ID)({ client, directory: process.cwd() })
    const input: any = {}
    await plugin.config(input)

    expect(input.provider[PROVIDER_ID].npm).toBe('@ai-sdk/openai-compatible')
    expect(input.provider[PROVIDER_ID].models.auto).toBeDefined()
  })

  test('does not overwrite a user-defined api or models block', async () => {
    const plugin = await initPlugin()
    const input: any = {
      provider: {
        [PROVIDER_ID]: {
          api: 'https://custom.example.com',
          models: { 'my-model': { name: 'Custom' } }
        }
      }
    }
    await plugin.config(input)

    expect(input.provider[PROVIDER_ID].api).toBe('https://custom.example.com')
    expect(input.provider[PROVIDER_ID].models).toEqual({ 'my-model': { name: 'Custom' } })
    // npm is always forced regardless of user overrides
    expect(input.provider[PROVIDER_ID].npm).toBe('@ai-sdk/openai-compatible')
  })
})

describe('auth hook', () => {
  test('provider matches the plugin id and methods is an array', async () => {
    const plugin = await initPlugin()
    expect(plugin.auth.provider).toBe(PROVIDER_ID)
    expect(Array.isArray(plugin.auth.methods)).toBe(true)
  })

  test('loader returns baseURL, empty apiKey, and a fetch function', async () => {
    const plugin = await initPlugin()
    const getAuth = async () => ({})
    const loaded = await plugin.auth.loader(getAuth)

    expect(loaded.apiKey).toBe('')
    expect(loaded.baseURL).toBe('https://runtime.us-east-1.kiro.dev')
    expect(typeof loaded.fetch).toBe('function')
  })
})

describe('provider hook', () => {
  test('normalizes each model to add api.npm and api.url fallback', async () => {
    const plugin = await initPlugin()
    const normalized = await plugin.provider.models({
      models: {
        'claude-sonnet-4-5': { name: 'Sonnet' }
      }
    })

    expect(normalized['claude-sonnet-4-5'].api.npm).toBe('@ai-sdk/openai-compatible')
    expect(normalized['claude-sonnet-4-5'].api.url).toBe('https://runtime.us-east-1.kiro.dev')
    expect(normalized['claude-sonnet-4-5'].name).toBe('Sonnet')
  })

  test('preserves an already-set model api.url', async () => {
    const plugin = await initPlugin()
    const normalized = await plugin.provider.models({
      models: {
        m: { name: 'M', api: { url: 'https://explicit.example.com' } }
      }
    })
    expect(normalized.m.api.url).toBe('https://explicit.example.com')
    expect(normalized.m.api.npm).toBe('@ai-sdk/openai-compatible')
  })

  test('empty provider.models -> empty normalized map', async () => {
    const plugin = await initPlugin()
    expect(await plugin.provider.models({ models: {} })).toEqual({})
    expect(await plugin.provider.models({})).toEqual({})
  })

  test('provider hook id matches the plugin id', async () => {
    const plugin = await initPlugin()
    expect(plugin.provider.id).toBe(PROVIDER_ID)
  })
})

describe('chat.headers hook', () => {
  test('marks only kiro-auth compaction requests', async () => {
    const plugin = await initPlugin()
    const hook = (plugin as any)['chat.headers']
    expect(typeof hook).toBe('function')

    const compaction = { headers: {} as Record<string, string> }
    await hook(
      {
        agent: 'compaction',
        model: { providerID: PROVIDER_ID },
        provider: { info: { id: PROVIDER_ID } }
      },
      compaction
    )
    expect(compaction.headers[KIRO_REQUEST_KIND_HEADER]).toBe('compaction')

    const normal = { headers: {} as Record<string, string> }
    await hook(
      {
        agent: 'build',
        model: { providerID: PROVIDER_ID },
        provider: { info: { id: PROVIDER_ID } }
      },
      normal
    )
    expect(normal.headers).toEqual({})

    const otherProvider = { headers: {} as Record<string, string> }
    await hook(
      {
        agent: 'compaction',
        model: { providerID: 'other-provider' },
        provider: { info: { id: 'other-provider' } }
      },
      otherProvider
    )
    expect(otherProvider.headers).toEqual({})
  })

  test('verbose diagnostics attach only hashed OpenCode correlation identities', async () => {
    const previous = process.env.KIRO_DIAGNOSTIC_LOG_LEVEL
    process.env.KIRO_DIAGNOSTIC_LOG_LEVEL = 'verbose'
    let plugin: Awaited<ReturnType<typeof initPlugin>>
    try {
      plugin = await initPlugin()
    } finally {
      if (previous === undefined) delete process.env.KIRO_DIAGNOSTIC_LOG_LEVEL
      else process.env.KIRO_DIAGNOSTIC_LOG_LEVEL = previous
    }
    const hook = (plugin as any)['chat.headers']
    const output = { headers: {} as Record<string, string> }

    await hook(
      {
        sessionID: 'ses-private-correlation',
        agent: 'private-build-agent',
        message: { id: 'msg-private-correlation' },
        model: { providerID: PROVIDER_ID },
        provider: { info: { id: PROVIDER_ID } }
      },
      output
    )

    expect(output.headers[KIRO_DIAGNOSTIC_TRACE_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(output.headers[KIRO_DIAGNOSTIC_SESSION_HEADER]).toBe(
      hashDiagnosticIdentity('ses-private-correlation')
    )
    expect(output.headers[KIRO_DIAGNOSTIC_AGENT_HEADER]).toBe(
      hashDiagnosticIdentity('private-build-agent')
    )
    expect(output.headers[KIRO_DIAGNOSTIC_MESSAGE_HEADER]).toBe(
      hashDiagnosticIdentity('msg-private-correlation')
    )
    const serialized = JSON.stringify(output.headers)
    expect(serialized).not.toContain('ses-private-correlation')
    expect(serialized).not.toContain('private-build-agent')
    expect(serialized).not.toContain('msg-private-correlation')

    const otherProvider = { headers: {} as Record<string, string> }
    await hook(
      {
        sessionID: 'ses-private-correlation',
        agent: 'private-build-agent',
        message: { id: 'msg-private-correlation' },
        model: { providerID: 'other-provider' },
        provider: { info: { id: 'other-provider' } }
      },
      otherProvider
    )
    expect(otherProvider.headers).toEqual({})
  })
})

describe('keep-alive singleton guard', () => {
  test('disposes the previous controller when the plugin is initialized twice', async () => {
    await initPlugin()
    const firstController = __getActiveKeepAliveControllerForTest()
    expect(firstController).not.toBeNull()
    if (!firstController) {
      throw new Error('Expected first keep-alive controller to be installed')
    }
    expect(firstController['disposed']).toBe(false)

    await initPlugin()
    const secondController = __getActiveKeepAliveControllerForTest()
    expect(secondController).not.toBeNull()
    if (!secondController) {
      throw new Error('Expected second keep-alive controller to be installed')
    }

    expect(secondController).not.toBe(firstController)
    expect(firstController['disposed']).toBe(true)
    expect(firstController['initialDelayTimer']).toBeNull()
    expect(firstController['intervalTimer']).toBeNull()
    expect(secondController['disposed']).toBe(false)
  })
})
