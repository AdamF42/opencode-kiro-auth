import { Plugin } from '@opencode/plugin'
import type { Context } from '@opencode/plugin/promise/plugin'
import { KiroOAuthPlugin } from './plugin.js'
import {
  createKiroCore,
  disposeActiveKeepAliveController,
  type ToastFunction
} from './plugin/core.js'
import { registerDiscoveredCatalog } from './plugin/discovery/resolve-catalog.js'
import { createV2ReauthDriver } from './plugin/v2/auth-management.js'
import { buildKiroIntegrationMethods } from './plugin/v2/auth-methods.js'
import { createIdcAuthFlow } from './plugin/v2/idc-flow.js'
import {
  buildPrivateHeaders,
  createKiroLanguageModel,
  type KiroLanguageModelCallContext
} from './plugin/v2/language-model.js'
import { buildKiroProviderInfo, mapCatalogToModelInfo } from './plugin/v2/model-mapper.js'

const PROVIDER_ID = 'kiro-auth'

export { KiroOAuthPlugin } from './plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

/**
 * v2 setup: builds the shared Kiro core and wires every v2 surface.
 *
 * The v2 server plugin context has no toast surface (toasts are a TUI-plugin
 * concern), so `showToast` degrades to a logger that never throws. The setup
 * registers: the provider + model inventory, the LanguageModelV3 interception
 * adapter, the add-account integration methods, and an automatic reauth driver.
 * The returned cleanup disposes every registration plus the keep-alive
 * controller.
 */
const setup = async (ctx: Context) => {
  const showToast: ToastFunction = (message, variant) => {
    try {
      const line = `[kiro-auth] ${variant}: ${message}`
      if (variant === 'error' || variant === 'warning') {
        console.warn(line)
      } else {
        console.info(line)
      }
    } catch {
      // Logging must never break a request.
    }
  }

  // v2 reauth driver: drive the host integration-oauth add-account flow when
  // every account is permanently unhealthy. Injected into the shared core so
  // RequestHandler stays host-agnostic.
  const reauthDriver = createV2ReauthDriver(ctx.integration.oauth)

  const core = await createKiroCore(ctx.location.directory, { showToast, reauthDriver })

  // Seed accounts (kiro-cli sync) and surface a fresh per-account usage summary
  // at load. On v1 this runs inside the auth loader; the v2 setup has no auth
  // loader, so it must be invoked here or the usage snapshot never runs. The
  // call never throws (it swallows its own failures) and must not block setup
  // registration, so it is intentionally not awaited.
  void core.authHandler.initialize(showToast)

  // Resolve the model catalog via live discovery before the sync registration.
  // On any discovery failure this returns the minimal fallback catalog (`auto`
  // only) plus a non-functional placeholder entry whose name encodes the
  // failure, and surfaces a formatted message through the logger — the picker
  // alone is otherwise silent about why the full model list is missing on v2.
  const catalog = await registerDiscoveredCatalog(
    {
      auth: {
        selector: core.requestHandler.sharedAccountSelector,
        refresher: core.requestHandler.sharedTokenRefresher,
        accountManager: core.accountManager,
        showToast
      }
    },
    showToast
  )

  const providerRegistration = await ctx.provider.transform((editor) => {
    editor.add({
      info: buildKiroProviderInfo(PROVIDER_ID, core.baseURL),
      models: mapCatalogToModelInfo(PROVIDER_ID, catalog)
    })
  })

  // Add-account integration methods (Builder ID / IDC, and IDC + Profile ARN),
  // backed by the real IDC device flow.
  const idcAuthorize = createIdcAuthFlow(core.config, core.repository, core.accountManager)
  const integrationRegistration = await ctx.integration.transform((editor) => {
    for (const method of buildKiroIntegrationMethods({
      authorize: idcAuthorize,
      config: {
        idc_start_url: core.config.idc_start_url,
        idc_region: core.config.idc_region,
        idc_profile_arn: core.config.idc_profile_arn
      }
    })) {
      editor.method.update(method)
    }
  })

  // Request-kind + diagnostic signaling.
  //
  // On v1 the `chat.headers` hook stamped five private headers that the
  // custom-fetch `handle()` read and stripped. On v2 the two surfaces are split:
  // the `aisdk.language` event (where we install the model) carries no session
  // kind/identity, while the `session.hook('model.request')` event carries
  // `{kind, sessionID, agent}` but has no model handle. We bridge them through
  // the call options' `headers`: `model.request` stamps the private headers on
  // `event.headers`, the host forwards those onto `LanguageModelV3CallOptions.
  // headers`, and the adapter's `resolveCallContext` reads them back and
  // re-emits the identical header channel into the synthesized request. This
  // keeps `handle()` byte-for-byte unchanged and keeps a single source of truth
  // for the header set (`buildPrivateHeaders`). Compaction request-kind is
  // derived from the v2 call kind; diagnostic identity headers obey
  // `diagnostic_log_level` exactly as on v1.
  const diagnosticLogLevel = core.config.diagnostic_log_level ?? 'off'
  const modelRequestRegistration = await ctx.session.hook(
    'model.request',
    (event) => {
      // Only forward identity fields that are actually present; coercing an
      // absent field via `String()` would hash the literal `"undefined"`.
      const context: KiroLanguageModelCallContext = {
        kind: event.kind,
        ...(event.sessionID != null ? { sessionID: String(event.sessionID) } : {}),
        ...(event.agent != null ? { agent: String(event.agent) } : {})
      }
      const headers = buildPrivateHeaders(context, diagnosticLogLevel !== 'off')
      Object.assign(event.headers, headers)
    },
    { providerID: PROVIDER_ID }
  )

  // Interception point: supply a LanguageModelV3 that routes through the shared
  // Kiro request pipeline. This replaces the v1 custom-fetch on the auth loader.
  // No `resolveCallContext` is passed: the adapter's fallback reads the private
  // headers the `model.request` hook stamped above (forwarded by the host onto
  // the call options) and re-emits that identical channel into the synthesized
  // request, so `buildPrivateHeaders` stays the single source of truth.
  const languageRegistration = await ctx.aisdk.hook(
    'language',
    (event) => {
      event.language = createKiroLanguageModel({
        providerID: PROVIDER_ID,
        modelID: String(event.model.modelID),
        baseURL: core.baseURL,
        pipeline: core.requestHandler,
        showToast
      })
    },
    { providerID: PROVIDER_ID }
  )

  return async () => {
    await modelRequestRegistration.dispose()
    await languageRegistration.dispose()
    await integrationRegistration.dispose()
    await providerRegistration.dispose()
    disposeActiveKeepAliveController()
  }
}

/**
 * Dual v1/v2 default export. OpenCode v1 reads `server()` and uses the returned
 * hook object; OpenCode v2 reads `id` + `setup`. Each path drives its own API —
 * there is no automatic hook translation between them.
 */
export default {
  ...Plugin.define({ id: 'kiro-auth', setup }),
  server: KiroOAuthPlugin
}
