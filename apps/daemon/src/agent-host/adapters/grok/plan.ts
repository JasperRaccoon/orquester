/**
 * Grok adapter — plan mode and proposed plans (spec §4.5 Grok "Plan mode is
 * detected, not declared", §7.3's plan row).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/acp/XAiAcpExtension.ts:269-408` (the path matcher
 * and the plan-markdown extractor) and
 * `apps/server/src/provider/Layers/GrokAdapter.ts:233-272` (the mode machine).
 *
 * **Reality correction** (fixtures observation 15): the spec and T3 both
 * *infer* plan mode from tool titles. CLI 1.0.34 **declares** it on every tool
 * call:
 *
 * ```json
 * "_meta":{"x.ai/tool":{"name":"enter_plan_mode","kind":"enter_plan",…}}
 * ```
 *
 * so `kind` is the discriminant and the title heuristic is only the fallback
 * for a frame with no `x.ai/tool` block.
 *
 * The second correction is the plan **path**. T3's canonical regex requires a
 * literal `.grok` component under a real home root
 * (`/^(?:\/home\/[^/]+|…)\/\.grok\/sessions\/…/`). Orquester binds the managed
 * account with `GROK_HOME`, and the plan is written to
 * `$GROK_HOME/sessions/<percent-encoded-cwd>/<session-id>/plan.md` — no
 * `.grok` component at all. Matching must be against `GROK_HOME` as the
 * adapter set it, never against `~/.grok`.
 */

import { homedir } from "node:os";

import { xaiToolMeta } from "./xai-meta.ts";

/** Returned when the agent exits plan mode without having written one. */
export const XAI_EMPTY_PLAN_MARKDOWN =
  "# No plan written yet\n\n(The agent exited plan mode without writing a plan.)";

/**
 * The reply to `_x.ai/exit_plan_mode`. **We abandon the native gate**: the
 * plan is captured into Orquester's own proposed-plan row and the agent is
 * told to stop, or the turn hangs on a dialog nobody can see.
 *
 * Observed verbatim in `07-plan-mode-exit-plan.ndjson`: the response is a
 * FLAT `{outcome, feedback}` — unlike `session/request_permission`, whose
 * reply nests as `{outcome:{outcome:…}}`. Getting those two the same way round
 * is the classic mistake.
 */
export const XAI_EXIT_PLAN_FEEDBACK =
  "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";

