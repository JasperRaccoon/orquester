/**
 * The delegate stop cascade: a chat's delegated tasks stop when it does.
 *
 * When a chat's turn is interrupted or its agent stopped — by the user in the GUI, by an agent's
 * `control_session`, by any client of the command routes — or its tab is closed, every unfinished
 * chat it delegated a task to (`lineage.relation === "delegate"` naming it as the parent), and
 * theirs in turn, is interrupted. Forks and opened chats are never followed: they are the user's
 * own conversations, not work the stopped chat was waiting on.
 *
 * Every interrupt goes through `DaemonApi` (the daemon's own command route, in process), so it is
 * gated, receipted and broadcast as any other, and carries an {@link InterruptCause}: the child's
 * timeline shows it stopped because the chat above it did (`STOP_CASCADED_ACTIVITY_KIND`). An
 * interrupt that carries a cause starts no cascade of its own — the root's walk already covers
 * the whole tree below it.
 *
 * A Stop sticks: before any interrupt is posted, the reply router hears every delegate link of the
 * stopped tree ({@link DelegateStopListener}) and ends what those links still wait on, so the
 * stopped children's "interrupted before it replied" notices — and replies already queued for a
 * stopped chat — never start a turn on the chat the user just stopped. This runs on every stop,
 * even with no unfinished child left to interrupt.
 *
 * Idempotent twice over: a child's command id is derived from the root command's id (a repeat of
 * the same stop posts the same ids, and the host's receipts answer them), and a child already
 * interrupted for its current turn is not interrupted again while its summary trails the host.
 */

import { createHash, randomUUID } from "node:crypto";

import type { SessionSummary } from "@orquester/api";
import {
  agentChatCommandPath,
  agentChatRoutes,
  parseInterruptCause,
  type DelegateStopAction,
  type InterruptCause,
  type ThreadHeadResponse
} from "@orquester/api/agent-chat";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { LineageSessions } from "./lineage.ts";

/** The stop commands whose acceptance starts a cascade (the agent-chat command route's names). */
export type DelegateStopCommand = "interrupt" | "session/stop";

/** Hears a stop before its interrupts go out (the reply router, `replies.ts`). */
export interface DelegateStopListener {
  delegatesStopped(links: readonly { parentId: string; childId: string }[]): Promise<void>;
}

export interface DelegateStopCascadeOptions {
  sessions: LineageSessions;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  now?: () => number;
}

/**
 * A chat that has not finished its work: a turn running or starting, a request open, a goal the
 * provider keeps going, or live background agents. A chat whose thread the host has not created
 * yet (`chatPending`) has nothing to interrupt.
 */
export function delegateUnfinished(session: SessionSummary): boolean {
  if (session.chatPending === true) return false;
  if (session.hasPendingApprovals || session.hasPendingUserInput) return true;
  if (session.chatSessionStatus === "running" || session.chatSessionStatus === "starting") return true;
  const state = session.latestTurn?.state;
  if (state === "running" || state === "pending") return true;
  return session.goal?.continuing === true || session.backgroundLiveness === "working";
}

/**
 * Every chat `rootId` delegated a task to, and theirs, breadth first — delegate links only, each
 * chat once (a lineage cycle, which no build writes, cannot loop).
 */
