import { Credential, Integration } from '@opencode/plugin'
import type {
  IntegrationOAuthAuthorization,
  IntegrationOAuthMethodRegistration
} from '@opencode/plugin/promise/integration'
import type { Form } from '@opencode/schema/form'

/**
 * v2 integration add-account method builder.
 *
 * Under OpenCode v1 the plugin exposed add-account flows through
 * `AuthHandler.getMethods()`; under v2 those live in the `integration` domain as
 * `IntegrationOAuthMethodRegistration`s applied via `editor.method.update(reg)`.
 *
 * This module is a PURE builder: it owns no OpenCode client and performs no I/O.
 * The real IDC device flow is injected as `deps.authorize`, so the builder can be
 * unit-tested with a fake that returns canned tokens. Ticket 08 wires the real
 * `IdcAuthMethod` in by adapting its `authorize(inputs)` to the `V1IdcAuthFlow`
 * contract below.
 *
 * INVARIANT: `integrationID` MUST stay `'kiro-auth'` (never bare `kiro`).
 */

/** The two add-account flows ported from the v1 `getMethods()` (methods 0 and 1). */
export type KiroAddAccountMethodID = 'kiro-auth:idc' | 'kiro-auth:idc-profile-arn'

/**
 * Narrow view of the v1 IDC device-flow result the builder needs.
 *
 * The real `IdcAuthMethod.authorize` returns `method: 'auto'` with a callback
 * resolving `{type:'success', key}` (access token only) or `{type:'failed'}`.
 * To build a full `Credential.OAuth` the builder also needs the refresh token
 * and expiry, so the injected flow surfaces them on the success result. The v1
 * `IdcAuthMethod` already has all three in scope at callback time (see
 * `src/core/auth/idc-auth-method.ts` — `token.accessToken` / `token.refreshToken`
 * / `token.expiresAt`); ticket 08's adapter forwards them here.
 */
export interface V1IdcTokens {
  readonly type: 'success'
  /** Access token (v1 `key`). */
  readonly key: string
  /** OAuth refresh token. */
  readonly refresh: string
  /** OAuth access token (same value as `key`; kept explicit for clarity). */
  readonly access: string
  /** Absolute expiry in epoch milliseconds. */
  readonly expires: number
}

export interface V1IdcFailure {
  readonly type: 'failed'
}

export type V1IdcCallbackResult = V1IdcTokens | V1IdcFailure

/**
 * The v1-shaped authorization result returned by the injected flow. Mirrors
 * `IdcAuthMethod.authorize`'s return value, but the success callback result is
 * widened to carry the full token set (see `V1IdcTokens`).
 */
export type V1IdcAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | { readonly method: 'auto'; readonly callback: () => Promise<V1IdcCallbackResult> }
  | { readonly method: 'code'; readonly callback: (code: string) => Promise<V1IdcCallbackResult> }
)

/** The injected device flow. `inputs` is the v1 prompt map (`start_url`, etc.). */
export type V1IdcAuthFlow = (inputs: Record<string, string>) => Promise<V1IdcAuthorization>

export interface BuildKiroIntegrationMethodsDeps {
  /** Runs the real IDC device flow. Injected so the builder stays I/O-free. */
  readonly authorize: V1IdcAuthFlow
  /** Optional config echoes used to enrich prompt copy (matches v1 behavior). */
  readonly config?: {
    readonly idc_start_url?: string
    readonly idc_region?: string
    readonly idc_profile_arn?: string
  }
}

export const KIRO_INTEGRATION_ID = 'kiro-auth'

/** Only the keys the add-account flows read out of a `Form.Answer`. */
const PROMPT_KEYS = ['start_url', 'idc_region', 'profile_arn'] as const

/** Coerce a `Form.Answer` value to the string the v1 flow expects (or ''). */
function answerString(answer: Form.Answer, key: string): string {
  const value = answer[key]
  return typeof value === 'string' ? value : ''
}

/** Project a `Form.Answer` down to the v1 `inputs` string map. */
function toV1Inputs(answer: Form.Answer): Record<string, string> {
  const inputs: Record<string, string> = {}
  for (const key of PROMPT_KEYS) {
    const value = answer[key]
    if (typeof value === 'string' && value.length > 0) inputs[key] = value
  }
  return inputs
}

function startUrlField(configStartUrl: string | undefined): Form.StringField {
  return {
    type: 'string',
    key: 'start_url',
    format: 'uri',
    required: false,
    title: 'IAM Identity Center Start URL',
    description: configStartUrl
      ? `IAM Identity Center Start URL (current: ${configStartUrl}, leave blank to keep)`
      : 'IAM Identity Center Start URL (leave blank for AWS Builder ID)',
    placeholder: 'https://your-company.awsapps.com/start'
  }
}

