/**
 * v2 account-management integration methods + automatic reauth driver.
 *
 * ## Open question resolved: can a v2 integration method complete without a credential?
 *
 * Yes — via a `command`-type integration method (`IntegrationCommandMethod`).
 * The OAuth method registration (`IntegrationOAuthMethodRegistration.authorize`)
 * is contractually required to resolve a `Credential.OAuth`, so it cannot model
 * a no-credential action without fabricating a fake credential. The command
 * method type carries only `{id, type:'command', label, command}` and no
 * credential-producing callback, so it is the correct shape for the two
 * account-management actions (refresh-all, manage/remove) which complete
 * without minting a credential.
 *
 * HOWEVER: a `command` method runs an external process (`command: string[]`)
 * that the host spawns; it is NOT an in-process callback into this plugin. The
 * v1 management actions ran *in-process* (calling `AccountRefreshService` /
 * interactive TTY menus against the plugin's own state), which a spawned
 * subprocess cannot reach. There is no v2 integration-method shape that invokes
 * an in-process plugin callback without producing a credential. Therefore the
 * two management actions remain **v1-only** (served through the `server()`
 * path), and are intentionally NOT registered as v2 integration methods. This
 * is a deliberate scope decision, documented here and in the migration spec.
 *
 * The add-account OAuth methods (ticket 06, `auth-methods.ts`) ARE registered on
 * v2 because they genuinely produce a credential.
 *
 * ## Automatic reauth
 *
 * `createV2ReauthDriver` adapts the v2 integration-oauth runtime API
 * (`connect` → poll `status` → `complete`) into the host-agnostic
 * `KiroReauthDriver` consumed by `RequestHandler`, replacing the v1
 * `client.provider.oauth.authorize/callback` coupling.
 */
import type { KiroReauthDriver } from '../../core/auth/reauth-driver.js'

/** The add-account method id reauth should drive (IDC / Builder ID). */
export const KIRO_REAUTH_METHOD_ID = 'kiro-auth:idc'

const INTEGRATION_ID = 'kiro-auth'

/** Terminal states for an oauth attempt poll. */
type AttemptStatusValue = 'pending' | 'complete' | 'failed' | 'expired'

interface OAuthAttemptStatus {
  readonly data: { readonly status: AttemptStatusValue; readonly message?: string }
}

interface OAuthConnectResult {
  readonly data: { readonly attemptID: string }
}

/**
 * Minimal structural view of the v2 `ctx.integration.oauth` runtime surface the
 * reauth driver needs. Matches `@opencode/client` `integration.oauth`.
 */
export interface V2IntegrationOAuthApi {
  connect(input: { integrationID: string; methodID: string }): Promise<OAuthConnectResult>
  status(input: { integrationID: string; attemptID: string }): Promise<OAuthAttemptStatus>
  complete(input: { integrationID: string; attemptID: string; code?: string }): Promise<void>
  cancel(input: { integrationID: string; attemptID: string }): Promise<void>
}

export interface CreateV2ReauthDriverOptions {
  /** Method id to connect; defaults to the IDC add-account method. */
  readonly methodID?: string
  /** Poll interval between `status` checks, ms. Default 1000. */
  readonly pollIntervalMs?: number
  /** Max total time to wait for a terminal status, ms. Default 300000 (5 min). */
  readonly timeoutMs?: number
  /** Injectable sleep for tests. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build a host-agnostic reauth driver backed by the v2 integration-oauth API.
 * Drives connect → poll status → complete for the add-account flow. Throws on a
 * failed/expired attempt or on timeout so `RequestHandler` records a failed
 * reauth (and cancels the dangling attempt before giving up).
 */
export function createV2ReauthDriver(
  oauth: V2IntegrationOAuthApi,
  options: CreateV2ReauthDriverOptions = {}
): KiroReauthDriver {
  const methodID = options.methodID ?? KIRO_REAUTH_METHOD_ID
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 300000
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now

  return {
    async reauthorize(): Promise<void> {
      const connected = await oauth.connect({ integrationID: INTEGRATION_ID, methodID })
      const attemptID = connected.data.attemptID
      const deadline = now() + timeoutMs

      for (;;) {
        const status = await oauth.status({ integrationID: INTEGRATION_ID, attemptID })
        const value = status.data.status
        if (value === 'complete') {
          await oauth.complete({ integrationID: INTEGRATION_ID, attemptID })
          return
        }
        if (value === 'failed' || value === 'expired') {
          throw new Error(
            `Kiro reauth attempt ${value}${
              status.data.message !== undefined ? `: ${status.data.message}` : ''
            }`
          )
        }
        if (now() >= deadline) {
          await oauth.cancel({ integrationID: INTEGRATION_ID, attemptID }).catch(() => {})
          throw new Error('Kiro reauth attempt timed out')
        }
        await sleep(pollIntervalMs)
      }
    }
  }
}
