import { GROK_OIDC_ISSUER, GROK_OIDC_CLIENT_ID } from "./agent-account-refresh.ts";
import { decodeJwtPayload } from "./agent-account-identity.ts";

/**
 * Direct RFC 8628 device-code login against xAI's OIDC issuer — the same
 * standard flow (endpoints, client id, grant) the grok CLI's own
 * `grok login --device-auth` performs, so linking a Grok account does NOT
 * depend on the model proxy being enabled. Verified live against
 * `auth.x.ai/.well-known/openid-configuration` (2026-08-06): device endpoint
 * `/oauth2/device/code`, token endpoint `/oauth2/token`, standard
 * `authorization_pending`/`slow_down` polling semantics.
 */

const DEVICE_CODE_URL = `${GROK_OIDC_ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${GROK_OIDC_ISSUER}/oauth2/token`;
/** offline_access → refresh token; openid/profile/email → id_token identity;
 *  grok-cli:access → the scope the Grok CLI's API calls ride on. */
const DEVICE_SCOPE = "openid profile email offline_access grok-cli:access";
const REQUEST_TIMEOUT_MS = 10_000;

export interface GrokDevicePrompt {
  url: string;
  userCode: string;
  /** Opaque polling handle — never shown to the user. */
  deviceCode: string;
  /** Server-mandated minimum seconds between polls (RFC 8628 `interval`). */
  intervalSec: number;
  expiresIn: number;
}

export interface GrokDeviceTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  id_token?: string;
}

export type GrokDeviceStart =
  | { ok: true; value: GrokDevicePrompt }
  | { ok: false; error: string; status?: number };

export type GrokDevicePoll =
  | { status: "wait"; slowDown?: boolean }
  | { status: "ok"; tokens: GrokDeviceTokens }
  | { status: "error"; error: string };

/** Injected into the manager so tests never touch the network. */
export interface GrokDeviceAuth {
  start(): Promise<GrokDeviceStart>;
  poll(deviceCode: string): Promise<GrokDevicePoll>;
}

async function form(
  url: string,
  fields: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const httpGrokDeviceAuth: GrokDeviceAuth = {
  async start() {
    const res = await form(DEVICE_CODE_URL, { client_id: GROK_OIDC_CLIENT_ID, scope: DEVICE_SCOPE });
    if ("error" in res) return { ok: false, error: res.error };
    const b = res.body;
    const deviceCode = typeof b.device_code === "string" ? b.device_code : "";
    const userCode = typeof b.user_code === "string" ? b.user_code : "";
    const url =
      typeof b.verification_uri_complete === "string" && b.verification_uri_complete
        ? b.verification_uri_complete
        : typeof b.verification_uri === "string"
          ? b.verification_uri
          : "";
    if (res.status < 200 || res.status >= 300 || !deviceCode || !url) {
      const detail = typeof b.error === "string" ? b.error : `HTTP ${res.status}`;
      return { ok: false, error: `xAI device authorization failed: ${detail}`, status: res.status };
    }
    return {
      ok: true,
      value: {
        url,
        userCode,
        deviceCode,
        intervalSec: typeof b.interval === "number" && b.interval > 0 ? b.interval : 5,
        expiresIn: typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 1800
      }
    };
  },

  async poll(deviceCode) {
    const res = await form(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: GROK_OIDC_CLIENT_ID
    });
    // A transient network failure is not a verdict — keep waiting.
    if ("error" in res) return { status: "wait" };
    const b = res.body;
    if (res.status >= 200 && res.status < 300) {
      const accessToken = typeof b.access_token === "string" ? b.access_token : "";
      const refreshToken = typeof b.refresh_token === "string" ? b.refresh_token : "";
      if (!accessToken || !refreshToken) {
        return { status: "error", error: "xAI returned no usable token pair" };
      }
      return {
        status: "ok",
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          ...(typeof b.expires_in === "number" ? { expires_in: b.expires_in } : {}),
          ...(typeof b.id_token === "string" && b.id_token ? { id_token: b.id_token } : {})
        }
      };
    }
    const code = typeof b.error === "string" ? b.error : "";
    if (code === "authorization_pending") return { status: "wait" };
    if (code === "slow_down") return { status: "wait", slowDown: true };
    const description = typeof b.error_description === "string" && b.error_description ? b.error_description : code;
    return { status: "error", error: description || `HTTP ${res.status}` };
  }
};

/**
 * Build the grok CLI's native `auth.json` from a completed device grant, ready
 * for `AgentAccountsService.importAccount`. Identity (email/user_id) comes from
 * the id_token claims when present — cosmetic only (it feeds the account label);
 * the CLI treats profile fields as optional (verified against the real binary).
 */
export function grokAuthJsonFromDeviceTokens(
  tokens: GrokDeviceTokens,
  now: number = Date.now()
): Record<string, unknown> {
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const email =
    claims && typeof claims.email === "string" && claims.email
      ? claims.email
      : accessClaims && typeof accessClaims.email === "string"
        ? accessClaims.email
        : undefined;
  const sub =
    claims && typeof claims.sub === "string" && claims.sub
      ? claims.sub
      : accessClaims && typeof accessClaims.sub === "string"
        ? accessClaims.sub
        : undefined;
  const entry: Record<string, unknown> = {
    key: tokens.access_token,
    auth_mode: "oidc",
    refresh_token: tokens.refresh_token,
    create_time: new Date(now).toISOString(),
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: GROK_OIDC_CLIENT_ID
  };
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) {
    entry.expires_at = new Date(now + tokens.expires_in * 1000).toISOString();
  }
  if (email) entry.email = email;
  if (sub) entry.user_id = sub;
  return { [`${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`]: entry };
}
