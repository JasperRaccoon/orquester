/**
 * Chat tabs as first-class sessions beside the PTY sessions (spec §5.2, §6.1).
 *
 * A chat tab is a `SessionSummary` with `kind: "agent-chat"` that no PTY backs.
 * It shares one per-project `order` space with the terminals — a user drags a
 * chat tab and a bash tab into one strip — and it shares `sessions.json`, where
 * the record carries the §5.2 `chat` block.
 *
 * `sessions.json` stays **tab metadata only**; the agent host is the source of
 * truth for thread state (§5.2). Nothing here folds events or holds a timeline.
 */

import { EventEmitter } from "node:events";
import type {
  AgentChatSessionSummaryFields,
  PendingMergeBack,
  SessionSummary,
  ThreadLineage,
  WorkflowSessionOwner
} from "@orquester/api";
import type { AgentChatHome, SessionRecord } from "@orquester/config";

/** Thrown for a refusal the route maps to a 400. */
export class ChatSessionError extends Error {
  constructor(
    message: string,
    readonly code = "SESSION_UNAVAILABLE",
    /** Set with `CONVERSATION_ALREADY_OPEN`: the tab that already owns the conversation. */
    readonly ownerSessionId?: string
  ) {
    super(message);
    this.name = "ChatSessionError";
  }
}

export interface ChatSessionCreateInput {
  id: string;
  refId: string;
  title: string;
  projectPath: string;
  cwd: string;
  order: number;
  accountId: string;
  home: AgentChatHome;
  createdAt?: string;
  /** The workflow run that started this tab (workflows spec §5.10), already validated by the route. */
  owner?: WorkflowSessionOwner;
  /** The thread this one was forked from or delegated by (spec 2026-10-14 §6), already checked. */
  lineage?: ThreadLineage;
  /** A keyed fork's requested fork point (`AgentChatService.forkSession`), persisted with the tab. */
  forkFingerprint?: string;
  /** A fork tab the host has not answered for yet (`AgentChatService.reconcileForks`). */
  forkUnconfirmed?: boolean;
  /** The host has not created the thread yet (`SessionSummary.chatPending`); see {@link confirmCreated}. */
  pending?: boolean;
}

interface ChatSession {
  summary: SessionSummary;
  /** The §5.2 block persisted into `sessions.json`. */
  chat: {
    threadId: string;
    accountId: string;
    home: AgentChatHome;
    lastSeq: number;
    forkFingerprint?: string;
    forkUnconfirmed?: true;
    /** A plain create the host has not answered yet; persisted ({@link confirmCreated}). */
    createUnconfirmed?: true;
  };
}

/**
 * Owns the chat tabs. Deliberately *not* an `ISessionManager`: it has no PTY,
 * no scrollback and no input. {@link ChatAwareSessionManager} joins it to
 * the PTY backend behind the one interface the daemon's routes already use.
 */
