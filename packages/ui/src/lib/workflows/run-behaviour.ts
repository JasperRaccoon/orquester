/**
 * What every block has besides its own settings — disabled, retries, a time
 * limit, a project override, notes — in words for the inspector's "Run
 * behaviour" section, and which time limit a block really obeys.
 *
 * A block can carry a block-level `timeoutMinutes` next to its type's own
 * limit. What the daemon does with it (`blockTimeoutMs` in
 * apps/daemon/src/workflows/run-context.ts and the executors that read it):
 * - Code / Shell: `config.timeoutMinutes` wins; the block-level value is the
 *   fallback before the 30 min default.
 * - HTTP: `config.timeoutSeconds` wins; the block-level value (× 60) is the
 *   fallback before the 5 min default.
 * - Run workflow: only the block-level value (none = no limit).
 * - Agent: the executor stops at `config.maxMinutes` ("Stop after") and never
 *   reads the block-level value; flow blocks, Wait and triggers don't either.
 *
 * Pure.
 */

import { isTriggerType, WORKFLOW_LIMITS, type WorkflowNode } from "@orquester/api";

import { formatMinutes, formatSeconds } from "./durations";

/** The type's own time-limit field, where the inspector shows it. */
export interface OwnLimit {
  field: "config.timeoutMinutes" | "config.timeoutSeconds";
  /** The section of the block's settings that holds it. */
  section: "Limits" | "Response";
  /** Its value, readable ("10 min"); `null` when it is not set. */
  value: string | null;
  /** The type's default when neither is set ("30 min"). */
  fallback: string;
}

export type NodeTimeout =
  /** No block-level limit, and none to offer. */
  | { kind: "none" }
  /** Run workflow: the block-level limit is the one; `max` in minutes. */
  | { kind: "editable"; minutes: number | undefined; max: number }
  /** Code / Shell / HTTP whose own limit is unset: the block-level value is in effect. */
  | { kind: "in-effect"; minutes: number; own: OwnLimit }
  /** Code / Shell / HTTP whose own limit is set: the block-level value is ignored. */
  | { kind: "overridden"; minutes: number; own: OwnLimit }
  /** A block that never reads the block-level value (Agent, flow blocks, Wait, triggers). */
  | { kind: "unused"; minutes: number };

function ownLimitOf(node: WorkflowNode): OwnLimit | null {
  switch (node.type) {
    case "code":
    case "shell": {
      const value = node.config.timeoutMinutes;
      return {
        field: "config.timeoutMinutes",
        section: "Limits",
        value: value === undefined ? null : formatMinutes(value),
        fallback: formatMinutes(WORKFLOW_LIMITS.processTimeoutMinutes.default)
      };
    }
    case "http": {
      const value = node.config.timeoutSeconds;
      return {
        field: "config.timeoutSeconds",
        section: "Response",
        value: value === undefined ? null : formatSeconds(value),
        fallback: formatSeconds(WORKFLOW_LIMITS.httpTimeoutSeconds.default)
      };
    }
    default:
      return null;
  }
}

/** Which time limit governs `node`, and what the block-level `timeoutMinutes` means for it. */
export function nodeTimeout(node: WorkflowNode): NodeTimeout {
  const minutes = typeof node.timeoutMinutes === "number" ? node.timeoutMinutes : undefined;
  if (node.type === "workflow") return { kind: "editable", minutes, max: WORKFLOW_LIMITS.processTimeoutMinutes.max };
  if (minutes === undefined) return { kind: "none" };
  const own = ownLimitOf(node);
  if (own === null) return { kind: "unused", minutes };
  return own.value === null ? { kind: "in-effect", minutes, own } : { kind: "overridden", minutes, own };
}

/**
 * The block-level limit moved into the type's own field, as the daemon applies
 * it today (capped at the type's maximum): `{ timeoutMinutes }` for Code /
 * Shell, `{ timeoutSeconds }` for HTTP; `null` for other types.
 */
export function movedTimeoutPatch(node: WorkflowNode): { timeoutMinutes: number } | { timeoutSeconds: number } | null {
  const minutes = node.timeoutMinutes;
  if (typeof minutes !== "number" || minutes <= 0) return null;
  switch (node.type) {
    case "code":
    case "shell":
      return { timeoutMinutes: Math.min(minutes, WORKFLOW_LIMITS.processTimeoutMinutes.max) };
    case "http":
      return { timeoutSeconds: Math.min(minutes * 60, WORKFLOW_LIMITS.httpTimeoutSeconds.max) };
    default:
      return null;
  }
}

/** "Up to 3 tries, 30 s apart"; "No retries" without a retry setting. */
export function retryText(retry: WorkflowNode["retry"]): string {
  if (!retry) return "No retries";
  const tries = Math.max(1, Math.floor(retry.maxTries));
  if (tries <= 1) return "1 try (no retries)";
  const delay = retry.delaySeconds > 0 ? `${formatSeconds(retry.delaySeconds)} apart` : "no pause";
  return `Up to ${tries} tries, ${delay}`;
}

/** Whether "Run in another project" applies to this type (the ones that work in a project folder). */
export function takesProjectOverride(type: WorkflowNode["type"]): boolean {
  return type === "agent" || type === "code" || type === "shell";
}

/** A project path's last segment ("/w/ws/app" → "app"). */
export function projectLabel(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * The one line under a collapsed "Run behaviour": "Disabled · Up to 3 tries,
 * 30 s apart · Time limit 2 h · Runs in app · Has notes". Triggers: "Enabled"
 * or "Disabled", then notes.
 */
export function runBehaviourSummary(node: WorkflowNode): string {
  const parts: string[] = [];
  if (isTriggerType(node.type)) {
    parts.push(node.disabled ? "Disabled — never fires" : "Enabled");
  } else {
    if (node.disabled) parts.push("Disabled");
    parts.push(retryText(node.retry));
    const timeout = nodeTimeout(node);
    if (timeout.kind === "editable") parts.push(timeout.minutes === undefined ? "No time limit" : `Time limit ${formatMinutes(timeout.minutes)}`);
    else if (timeout.kind === "in-effect") parts.push(`Time limit ${formatMinutes(timeout.minutes)} (older setting)`);
    else if (timeout.kind === "overridden" || timeout.kind === "unused") parts.push("Unused time limit");
    if (node.projectOverride) parts.push(`Runs in ${projectLabel(node.projectOverride)}`);
  }
  if (node.notes?.trim()) parts.push("Has notes");
  return parts.join(" · ");
}