export function delegateDescendants(sessions: readonly SessionSummary[], rootId: string): SessionSummary[] {
  const byParent = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const lineage = session.lineage;
    if (session.kind !== "agent-chat" || lineage?.relation !== "delegate") continue;
    const siblings = byParent.get(lineage.parentThreadId) ?? [];
    siblings.push(session);
    byParent.set(lineage.parentThreadId, siblings);
  }
  const seen = new Set<string>([rootId]);
  const out: SessionSummary[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

/** The interrupt command id a cascade posts to `childId` for the stop `rootKey`: stable, within the id cap. */
export function cascadeCommandId(rootKey: string, childId: string): string {
  return `delegate-stop-${createHash("sha256").update(`${rootKey}\u0000${childId}`).digest("hex").slice(0, 40)}`;
}

/** Children remembered as interrupted for a turn: enough for any tree the caps allow, bounded. */
const INTERRUPTED_MEMORY = 512;

/**
 * How long a child interrupted for a turn is not interrupted again for the same turn: the window in
 * which its summary may still read "running" (the summary poll trails the host). A later stop of a
 * turn that kept running is a new attempt.
 */
export const REPEAT_INTERRUPT_WINDOW_MS = 10_000;

export class DelegateStopCascade {
  private api: DaemonApi | null = null;
  private listener: DelegateStopListener | null = null;
  private stopped = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Per child, the turn (or "" for none) a cascade interrupted lately, and when. */
  private readonly interrupted = new Map<string, { mark: string; at: number }>();

  constructor(private readonly opts: DelegateStopCascadeOptions) {}

  /** Bind the daemon's own API; until then nothing cascades (the daemon is still starting). */
  attachApi(api: DaemonApi): void {
    this.api = api;
  }

  /** Bind the reply router: it hears each stop's delegate links before the interrupts go out. */
  setListener(listener: DelegateStopListener): void {
    this.listener = listener;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * The command route accepted `command` for `sessionId` (any transport, any caller). An
   * interrupt carrying a cause is the cascade's own, and one marked `cascade: false` is
   * housekeeping (usage-limit recovery clearing a parked turn): neither starts anything.
   */
  commandAccepted(sessionId: string, command: DelegateStopCommand, body: unknown): void {
    const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (command === "interrupt" && (parseInterruptCause(record.cause) !== undefined || record.cascade === false)) return;
    const commandId = typeof record.commandId === "string" && record.commandId.length > 0 ? record.commandId : randomUUID();
    this.start(sessionId, command === "interrupt" ? "interrupted" : "stopped", `${sessionId}\u0000${command}\u0000${commandId}`);
  }

  /** `sessionId`'s tab is closing — called while its record is still readable. */
  closing(sessionId: string): void {
    this.start(sessionId, "closed", `${sessionId}\u0000close`);
  }

  /** Resolves once every cascade started so far has posted (tests wait on it). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private start(rootId: string, action: DelegateStopAction, rootKey: string): void {
    if (this.stopped || this.api === null) return;
    // Read now, synchronously: a closing root's record and its title are gone once it closes.
    const sessions = this.opts.sessions.list();
    const descendants = delegateDescendants(sessions, rootId);
    if (descendants.length === 0) return;
    const links = descendants.map((child) => ({ parentId: child.lineage!.parentThreadId, childId: child.id }));
    const targets = descendants.filter(delegateUnfinished);
    const root = this.opts.sessions.get(rootId) ?? sessions.find((session) => session.id === rootId);
    const cause: InterruptCause = { kind: "parent-stopped", parentSessionId: rootId, parentTitle: root?.title ?? "", action };
    const api = this.api;
    const step = (async () => {
      // The router first, so nothing the interrupts settle is delivered; a failure there never
      // keeps the children running.
      await this.listener?.delegatesStopped(links).catch((error: unknown) => {
        this.opts.logger?.warn?.("[delegates] the reply router could not record the stop", error);
      });
      if (targets.length > 0) await this.cascade(api, targets, cause, rootKey);
    })().catch((error: unknown) => {
      this.opts.logger?.warn?.("[delegates] the stop cascade failed", error);
    });
    this.inFlight.add(step);
    void step.then(() => this.inFlight.delete(step));
  }

  private async cascade(api: DaemonApi, targets: readonly SessionSummary[], cause: InterruptCause, rootKey: string): Promise<void> {
    const results = await Promise.all(targets.map((child) => this.interrupt(api, child, cause, rootKey)));
    const count = results.filter(Boolean).length;
    if (count > 0) {
      this.opts.logger?.info?.(
        `[delegates] ${cause.action === "closed" ? "closing" : cause.action === "stopped" ? "stopping" : "interrupting"} ${cause.parentSessionId} interrupted ${count} delegated chat${count === 1 ? "" : "s"}`
      );
    }
  }

  /** Interrupt one child's running turn; true when the host took it. Never throws. */
  private async interrupt(api: DaemonApi, child: SessionSummary, cause: InterruptCause, rootKey: string): Promise<boolean> {
    // Still open and still unfinished when its turn comes (a sibling's interrupt took a moment).
    const current = this.opts.sessions.get(child.id);
    if (!current || !delegateUnfinished(current)) return false;
    let turnId: string | null = null;
    try {
      const res = await api.request("GET", agentChatRoutes.threadHead(child.id));
      const head = res.status < 400 ? (res.body as ThreadHeadResponse | null)?.head : undefined;
      // Name the turn only while the session runs one — read from the same head as the turn id.
      if (head?.session.status === "running") turnId = head.session.activeTurnId ?? null;
    } catch {
      // Unreadable head: interrupt without a turn id (the host then stops what is live).
    }
    const mark = turnId ?? current.latestTurn?.turnId ?? "";
    const now = (this.opts.now ?? Date.now)();
    const last = this.interrupted.get(child.id);
    if (last !== undefined && last.mark === mark && now - last.at < REPEAT_INTERRUPT_WINDOW_MS) return false;
    try {
      const res = await api.request("POST", agentChatCommandPath(child.id, "interrupt"), {
        body: { commandId: cascadeCommandId(rootKey, child.id), ...(turnId ? { turnId } : {}), cause }
      });
      if (res.status >= 400) {
        const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
        this.opts.logger?.warn?.("[delegates] a delegated chat refused the cascaded interrupt", {
          sessionId: child.id,
          status: res.status,
          code: error?.code
        });
        return false;
      }
    } catch (error) {
      this.opts.logger?.warn?.("[delegates] a delegated chat could not be interrupted", { sessionId: child.id, error });
      return false;
    }
    this.interrupted.delete(child.id);
    this.interrupted.set(child.id, { mark, at: now });
    if (this.interrupted.size > INTERRUPTED_MEMORY) this.interrupted.delete(this.interrupted.keys().next().value as string);
    return true;
  }
}
