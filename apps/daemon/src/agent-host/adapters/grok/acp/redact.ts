/**
 * ACP client — raw-frame redaction before anything is logged (spec §3.1
 * Observability, §10 "`raw.ndjson` is as sensitive as the repository").
 *
 * Grok is the one provider whose raw stream is a **credential sink**. Straight
 * after `initialize`, unprompted, the agent pushes every MCP server it
 * discovered *including each server's environment*
 * (`apps/daemon/test/fixtures/grok/README.md`, observation 1):
 *
 * ```json
 * {"method":"_x.ai/mcp/servers_updated","params":{"mcpServers":[
 *   {"name":"jira-cloud","env":[{"name":"JIRA_API_TOKEN","value":"<the real token>"}]}]}}
 * ```
 *
 * In the original capture those were the host's real Atlassian token, password
 * and e-mail. Nothing in T3 handles this — it registers no handler for the
 * method, so the frame dies at the adapter — but a raw logger sitting *below*
 * the adapter still persists it. So the frame is redacted **before the line is
 * written**, not after.
 *
 * Two layers:
 * 1. every string goes through `support/stderr.ts`'s `redactStderr` (home
 *    paths → `~`, `Authorization`/`x-api-key` values, `Bearer`, `sk-`/`ghp_`/
 *    `xox*` shapes), which is the same redactor the stderr tail uses; and
 * 2. structural rules for the shapes only Grok has: every MCP server `env`
 *    value, the `authenticate` result's `_meta.email`, and `_meta.agentId`
 *    (a stable per-host identifier — observation 31 says keep it out of logs).
 */

import { redactStderr } from "../../../support/stderr.ts";

/** Sentinel written in place of a redacted value. Matches the fixtures. */
export const REDACTED = "<redacted>";

/** Depth past which a frame is replaced by a marker rather than walked. */
const MAX_DEPTH = 24;
/** Arrays longer than this keep their head; the rest becomes one marker. */
const MAX_ARRAY_ITEMS = 256;

export interface RedactAcpOptions {
  /** Absolute home dirs collapsed to `~`. Longest first is handled inside. */
  homeDirs?: readonly string[];
}

/**
 * Keys whose value is a credential wherever it appears. `value` is NOT in the
 * list — it is far too common — so MCP env is handled structurally below.
 */
const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "authorization",
  "password",
  "secret",
  "token",
  "x-api-key",
  "email",
  "agentid"
]);

/**
 * Deep-copy a frame with every credential-shaped value masked. Pure, and it
 * never throws: a raw writer that throws is a raw writer that takes a turn
 * down with it.
 */
export function redactAcpFrame(frame: unknown, options: RedactAcpOptions = {}): unknown {
  try {
    return walk(frame, options, 0, false);
  } catch {
    return { redactionFailed: true };
  }
}

function walk(value: unknown, options: RedactAcpOptions, depth: number, inMcpEnv: boolean): unknown {
  if (depth > MAX_DEPTH) {
    return "<depth limit>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactStderr(value, { homeDirs: options.homeDirs });
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, options, depth + 1, inMcpEnv));
    if (value.length > MAX_ARRAY_ITEMS) {
      head.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`);
    }
    return head;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    const lower = key.toLowerCase();

    // An MCP server's `env` is an array of {name, value} pairs whose values
    // are the host's real credentials — the whole reason this module exists.
    if (lower === "env" && Array.isArray(item)) {
      out[key] = item.map((entry) => walk(entry, options, depth + 1, true));
      continue;
    }
    if (inMcpEnv && lower === "value") {
      out[key] = REDACTED;
      continue;
    }
    if (SECRET_KEYS.has(lower) && (typeof item === "string" || typeof item === "number")) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = walk(item, options, depth + 1, inMcpEnv);
  }
  return out;
}
