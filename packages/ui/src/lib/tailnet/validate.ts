/**
 * Tailnet — wire validation for `tailnetRoutes` answers and `TAILNET_CHANGED_EVENT` payloads before
 * they reach Settings → Server (tailnet machines spec 2026-11-22 §4.7).
 *
 * A broken envelope (not an object, no serve state) makes the answer `null`; a preview this client
 * cannot read is left out on its own; a problem with a code this client doesn't know keeps its
 * message and fix. Unknown fields are ignored. No React, no store.
 */

import {
  isMachineProblemCode,
  type MachineProblem,
  type TailnetChangedPayload,
  type TailnetHttpsStatus,
  type TailnetPreviewShare,
  type TailnetServeState
} from "@orquester/api";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
const SERVE_STATES: ReadonlySet<string> = new Set<TailnetServeState>(["off", "serving", "repairing", "taken", "failed"]);

/** A problem's message and fix; an unknown code (a newer daemon) reads as a failed serve change. */
export function parseMachineProblem(value: unknown): MachineProblem | undefined {
  if (!isRecord(value)) return undefined;
  const message = text(value.message);
  if (!message) return undefined;
  const fix = text(value.fix);
  return { code: isMachineProblemCode(value.code) ? value.code : "tailscale-serve-failed", message, ...(fix ? { fix } : {}) };
}

export function parseTailnetHttpsStatus(value: unknown): TailnetHttpsStatus | null {
  if (!isRecord(value) || typeof value.serveState !== "string" || !SERVE_STATES.has(value.serveState)) return null;
  const url = text(value.url);
  const problem = parseMachineProblem(value.problem);
  return {
    available: value.available === true,
    url: url && /^https:\/\//.test(url) ? url : null,
    operatorOk: value.operatorOk === true,
    serveState: value.serveState as TailnetServeState,
    port: isPort(value.port) ? value.port : 10000,
    checkedAt: text(value.checkedAt),
    ...(problem ? { problem } : {})
  };
}

function parsePreview(value: unknown): TailnetPreviewShare | null {
  if (!isRecord(value) || !isPort(value.port)) return null;
  const url = text(value.url);
  if (!url || !/^https:\/\//.test(url)) return null;
  return { port: value.port, url, threadId: text(value.threadId), createdAt: text(value.createdAt) ?? "" };
}

/** The readable previews of a `{ previews }` answer, or null when it is not one. */
export function parseTailnetPreviews(value: unknown): TailnetPreviewShare[] | null {
  if (!isRecord(value) || !Array.isArray(value.previews)) return null;
  return value.previews.flatMap((entry) => {
    const preview = parsePreview(entry);
    return preview ? [preview] : [];
  });
}

/** `POST tailnetRoutes.previews`'s `{ preview }`. */
export function parseTailnetPreviewResponse(value: unknown): TailnetPreviewShare | null {
  return isRecord(value) ? parsePreview(value.preview) : null;
}

export function parseTailnetChanged(value: unknown): TailnetChangedPayload | null {
  if (!isRecord(value)) return null;
  const https = parseTailnetHttpsStatus(value.https);
  const previews = parseTailnetPreviews(value);
  return https && previews ? { https, previews } : null;
}

/** The problem a refused tailnet request carries (`409 TAILNET_PROBLEM` bodies), if any. */
export function problemOfError(error: unknown): MachineProblem | undefined {
  const body = (error as { body?: unknown } | null)?.body;
  return isRecord(body) ? parseMachineProblem(body.problem) : undefined;
}