export class ChatSessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  /** Emits "created" | "updated" (SessionSummary), "closed" ({ id }). */
  readonly lifecycle = new EventEmitter();

  constructor(private readonly options: { requestPersist: () => void } = { requestPersist: () => undefined }) {}

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  get(id: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.summary } : undefined;
  }

  list(projectPath?: string): SessionSummary[] {
    const rows = [...this.sessions.values()]
      .filter((s) => projectPath === undefined || s.summary.projectPath === projectPath)
      .map((s) => ({ ...s.summary }));
    return rows;
  }

  /** A keyed fork tab's requested fork point, if it was opened as one (spec 2026-10-14 §6). */
  forkFingerprint(id: string): string | undefined {
    return this.sessions.get(id)?.chat.forkFingerprint;
  }

  /** Fork tabs the host has not answered for yet: their fork is in flight, or its answer was lost. */
  unconfirmedForks(): string[] {
    return [...this.sessions.values()].filter((s) => s.chat.forkUnconfirmed === true).map((s) => s.summary.id);
  }

  /** Plain chat tabs whose host create never answered (a daemon restart in between): to reconcile. */
  unconfirmedCreates(): string[] {
    return [...this.sessions.values()].filter((s) => s.chat.createUnconfirmed === true).map((s) => s.summary.id);
  }

  /** The last sequence this tab was rendered at, for a §6.3 reconnect. */
  lastSeq(id: string): number {
    return this.sessions.get(id)?.chat.lastSeq ?? 0;
  }

  /** Monotonic: a stale frame can never rewind a tab's cursor. */
  noteSeq(id: string, seq: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isInteger(seq) || seq <= session.chat.lastSeq) {
      return;
    }
    session.chat.lastSeq = seq;
    this.options.requestPersist();
  }

  /** The account ids a live chat tab pins, for the idle-account refresher. */
  liveAccountIds(): Set<string> {
    const ids = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.summary.accountId) ids.add(session.summary.accountId);
    }
    return ids;
  }

  create(input: ChatSessionCreateInput): SessionSummary {
    if (this.sessions.has(input.id)) {
      throw new ChatSessionError(`Session "${input.id}" already exists.`);
    }
    const summary: SessionSummary = {
      id: input.id,
      kind: "agent-chat",
      refId: input.refId,
      accountId: input.accountId || undefined,
      title: input.title,
      projectPath: input.projectPath,
      cwd: input.cwd,
      // A chat tab has no PTY; the size fields stay at the schema's defaults so
      // every surface reading a SessionSummary keeps its shape.
      cols: 0,
      rows: 0,
      // `status` is the TAB's liveness, not the thread's. It stays `running`
      // for as long as the tab exists — including while the thread's session is
      // in `error`, which is a recoverable state the user retries into with
      // `/session/stop` or a new turn. `exited` would make every client drop
      // the tab. The thread's own state is `chatSessionStatus` (§6.4), and the
      // ladder already surfaces an error as `activity` — which is what the tab
      // strip and the Attention Center colour a chat row from.
      status: "running",
      order: input.order,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.owner ? { owner: { ...input.owner } } : {}),
      ...(input.lineage ? { lineage: cloneLineage(input.lineage) } : {}),
      ...(input.pending === true || input.forkUnconfirmed === true ? { chatPending: true } : {})
    };
    this.sessions.set(input.id, {
      summary,
      chat: {
        threadId: input.id,
        accountId: input.accountId,
        home: input.home,
        lastSeq: 0,
        ...(input.forkFingerprint !== undefined ? { forkFingerprint: input.forkFingerprint } : {}),
        ...(input.forkUnconfirmed === true ? { forkUnconfirmed: true as const } : {}),
        ...(input.pending === true && input.forkUnconfirmed !== true ? { createUnconfirmed: true as const } : {})
      }
    });
    this.lifecycle.emit("created", { ...summary });
    this.options.requestPersist();
    return { ...summary };
  }

  rename(id: string, title: string, fallback: string): SessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.summary.title = title.trim() || fallback;
    this.lifecycle.emit("updated", { ...session.summary });
    this.options.requestPersist();
    return { ...session.summary };
  }

  /**
   * Threads whose tab is gone but whose host-side delete has not been
   * acknowledged. Persisted with the index so the retry survives a restart.
   */
  private readonly pendingDeletes = new Set<string>();

  /** Forget the tab. The host-side thread delete is the caller's job (§6.1). */
  close(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    // Queue the cascade BEFORE the tab is forgotten is announced: if the host
    // is down right now, §3.3's reconcile would otherwise find an orphan with a
    // cursor and a continuation marker and resume it — a provider child and
    // tokens spent for a tab nobody is looking at.
    this.pendingDeletes.add(id);
    this.lifecycle.emit("closed", { id });
    this.options.requestPersist();
    return true;
  }

  /**
   * Take back a tab its own create never finished — the host refused the thread, so there is
   * nothing to delete there. Unlike {@link close} no host delete is queued, and the "closed"
   * event says `rolledBack`, so nothing reads it as the user closing a tab.
   */
  discard(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    this.lifecycle.emit("closed", { id, rolledBack: true });
    this.options.requestPersist();
    return true;
  }

  /** The unacknowledged deletes, for persistence and for replay on adoption. */
  pendingThreadDeletes(): string[] {
    return [...this.pendingDeletes];
  }

  /** The host confirmed (or definitively 404'd) the delete: stop retrying. */
  resolveThreadDelete(id: string): void {
    if (this.pendingDeletes.delete(id)) {
      this.options.requestPersist();
    }
  }

  /** Restore the queue from the index on boot. */
  adoptPendingDeletes(ids: readonly string[]): void {
    for (const id of ids) {
      if (typeof id === "string" && id) this.pendingDeletes.add(id);
    }
  }

  /**
   * Re-point a tab at another managed account (§3.4's account switch).
   *
   * Both spellings move together on purpose: `summary.accountId` is what the
   * tab badge and {@link liveAccountIds} read, and `chat.accountId`/`chat.home`
   * are what `sessions.json` persists and what a daemon restart rebuilds the
   * summary from. Writing one without the other survives until the next
   * restart and then silently reverts.
   */
  setAccount(id: string, input: { accountId: string; home: AgentChatHome }): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.chat.accountId === input.accountId && session.chat.home === input.home) {
      return null;
    }
    session.chat.accountId = input.accountId;
    session.chat.home = input.home;
    // `undefined`, never `""`: the summary's account id is absent for the
    // system identity, which is the shape every client already renders.
    session.summary.accountId = input.accountId || undefined;
    this.lifecycle.emit("updated", { ...session.summary });
    this.options.requestPersist();
    return { ...session.summary };
  }

  /**
   * Record the lineage the host resolved for a fork (spec 2026-10-14 §6): its fork point is
   * only known once the host has cut the parent's conversation.
   */
  setLineage(id: string, lineage: ThreadLineage): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.summary.lineage = cloneLineage(lineage);
    // The host's answer is in: the fork is confirmed, its thread exists.
    delete session.chat.forkUnconfirmed;
    if (session.summary.chatPending === true) session.summary.chatPending = false;
    this.lifecycle.emit("updated", { ...session.summary });
    this.options.requestPersist();
    return { ...session.summary };
  }

  /**
   * The host created the tab's thread: `chatPending` goes to `false` (explicitly — a client
   * merges summaries field by field), announced so a view that met `THREAD_NOT_FOUND` while it
   * was being created connects again. Nothing is announced for a tab that was not pending.
   */
  confirmCreated(id: string): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.summary.chatPending !== true) return { ...session.summary };
    session.summary.chatPending = false;
    if (session.chat.forkUnconfirmed === true || session.chat.createUnconfirmed === true) {
      delete session.chat.forkUnconfirmed;
      delete session.chat.createUnconfirmed;
      this.options.requestPersist();
    }
    this.lifecycle.emit("updated", { ...session.summary });
    return { ...session.summary };
  }

  /**
   * The merges a tab sent or is owed that the parent has not taken (spec 2026-10-14 §6),
   * published by the lineage service. Derived, never persisted; "updated" only on a change.
   */
  setPendingMerges(id: string, merges: readonly PendingMergeBack[]): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (JSON.stringify(session.summary.pendingMerges ?? []) === JSON.stringify(merges)) return null;
    // Cleared as `[]`, never by dropping the key: a client merges a summary into the one it
    // holds field by field, and a missing key would leave its last list (and its buttons) up.
    session.summary.pendingMerges = merges.map((merge) => ({ ...merge }));
    this.lifecycle.emit("updated", { ...session.summary });
    return { ...session.summary };
  }

  /** Set one tab's order; used by the shared cross-kind reorder. */
  setOrder(id: string, order: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.summary.order === order) return false;
    session.summary.order = order;
    this.lifecycle.emit("updated", { ...session.summary });
    return true;
  }

  /**
   * Merge the seven §6.4 fields onto a tab and publish "updated" only when
   * something actually changed — the summary service runs off a live stream and
   * must not turn every heartbeat into a broadcast.
   */
  applyFields(id: string, fields: AgentChatSessionSummaryFields): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    // REPLACE, never merge: a `hello` frame from a restarted host carries the
    // whole truth, and a merge would leave a stale `backgroundLiveness` from an
    // in-memory registry that no longer exists (§3.1, §6.4).
    const next: SessionSummary = {
      ...session.summary,
      hasPendingApprovals: fields.hasPendingApprovals,
      hasPendingUserInput: fields.hasPendingUserInput,
      hasActionableProposedPlan: fields.hasActionableProposedPlan,
      backgroundLiveness: fields.backgroundLiveness,
      latestTurn: fields.latestTurn,
      chatSessionStatus: fields.chatSessionStatus,
      goal: fields.goal
    };
    if (sameDerivedFields(session.summary, next)) return null;
    session.summary = next;
    this.lifecycle.emit("updated", { ...next });
    return { ...next };
  }

  /** Attach the live activity snapshot the ladder resolved (§6.4). */
  setActivity(id: string, activity: SessionSummary["activity"]): SessionSummary | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.summary.activity = activity;
    return { ...session.summary };
  }

  /** Records to persist into `sessions.json` beside the PTY ones. */
  records(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.summary.id,
      title: s.summary.title,
      order: s.summary.order,
      projectPath: s.summary.projectPath,
      refId: s.summary.refId,
      kind: "agent-chat" as const,
      cwd: s.summary.cwd,
      createdAt: s.summary.createdAt,
      accountId: s.summary.accountId,
      chat: { ...s.chat },
      // workflows §5.10: persisted so the Workflow chip and the tab sweeper survive a restart.
      ...(s.summary.owner ? { owner: { ...s.summary.owner } } : {}),
      // Spec 2026-10-14 §6: a parent's children are the tabs naming it here.
      ...(s.summary.lineage ? { lineage: cloneLineage(s.summary.lineage) } : {})
    }));
  }

  /**
   * Boot: adopt the `agent-chat` records read out of `sessions.json`. A record
   * whose `chat` block did not survive the tolerant parse is not one of ours —
   * `parseSessionsConfig` already dropped the malformed ones, so one bad chat
   * record can never poison the index (§5.2) — and a record without the block
   * is skipped here rather than resurrected as a half-thread.
   */
  adopt(records: readonly SessionRecord[]): void {
    for (const record of records) {
      if (record.kind !== "agent-chat" || !record.chat) continue;
      if (this.sessions.has(record.id)) continue;
      const summary: SessionSummary = {
        id: record.id,
        kind: "agent-chat",
        refId: record.refId,
        accountId: record.accountId,
        title: record.title,
        projectPath: record.projectPath,
        cwd: record.cwd,
        cols: 0,
        rows: 0,
        status: "running",
        order: record.order,
        createdAt: record.createdAt,
        // The tolerant parse already dropped a malformed owner (never the record).
        ...(record.owner ? { owner: { ...record.owner } } : {}),
        // …and a malformed lineage, or a fork point that did not read on its own.
        ...(record.lineage ? { lineage: lineageFromRecord(record.lineage) } : {}),
        // A fork or a create whose host answer never came: still being reconciled.
        ...(record.chat.forkUnconfirmed === true || record.chat.createUnconfirmed === true ? { chatPending: true } : {})
      };
      this.sessions.set(record.id, {
        summary,
        chat: {
          threadId: record.chat.threadId,
          accountId: record.chat.accountId,
          home: record.chat.home,
          lastSeq: record.chat.lastSeq,
          ...(record.chat.forkFingerprint !== undefined
            ? { forkFingerprint: record.chat.forkFingerprint }
            : {}),
          ...(record.chat.forkUnconfirmed === true ? { forkUnconfirmed: true as const } : {}),
          ...(record.chat.createUnconfirmed === true ? { createUnconfirmed: true as const } : {})
        }
      });
    }
  }
}

