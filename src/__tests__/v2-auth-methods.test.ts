import { describe, expect, test } from 'bun:test'
import {
  buildKiroIntegrationMethods,
  KIRO_INTEGRATION_ID,
  type V1IdcAuthorization,
  type V1IdcCallbackResult
} from '../plugin/v2/auth-methods.js'

// buildKiroIntegrationMethods is a PURE builder: it adapts the v1 IDC device
// flow (injected as deps.authorize) into v2 integration OAuth method
// registrations. These tests use a FAKE flow returning canned tokens, so no
// real device-code polling, browser, or network happens.

function fakeAutoAuthorization(
  callbackResult: V1IdcCallbackResult,
  overrides: Partial<Pick<V1IdcAuthorization, 'url' | 'instructions' | 'expiresAt'>> = {}
): V1IdcAuthorization {
  return {
    url: 'https://device.example/verify?code=USER-CODE',
    instructions: 'Open the verification URL and complete sign-in.\nCode: USER-CODE',
    method: 'auto',
    callback: async () => callbackResult,
    ...overrides
  }
}

const SUCCESS: V1IdcCallbackResult = {
  type: 'success',
  key: 'access-tok',
  access: 'access-tok',
  refresh: 'refresh-tok',
  expires: 1_900_000_000_000
}

describe('buildKiroIntegrationMethods — registration shape', () => {
  test('returns exactly the two add-account methods on integration kiro-auth', () => {
    const methods = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS)
    })

    expect(methods).toHaveLength(2)
    for (const reg of methods) {
      expect(reg.integrationID).toBe(KIRO_INTEGRATION_ID)
      expect(reg.integrationID).toBe('kiro-auth')
      expect(reg.method.type).toBe('oauth')
      expect(typeof reg.authorize).toBe('function')
    }

    const [idc, idcProfile] = methods
    expect(idc!.method.id).toBe('kiro-auth:idc')
    expect(idcProfile!.method.id).toBe('kiro-auth:idc-profile-arn')
  })

  test('method 0 (Builder ID / IDC) prompts for start_url and idc_region only', () => {
    const [idc] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS)
    })
    const keys = (idc!.method.form ?? []).map((f) => f.key)
    expect(keys).toEqual(['start_url', 'idc_region'])
    for (const f of idc!.method.form ?? []) expect(f.type).toBe('string')
  })

  test('method 1 (IDC + Profile ARN) adds a profile_arn prompt', () => {
    const [, idcProfile] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS)
    })
    const keys = (idcProfile!.method.form ?? []).map((f) => f.key)
    expect(keys).toEqual(['start_url', 'idc_region', 'profile_arn'])
  })

  test('config echoes enrich prompt copy and make profile_arn optional when preset', () => {
    const [, idcProfile] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS),
      config: {
        idc_start_url: 'https://acme.awsapps.com/start',
        idc_region: 'eu-central-1',
        idc_profile_arn: 'arn:aws:codewhisperer:eu-central-1:1:profile/ABC'
      }
    })
    const form = idcProfile!.method.form ?? []
    const start = form.find((f) => f.key === 'start_url')!
    const region = form.find((f) => f.key === 'idc_region')!
    const profile = form.find((f) => f.key === 'profile_arn')!
    expect(start.description).toContain('acme.awsapps.com/start')
    expect(region.description).toContain('eu-central-1')
    expect(profile.type).toBe('string')
    if (profile.type !== 'string') throw new Error('expected string field')
    expect(profile.required).toBe(false)
    expect(profile.description).toContain('arn:aws:codewhisperer:eu-central-1:1:profile/ABC')
  })

  test('profile_arn is required when no config default is present', () => {
    const [, idcProfile] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS)
    })
    const profile = (idcProfile!.method.form ?? []).find((f) => f.key === 'profile_arn')!
    expect(profile.type).toBe('string')
    if (profile.type !== 'string') throw new Error('expected string field')
    expect(profile.required).toBe(true)
  })
})

