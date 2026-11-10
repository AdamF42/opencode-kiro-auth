import { describe, expect, mock, test } from 'bun:test'
import {
  DISCOVERY_FAILURE_PLACEHOLDER_ID,
  clearDiscoveryCache
} from '../plugin/discovery/catalog.js'
import type { DiscoveredModel } from '../plugin/discovery/list-models.js'
import {
  registerDiscoveredCatalog,
  resolveCatalogForRegistration
} from '../plugin/discovery/resolve-catalog.js'
import type { ManagedAccount } from '../plugin/types.js'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/ABC',
    refreshToken: 'refresh-1',
    accessToken: 'access-1',
    expiresAt: 2_000_000_000_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    ...overrides
  } as ManagedAccount
}

function makeAuthDeps(account: ManagedAccount | null) {
  const accounts = account ? [account] : []
  return {
    selector: {
      selectHealthyAccount: mock(async () => {
        // Mirror the real AccountSelector: an empty store throws 'No accounts'.
        if (account === null) throw new Error('No accounts')
        return account
      })
    },
    refresher: {
      refreshIfNeeded: mock(async (acc: ManagedAccount) => ({
        account: acc,
        shouldContinue: false
      }))
    },
    accountManager: {
      toAuthDetails: (a: ManagedAccount) =>
        ({
          refresh: 'enc',
          access: a.accessToken,
          expires: a.expiresAt,
          authMethod: a.authMethod,
          region: a.region,
          profileArn: a.profileArn
        }) as never,
      getAccounts: () => accounts
    },
    showToast: () => {}
  }
}

function makeFetch(models: DiscoveredModel[]) {
  return mock(
    async () =>
      new Response(JSON.stringify({ models }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )
}

const neverTimeout = (): AbortSignal => new AbortController().signal

describe('resolveCatalogForRegistration', () => {
  test('returns the live catalog on success', async () => {
    clearDiscoveryCache()
    const result = await resolveCatalogForRegistration({
      auth: makeAuthDeps(makeAccount()),
      discovery: {
        fetch: makeFetch([
          { modelId: 'claude-sonnet-5', modelName: 'Claude Sonnet 5' },
          { modelId: 'gpt-5.6-sol', modelName: 'GPT 5.6 Sol' }
        ]) as unknown as typeof fetch,
        timeoutSignal: neverTimeout
      }
    })

    expect(result.discovered).toBe(true)
    expect(result.failureMessage).toBeUndefined()
    // auto is always seeded, plus the two live models.
    expect(Object.keys(result.catalog).sort()).toEqual(
      ['auto', 'claude-sonnet-5', 'gpt-5.6-sol'].sort()
    )
    expect(result.catalog[DISCOVERY_FAILURE_PLACEHOLDER_ID]).toBeUndefined()
  })

  test('treats no-account as a benign warning: only auto, NO failure placeholder', async () => {
    clearDiscoveryCache()
    const result = await resolveCatalogForRegistration({
      auth: makeAuthDeps(null),
      discovery: { fetch: makeFetch([]) as unknown as typeof fetch, timeoutSignal: neverTimeout }
    })

    expect(result.discovered).toBe(false)
    expect(result.failureSeverity).toBe('warning')
    expect(result.failureMessage).toContain('no authenticated account')
    // User story 11: register a usable `auto` so the user can sign in after.
    // There must be NO failure placeholder for the benign pre-auth state.
    expect(Object.keys(result.catalog)).toEqual(['auto'])
    expect(result.catalog[DISCOVERY_FAILURE_PLACEHOLDER_ID]).toBeUndefined()
    expect(result.catalog.auto?.name).toBe('Auto (1.0x)')
  })

  test('falls back with an HTTP placeholder + error severity on an auth rejection', async () => {
    clearDiscoveryCache()
    const failFetch = mock(
      async () => new Response('nope', { status: 403, headers: { 'x-amzn-requestid': 'req-xyz' } })
    )
    const result = await resolveCatalogForRegistration({
      auth: makeAuthDeps(makeAccount()),
      discovery: { fetch: failFetch as unknown as typeof fetch, timeoutSignal: neverTimeout }
    })

    expect(result.discovered).toBe(false)
    expect(result.failureSeverity).toBe('error')
    expect(result.catalog[DISCOVERY_FAILURE_PLACEHOLDER_ID]?.name).toContain('auth')
    expect(result.failureMessage).toContain('request id req-xyz')
  })
})

describe('registerDiscoveredCatalog', () => {
  test('returns the live catalog and emits no toast on success', async () => {
    clearDiscoveryCache()
    const toasts: Array<{ message: string; variant: string }> = []
    const catalog = await registerDiscoveredCatalog(
      {
        auth: makeAuthDeps(makeAccount()),
        discovery: {
          fetch: makeFetch([
            { modelId: 'claude-sonnet-5', modelName: 'Claude Sonnet 5' }
          ]) as unknown as typeof fetch,
          timeoutSignal: neverTimeout
        }
      },
      (message, variant) => {
        toasts.push({ message, variant })
      }
    )

    expect(Object.keys(catalog).sort()).toEqual(['auto', 'claude-sonnet-5'].sort())
    expect(toasts).toHaveLength(0)
  })

  test('forwards a benign no-account warning to the toast surface', async () => {
    clearDiscoveryCache()
    const toasts: Array<{ message: string; variant: string }> = []
    const catalog = await registerDiscoveredCatalog(
      {
        auth: makeAuthDeps(null),
        discovery: { fetch: makeFetch([]) as unknown as typeof fetch, timeoutSignal: neverTimeout }
      },
      (message, variant) => {
        toasts.push({ message, variant })
      }
    )

    expect(Object.keys(catalog)).toEqual(['auto'])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toContain('no authenticated account')
  })

  test('forwards a genuine failure at error severity', async () => {
    clearDiscoveryCache()
    const failFetch = mock(
      async () => new Response('nope', { status: 403, headers: { 'x-amzn-requestid': 'req-xyz' } })
    )
    const toasts: Array<{ message: string; variant: string }> = []
    const catalog = await registerDiscoveredCatalog(
      {
        auth: makeAuthDeps(makeAccount()),
        discovery: { fetch: failFetch as unknown as typeof fetch, timeoutSignal: neverTimeout }
      },
      (message, variant) => {
        toasts.push({ message, variant })
      }
    )

    expect(catalog[DISCOVERY_FAILURE_PLACEHOLDER_ID]?.name).toContain('auth')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe('error')
  })
})