function cloneLineage(lineage: ThreadLineage): ThreadLineage {
  return {
    parentThreadId: lineage.parentThreadId,
    relation: lineage.relation,
    ...(lineage.forkedFrom ? { forkedFrom: { ...lineage.forkedFrom } } : {}),
    createdAt: lineage.createdAt,
    ...(lineage.delegationDepth !== undefined ? { delegationDepth: lineage.delegationDepth } : {}),
    ...(lineage.agentCreated === true ? { agentCreated: true as const } : {}),
    ...(lineage.workflowOwned === true ? { workflowOwned: true as const } : {})
  };
}

function lineageFromRecord(record: NonNullable<SessionRecord["lineage"]>): ThreadLineage {
  return {
    parentThreadId: record.parentThreadId,
    relation: record.relation,
    ...(record.forkedFrom ? { forkedFrom: { ...record.forkedFrom } } : {}),
    createdAt: record.createdAt,
    ...(record.delegationDepth !== undefined ? { delegationDepth: record.delegationDepth } : {}),
    // Unified MCP design 2026-10-15 §13 c: only a child a chat tool created is its parent agent's.
    ...(record.agentCreated === true ? { agentCreated: true as const } : {}),
    // §5.4: inherited workflow ownership, stamped at creation; survives the creator's tab closing.
    ...(record.workflowOwned === true ? { workflowOwned: true as const } : {})
  };
}