export interface PlanPathHost {
  readonly platform: NodeJS.Platform;
  /** The child's environment, as the adapter built it — `GROK_HOME` included. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasTraversalSegment(normalized: string): boolean {
  return normalized.split("/").includes("..");
}

/**
 * Every prefix under which a session `plan.md` may legitimately live. The
 * `GROK_HOME` entries come first because they are the ones Orquester creates;
 * the `~/.grok` ones remain for a `system`-identity thread.
 */
export function planSessionPrefixes(host: PlanPathHost): readonly string[] {
  const prefixes = new Set<string>();
  const add = (root: string | undefined, nested: boolean): void => {
    if (root === undefined) {
      return;
    }
    const normalized = normalizePath(root);
    if (normalized.length === 0) {
      return;
    }
    prefixes.add(nested ? `${normalized}/.grok/sessions/` : `${normalized}/sessions/`);
  };

  // The managed account home, which is what §3.1 binds. Both layouts are
  // accepted because `GROK_HOME` may point at either a `.grok` dir or its
  // parent depending on how the account was created.
  add(host.env["GROK_HOME"], false);
  add(host.env["GROK_HOME"], true);
  add(host.env["HOME"], true);
  add(host.env["USERPROFILE"], true);
  try {
    add(homedir(), true);
  } catch {
    // A host with no resolvable home is not a reason to fail a match.
  }
  return [...prefixes];
}

/**
 * True for a path that is genuinely a Grok session plan.
 *
 * Deliberately does **not** match a workspace-local `docs/plan.md` or a
 * repo-local `.grok/sessions/.../plan.md`: the adapter promotes a match into a
 * user-visible proposal, so a file the agent edits for unrelated reasons must
 * not hijack that row.
 */
export function isPlanMarkdownPath(path: unknown, host: PlanPathHost): boolean {
  if (typeof path !== "string") {
    return false;
  }
  const normalized = path.trim().replace(/\\/g, "/");
  if (normalized.length === 0 || hasTraversalSegment(normalized)) {
    // `..` is a hard refusal, not a normalisation: without it,
    // `$GROK_HOME/sessions/x/../../../workspace/plan.md` passes the prefix
    // test and becomes a path-confusion write primitive.
    return false;
  }
  const win32 = host.platform === "win32";
  const haystack = win32 ? normalized.toLowerCase() : normalized;
  if (!haystack.endsWith("/plan.md")) {
    return false;
  }
  for (const prefix of planSessionPrefixes(host)) {
    const needle = win32 ? prefix.toLowerCase() : prefix;
    if (!haystack.startsWith(needle)) {
      continue;
    }
    const rest = haystack.slice(needle.length);
    // The layout is `<root>/sessions/<encoded-cwd>/<session-id>/plan.md`, so
    // at least one intermediate directory is required: a bare
    // `<root>/sessions/plan.md` is not a session plan.
    if (rest !== "plan.md" && rest.endsWith("plan.md")) {
      return true;
    }
  }
  return false;
}

/**
 * The plan markdown a tool call wrote, `""` when a plan write happened with an
 * empty body (which resets the fallback without emitting a row), or
 * `undefined` when the call touched no plan at all.
 *
 * Both shapes the captures produce are read: the `write` tool's `rawInput`
 * (`{file_path, content}`) and the `tool_call_update`'s `content[]` diff entry
 * (`{type:"diff", path, newText}`).
 */
export function planMarkdownFromToolCall(
  input: { rawInput?: unknown; content?: unknown },
  host: PlanPathHost
): string | undefined {
  let sawPlanWrite = false;

  const take = (text: unknown, path: unknown): string | undefined => {
    if (typeof text !== "string" || !isPlanMarkdownPath(path, host)) {
      return undefined;
    }
    sawPlanWrite = true;
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const raw = input.rawInput;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const path = record["file_path"] ?? record["path"] ?? record["target_file"];
    const found = take(record["content"], path);
    if (found !== undefined) {
      return found;
    }
  }

  if (Array.isArray(input.content)) {
    for (const entry of input.content) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const block = entry as Record<string, unknown>;
      if (block["type"] !== "diff") {
        continue;
      }
      const found = take(block["newText"], block["path"]);
      if (found !== undefined) {
        return found;
      }
    }
  }

  return sawPlanWrite ? "" : undefined;
}

// ---------------------------------------------------------------------------
// The mode machine
// ---------------------------------------------------------------------------

export interface PlanToolCallView {
  readonly title?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly meta?: unknown;
}

/**
 * True for the tool call that ENTERS plan mode. `_meta["x.ai/tool"].kind ===
 * "enter_plan"` is authoritative; the title/`variant` heuristic below is the
 * fallback for a frame that carries no vendor meta.
 */
export function isEnterPlanToolCall(call: PlanToolCallView): boolean {
  const meta = xaiToolMeta(call.meta);
  if (meta !== undefined) {
    return meta.kind === "enter_plan";
  }
  const title = call.title?.trim().toLowerCase() ?? "";
  if (title === "enter_plan_mode" || title === "plan: enter" || title === "plan mode entered") {
    return true;
  }
  if (title.includes("enter_plan_mode")) {
    return true;
  }
  const raw = call.rawInput;
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)["variant"] === "EnterPlanMode"
  );
}

/** True for the tool call that EXITS it. */
export function isExitPlanToolCall(call: PlanToolCallView): boolean {
  const meta = xaiToolMeta(call.meta);
  if (meta !== undefined) {
    return meta.kind === "exit_plan";
  }
  const title = call.title?.trim().toLowerCase() ?? "";
  if (title === "exit_plan_mode" || title === "plan: exit") {
    return true;
  }
  const raw = call.rawInput;
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)["variant"] === "ExitPlanMode"
  );
}

/**
 * The next plan-mode flag. A **failed** `enter_plan_mode` must not leave the
 * flag stuck on, and a merely `pending` one is not yet a commitment.
 */
export function nextPlanModeActive(active: boolean, call: PlanToolCallView): boolean {
  if (isExitPlanToolCall(call) && (call.status === "completed" || call.status === "failed")) {
    return false;
  }
  if (!isEnterPlanToolCall(call)) {
    return active;
  }
  if (call.status === "failed") {
    return false;
  }
  if (call.status === "completed" || call.status === "in_progress" || call.status === "inProgress") {
    return true;
  }
  return active;
}
