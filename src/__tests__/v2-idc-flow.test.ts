import { describe, expect, mock, test } from 'bun:test'
import { createIdcAuthFlow } from '../plugin/v2/idc-flow.js'

// We stub IdcAuthMethod indirectly: createIdcAuthFlow constructs one internally,
// so we exercise the recover-tokens widening via the repository + a fake
// authorize by monkeypatching the prototype. Simpler: test recoverTokens
// behavior through the public flow using a repository whose findAll returns the
// just-saved account. We fake IdcAuthMethod.authorize by replacing it on the
// instance via a subclass hook is not exposed, so instead we validate the flow
// against a real IdcAuthMethod would require network — therefore this suite
// focuses on the token-widening contract through a seam we DO control: the
// repository. To isolate, we spy on IdcAuthMethod via module mock.

import * as idcModule from '../core/auth/idc-auth-method.js'

function makeConfig(): any {
  return { idc_start_url: undefined, idc_region: 'us-east-1', idc_profile_arn: undefined }
}

function makeRepository(accounts: any[]): any {
  return {
    findAll: mock(async () => accounts),
    save: mock(async () => {})
  }
}

function makeAccountManager(): any {
  return { addAccount: mock(() => {}), getAccounts: mock(() => []) }
}

describe('createIdcAuthFlow', () => {
  test('widens a v1 success into the full token set via the repository', async () => {
    const savedAccount = {
      accessToken: 'access-xyz',
      refreshToken: 'refresh-abc',
      expiresAt: 1_900_000_000_000
    }
    const repository = makeRepository([savedAccount])

    // Patch the IdcAuthMethod prototype's authorize to a canned success flow.
    const authorizeSpy = mock(async () => ({
      url: 'https://device.verify/abc',
      instructions: 'Enter code ABCD',
      method: 'auto' as const,
      callback: async () => ({ type: 'success' as const, key: 'access-xyz' })
    }))
    const original = idcModule.IdcAuthMethod.prototype.authorize
    idcModule.IdcAuthMethod.prototype.authorize = authorizeSpy as never

    try {
      const flow = createIdcAuthFlow(makeConfig(), repository, makeAccountManager())
      const authorization = await flow({ start_url: 'https://corp.awsapps.com/start' })
      expect(authorization.url).toBe('https://device.verify/abc')
      expect(authorization.method).toBe('auto')
      const result = await (authorization.method === 'auto'
        ? authorization.callback()
        : authorization.callback(''))
      expect(result.type).toBe('success')
      if (result.type === 'success') {
        expect(result.key).toBe('access-xyz')
        expect(result.access).toBe('access-xyz')
        expect(result.refresh).toBe('refresh-abc')
        expect(result.expires).toBe(1_900_000_000_000)
      }
      expect(repository.findAll).toHaveBeenCalled()
    } finally {
      idcModule.IdcAuthMethod.prototype.authorize = original
    }
  })

  test('propagates a v1 failure as a failed result', async () => {
    const repository = makeRepository([])
    const authorizeSpy = mock(async () => ({
      url: '',
      instructions: 'failed',
      method: 'auto' as const,
      callback: async () => ({ type: 'failed' as const })
    }))
    const original = idcModule.IdcAuthMethod.prototype.authorize
    idcModule.IdcAuthMethod.prototype.authorize = authorizeSpy as never

    try {
      const flow = createIdcAuthFlow(makeConfig(), repository, makeAccountManager())
      const authorization = await flow({})
      const result = await (authorization.method === 'auto'
        ? authorization.callback()
        : authorization.callback(''))
      expect(result.type).toBe('failed')
    } finally {
      idcModule.IdcAuthMethod.prototype.authorize = original
    }
  })

  test('fails cleanly when the saved account cannot be recovered', async () => {
    const repository = makeRepository([]) // nothing saved
    const authorizeSpy = mock(async () => ({
      url: 'https://device.verify/abc',
      instructions: 'Enter code',
      method: 'auto' as const,
      callback: async () => ({ type: 'success' as const, key: 'access-missing' })
    }))
    const original = idcModule.IdcAuthMethod.prototype.authorize
    idcModule.IdcAuthMethod.prototype.authorize = authorizeSpy as never

    try {
      const flow = createIdcAuthFlow(makeConfig(), repository, makeAccountManager())
      const authorization = await flow({})
      const result = await (authorization.method === 'auto'
        ? authorization.callback()
        : authorization.callback(''))
      expect(result.type).toBe('failed')
    } finally {
      idcModule.IdcAuthMethod.prototype.authorize = original
    }
  })

  test('fails when the matched account has no refresh token', async () => {
    const repository = makeRepository([
      { accessToken: 'access-xyz', refreshToken: '', expiresAt: 1_900_000_000_000 }
    ])
    const authorizeSpy = mock(async () => ({
      url: 'https://device.verify/abc',
      instructions: 'Enter code',
      method: 'auto' as const,
      callback: async () => ({ type: 'success' as const, key: 'access-xyz' })
    }))
    const original = idcModule.IdcAuthMethod.prototype.authorize
    idcModule.IdcAuthMethod.prototype.authorize = authorizeSpy as never

    try {
      const flow = createIdcAuthFlow(makeConfig(), repository, makeAccountManager())
      const authorization = await flow({})
      const result = await (authorization.method === 'auto'
        ? authorization.callback()
        : authorization.callback(''))
      expect(result.type).toBe('failed')
    } finally {
      idcModule.IdcAuthMethod.prototype.authorize = original
    }
  })

  test('does NOT fall back to a different account when the exact token is absent', async () => {
    // A healthy OTHER account exists, but its access token does not match the
    // one the flow just minted. The old fuzzy fallback would have returned this
    // account's refresh token; the exact-match contract must reject instead.
    const repository = makeRepository([
      { accessToken: 'someone-else', refreshToken: 'other-refresh', expiresAt: 9_999_999_999_999 }
    ])
    const authorizeSpy = mock(async () => ({
      url: 'https://device.verify/abc',
      instructions: 'Enter code',
      method: 'auto' as const,
      callback: async () => ({ type: 'success' as const, key: 'access-just-minted' })
    }))
    const original = idcModule.IdcAuthMethod.prototype.authorize
    idcModule.IdcAuthMethod.prototype.authorize = authorizeSpy as never

    try {
      const flow = createIdcAuthFlow(makeConfig(), repository, makeAccountManager())
      const authorization = await flow({})
      const result = await (authorization.method === 'auto'
        ? authorization.callback()
        : authorization.callback(''))
      expect(result.type).toBe('failed')
    } finally {
      idcModule.IdcAuthMethod.prototype.authorize = original
    }
  })
})
