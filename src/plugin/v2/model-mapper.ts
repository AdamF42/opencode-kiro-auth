import { Model, Provider } from '@opencode/plugin'
import { cloneKiroModelCatalog, type KiroModelCatalog } from '../model-catalog.js'

/**
 * Maps the shared Kiro model catalog into OpenCode v2 `Model.Info[]`.
 *
 * The v1 config hook shipped each model as
 * `{ name, limit:{context,output}, modalities:{input,output} }`. v2 expects a
 * fully-populated `Model.Info`, so we start from `Model.Info.default(providerID,
 * id)` and overlay the catalog fields:
 *   - map key          -> `id` / `modelID`
 *   - `name`           -> `name`
 *   - `limit`          -> `limit` (context + output; input left unset)
 *   - `modalities.input`  -> `capabilities.input`  (preserves `pdf`)
 *   - `modalities.output` -> `capabilities.output`
 *
 * `capabilities.tools` keeps the schema default (`true`). The catalog is cloned
 * first so the returned structures never alias the module-level constant.
 */
export function mapCatalogToModelInfo(
  providerID: string,
  catalog: KiroModelCatalog = cloneKiroModelCatalog()
): Model.Info[] {
  const branded = Provider.ID.make(providerID)
  return Object.entries(catalog).map(([modelID, definition]) => {
    const base = Model.Info.default(branded, Model.ID.make(modelID))
    return {
      ...base,
      name: definition.name,
      capabilities: {
        ...base.capabilities,
        input: [...definition.modalities.input],
        output: [...definition.modalities.output]
      },
      limit: {
        ...base.limit,
        context: definition.limit.context,
        output: definition.limit.output
      }
    }
  })
}

/**
 * Builds the `Provider.Info` registered for the `kiro-auth` provider on the v2
 * path. The package must carry the `aisdk:` prefix so OpenCode routes the model
 * through the AI-SDK plugin hook chain (where the `aisdk.language` hook below
 * replaces the language model) instead of treating it as a native provider that
 * dials `baseURL` directly. The prefix must reference the `@ai-sdk/*` spelling
 * (`@ai-sdk/openai-compatible`), which OpenCode maps to its bundled native
 * `@opencode/ai/providers/openai-compatible`; the `@opencode/ai/*` spelling is
 * not a valid `aisdk:` package and fails to resolve. Without the prefix
 * `Provider.isAISDK` is false and the `aisdk.language` hook never fires, so
 * requests go straight to `baseURL`. The package is therefore only a
 * host-wiring placeholder; no real HTTP flows through it.
 */
export function buildKiroProviderInfo(providerID: string, baseURL: string): Provider.Info {
  return {
    ...Provider.Info.empty(Provider.ID.make(providerID)),
    name: 'Kiro',
    activation: 'enabled',
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL }
  }
}
