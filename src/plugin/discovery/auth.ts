/**
 * Ticket 03 — resolve management-plane auth for model discovery.
 *
 * Model discovery calls the Kiro management API (`ListAvailableModels`), which
 * needs a valid bearer access token + the account's `profileArn` + region. This
 * helper reuses the exact same account-selection and token-refresh machinery
 * the chat path uses, so discovery never invents its own credential handling:
 *
 *  1. `AccountSelector.selectHealthyAccount` picks a usable account (and may
 *     sync from kiro-cli on an empty store). It throws `'No accounts'` when the
 *     store is genuinely empty — we map only that to a typed
 *     `ModelDiscoveryError{kind:'no-account'}` so callers can render the
 *     dedicated "no accounts" placeholder; any other selector error (circuit
 *     breaker, all-unhealthy, overage) is surfaced verbatim.
 *  2. `TokenRefresher.refreshIfNeeded` refreshes the access token in place when
 *     it is within the expiry buffer. We then re-read the account so the
 *     returned `access` reflects any rotation.
 *
 * A selector that returns `null` (transient rate-limit backoff) is reported as a
 * `network`-kind error: discovery is best-effort and should fall back rather
 * than hang.
 */
import { normalizeRegion } from '../../constants.js'
import type { AccountManager } from '../accounts.js'
import type { ManagedAccount } from '../types.js'
import { ModelDiscoveryError, type KiroManagementAuth } from './list-models.js'

export type ToastFunction = (
  message: string,
  variant: 'info' | 'warning' | 'success' | 'error'
) => void

/** The slice of `AccountSelector` this helper depends on. */
export interface ManagementAccountSelector {
  selectHealthyAccount(
    showToast: ToastFunction,
    signal?: AbortSignal
  ): Promise<ManagedAccount | null>
}

/** The slice of `TokenRefresher` this helper depends on. */
export interface ManagementTokenRefresher {
  refreshIfNeeded(
    account: ManagedAccount,
    auth: ReturnType<AccountManager['toAuthDetails']>,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }>
}

export interface ResolveManagementAuthDeps {
  readonly selector: ManagementAccountSelector
  readonly refresher: ManagementTokenRefresher
  readonly accountManager: Pick<AccountManager, 'toAuthDetails' | 'getAccounts'>
  readonly showToast: ToastFunction
  readonly signal?: AbortSignal
}

/**
 * Resolve a fresh `KiroManagementAuth` from the healthiest account. Throws a
 * typed {@link ModelDiscoveryError} on the no-account / transient paths; other
 * selector/refresher errors propagate unchanged.
 */
export async function resolveManagementAuth(
  deps: ResolveManagementAuthDeps
): Promise<KiroManagementAuth> {
  const { selector, refresher, accountManager, showToast, signal } = deps

  let selected: ManagedAccount | null
  try {
    selected = await selector.selectHealthyAccount(showToast, signal)
  } catch (error) {
    if (error instanceof Error && error.message === 'No accounts') {
      throw new ModelDiscoveryError('no-account', 'No Kiro accounts are configured', {
        cause: error
      })
    }
    throw error
  }

  if (!selected) {
    throw new ModelDiscoveryError(
      'network',
      'No healthy Kiro account was available for model discovery'
    )
  }

  const auth = accountManager.toAuthDetails(selected)
  await refresher.refreshIfNeeded(selected, auth, showToast)

  // Re-read so a rotated access token is reflected; fall back to the selected
  // snapshot if the manager no longer tracks it.
  const refreshed =
    accountManager.getAccounts().find((candidate) => candidate.id === selected.id) ?? selected

  return {
    access: refreshed.accessToken,
    profileArn: refreshed.profileArn ?? '',
    region: normalizeRegion(refreshed.region)
  }
}
