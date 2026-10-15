/**
 * Session tools — the turn policy: the one rule every session tool that causes a turn in a
 * thread follows (`thread_send`, `thread_create`, `delegate_task`, `thread_merge_back`; the
 * scheduling toolkit is next). Session tools are pre-approved in every permission and interaction
 * mode (design §1.3), so without this a supervised or planning agent could get unsupervised or
 * editing work done by asking another thread for it.
 *
 * (a) **Never broader.** A turn may not be caused in a thread whose permission mode is broader
 *     than the caller's ({@link assertTargetModeNotBroader}); a thread the tool opens runs in the
 *     caller's own mode, or a narrower one the tool names ({@link openedThreadRuntimeMode}).
 * (b) **Plan carries on.** When the caller's running turn is in plan mode, the turn it causes runs
 *     in plan mode ({@link interactionModeFor}); an agent with no plan mode is refused.
 * (c) **Provenance.** The turn's input says which thread caused it, as text the receiving model
 *     reads ({@link withProvenance}: `[Sent by thread "…"]` + one sentence); the GUI shows that
 *     header as a caption (`parseThreadMessage`, `@orquester/api`). A merge back carries its own
 *     header (`buildMergeBackMessage`).
 *
 * Imported by the agent host with the toolkits: it reaches the daemon only through `ctx.api`.
 */

import {
  buildThreadMessage,
  currentInteractionMode,
  RUNTIME_MODES,
  THREAD_MESSAGE_OVERHEAD_CHARS,
  type InteractionMode,
  type RuntimeMode,
  type ThreadMessageOrigin,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { ToolError } from "../mcp/errors.ts";
import { listSessions, readThread } from "../mcp/reads.ts";
import type { SessionToolContext } from "./contract.ts";

/** What the policy knows about the calling thread. */
export interface TurnPolicyCaller {
  threadId: string;
  /** Its tab title: the provenance names it. */
  title: string;
  runtimeMode: RuntimeMode;
  /** Its running turn is in plan mode. */
  planning: boolean;
}

/** The characters {@link withProvenance} adds to a text, at most: keep a tool's input that much under the turn cap. */
export const TURN_PROVENANCE_OVERHEAD_CHARS = THREAD_MESSAGE_OVERHEAD_CHARS;

/**
 * Whether a thread's running turn is in plan mode: `currentInteractionMode` — the active turn (else
 * the latest unsettled one, else the latest), and a steer of it that recorded another mode wins
 * (T6-M2: a default turn steered into plan plans).
 */
export function runningTurnPlans(snap: ThreadSnapshotPayload): boolean {
  return currentInteractionMode(snap) === "plan";
}

/** The caller from its tab and its thread, already read. */
export function turnPolicyCallerFrom(tab: { id: string; title: string }, snap: ThreadSnapshotPayload): TurnPolicyCaller {
  return { threadId: tab.id, title: tab.title, runtimeMode: snap.head.runtimeMode, planning: runningTurnPlans(snap) };
}

/** The caller, read now through `ctx.api`. */
export async function readTurnPolicyCaller(ctx: SessionToolContext): Promise<TurnPolicyCaller> {
  const [sessions, snap] = await Promise.all([listSessions(ctx.api), readThread(ctx.api, ctx.threadId)]);
  const tab = sessions.find((s) => s.id === ctx.threadId);
  if (!tab) throw new ToolError("THREAD_NOT_FOUND", "This chat thread is no longer open.");
  return turnPolicyCallerFrom(tab, snap);
}

/** A permission mode's breadth: approval-required < auto-accept-edits < auto < full-access. */
function breadth(mode: RuntimeMode): number {
  const index = RUNTIME_MODES.indexOf(mode);
  return index === -1 ? RUNTIME_MODES.length : index;
}

/** (a) Refuse a target thread whose permission mode is broader than the caller's (`PERMISSION_DENIED`). */
export function assertTargetModeNotBroader(caller: TurnPolicyCaller, target: { threadId: string; runtimeMode: RuntimeMode }): void {
  if (breadth(target.runtimeMode) > breadth(caller.runtimeMode)) {
    throw new ToolError(
      "PERMISSION_DENIED",
      `Thread "${target.threadId}" runs in ${target.runtimeMode} mode, broader than this thread's ${caller.runtimeMode}; only the user can give it work.`
    );
  }
}

/** The permission modes no broader than `mode`, narrowest first. */
export function runtimeModesUpTo(mode: RuntimeMode): RuntimeMode[] {
  return RUNTIME_MODES.filter((m) => breadth(m) <= breadth(mode));
}

/**
 * (a) for a thread the caller opens: the caller's own permission mode, or the narrower one it names
 * (`requested`); a broader one is refused (`PERMISSION_DENIED`).
 */
export function openedThreadRuntimeMode(caller: TurnPolicyCaller, requested: RuntimeMode | undefined): RuntimeMode {
  if (requested === undefined) return caller.runtimeMode;
  if (breadth(requested) > breadth(caller.runtimeMode)) {
    throw new ToolError(
      "PERMISSION_DENIED",
      `runtimeMode ${requested} is broader than this thread's ${caller.runtimeMode}; a thread you open may run in ${runtimeModesUpTo(caller.runtimeMode).join(", ")}.`
    );
  }
  return requested;
}

/**
 * (b) The interaction mode of the turn the caller causes: `"plan"` while the caller plans — then
 * an agent with no plan mode is refused (`PERMISSION_DENIED`) — else `"default"`.
 * `supportsPlanMode` is asked only while the caller plans.
 */
export async function interactionModeFor(
  caller: TurnPolicyCaller,
  target: { agent: string; supportsPlanMode: () => boolean | Promise<boolean> }
): Promise<InteractionMode> {
  if (!caller.planning) return "default";
  if (!(await target.supportsPlanMode())) {
    throw new ToolError(
      "PERMISSION_DENIED",
      `This thread is in plan mode and ${target.agent} has no plan mode, so it cannot be given work from here. Propose it in your plan instead.`
    );
  }
  return "plan";
}

/**
 * (c) The text with its provenance: which thread caused the turn, as the receiving model reads it.
 * A slash command in it is no longer one — another thread never runs commands as the user.
 */
export function withProvenance(caller: TurnPolicyCaller, origin: ThreadMessageOrigin, text: string): string {
  return buildThreadMessage({ origin, fromTitle: caller.title, text });
}
