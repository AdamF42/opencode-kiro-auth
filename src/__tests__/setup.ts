// Bun test preload. Runs ONCE before any test module is evaluated.
//
// The `kiroDb` singleton in src/plugin/storage/sqlite.ts computes its DB_PATH
// from APPDATA on Windows and XDG_CONFIG_HOME elsewhere at module-eval time.
// Point both at a throwaway temp dir BEFORE any test imports the singleton, so
// the suite never reads or writes the developer's real opencode/kiro.db.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const activeConfigHome =
  process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME
const testHome =
  activeConfigHome?.includes('kiro-test-home-') === true
    ? activeConfigHome
    : mkdtempSync(join(tmpdir(), 'kiro-test-home-'))

process.env.XDG_CONFIG_HOME = testHome
if (process.platform === 'win32') process.env.APPDATA = testHome

// `writeToKiroCli()` (src/plugin/sync/kiro-cli.ts) mirrors refreshed tokens into
// the kiro-cli SQLite database. Tests exercise the real AccountManager refresh
// path, so without this pin a test run would overwrite the developer's live
// credentials in ~/.local/share/kiro-cli/data.sqlite3. Pin it to a throwaway
// file too, exactly like the opencode config home above.
if (!process.env.KIROCLI_DB_PATH) {
  process.env.KIROCLI_DB_PATH = join(testHome, 'kiro-cli-data.sqlite3')
}
