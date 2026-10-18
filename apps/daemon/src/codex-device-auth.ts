import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from "./agent-account-refresh.ts";
import { decodeJwtPayload } from "./agent-account-identity.ts";
import type { DeviceAuth } from "./device-link.ts";

/**
 * The device-code login the codex CLI's own `codex login --device-auth`
 * performs (codex-rs `login/src/device_code_auth.rs`; endpoints read from the
 * 0.159 binary and the user-code response shape verified live, 2026-10-18).
 * Not RFC 8628: auth.openai.com issues a `device_auth_id` + user code, the poll
 * answers 403/404 until the user approves on `/codex/device`, then hands back
 * an authorization code with its PKCE verifier, which is exchanged at the
 * ordinary token endpoint against the `/deviceauth/callback` redirect.
 */

const ISSUER = "https://auth.openai.com";
const USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const VERIFICATION_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
/** The CLI gives up after 15 minutes when the server names no expiry. */
const DEFAULT_EXPIRES_IN_SEC = 15 * 60;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CodexDeviceHandle {
  deviceAuthId: string;
  userCode: string;
}

export interface CodexDeviceTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

async function post(
  url: string,
  body: string,
  contentType: string
): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A provider error body's most readable reason. */
function reason(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (typeof error === "string" && error) return str(body.error_description) || error;
  if (error && typeof error === "object") {
    const message = str((error as Record<string, unknown>).message);
    if (message) return message;
  }
  return `HTTP ${status}`;
}

export const httpCodexDeviceAuth: DeviceAuth<CodexDeviceHandle, CodexDeviceTokens> = {
  async start() {
    const res = await post(USER_CODE_URL, JSON.stringify({ client_id: CODEX_CLIENT_ID }), "application/json");
    if ("error" in res) return { ok: false, error: res.error };
    const b = res.body;
    const deviceAuthId = str(b.device_auth_id);
    const userCode = str(b.user_code) || str(b.usercode);
    // The CLI reads a 404 here as the server not offering device login.
    if (res.status === 404) {
      return { ok: false, error: "OpenAI device code login is not enabled; import a Codex auth.json instead.", status: 404 };
    }
    if (res.status < 200 || res.status >= 300 || !deviceAuthId || !userCode) {
      return { ok: false, error: `OpenAI device authorization failed: ${reason(b, res.status)}`, status: res.status };
    }
    // The server sends `interval` as a numeric string.
    const interval = Number(b.interval);
    const expiresAtMs = Date.parse(str(b.expires_at));
    const expiresIn = Number.isFinite(expiresAtMs)
      ? Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000))
      : DEFAULT_EXPIRES_IN_SEC;
    return {
      ok: true,
      value: {
        url: VERIFICATION_URL,
        userCode,
        handle: { deviceAuthId, userCode },
        intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 5,
        expiresIn
      }
    };
  },

  async poll(handle) {
    const res = await post(
      POLL_URL,
      JSON.stringify({ device_auth_id: handle.deviceAuthId, user_code: handle.userCode }),
      "application/json"
    );
    // A transient network failure is not a verdict — keep waiting.
    if ("error" in res) return { status: "wait" };
    // Not approved yet.
    if (res.status === 403 || res.status === 404) return { status: "wait" };
    if (res.status < 200 || res.status >= 300) {
      return { status: "error", error: `OpenAI device authorization failed: ${reason(res.body, res.status)}` };
    }
    const code = str(res.body.authorization_code);
    const verifier = str(res.body.code_verifier);
    if (!code || !verifier) return { status: "error", error: "OpenAI returned no authorization code" };

    const exchange = await post(
      CODEX_TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CODEX_CLIENT_ID,
        code_verifier: verifier
      }).toString(),
      "application/x-www-form-urlencoded"
    );
    // The authorization code is single-use: a failed exchange is final.
    if ("error" in exchange) return { status: "error", error: `OpenAI token exchange failed: ${exchange.error}` };
    const b = exchange.body;
    if (exchange.status < 200 || exchange.status >= 300) {
      return { status: "error", error: `OpenAI token exchange failed: ${reason(b, exchange.status)}` };
    }
    const tokens = { id_token: str(b.id_token), access_token: str(b.access_token), refresh_token: str(b.refresh_token) };
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
      return { status: "error", error: "OpenAI returned no usable token set" };
    }
    return { status: "ok", tokens };
  }
};

/**
 * Build the codex CLI's native `auth.json` from a completed device login, ready
 * for `AgentAccountsService.importAccount` — the shape `codex login` writes. The
 * ChatGPT account id comes from the id_token's OpenAI auth claim.
 */
export function codexAuthJsonFromDeviceTokens(
  tokens: CodexDeviceTokens,
  now: number = Date.now()
): Record<string, unknown> {
  const claims = decodeJwtPayload(tokens.id_token);
  const auth = claims?.["https://api.openai.com/auth"];
  const accountId =
    auth && typeof auth === "object" ? str((auth as Record<string, unknown>).chatgpt_account_id) : "";
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(accountId ? { account_id: accountId } : {})
    },
    last_refresh: new Date(now).toISOString()
  };
}
