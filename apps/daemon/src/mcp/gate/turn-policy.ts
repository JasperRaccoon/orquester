/**
 * Session tools — the turn policy: the one rule every session tool that causes a turn in a
 * thread follows (`thread_send`, `thread_create`, `delegate_task`, `thread_merge_back`). Session
 * tools are pre-approved in every permission and interaction mode (design §1.3), so without this a
 * supervised or planning agent could get unsupervised or editing work done by asking another
 * thread for it.
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
 *
 * Unified MCP (design 2026-10-15 §5.3, §8.4): moved here from `session-tools/turn-policy.ts` (now a
 * re-export) and applied generically by the catalog executor to every session a call names in
 * `ScopeClaim.causesTurnIn`, cross-project included; plus the exchange: every agent-caused turn
 * carries `causedBy {threadId, exchangeId, hop}` ({@link causedByFor}), refused past
 * `MAX_EXCHANGE_HOPS` (`EXCHANGE_LIMIT`, {@link assertExchangeRoom}).
 */

import {
  buildThreadMessage,
  currentInteractionMode,
  exceedsExchangeLimit,
  MAX_EXCHANGE_HOPS,
  nextCausedBy,
  parseCausedBy,
  SETTLED_TURN_STATES,
  type CausedBy,
  RUNTIME_MODES,
  THREAD_MESSAGE_OVERHEAD_CHARS,
  type InteractionMode,
  type RuntimeMode,
  type ThreadMessageOrigin,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { ToolError } from "../errors.ts";
import { listSessions, readThread } from "../reads.ts";
import type { SessionToolContext } from "../../session-tools/contract.ts";

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

// ---------------------------------------------------------------------------
// The exchange (§8.4)
// ---------------------------------------------------------------------------

/**
 * The turn whose `causedBy` the caller's call continues: the active turn, else the latest
 * unsettled one, else the latest — the turn `currentInteractionMode` reads.
 */
function runningTurn(snap: ThreadSnapshotPayload): ThreadSnapshotPayload["turns"][number] | undefined {
  const active = snap.head.session.activeTurnId;
  return (
    (active !== null ? snap.turns.find((candidate) => candidate.turnId === active) : undefined) ??
    [...snap.turns].reverse().find((candidate) => !SETTLED_TURN_STATES.has(candidate.state)) ??
    snap.turns.at(-1)
  );
}

/**
 * The caller's exchange, server-side from its own snapshot (never from arguments): its running
 * turn's `causedBy` as `{id, hop}`, or null for a user-authored turn (or an older log without it).
 */
export function runningExchange(snap: ThreadSnapshotPayload): { id: string; hop: number } | null {
  const causedBy = parseCausedBy(runningTurn(snap)?.causedBy);
  return causedBy ? { id: causedBy.exchangeId, hop: causedBy.hop } : null;
}

/**
 * The `causedBy` of a turn a chat caller causes now: its exchange at hop + 1, or a new exchange
 * (`newExchangeId`) at hop 1 when its running turn is user-authored. The hop counts every caused
 * turn whatever the reply mode.
 */
export function causedByFor(caller: { threadId: string; exchange: { id: string; hop: number } | null }, newExchangeId: string): CausedBy {
  return nextCausedBy({
    callerThreadId: caller.threadId,
    running: caller.exchange ? { threadId: caller.threadId, exchangeId: caller.exchange.id, hop: caller.exchange.hop } : null,
    newExchangeId
  });
}

/** Refuse a caused turn past the cap (`EXCHANGE_LIMIT`): only the user's next message starts a fresh exchange. */
export function assertExchangeRoom(causedBy: CausedBy): void {
  if (exceedsExchangeLimit(causedBy)) {
    throw new ToolError(
      "EXCHANGE_LIMIT",
      `This exchange between agent chats reached its limit of ${MAX_EXCHANGE_HOPS} agent-caused turns. Summarise for your user instead; their next message starts a fresh exchange.`
    );
  }
}
