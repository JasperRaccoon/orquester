/**
 * Reading an account failure off a thread (workflows §5.4).
 *
 * The workflow engine's account failover must know "this account hit its
 * usage limit" and "this account's login was refused" without matching
 * message text. Every adapter now stamps `reason` (and, when the provider
 * says, `resetsAt`) on the `runtime.error` / `runtime.warning` it raises at
 * exactly the branch where it already knew, and ingestion carries both onto
 * the persisted activity payload. This module is the one reader.
 *
 * **The legacy fallback.** A row written by a host from before the field has
 * no `reason`. For that case ONLY — a payload whose `reason` is absent — a
 * documented, tested set of message prefixes the adapters have always
 * written is recognised ({@link LEGACY_FAILURE_PREFIXES}). A payload that
 * carries a `reason` is never second-guessed by its text, and an unknown
 * `reason` (a newer host's) is not an account failure this reader knows.
 */

import type { RuntimeFailureReason } from "./runtime-events.ts";
import type { ThreadActivityItem, ThreadActivityTone } from "./thread.ts";

export interface ActivityFailureReason {
  reason: RuntimeFailureReason;
  /** ISO time the limit resets, when the provider said. */
  resetsAt?: string;
  /** The row's own message (its summary when the payload carries none). */
  message: string;
  tone: ThreadActivityTone;
  /** True when the reason was read off a legacy message prefix, not the field. */
  legacy: boolean;
}

/** The activity kinds an adapter's account failure is written as. */
const FAILURE_ACTIVITY_KINDS: ReadonlySet<string> = new Set(["runtime.error", "runtime.warning"]);

const FAILURE_REASONS: ReadonlySet<string> = new Set<RuntimeFailureReason>(["usage_limit", "auth"]);

/**
 * The message prefixes hosts from before the `reason` field wrote for an
 * account failure — each an adapter's own constant sentence, never provider
 * text:
 *
 * - `Claude usage limit reached.` — the Claude adapter's parked-turn warning
 *   (`describeUsageLimit`) and its failed-result hint.
 * - `Grok usage limit reached.` — the Grok adapter's `rate_limit` stop.
 * - `Claude is not logged in` — the Claude adapter's `authentication_failed`
 *   hint.
 *
 * Read only when a row carries no `reason` at all.
 */
const LEGACY_FAILURE_PREFIXES: ReadonlyArray<{
  prefix: string;
  reason: RuntimeFailureReason;
}> = [
  { prefix: "Claude usage limit reached.", reason: "usage_limit" },
  { prefix: "Grok usage limit reached.", reason: "usage_limit" },
  { prefix: "Claude is not logged in", reason: "auth" }
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * A legacy Claude parked-turn warning carried the CLI's `rate_limit_info` as
 * its `detail`, whose `resetsAt` is epoch SECONDS — structured, so the reset
 * is still known for a row written before the field.
 */
function legacyResetsAt(detail: unknown): string | undefined {
  const info = asRecord(detail);
  const seconds = info?.resetsAt;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The account failure one activity names, or `null`. Only `runtime.error` /
 * `runtime.warning` rows can name one.
 */
export function failureReasonOfActivity(
  activity: ThreadActivityItem
): ActivityFailureReason | null {
  if (!FAILURE_ACTIVITY_KINDS.has(activity.activityKind)) {
    return null;
  }
  const payload = asRecord(activity.payload) ?? {};
  const message =
    typeof payload.message === "string" && payload.message.length > 0
      ? payload.message
      : activity.summary;

  if ("reason" in payload && payload.reason !== undefined) {
    if (typeof payload.reason !== "string" || !FAILURE_REASONS.has(payload.reason)) {
      return null;
    }
    const resetsAt = isoOrUndefined(payload.resetsAt);
    return {
      reason: payload.reason as RuntimeFailureReason,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      message,
      tone: activity.tone,
      legacy: false
    };
  }

  const legacy = LEGACY_FAILURE_PREFIXES.find((entry) => message.startsWith(entry.prefix));
  if (legacy === undefined) {
    return null;
  }
  const resetsAt = legacy.reason === "usage_limit" ? legacyResetsAt(payload.detail) : undefined;
  return {
    reason: legacy.reason,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    message,
    tone: activity.tone,
    legacy: true
  };
}
