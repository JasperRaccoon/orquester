/**
 * The Connection card (spec §6): how boxes reach this daemon — its public
 * HTTPS address, or Tailscale (an API token or an OAuth client, and the
 * daemon's tailnet address). The form edits a draft; Save sends only what
 * changed, and secrets only when typed (they are write-only).
 */

import type { BoxConnectionMode, BoxConnectionSettings, SetBoxConnectionRequest } from "@orquester/api";

import type { Tone } from "../../settings/primitives";

export type TailscaleCredentialKind = "api-token" | "oauth";

export interface ConnectionDraft {
  mode: BoxConnectionMode;
  publicUrl: string;
  daemonUrl: string;
  credentialKind: TailscaleCredentialKind;
  apiToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

export function connectionDraft(settings: BoxConnectionSettings | null): ConnectionDraft {
  return {
    mode: settings?.mode ?? "public-url",
    publicUrl: settings?.publicUrl ?? "",
    daemonUrl: settings?.tailscale.daemonUrl ?? "",
    credentialKind: "api-token",
    apiToken: "",
    oauthClientId: "",
    oauthClientSecret: ""
  };
}

/** Why `value` is not an HTTPS origin boxes can dial, or null. */
export function httpsUrlProblem(value: string, what: string): string | null {
  const text = value.trim();
  if (!text) return `Enter the ${what}.`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `The ${what} is not a URL.`;
  }
  if (url.protocol !== "https:") return `The ${what} must start with https://.`;
  if (url.username || url.password) return `The ${what} must not carry a user name or password.`;
  if (url.search || url.hash) return `The ${what} must not have a query or fragment.`;
  return null;
}

/** Field → problem; empty when the draft can be saved. */
export function connectionProblems(
  draft: ConnectionDraft,
  settings: BoxConnectionSettings | null
): Partial<Record<"publicUrl" | "daemonUrl" | "apiToken" | "oauthClientId" | "oauthClientSecret", string>> {
  const problems: ReturnType<typeof connectionProblems> = {};
  if (draft.mode === "public-url") {
    const problem = httpsUrlProblem(draft.publicUrl, "public URL");
    if (problem) problems.publicUrl = problem;
    return problems;
  }
  const daemonUrl = httpsUrlProblem(draft.daemonUrl, "tailnet address");
  if (daemonUrl) problems.daemonUrl = daemonUrl;
  const stored = settings?.tailscale.configured ?? false;
  if (draft.credentialKind === "api-token") {
    const token = draft.apiToken.trim();
    if (!token && !stored) problems.apiToken = "Enter a Tailscale API access token.";
    else if (/\s/.test(token)) problems.apiToken = "The token must not contain spaces.";
  } else {
    const id = draft.oauthClientId.trim();
    const secret = draft.oauthClientSecret.trim();
    // Both or neither (neither keeps the stored credentials).
    if (id || secret || !stored) {
      if (!id) problems.oauthClientId = "Enter the OAuth client ID.";
      if (!secret) problems.oauthClientSecret = "Enter the OAuth client secret.";
    }
  }
  return problems;
}

/**
 * The `PUT boxRoutes.connection` body for what the draft changed, or null
 * when nothing changed or a problem remains.
 */
export function connectionRequest(
  draft: ConnectionDraft,
  settings: BoxConnectionSettings | null
): SetBoxConnectionRequest | null {
  if (Object.keys(connectionProblems(draft, settings)).length > 0) return null;
  const req: SetBoxConnectionRequest = {};
  if (draft.mode !== (settings?.mode ?? null)) req.mode = draft.mode;
  if (draft.mode === "public-url") {
    const publicUrl = draft.publicUrl.trim();
    if (publicUrl !== (settings?.publicUrl ?? "")) req.publicUrl = publicUrl;
  } else {
    const daemonUrl = draft.daemonUrl.trim();
    if (daemonUrl !== (settings?.tailscale.daemonUrl ?? "")) req.tailscaleDaemonUrl = daemonUrl;
    if (draft.credentialKind === "api-token") {
      const token = draft.apiToken.trim();
      if (token) req.tailscaleApiToken = token;
    } else {
      const id = draft.oauthClientId.trim();
      const secret = draft.oauthClientSecret.trim();
      if (id && secret) {
        req.tailscaleOAuthClientId = id;
        req.tailscaleOAuthClientSecret = secret;
      }
    }
  }
  return Object.keys(req).length > 0 ? req : null;
}

/** The "Check" result pill. */
export function reachabilityView(settings: BoxConnectionSettings | null): { tone: Tone; label: string; title: string | null } {
  switch (settings?.reachable) {
    case "ok":
      return { tone: "ok", label: "Reachable", title: settings.reachableMessage };
    case "failed":
      return { tone: "danger", label: "Unreachable", title: settings.reachableMessage };
    default:
      return { tone: "neutral", label: "Not checked", title: null };
  }
}
