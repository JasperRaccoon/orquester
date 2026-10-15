/**
 * The turn policy (unified MCP design 2026-10-15 §5.3, §8.4): the one rule every catalog tool that
 * causes a turn follows, applied generically by the executor (`../executor.ts`) to every session a
 * call names in `ScopeClaim.causesTurnIn`, cross-project included, checked at call time. Every
 * Orquester tool is pre-approved at the provider, so without it a supervised or planning agent
 * could get unsupervised or editing work done by asking another chat for it.
 *
 * - **Never broader.** A turn may not be caused in a chat whose permission mode is broader than
 *   the caller's ({@link assertTargetModeNotBroader}); a chat the tool opens runs in the caller's
 *   own mode, or a narrower one it names ({@link openedThreadRuntimeMode}). A narrower chat answers
 *   a broader one only through the reply the broader chat asked for (`reply: "wait" | "notify"`),
 *   which is no new send.
 * - **Plan carries on.** A planning caller's caused turn plans too (the executor's `turn`).
 * - **Provenance.** The caused turn's text carries the v2 header (`buildThreadMessage`).
 * - **The exchange.** Every agent-caused turn carries `causedBy {threadId, exchangeId, hop}`
 *   ({@link causedByFor}), refused past `MAX_EXCHANGE_HOPS` (`EXCHANGE_LIMIT`,
 *   {@link assertExchangeRoom}).
 *
 * Pure: reachable from the catalog, which the agent host loads statically.
 */

import {
  currentInteractionMode,
  exceedsExchangeLimit,
  MAX_EXCHANGE_HOPS,
  nextCausedBy,
  parseCausedBy,
  SETTLED_TURN_STATES,
  type CausedBy,
  RUNTIME_MODES,
  type RuntimeMode,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { ToolError } from "../errors.ts";

/** What the policy knows about the calling thread. */
export interface TurnPolicyCaller {
  threadId: string;
  /** Its tab title: the provenance names it. */
  title: string;
  runtimeMode: RuntimeMode;
  /** Its running turn is in plan mode. */
  planning: boolean;
}

/**
 * Whether a thread's running turn is in plan mode: `currentInteractionMode` — the active turn (else
 * the latest unsettled one, else the latest), and a steer of it that recorded another mode wins
 * (T6-M2: a default turn steered into plan plans).
 */
export function runningTurnPlans(snap: ThreadSnapshotPayload): boolean {
  return currentInteractionMode(snap) === "plan";
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

// ---------------------------------------------------------------------------
// The exchange (§8.4)
// ---------------------------------------------------------------------------

/**
 * `ScopeClaim.causesTurnIn` entry for a session the call itself creates (`create_session`,
 * `fork_session` with a prompt): the exchange applies to it, the never-broader check does not —
 * the tool opens it no broader than the caller (`openedThreadRuntimeMode`).
 */
export const NEW_SESSION = "(new)";

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