function regionField(configRegion: string | undefined): Form.StringField {
  const hasCustom = configRegion && configRegion !== 'us-east-1'
  return {
    type: 'string',
    key: 'idc_region',
    required: false,
    title: 'IAM Identity Center region (sso_region)',
    description: hasCustom
      ? `IAM Identity Center region (sso_region) (current: ${configRegion}, leave blank to keep)`
      : 'IAM Identity Center region (sso_region) (leave blank for us-east-1)',
    placeholder: 'us-east-1'
  }
}

function profileArnField(configProfileArn: string | undefined): Form.StringField {
  return {
    type: 'string',
    key: 'profile_arn',
    required: !configProfileArn,
    title: 'Profile ARN',
    description: configProfileArn
      ? `Profile ARN (current: ${configProfileArn}, leave blank to keep)`
      : 'Profile ARN (e.g. arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW)',
    placeholder: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX'
  }
}

/**
 * Adapt a v1 `V1IdcAuthorization` into a v2 `IntegrationOAuthAuthorization`.
 *
 * - v1 `method` -> v2 `mode`.
 * - On `{type:'success', ...}` the v1 token set is mapped into a
 *   `Credential.OAuth` (refresh/access/expires), branded with `methodID`.
 * - On `{type:'failed'}` the promise REJECTS so the host surfaces the failure
 *   (v2 has no `{type:'failed'}` sentinel; absence of a credential is an error).
 * - For `mode:'auto'` the v2 `callback` is a `Promise<Credential.OAuth>`,
 *   produced by invoking the v1 auto callback eagerly.
 * - For `mode:'code'` the v2 `callback` is `(code) => Promise<Credential.OAuth>`,
 *   wrapping the v1 code callback.
 */
function adaptAuthorization(
  methodID: string,
  v1: V1IdcAuthorization
): IntegrationOAuthAuthorization {
  const brandedMethodID = Integration.MethodID.make(methodID)

  const toCredential = (result: V1IdcCallbackResult): Credential.OAuth => {
    if (result.type === 'failed') {
      throw new Error('Kiro IDC authorization failed')
    }
    return Credential.OAuth.make({
      type: 'oauth',
      methodID: brandedMethodID,
      refresh: result.refresh,
      access: result.access,
      // `expires` must be a non-negative integer; the device flow yields epoch ms.
      expires: Math.max(0, Math.floor(result.expires))
    })
  }

  const head = {
    url: v1.url,
    instructions: v1.instructions,
    ...(v1.expiresAt !== undefined ? { expiresAt: v1.expiresAt } : {})
  }

  if (v1.method === 'code') {
    const codeCallback = v1.callback
    return {
      ...head,
      mode: 'code',
      callback: async (code: string) => toCredential(await codeCallback(code))
    }
  }

  const autoCallback = v1.callback
  return {
    ...head,
    mode: 'auto',
    callback: autoCallback().then(toCredential)
  }
}

/**
 * Build the v2 integration add-account method registrations for the two Kiro
 * add-account flows:
 *   1. `kiro-auth:idc`             — Builder ID / IAM Identity Center
 *      (prompts: start_url, idc_region)
 *   2. `kiro-auth:idc-profile-arn` — IAM Identity Center with Profile ARN
 *      (prompts: start_url, idc_region, profile_arn)
 *
 * Both are `type:'oauth'` methods whose `authorize(answer)` runs the injected
 * IDC device flow and resolves a `Credential.OAuth`.
 *
 * @returns registrations suitable for `editor.method.update(reg)` (ticket 08).
 */
export function buildKiroIntegrationMethods(
  deps: BuildKiroIntegrationMethodsDeps
): IntegrationOAuthMethodRegistration[] {
  const config = deps.config ?? {}

  const makeAuthorize =
    (methodID: string) =>
    async (answer: Form.Answer): Promise<IntegrationOAuthAuthorization> => {
      const v1 = await deps.authorize(toV1Inputs(answer))
      return adaptAuthorization(methodID, v1)
    }

  const idcForm: Form.Fields = [startUrlField(config.idc_start_url), regionField(config.idc_region)]

  const idcProfileForm: Form.Fields = [
    startUrlField(config.idc_start_url),
    regionField(config.idc_region),
    profileArnField(config.idc_profile_arn)
  ]

  const idcMethodID: KiroAddAccountMethodID = 'kiro-auth:idc'
  const idcProfileMethodID: KiroAddAccountMethodID = 'kiro-auth:idc-profile-arn'

  return [
    {
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: idcMethodID,
        type: 'oauth',
        label: 'Add account · AWS Builder ID / IAM Identity Center',
        form: idcForm
      },
      authorize: makeAuthorize(idcMethodID)
    },
    {
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: idcProfileMethodID,
        type: 'oauth',
        label: 'Add account · IAM Identity Center (with Profile ARN)',
        form: idcProfileForm
      },
      authorize: makeAuthorize(idcProfileMethodID)
    }
  ]
}

/** Exposed for the use site: translate a v2 `Form.Answer` to a single string. */
export { answerString }
