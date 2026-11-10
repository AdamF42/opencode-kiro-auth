/**
 * Ticket 04/05 shared helper — resolve the model catalog for registration.
 *
 * Both the v2 setup (`src/index.ts`) and the v1 config hook (`src/plugin.ts`)
 * need the same behavior: try live discovery first, and on any typed
 * {@link ModelDiscoveryError} fall back to the minimal safe catalog (`auto`
 * only) plus a non-functional failure placeholder whose name encodes why
 * discovery failed. The visible toast/logger message is the caller's concern
 * (v1 has a real TUI toast; v2 degrades to a logger), so this helper returns the
 * formatted message alongside the catalog rather than emitting it, keeping the
 * helper pure and host-agnostic.
 *
 * Live discovery reuses the exact chat-path credential machinery via
 * {@link resolveManagementAuth}; no unconfirmed wire id ever reaches the API
 * because the fallback is `auto` only (AGENTS.md §4).
 */
import type { KiroModelCatalog } from '../model-catalog.js'
import type { ToastFunction } from './auth.js'
import { resolveManagementAuth, type ResolveManagementAuthDeps } from './auth.js'
import {
  buildDiscoveryFailurePlaceholder,
  formatDiscoveryError,
  getAvailableModels,
  MINIMAL_FALLBACK_CATALOG,
  recordDiscoveredContextLimits,
  recordDiscoveredEffort,
  recordDiscoveredWireIds,
  toKiroModelCatalog,
  type GetAvailableModelsDeps
} from './catalog.js'
import { ModelDiscoveryError } from './list-models.js'

/** Outcome of a catalog resolution. */
export interface ResolveCatalogResult {
  /** The catalog to register (live, or minimal + placeholder on failure). */
  readonly catalog: KiroModelCatalog
  /** Whether live discovery succeeded. */
  readonly discovered: boolean
  /**
   * A formatted, user-facing message when `discovered` is false. The caller
   * surfaces this via its toast/logger surface. Undefined on success.
   */
  readonly failureMessage?: string
  /**
   * Severity for `failureMessage`. `no-account` is a benign pre-auth state
   * (user story 11: still register a usable `auto` so the user can sign in
   * after), so it is `'warning'` with NO failure placeholder. Genuine failures
   * (`auth`/`http`/`network`/`empty`) are `'error'` and carry the placeholder.
   * Undefined on success.
   */
  readonly failureSeverity?: 'warning' | 'error'
}

export interface ResolveCatalogDeps {
  /** Auth-resolution collaborators (selector, refresher, accountManager, toast). */
  readonly auth: ResolveManagementAuthDeps
  /** Discovery collaborators (fetch, clock, cache); defaults to module-level. */
  readonly discovery?: GetAvailableModelsDeps
}

/**
 * Resolve the catalog to register. Never throws for a discovery failure: a
 * typed {@link ModelDiscoveryError} is caught and converted into the minimal
 * fallback catalog plus a placeholder entry. Unexpected (non-typed) errors are
 * also contained the same way, since catalog resolution must never break plugin
 * startup.
 */
export async function resolveCatalogForRegistration(
  deps: ResolveCatalogDeps
): Promise<ResolveCatalogResult> {
  try {
    const auth = await resolveManagementAuth(deps.auth)
    const models = await getAvailableModels(auth, deps.discovery ?? {})
    recordDiscoveredEffort(models)
    // Register the raw wire ids so the chat-path resolver treats a discovered
    // id (even one never hardcoded in MODEL_MAPPING) as an already-resolved
    // pass-through instead of throwing `Unsupported model` on send.
    recordDiscoveredWireIds(models)
    // Publish the API-advertised context windows to the token-accounting path so
    // usage percentages are computed against the same window OpenCode sees.
    recordDiscoveredContextLimits(models)
    return { catalog: toKiroModelCatalog(models), discovered: true }
  } catch (error) {
    const discoveryError =
      error instanceof ModelDiscoveryError
        ? error
        : new ModelDiscoveryError('network', 'Unexpected model-discovery failure', {
            cause: error
          })

    // A missing account is not a failure: the user simply hasn't signed in yet
    // (user story 11). Register only the always-valid `auto` route, with NO
    // failure placeholder, and surface a benign warning so the picker stays
    // clean once they authenticate.
    if (discoveryError.kind === 'no-account') {
      return {
        catalog: { ...MINIMAL_FALLBACK_CATALOG },
        discovered: false,
        failureMessage: formatDiscoveryError(discoveryError),
        failureSeverity: 'warning'
      }
    }

    const placeholder = buildDiscoveryFailurePlaceholder(discoveryError)
    const catalog: KiroModelCatalog = {
      ...MINIMAL_FALLBACK_CATALOG,
      [placeholder.id]: placeholder.entry
    }
    return {
      catalog,
      discovered: false,
      failureMessage: formatDiscoveryError(discoveryError),
      failureSeverity: 'error'
    }
  }
}

/**
 * Resolve the catalog and surface any failure through the caller's toast/logger
 * in one step. Both the v1 config hook and the v2 setup need the identical
 * sequence — resolve, then emit the formatted message at its kind-dependent
 * severity when discovery did not succeed — so it lives here. Adding a field to
 * {@link ResolveCatalogResult} (as `failureSeverity` was) now touches only this
 * function, not both wiring sites. Returns the catalog to register.
 */
export async function registerDiscoveredCatalog(
  deps: ResolveCatalogDeps,
  showToast: ToastFunction
): Promise<KiroModelCatalog> {
  const { catalog, discovered, failureMessage, failureSeverity } =
    await resolveCatalogForRegistration(deps)
  if (!discovered && failureMessage !== undefined) {
    showToast(failureMessage, failureSeverity ?? 'error')
  }
  return catalog
}