describe('buildKiroIntegrationMethods — authorize adapts v1 -> v2', () => {
  test('mode auto: callback is a Promise that resolves a Credential.OAuth', async () => {
    const [idc] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS)
    })

    const authz = await idc!.authorize({})
    expect(authz.url).toBe('https://device.example/verify?code=USER-CODE')
    expect(authz.instructions).toContain('USER-CODE')
    expect(authz.mode).toBe('auto')
    if (authz.mode !== 'auto') throw new Error('expected auto mode')

    const cred = await authz.callback
    expect(cred.type).toBe('oauth')
    expect(String(cred.methodID)).toBe('kiro-auth:idc')
    expect(cred.access).toBe('access-tok')
    expect(cred.refresh).toBe('refresh-tok')
    expect(cred.expires).toBe(1_900_000_000_000)
  })

  test('mode code: callback wraps the v1 code callback and resolves Credential.OAuth', async () => {
    let receivedCode: string | undefined
    const codeFlow: V1IdcAuthorization = {
      url: 'https://device.example/verify',
      instructions: 'Paste the code',
      method: 'code',
      callback: async (code: string) => {
        receivedCode = code
        return SUCCESS
      }
    }
    const [idc] = buildKiroIntegrationMethods({ authorize: async () => codeFlow })

    const authz = await idc!.authorize({})
    expect(authz.mode).toBe('code')
    if (authz.mode !== 'code') throw new Error('expected code mode')

    const cred = await authz.callback('THE-CODE')
    expect(receivedCode).toBe('THE-CODE')
    expect(cred.type).toBe('oauth')
    expect(String(cred.methodID)).toBe('kiro-auth:idc')
    expect(cred.access).toBe('access-tok')
  })

  test('a {type:"failed"} auto result rejects so the host surfaces failure', async () => {
    const [idc] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization({ type: 'failed' })
    })

    const authz = await idc!.authorize({})
    if (authz.mode !== 'auto') throw new Error('expected auto mode')
    await expect(authz.callback).rejects.toThrow('Kiro IDC authorization failed')
  })

  test('a {type:"failed"} code result rejects when the code callback is invoked', async () => {
    const codeFlow: V1IdcAuthorization = {
      url: 'https://device.example/verify',
      instructions: 'Paste the code',
      method: 'code',
      callback: async () => ({ type: 'failed' })
    }
    const [idc] = buildKiroIntegrationMethods({ authorize: async () => codeFlow })

    const authz = await idc!.authorize({})
    if (authz.mode !== 'code') throw new Error('expected code mode')
    await expect(authz.callback('x')).rejects.toThrow('Kiro IDC authorization failed')
  })

  test('fractional expiry is floored to a non-negative integer for the schema', async () => {
    const [idc] = buildKiroIntegrationMethods({
      authorize: async () =>
        fakeAutoAuthorization({
          type: 'success',
          key: 'a',
          access: 'a',
          refresh: 'r',
          expires: 1234.9
        })
    })
    const authz = await idc!.authorize({})
    if (authz.mode !== 'auto') throw new Error('expected auto mode')
    const cred = await authz.callback
    expect(cred.expires).toBe(1234)
    expect(Number.isInteger(cred.expires)).toBe(true)
  })

  test('the v1 inputs map is projected from the Form.Answer (empty strings dropped)', async () => {
    let seen: Record<string, string> | undefined
    const [, idcProfile] = buildKiroIntegrationMethods({
      authorize: async (inputs) => {
        seen = inputs
        return fakeAutoAuthorization(SUCCESS)
      }
    })

    await idcProfile!.authorize({
      start_url: 'https://acme.awsapps.com/start',
      idc_region: '',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:1:profile/X'
    })

    expect(seen).toEqual({
      start_url: 'https://acme.awsapps.com/start',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:1:profile/X'
    })
  })

  test('expiresAt is forwarded onto the v2 authorization when present', async () => {
    const [idc] = buildKiroIntegrationMethods({
      authorize: async () => fakeAutoAuthorization(SUCCESS, { expiresAt: 1_888_000_000_000 })
    })
    const authz = await idc!.authorize({})
    expect(authz.expiresAt).toBe(1_888_000_000_000)
  })
})
