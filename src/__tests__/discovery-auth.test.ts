import { describe, expect, mock, test } from 'bun:test'
import { resolveManagementAuth } from '../plugin/discovery/auth.js'
import { ModelDiscoveryError } from '../plugin/discovery/list-models.js'
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

function makeDeps(account: ManagedAccount | null, extra: Record<string, unknown> = {}) {
  const accounts = account ? [account] : []
  const toastCalls: Array<[string, string]> = []
  const refreshIfNeeded = mock(async (acc: ManagedAccount) => ({
    account: acc,
    shouldContinue: false
  }))
  return {
    deps: {
      selector: { selectHealthyAccount: mock(async () => account) },
      refresher: { refreshIfNeeded },
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
      showToast: (m: string, v: string) => {
        toastCalls.push([m, v])
      },
      ...extra
    },
    refreshIfNeeded,
    toastCalls
  }
}

describe('resolveManagementAuth', () => {
  test('resolves access/profileArn/region from the healthy account', async () => {
    const account = makeAccount()
    const { deps, refreshIfNeeded } = makeDeps(account)
    const auth = await resolveManagementAuth(deps as never)
    expect(auth.access).toBe('access-1')
    expect(auth.profileArn).toBe('arn:aws:codewhisperer:us-east-1:111:profile/ABC')
    expect(auth.region).toBe('us-east-1')
    expect(refreshIfNeeded).toHaveBeenCalledTimes(1)
  })

  test('reflects a rotated access token after refresh', async () => {
    const account = makeAccount()
    const rotated = makeAccount({ accessToken: 'access-2' })
    const { deps } = makeDeps(account, {
      accountManager: {
        toAuthDetails: (a: ManagedAccount) => ({ access: a.accessToken }) as never,
        getAccounts: () => [rotated]
      }
    })
    const auth = await resolveManagementAuth(deps as never)
    expect(auth.access).toBe('access-2')
  })

  test('maps the empty-store "No accounts" throw to a no-account discovery error', async () => {
    const { deps } = makeDeps(null, {
      selector: {
        selectHealthyAccount: mock(async () => {
          throw new Error('No accounts')
        })
      }
    })
    await expect(resolveManagementAuth(deps as never)).rejects.toMatchObject({
      kind: 'no-account'
    })
  })

  test('propagates other selector errors unchanged', async () => {
    const { deps } = makeDeps(null, {
      selector: {
        selectHealthyAccount: mock(async () => {
          throw new Error('Circuit breaker tripped')
        })
      }
    })
    await expect(resolveManagementAuth(deps as never)).rejects.toThrow('Circuit breaker tripped')
  })

  test('treats a null selection (transient backoff) as a network discovery error', async () => {
    const { deps } = makeDeps(null)
    const err = await resolveManagementAuth(deps as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ModelDiscoveryError)
    expect((err as ModelDiscoveryError).kind).toBe('network')
  })

  test('normalizes an invalid region to us-east-1', async () => {
    const account = makeAccount({ region: 'not-a-region' as never })
    const { deps } = makeDeps(account)
    const auth = await resolveManagementAuth(deps as never)
    expect(auth.region).toBe('us-east-1')
  })

  test('defaults a missing profileArn to empty string', async () => {
    const account = makeAccount({ profileArn: undefined })
    const { deps } = makeDeps(account)
    const auth = await resolveManagementAuth(deps as never)
    expect(auth.profileArn).toBe('')
  })
})
