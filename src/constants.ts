import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = RegionSchema.options

export function isValidRegion(region: string): region is KiroRegion {
  return VALID_REGIONS.includes(region as KiroRegion)
}

export function normalizeRegion(region: string | undefined): KiroRegion {
  if (!region || !isValidRegion(region)) {
    return 'us-east-1'
  }
  return region
}

export function buildUrl(template: string, region: KiroRegion): string {
  const url = template.replace('{{region}}', region)

  try {
    new URL(url)
    return url
  } catch {
    throw new Error(`Invalid URL generated: ${url}`)
  }
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  if (parts.length < 6) return undefined
  if (parts[0] !== 'arn') return undefined
  const region = parts[3]
  if (typeof region !== 'string' || !region) return undefined
  return isValidRegion(region) ? (region as KiroRegion) : undefined
}

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  /**
   * Chat runtime host. AWS retired `q.{{region}}.amazonaws.com` for
   * generateAssistantResponse: it now answers 403 FEATURE_NOT_SUPPORTED
   * ("This version of Kiro is no longer supported"). kiro-cli 3.1.0
   * (KAS) moved to `runtime.{{region}}.kiro.dev`, which accepts the same
   * body and headers.
   */
  BASE_URL: 'https://runtime.{{region}}.kiro.dev/generateAssistantResponse',
  /** Usage limits stayed on the legacy q.* host. */
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  SDK_VERSION: '3.738.0',
  SDK_VERSION_USAGE: '3.0.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

/**
 * Kiro management-plane (ListAvailableModels) wire facts, verified against
 * kiro-cli v2.10.0. These are the control-plane equivalents of the chat-path
 * constants above and are deliberately SEPARATE: the discovery call uses the
 * `KIRO_CLI` origin and the `management.{region}.kiro.dev` host, NOT the
 * `AI_EDITOR` origin or `runtime.{region}.kiro.dev` chat host. Centralized here
 * (never inlined at call sites) per AGENTS.md §4/§6.
 */
const KIRO_MANAGEMENT_CLI_VERSION = '2.10.0'
const KIRO_MANAGEMENT_SDK_API_VERSION = '0.1.16551'
const KIRO_MANAGEMENT_OS =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

export const KIRO_MANAGEMENT = {
  /** Region-templated control-plane endpoint (mirrors BASE_URL templating). */
  URL: 'https://management.{{region}}.kiro.dev/',
  /** awsJson1.0 operation target header value. */
  LIST_MODELS_TARGET: 'AmazonCodeWhispererService.ListAvailableModels',
  CONTENT_TYPE: 'application/x-amz-json-1.0',
  /** Discovery-call origin — distinct from the chat-path ORIGIN_AI_EDITOR. */
  ORIGIN: 'KIRO_CLI',
  /** Management user-agent, matching kiro-cli's codewhispererruntime UA. */
  USER_AGENT: `aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/${KIRO_MANAGEMENT_SDK_API_VERSION} os/${KIRO_MANAGEMENT_OS} lang/rust/1.92.0 md/appVersion-${KIRO_MANAGEMENT_CLI_VERSION} app/AmazonQ-For-CLI`,
  /** Request/response pagination cap (runaway nextToken guard). */
  MAX_PAGES: 10,
  /** Per-request network timeout. */
  TIMEOUT_MS: 15000
} as const

export const MODEL_MAPPING: Record<string, string> = {
  // Claude Haiku 5.5
  'claude-haiku-5-5': 'claude-haiku-5.5',
  'claude-haiku-5-5-thinking': 'claude-haiku-5.5',
  // Claude Haiku
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-thinking': 'claude-haiku-4.5',
  // Claude Sonnet 5.5
  'claude-sonnet-5-5': 'claude-sonnet-5.5',
  'claude-sonnet-5-5-thinking': 'claude-sonnet-5.5',
  // Claude Sonnet
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-1m': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-5-1m-thinking': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-6-1m-thinking': 'claude-sonnet-4.6-1m',
  // Wire id has no dot suffix and no .0/-1m variants (probe-confirmed; those 400).
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-thinking': 'claude-sonnet-5',
  // Claude Opus 5.5
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-opus-5-5-thinking': 'claude-opus-5.5',
  // Claude Opus
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-thinking': 'claude-opus-4.5',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-thinking': 'claude-opus-4.6',
  'claude-opus-4-6-1m': 'claude-opus-4.6-1m',
  'claude-opus-4-6-1m-thinking': 'claude-opus-4.6-1m',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-7-thinking': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-8-thinking': 'claude-opus-4.8',
  // Wire id has no dot suffix (probe-confirmed against the live API).
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-5-thinking': 'claude-opus-5',
  // Auto
  auto: 'auto',
  // Open weight models
  'deepseek-3.2': 'deepseek-3.2',
  'glm-5': 'glm-5',
  'minimax-m2.5': 'minimax-m2.5',
  'minimax-m2.1': 'minimax-m2.1',
  'qwen3-coder-next': 'qwen3-coder-next',
  // OpenAI GPT 5.6 — probe-confirmed (200, us-east-1); other naming guesses 400.
  // Effort variants (-low..-max) are parsed by resolveModelVariant, not mapped here.
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  // Legacy / internal mappings kept for backwards compatibility
  'claude-3-7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'nova-swe': 'AGI_NOVA_SWE_V1_5',
  'gpt-oss-120b': 'OPENAI_GPT_OSS_120B_1_0',
  'minimax-m2': 'MINIMAX_MINIMAX_M2',
  'kimi-k2-thinking': 'MOONSHOT_KIMI_K2_THINKING'
}

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

const LONG_CONTEXT_MODELS = new Set(Object.keys(MODEL_MAPPING).filter((k) => k.includes('-1m')))

export function isLongContextModel(model: string): boolean {
  return LONG_CONTEXT_MODELS.has(model)
}

// SSOT for token accounting, keyed by BASE model id (effort/thinking suffix
// stripped). Values MUST equal the limit.context advertised in src/plugin.ts —
// enforced by context-window.test.ts. Drift makes OpenCode under-count usage and
// skip auto-compaction until Kiro hard-rejects with 400 "Input is too long."
export const DEFAULT_MODEL_CONTEXT_LIMIT = 200000

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Live values from the management API `ListAvailableModels` (2026-11-10):
  // tokenLimits.maxInputTokens is authoritative; discovery overrides this table
  // at runtime for any model it returns (see getContextWindowSize).
  auto: 1000000,
  'claude-haiku-4-5': 200000,
  'claude-haiku-5-5': 1000000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-5-1m': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-sonnet-4-6-1m': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-sonnet-5-5': 1000000,
  'claude-opus-4-5': 200000,
  'claude-opus-4-6': 1000000,
  'claude-opus-4-6-1m': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-5': 1000000,
  'claude-opus-5-5': 1000000,
  'deepseek-3.2': 128000,
  'glm-5': 200000,
  'minimax-m2.5': 196000,
  'minimax-m2.1': 196000,
  'qwen3-coder-next': 256000,
  'gpt-5.6-sol': 986000,
  'gpt-5.6-terra': 986000,
  'gpt-5.6-luna': 986000
}

export function getModelContextLimit(baseModel: string): number {
  return MODEL_CONTEXT_LIMITS[baseModel] ?? DEFAULT_MODEL_CONTEXT_LIMIT
}

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  USER_INFO_URL: 'https://view.awsapps.com/api/user/info',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}
