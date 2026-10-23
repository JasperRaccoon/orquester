/**
 * The Connection card (spec §6): how boxes reach this daemon — its public
 * HTTPS address, or Tailscale (an API token or an OAuth client, and the
 * daemon's tailnet address). The form edits a draft; Save sends only what
 * changed, and secrets only when typed (they are write-only).
 */

import type { BoxConnectionMode, BoxConnectionSettings, SetBoxConnectionRequest } from "@orquester/api";

import { boxesErrorText } from "../../../lib/boxes/errors";
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
  /** The Tailscale federated identity macOS runners join the tailnet with (not secret). */
  workloadClientId: string;
  workloadAudience: string;
}

export function connectionDraft(settings: BoxConnectionSettings | null): ConnectionDraft {
  return {
    mode: settings?.mode ?? "public-url",
    publicUrl: settings?.publicUrl ?? "",
    daemonUrl: settings?.tailscale.daemonUrl ?? "",
    credentialKind: "api-token",
    apiToken: "",
    oauthClientId: "",
    oauthClientSecret: "",
    workloadClientId: settings?.tailscale.workloadIdentity?.clientId ?? "",
    workloadAudience: settings?.tailscale.workloadIdentity?.audience ?? ""
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
): Partial<Record<"publicUrl" | "daemonUrl" | "apiToken" | "oauthClientId" | "oauthClientSecret" | "workloadClientId" | "workloadAudience", string>> {
  const problems: ReturnType<typeof connectionProblems> = {};
  if (draft.mode === "public-url") {
    const problem = httpsUrlProblem(draft.publicUrl, "public URL");
    if (problem) problems.publicUrl = problem;
    return problems;
  }
  // Tailscale mode: the public URL is optional (macOS boxes dial it when set).
  if (draft.publicUrl.trim()) {
    const problem = httpsUrlProblem(draft.publicUrl, "public URL");
    if (problem) problems.publicUrl = problem;
  }
  const workloadId = draft.workloadClientId.trim();
  const workloadAudience = draft.workloadAudience.trim();
  const workloadValue = /^[A-Za-z0-9._:/-]{1,200}$/;
  if (workloadId && !workloadValue.test(workloadId)) problems.workloadClientId = "Letters, digits and . _ : / - only.";
  else if (!workloadId && workloadAudience) problems.workloadClientId = "Enter the client ID too.";
  if (workloadAudience && !workloadValue.test(workloadAudience)) problems.workloadAudience = "Letters, digits and . _ : / - only.";
  else if (workloadId && !workloadAudience) problems.workloadAudience = "Enter the audience too.";
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
    const publicUrl = draft.publicUrl.trim();
    if (publicUrl !== (settings?.publicUrl ?? "")) req.publicUrl = publicUrl || null;
    const workloadId = draft.workloadClientId.trim();
    const workloadAudience = draft.workloadAudience.trim();
    const identity = settings?.tailscale.workloadIdentity ?? null;
    if (workloadId !== (identity?.clientId ?? "") || workloadAudience !== (identity?.audience ?? "")) {
      req.tailscaleWorkloadClientId = workloadId || null;
      req.tailscaleWorkloadAudience = workloadAudience || null;
    }
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

/** Tailscale on the daemon's machine, as the Tailscale mode shows it. */
export interface TailscaleLocalView {
  /** The status line; null when the daemon does not report it (older daemons). */
  status: string | null;
  tone: Tone;
  /** Offer "Use <url>": the address Tailscale serves (or would serve) Orquester at, when the field holds another. */
  suggestion: string | null;
  /** Offer "Set up for me": Tailscale runs here but does not serve Orquester yet. */
  canSetUp: boolean;
}

function sameUrl(a: string, b: string): boolean {
  const trim = (value: string) => value.trim().replace(/\/+$/, "");
  try {
    return new URL(trim(a)).href === new URL(trim(b)).href;
  } catch {
    return trim(a) === trim(b);
  }
}

export function tailscaleLocalView(settings: BoxConnectionSettings | null, daemonUrl: string): TailscaleLocalView {
  const local = settings?.tailscale.local;
  if (!local) return { status: null, tone: "neutral", suggestion: null, canSetUp: false };
  if (!local.installed) return { status: "Tailscale isn't installed on this machine.", tone: "warn", suggestion: null, canSetUp: false };
  if (!local.running) return { status: "Tailscale isn't running on this machine.", tone: "warn", suggestion: null, canSetUp: false };
  const name = local.dnsName ?? local.tailnetIp ?? "this machine";
  const suggestion = local.suggestedUrl && !sameUrl(local.suggestedUrl, daemonUrl) ? local.suggestedUrl : null;
  if (local.serving) {
    return { status: `Tailscale on this machine: ${name} · serving Orquester on :${local.servePort}`, tone: "ok", suggestion, canSetUp: false };
  }
  return { status: `Tailscale on this machine: ${name} · not serving Orquester yet`, tone: "warn", suggestion, canSetUp: true };
}

/** Why "Set up for me" failed, and the commands that fix it (409 `BOX_TAILSCALE_NEEDS_PERMISSION`). */
export function tailscaleSetupFailure(err: unknown): { message: string; commands: string[] } {
  const body = (err as { body?: unknown } | null)?.body;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const commands =
    record.code === "BOX_TAILSCALE_NEEDS_PERMISSION" && Array.isArray(record.commands)
      ? record.commands.filter((command): command is string => typeof command === "string" && command.length > 0 && command.length < 500).slice(0, 4)
      : [];
  return { message: boxesErrorText(err, "Tailscale could not be set up."), commands };
}
