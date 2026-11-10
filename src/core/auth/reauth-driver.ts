/**
 * Host-agnostic reauthentication driver.
 *
 * `RequestHandler` triggers an interactive re-authentication when every account
 * is permanently unhealthy. In v1 that was done by calling the OpenCode plugin
 * `client.provider.oauth.authorize/callback` directly, hard-coupling the request
 * pipeline to the v1 host client. This interface decouples it: the pipeline only
 * needs *something* that can run the add-account OAuth flow to completion. The
 * two OpenCode API versions supply their own implementation:
 *
 *  - v1 (`src/plugin.ts`): a shim over `client.provider.oauth.authorize` +
 *    `client.provider.oauth.callback`.
 *  - v2 (`src/index.ts`): a shim over `ctx.integration.oauth.connect` +
 *    `ctx.integration.oauth.complete`.
 *
 * The driver's sole job is to drive the host's add-account flow. Discovering and
 * registering the resulting accounts stays in `RequestHandler`, so the driver
 * stays tiny and host-specific.
 */
export interface KiroReauthDriver {
  /**
   * Run the interactive add-account flow for the Kiro provider to completion.
   * Resolves when the host reports the flow finished (successfully or not);
   * `RequestHandler` then re-reads accounts from disk to decide usability.
   * Rejecting is treated as a failed reauth.
   */
  reauthorize(): Promise<void>
}

/** Narrow structural type for the v1 OpenCode plugin client's oauth surface. */
interface V1OAuthClient {
  provider: {
    oauth: {
      authorize(input: { path: { id: string }; body: { method: number } }): Promise<unknown>
      callback(input: { path: { id: string }; body: { method: number } }): Promise<unknown>
    }
  }
}

/**
 * Build a reauth driver from the v1 OpenCode plugin `client`. Preserves the
 * exact prior behavior: authorize then callback for the first auth method
 * (index 0 = IDC / Builder ID add-account) on provider `kiro-auth`.
 */
export function createV1ReauthDriver(client: V1OAuthClient): KiroReauthDriver {
  return {
    async reauthorize(): Promise<void> {
      await client.provider.oauth.authorize({ path: { id: 'kiro-auth' }, body: { method: 0 } })
      await client.provider.oauth.callback({ path: { id: 'kiro-auth' }, body: { method: 0 } })
    }
  }
}
