import { createV1ReauthDriver } from './core/auth/reauth-driver.js'
import {
  hashDiagnosticIdentity,
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_MESSAGE_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_REQUEST_KIND_HEADER
} from './core/request/request-kind.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { createKiroCore, type ToastFunction } from './plugin/core.js'
import { registerDiscoveredCatalog } from './plugin/discovery/resolve-catalog.js'

export { __getActiveKeepAliveControllerForTest } from './plugin/core.js'

const KIRO_PROVIDER_ID = 'kiro-auth'

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const { config, authHandler, requestHandler, accountManager, baseURL } = await createKiroCore(
      directory,
      {
        showToast,
        reauthDriver: createV1ReauthDriver(client)
      }
    )

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        // Only populate models if the user hasn't defined them. Try live
        // discovery first; on any failure fall back to the minimal catalog
        // (`auto` only) plus a non-functional placeholder entry whose name
        // encodes the failure, and surface a visible TUI toast.
        if (!input.provider[id].models) {
          input.provider[id].models = await registerDiscoveredCatalog(
            {
              auth: {
                selector: requestHandler.sharedAccountSelector,
                refresher: requestHandler.sharedTokenRefresher,
                accountManager,
                showToast
              }
            },
            showToast
          )
        }
      },
      'chat.headers': async (input: any, output: { headers: Record<string, string> }) => {
        const providerID = input?.model?.providerID ?? input?.provider?.info?.id
        if (providerID !== id) return
        if (input?.agent === 'compaction') output.headers[KIRO_REQUEST_KIND_HEADER] = 'compaction'
        if (config.diagnostic_log_level === 'off') return

        output.headers[KIRO_DIAGNOSTIC_TRACE_HEADER] = crypto.randomUUID()
        const identities = [
          [KIRO_DIAGNOSTIC_SESSION_HEADER, hashDiagnosticIdentity(input?.sessionID)],
          [KIRO_DIAGNOSTIC_AGENT_HEADER, hashDiagnosticIdentity(input?.agent)],
          [KIRO_DIAGNOSTIC_MESSAGE_HEADER, hashDiagnosticIdentity(input?.message?.id)]
        ] as const
        for (const [header, value] of identities) {
          if (value !== undefined) output.headers[header] = value
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...modelInfo.api,
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
