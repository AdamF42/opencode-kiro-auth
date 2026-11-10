import { KIRO_CONSTANTS } from '../constants.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import type { KiroReauthDriver } from '../core/auth/reauth-driver.js'
import { KeepAliveController } from '../core/auth/token-keepalive.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from './accounts.js'
import { loadConfig } from './config/index.js'
import { migrateSafeFilesIfNeeded } from './storage/migrate-layout.js'

export type ToastFunction = (message: string, variant: string) => void

/**
 * Host-agnostic capabilities the core needs from whichever OpenCode API
 * version is driving it. v1 supplies these from the plugin `client`; v2 wires
 * them from the plugin `setup` context.
 */
export interface KiroCoreCapabilities {
  showToast: ToastFunction
  /**
   * Host-agnostic reauth driver handed to RequestHandler. It runs the host's
   * add-account OAuth flow to completion. v1 builds it from the OpenCode
   * `client` (`createV1ReauthDriver`); v2 builds it from the integration-oauth
   * domain. Optional: when absent, RequestHandler never auto-reauths.
   */
  reauthDriver?: KiroReauthDriver
}

export interface KiroCore {
  config: ReturnType<typeof loadConfig>
  repository: AccountRepository
  authHandler: AuthHandler
  accountManager: AccountManager
  requestHandler: RequestHandler
  baseURL: string
  keepAlive: KeepAliveController
}

let activeKeepAliveController: KeepAliveController | null = null
let keepAliveTeardownRegistered = false

export function disposeActiveKeepAliveController(): void {
  activeKeepAliveController?.dispose()
  activeKeepAliveController = null
}

function registerKeepAliveTeardown(): void {
  if (keepAliveTeardownRegistered) {
    return
  }

  keepAliveTeardownRegistered = true
  process.once('beforeExit', disposeActiveKeepAliveController)
  process.once('SIGTERM', disposeActiveKeepAliveController)
}

function installKeepAliveController(controller: KeepAliveController, enabled: boolean): void {
  disposeActiveKeepAliveController()
  activeKeepAliveController = controller
  if (enabled) {
    registerKeepAliveTeardown()
  }
  controller.start()
}

export function __getActiveKeepAliveControllerForTest(): KeepAliveController | null {
  return activeKeepAliveController
}

/**
 * Builds the shared Kiro runtime used by both the v1 plugin hooks and the v2
 * plugin setup. All host-coupled behaviour (toast, reauth) arrives via
 * `capabilities` so this function has no dependency on any OpenCode client.
 */
export async function createKiroCore(
  directory: string,
  capabilities: KiroCoreCapabilities
): Promise<KiroCore> {
  try {
    migrateSafeFilesIfNeeded()
  } catch (error) {
    console.warn(
      'Kiro storage layout migration failed non-fatally:',
      error instanceof Error ? error.message : String(error)
    )
  }

  const config = loadConfig(directory)

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)

  const authHandler = new AuthHandler(config, repository)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy, {
    quotaAvoidanceEnabled: config.quota_avoidance_enabled,
    quotaReserveThreshold: config.quota_reserve_threshold,
    stopOnOverage: config.stop_on_overage,
    overageThreshold: config.overage_threshold,
    distributeAcrossProcesses: config.distribute_across_processes,
    perRequestSpread: config.per_request_spread,
    invalidateAccountCache: (accountId) => repository.invalidateAccount(accountId)
  })
  authHandler.setAccountManager(accountManager)

  const requestHandler = new RequestHandler(
    accountManager,
    config,
    repository,
    capabilities.reauthDriver
  )
  authHandler.setAccountRefreshService(requestHandler.sharedAccountRefreshService)

  const keepAlive = new KeepAliveController(
    config,
    accountManager,
    requestHandler.sharedTokenRefresher,
    repository
  )
  installKeepAliveController(keepAlive, config.token_keepalive_enabled)

  // Compute the base URL once so both the config hook and auth loader use the same value
  const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
    '{{region}}',
    config.default_region || 'us-east-1'
  )

  return {
    config,
    repository,
    authHandler,
    accountManager,
    requestHandler,
    baseURL,
    keepAlive
  }
}
