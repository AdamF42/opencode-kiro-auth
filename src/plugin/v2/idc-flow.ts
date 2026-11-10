/**
 * Wires the real IDC device flow into the pure v2 integration add-account
 * builder (`buildKiroIntegrationMethods`).
 *
 * The v1 `IdcAuthMethod.authorize(inputs)` returns a `{method:'auto', callback}`
 * whose success result is only `{type:'success', key: accessToken}` — it does
 * NOT surface the refresh token / expiry that a v2 `Credential.OAuth` requires.
 * However, the callback persists the freshly-authorized account to the
 * repository BEFORE returning (see `idc-auth-method.ts`), so immediately after a
 * success we can read the just-saved account back out and recover
 * `refreshToken` / `accessToken` / `expiresAt`.
 *
 * This adapter therefore wraps the v1 flow: it keeps the v1 `url`/`instructions`
 * and callback mode, but widens the success result to the full `V1IdcTokens`
 * the builder needs by resolving the newest matching account from the
 * repository.
 */
import { IdcAuthMethod } from '../../core/auth/idc-auth-method.js'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import type { AccountManager } from '../accounts.js'
import type { KiroConfig } from '../config/index.js'
import type { V1IdcAuthFlow, V1IdcAuthorization, V1IdcCallbackResult } from './auth-methods.js'

/**
 * Resolve the token set for the account the flow just authorized.
 *
 * The IDC success result carries the exact access token that was just minted,
 * and the callback persisted that account before returning, so we match the
 * saved account by that access token EXACTLY. We deliberately do NOT fall back
 * to "some other recent account": under concurrent or multi-account state a
 * fuzzy match could hand back a different account's refresh token, binding the
 * new credential to the wrong identity. If the exact account is absent, or it
 * lacks a usable refresh token, we fail — a `Credential.OAuth` with no refresh
 * token cannot be refreshed and would silently die on first expiry.
 */
async function recoverTokens(
  repository: AccountRepository,
  accessTokenHint: string
): Promise<{ refresh: string; access: string; expires: number } | undefined> {
  const accounts = await repository.findAll()
  const match = accounts.find(
    (acc) => typeof acc?.accessToken === 'string' && acc.accessToken === accessTokenHint
  )
  if (!match) return undefined

  const refresh = typeof match.refreshToken === 'string' ? match.refreshToken : ''
  if (refresh.length === 0) return undefined

  const expires = typeof match.expiresAt === 'number' ? match.expiresAt : 0
  return { refresh, access: accessTokenHint, expires }
}

/**
 * Build the injectable `V1IdcAuthFlow` the pure builder consumes, backed by the
 * real `IdcAuthMethod`. The returned flow runs the device flow and, on success,
 * enriches the result with the refresh token + expiry read back from the
 * repository.
 */
export function createIdcAuthFlow(
  config: KiroConfig,
  repository: AccountRepository,
  accountManager: AccountManager
): V1IdcAuthFlow {
  const idcMethod = new IdcAuthMethod(config, repository, accountManager)

  return async (inputs: Record<string, string>): Promise<V1IdcAuthorization> => {
    const v1 = await idcMethod.authorize(inputs)

    // v1 is always `{method:'auto', callback}` in the current IdcAuthMethod; map
    // its callback to the widened success shape, recovering tokens post-success.
    const originalCallback = v1.callback as () => Promise<
      { type: 'success'; key: string } | { type: 'failed' }
    >

    const widenedCallback = async (): Promise<V1IdcCallbackResult> => {
      const result = await originalCallback()
      if (result.type !== 'success') {
        return { type: 'failed' }
      }
      const tokens = await recoverTokens(repository, result.key)
      if (!tokens) {
        // Shouldn't happen (the account was just saved), but fail cleanly.
        return { type: 'failed' }
      }
      return {
        type: 'success',
        key: result.key,
        refresh: tokens.refresh,
        access: tokens.access,
        expires: tokens.expires
      }
    }

    return {
      url: v1.url,
      instructions: v1.instructions,
      method: 'auto',
      callback: widenedCallback
    }
  }
}
