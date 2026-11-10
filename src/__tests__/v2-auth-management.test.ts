import { describe, expect, mock, test } from 'bun:test'
import {
  KIRO_REAUTH_METHOD_ID,
  createV2ReauthDriver,
  type V2IntegrationOAuthApi
} from '../plugin/v2/auth-management.js'

type StatusValue = 'pending' | 'complete' | 'failed' | 'expired'

function fakeOAuth(statuses: Array<{ status: StatusValue; message?: string }>): {
  oauth: V2IntegrationOAuthApi
  calls: {
    connect: ReturnType<typeof mock>
    status: ReturnType<typeof mock>
    complete: ReturnType<typeof mock>
    cancel: ReturnType<typeof mock>
  }
} {
  let i = 0
  const connect = mock(async () => ({ data: { attemptID: 'attempt-1' } }))
  const status = mock(async () => {
    const next = statuses[Math.min(i, statuses.length - 1)]!
    i += 1
    return { data: next }
  })
  const complete = mock(async () => {})
  const cancel = mock(async () => {})
  return {
    oauth: { connect, status, complete, cancel },
    calls: { connect, status, complete, cancel }
  }
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('createV2ReauthDriver', () => {
  test('defaults to the IDC add-account method id', () => {
    expect(KIRO_REAUTH_METHOD_ID).toBe('kiro-auth:idc')
  })

  test('connect -> poll -> complete on a successful attempt', async () => {
    const { oauth, calls } = fakeOAuth([{ status: 'pending' }, { status: 'complete' }])
    const driver = createV2ReauthDriver(oauth, { sleep: noSleep })
    await driver.reauthorize()
    expect(calls.connect).toHaveBeenCalledTimes(1)
    expect(calls.connect.mock.calls[0]![0]).toEqual({
      integrationID: 'kiro-auth',
      methodID: 'kiro-auth:idc'
    })
    expect(calls.status).toHaveBeenCalledTimes(2)
    expect(calls.complete).toHaveBeenCalledTimes(1)
    expect(calls.complete.mock.calls[0]![0]).toEqual({
      integrationID: 'kiro-auth',
      attemptID: 'attempt-1'
    })
    expect(calls.cancel).not.toHaveBeenCalled()
  })

  test('throws on a failed attempt and does not complete', async () => {
    const { oauth, calls } = fakeOAuth([{ status: 'failed', message: 'denied' }])
    const driver = createV2ReauthDriver(oauth, { sleep: noSleep })
    await expect(driver.reauthorize()).rejects.toThrow('denied')
    expect(calls.complete).not.toHaveBeenCalled()
  })

  test('throws on an expired attempt', async () => {
    const { oauth, calls } = fakeOAuth([{ status: 'expired' }])
    const driver = createV2ReauthDriver(oauth, { sleep: noSleep })
    await expect(driver.reauthorize()).rejects.toThrow('expired')
    expect(calls.complete).not.toHaveBeenCalled()
  })

  test('times out, cancels the dangling attempt, and throws', async () => {
    const { oauth, calls } = fakeOAuth([{ status: 'pending' }])
    let clock = 0
    const driver = createV2ReauthDriver(oauth, {
      sleep: noSleep,
      timeoutMs: 10,
      now: () => {
        const value = clock
        clock += 100
        return value
      }
    })
    await expect(driver.reauthorize()).rejects.toThrow('timed out')
    expect(calls.cancel).toHaveBeenCalledTimes(1)
    expect(calls.complete).not.toHaveBeenCalled()
  })

  test('honors a custom method id', async () => {
    const { oauth, calls } = fakeOAuth([{ status: 'complete' }])
    const driver = createV2ReauthDriver(oauth, {
      sleep: noSleep,
      methodID: 'kiro-auth:idc-profile-arn'
    })
    await driver.reauthorize()
    expect(calls.connect.mock.calls[0]![0]).toEqual({
      integrationID: 'kiro-auth',
      methodID: 'kiro-auth:idc-profile-arn'
    })
  })
})
