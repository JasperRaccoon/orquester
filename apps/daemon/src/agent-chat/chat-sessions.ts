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
import { sep } from "node:path";
import type {
  AgentChatSessionSummaryFields,
  CreateSessionRequest,
  SessionSummary
} from "@orquester/api";
import type { AgentChatHome, SessionRecord } from "@orquester/config";

/** Thrown for a refusal the route maps to a 400. */
export class ChatSessionError extends Error {
  constructor(message: string, readonly code = "SESSION_UNAVAILABLE") {
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
  /** The resolved launch model, mirrored onto the summary like a terminal's. */
  model?: string;
  createdAt?: string;
}

interface ChatSession {
  summary: SessionSummary;
  /** The §5.2 block persisted into `sessions.json`. */
  chat: { threadId: string; accountId: string; home: AgentChatHome; lastSeq: number };
}

/**
 * Owns the chat tabs. Deliberately *not* an `ISessionManager`: it has no PTY,
 * no scrollback and no input. {@link createChatAwareSessionManager} joins it to
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
      model: input.model,
      title: input.title,
      projectPath: input.projectPath,
      cwd: input.cwd,
      // A chat tab has no PTY; the size fields stay at the schema's defaults so
      // every surface reading a SessionSummary keeps its shape.
      cols: 0,
      rows: 0,
      status: "running",
      order: input.order,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.sessions.set(input.id, {
      summary,
      chat: { threadId: input.id, accountId: input.accountId, home: input.home, lastSeq: 0 }
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

  /** Forget the tab. The host-side thread delete is the caller's job (§6.1). */
  close(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    this.lifecycle.emit("closed", { id });
    this.options.requestPersist();
    return true;
  }

  closeByProjectPrefix(prefix: string): string[] {
    const closed: string[] = [];
    for (const [id, session] of [...this.sessions]) {
      const project = session.summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) {
        if (this.close(id)) closed.push(id);
      }
    }
    return closed;
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
   * Merge the six §6.4 fields onto a tab and publish "updated" only when
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
      chatSessionStatus: fields.chatSessionStatus
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
      model: s.summary.model,
      chat: { ...s.chat }
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
        model: record.model,
        title: record.title,
        projectPath: record.projectPath,
        cwd: record.cwd,
        cols: 0,
        rows: 0,
        status: "running",
        order: record.order,
        createdAt: record.createdAt
      };
      this.sessions.set(record.id, {
        summary,
        chat: {
          threadId: record.chat.threadId,
          accountId: record.chat.accountId,
          home: record.chat.home,
          lastSeq: record.chat.lastSeq
        }
      });
    }
  }

  /** Test/teardown helper: forget everything without emitting deletes upstream. */
  clear(): void {
    this.sessions.clear();
  }
}

/** Only the derived §6.4 fields are compared — never `activity`, which is derived from them. */
function sameDerivedFields(a: SessionSummary, b: SessionSummary): boolean {
  return (
    Boolean(a.hasPendingApprovals) === Boolean(b.hasPendingApprovals) &&
    Boolean(a.hasPendingUserInput) === Boolean(b.hasPendingUserInput) &&
    Boolean(a.hasActionableProposedPlan) === Boolean(b.hasActionableProposedPlan) &&
    (a.backgroundLiveness ?? null) === (b.backgroundLiveness ?? null) &&
    a.chatSessionStatus === b.chatSessionStatus &&
    sameLatestTurn(a.latestTurn ?? null, b.latestTurn ?? null)
  );
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

export type { ChatSession };
