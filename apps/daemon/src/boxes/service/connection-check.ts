/**
 * The connection Check's words: why a box could not reach `<url>` (fetch's "fetch failed" says
 * nothing; its `cause` chain carries the socket, DNS or TLS error), and what to do about it.
 */

import type { BoxConnectionMode, BoxLocalTailscale } from "@orquester/api";

import { errorLine } from "./errors.ts";

export type CheckFailureKind = "dns" | "refused" | "timeout" | "certificate" | "reset" | "other";

const CERTIFICATE_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_NOT_YET_VALID"
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "ABORT_ERR"]);

/** Every error in `error`'s cause chain (and an AggregateError's members), outermost first. */
function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.length < 16) {
    const next = queue.shift();
    if (next === undefined || next === null || seen.includes(next)) continue;
    seen.push(next);
    if (typeof next === "object") {
      const record = next as { cause?: unknown; errors?: unknown };
      if (record.cause !== undefined) queue.push(record.cause);
      if (Array.isArray(record.errors)) queue.push(...record.errors);
    }
  }
  return seen;
}

/** What went wrong under a failed fetch, from the codes, names and messages of its causes. */
export function classifyFetchError(error: unknown): { kind: CheckFailureKind; detail: string } {
  const errors = chain(error);
  const codes = errors.map((item) => (item as { code?: unknown } | null)?.code).filter((code): code is string => typeof code === "string");
  const names = errors.map((item) => (item as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === "string");
  const messages = errors.map((item) => (item instanceof Error ? item.message : typeof item === "string" ? item : "")).filter(Boolean);
  const innermost = errors[errors.length - 1];
  const detail = errorLine(innermost ?? error);
  const has = (test: (code: string) => boolean) => codes.some(test);
  const said = (pattern: RegExp) => messages.some((message) => pattern.test(message));
  if (has((code) => code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME")) return { kind: "dns", detail };
  if (has((code) => CERTIFICATE_CODES.has(code) || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_CERT")) || said(/certificate/i)) {
    return { kind: "certificate", detail };
  }
  if (has((code) => code === "ECONNREFUSED")) return { kind: "refused", detail };
  if (has((code) => TIMEOUT_CODES.has(code)) || names.some((name) => name === "TimeoutError" || name === "AbortError") || said(/timed? ?out/i)) {
    return { kind: "timeout", detail };
  }
  if (has((code) => code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") || said(/socket hang up|other side closed/i)) {
    return { kind: "reset", detail };
  }
  return { kind: "other", detail };
}

export interface CheckContext {
  mode: BoxConnectionMode;
  /** Tailscale on this machine, when known. */
  local: BoxLocalTailscale | null;
  /** The daemon's local HTTP port, when known (the reverse proxy remedy names it). */
  daemonPort: number | null;
}

function hostPort(url: string): { host: string; port: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parsed.port || (parsed.protocol === "http:" ? "80" : "443") };
  } catch {
    return { host: url, port: "443" };
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What to do next, or null when there is nothing specific to say. */
export function checkRemedy(url: string, kind: CheckFailureKind | "status", context: CheckContext): string | null {
  const { host } = hostPort(url);
  if (context.mode === "tailscale") {
    const local = context.local;
    if (!local) return null;
    if (!local.installed) return "Tailscale isn't installed on this machine.";
    if (!local.running) return "Tailscale isn't running on this machine.";
    if (!local.serving) return local.serveCommand ? `Click "Set up for me" or run: ${local.serveCommand}` : null;
    if (local.suggestedUrl && !sameOrigin(url, local.suggestedUrl)) return `Tailscale serves Orquester at ${local.suggestedUrl} — use that URL.`;
    return null;
  }
  if (kind === "dns") return `Point the DNS record for ${host} at this server.`;
  const target = context.daemonPort ? `this daemon on 127.0.0.1:${context.daemonPort}` : "this daemon's port";
  return `Make sure the reverse proxy (e.g. Caddy) for ${host} forwards to ${target}.`;
}

/** The Check's message for a fetch that threw. */
export function fetchFailureMessage(url: string, error: unknown, context: CheckContext): string {
  const { kind, detail } = classifyFetchError(error);
  const { host, port } = hostPort(url);
  let message: string;
  switch (kind) {
    case "dns":
      message = `${host} is not reachable: the name doesn't resolve from this machine.`;
      break;
    case "refused":
      message = `${url} is not reachable: nothing listens on ${host}:${port}.`;
      break;
    case "timeout":
      message = `${url} is not reachable: no answer within 15 s.`;
      break;
    case "certificate":
      message = `The server at ${host}:${port} presented a certificate that isn't for ${host} — something other than Orquester answers on that port.`;
      break;
    case "reset":
      message = `${url} is not reachable: the connection was closed during the handshake.`;
      break;
    default:
      message = `${url} is not reachable: ${detail}`;
  }
  const remedy = checkRemedy(url, kind, context);
  return remedy ? `${message} ${remedy}` : message;
}

/** The Check's message for an answer other than Orquester's 401. */
export function statusFailureMessage(url: string, status: number, context: CheckContext): string {
  const message = `${url} answered ${status} — that's not Orquester (expected its 401).`;
  const remedy = checkRemedy(url, "status", context);
  return remedy ? `${message} ${remedy}` : message;
}