/** Only the derived §6.4 fields are compared — never `activity`, which is derived from them. */
function sameDerivedFields(a: SessionSummary, b: SessionSummary): boolean {
  return (
    Boolean(a.hasPendingApprovals) === Boolean(b.hasPendingApprovals) &&
    Boolean(a.hasPendingUserInput) === Boolean(b.hasPendingUserInput) &&
    Boolean(a.hasActionableProposedPlan) === Boolean(b.hasActionableProposedPlan) &&
    (a.backgroundLiveness ?? null) === (b.backgroundLiveness ?? null) &&
    a.chatSessionStatus === b.chatSessionStatus &&
    sameLatestTurn(a.latestTurn ?? null, b.latestTurn ?? null) &&
    sameGoal(a.goal ?? null, b.goal ?? null)
  );
}

/** goals §4.7: every field of the goal summary is what a surface renders. */
function sameGoal(
  a: SessionSummary["goal"] | null,
  b: SessionSummary["goal"] | null
): boolean {
  if (!a || !b) return !a && !b;
  return a.objective === b.objective && a.status === b.status && a.continuing === b.continuing;
}

function sameLatestTurn(
  a: SessionSummary["latestTurn"] | null,
  b: SessionSummary["latestTurn"] | null
): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return (
    a.turnId === b.turnId &&
    a.state === b.state &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt
  );
}
