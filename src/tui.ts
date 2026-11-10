// Import `define` from the plugin subpath directly rather than the `/tui`
// index, because the index also re-exports a solid-js helper that pulls in an
// optional `solid-js` dependency we neither need nor install.
import type { Context } from '@opencode/plugin/tui/context'
import { define } from '@opencode/plugin/tui/plugin'
import {
  createKiroCore,
  disposeActiveKeepAliveController,
  type ToastFunction
} from './plugin/core.js'

/**
 * v2 TUI entry.
 *
 * The v2 *server* plugin context (`src/index.ts`) has no toast surface, so its
 * usage summary only reaches the plugin log and stdout — never the TUI. OpenCode
 * loads a separate `tui` entry for plugins that want to touch the terminal UI;
 * this file is that entry. It wires `showToast` to `ctx.ui.toast.show` so the
 * per-account usage summary is actually visible when a terminal opens.
 *
 * The server entry remains the authoritative owner of account seeding
 * (kiro-cli sync) and model registration. This TUI entry therefore reuses the
 * shared core but calls `initialize(..., { syncKiroCli: false })`: it must NOT
 * re-run kiro-cli sync, only force a fresh usage snapshot and toast the result.
 * Both entries resolve the same `kiro.db`, so the usage figures match.
 *
 * On v1 this file is never loaded (v1 has its own TUI toast inside the auth
 * loader), so it is inert there.
 */
const setup = async (ctx: Context) => {
  const showToast: ToastFunction = (message, variant) => {
    try {
      ctx.ui.toast.show({
        message,
        variant: variant as 'info' | 'success' | 'warning' | 'error'
      })
    } catch {
      // A toast must never break the TUI.
    }
  }

  const directory = ctx.location?.directory
  if (!directory) {
    // Without a resolved location there is no project to build a core for;
    // nothing to toast and nothing to clean up.
    return
  }

  const core = await createKiroCore(directory, { showToast })

  // Force a fresh per-account usage snapshot and surface it through the TUI
  // toast. syncKiroCli:false keeps the server entry as the sole kiro-cli
  // sync owner. The call swallows its own failures and must not block setup.
  void core.authHandler.initialize(showToast, { syncKiroCli: false })

  return () => {
    disposeActiveKeepAliveController()
  }
}

export default define({ id: 'kiro-auth-tui', setup })
