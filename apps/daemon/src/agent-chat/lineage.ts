/**
 * Thread lineage, the daemon side (spec 2026-10-14 §6): a thread's parent and
 * children as the tab records name them, and the merge back — a child's result
 * sent to its parent as an ordinary `/turn`, queued while the parent is busy.
 *
 * Every send goes through `DaemonApi` (the daemon's own routes, in process),
 * so the parent's turn is gated, receipted and broadcast exactly as the GUI's
 * own. A queued merge is persisted BEFORE the caller hears "queued"
 * (`agent-merge-outbox.json`) with the `commandId` it will be delivered under,
 * so a daemon restart neither loses it nor — the host's receipts deduplicate
 * a re-post — delivers it twice.
 *
 * Delivery waits on the bus, never on a sleep: every `sessions` event about a
 * parent with a queued merge re-checks it, one merge per idle point (the
 * merge's own turn makes the parent busy again). A slow safety re-check runs
 * only while something is queued, for an event that never came.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  MergeBackRequest,
  MergeBackResponse,
  PendingMergeBack,
  SessionLineageResponse,
  SessionSummary,
  LineageChild
} from "@orquester/api";
import {
  agentChatCommandPath,
  buildMergeBackMessage,
  MAX_TURN_INPUT_CHARS,
  MERGE_BACK_OVERHEAD_CHARS,
  SETTLED_TURN_STATES,
  type ThreadReadResponse,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { parseMergeOutbox, type MergeOutbox, type MergeOutboxEntry } from "@orquester/config";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import { assistantTextForTurn } from "../mcp/views.ts";

/** A refusal the route maps onto the §6.2 envelope. */
export class LineageError extends Error {
  constructor(
    message: string,
    readonly code: "THREAD_NOT_FOUND" | "INVALID_COMMAND" | "COMMAND_REJECTED" | "HOST_UNAVAILABLE"
  ) {
    super(message);
    this.name = "LineageError";
  }
}

/** The tab records the service reads. */
export interface LineageSessions {
  get(id: string): SessionSummary | undefined;
  list(projectPath?: string): SessionSummary[];
}

export interface LineageServiceOptions {
  sessions: LineageSessions;
  outboxFile: string;
  logger?: { warn?: (...args: unknown[]) => void };
  now?: () => Date;
  newId?: () => string;
  /** The safety re-check while something is queued; 0 disables it (tests). */
  recheckMs?: number;
}

const DEFAULT_RECHECK_MS = 30_000;
/** What a merge's text may hold, header excluded: the parent's `/turn` cap minus the header. */
export const MERGE_BACK_MAX_TEXT_CHARS = MAX_TURN_INPUT_CHARS - MERGE_BACK_OVERHEAD_CHARS;

/**
 * Whether a parent can take a message now — no turn running or starting, no
 * approval or question open, no goal the provider is continuing: the
 * conditions a user would wait for before typing (the composer's queue
 * flushes on the same). Read from the tab's summary AND the thread itself,
 * because the summary trails the host by a poll.
 */
export function acceptsMessage(summary: SessionSummary, snap: ThreadSnapshotPayload): boolean {
  if (summary.chatSessionStatus === "running" || summary.chatSessionStatus === "starting") return false;
  if (summary.latestTurn?.state === "running" || summary.latestTurn?.state === "pending") return false;
  if (summary.hasPendingApprovals || summary.hasPendingUserInput) return false;
  if (summary.goal?.continuing === true) return false;
  const head = snap.head.session;
  if (head.activeTurnId !== null || head.status === "running" || head.status === "starting") return false;
  const last = snap.turns.at(-1);
  if (last && !SETTLED_TURN_STATES.has(last.state)) return false;
  return snap.pending.approvals.length === 0 && snap.pending.userInputs.length === 0;
}

/** The child's final assistant reply: its latest settled turn's answer, as the timeline shows it. */
export function finalReply(snap: ThreadSnapshotPayload): string {
  for (let i = snap.turns.length - 1; i >= 0; i -= 1) {
    const turn = snap.turns[i]!;
    if (turn.turnId !== null && SETTLED_TURN_STATES.has(turn.state)) {
      return assistantTextForTurn(snap.items, turn.turnId).trim();
    }
  }
  return "";
}

export class LineageService {
  private api: DaemonApi | null = null;
  private outbox: MergeOutbox = { entries: [], unreadable: [] };
  private unsubscribe: (() => void) | null = null;
  private recheck: ReturnType<typeof setInterval> | null = null;
  /** Per-parent delivery, one at a time. */
  private readonly draining = new Map<string, Promise<void>>();
  /** A parent that got another event while its delivery ran: look again once it ends. */
  private readonly dirty = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly opts: LineageServiceOptions) {}

  /** Read the outbox. A missing or unreadable file is an empty queue; its unreadable entries are kept. */
  async load(): Promise<void> {
    try {
      this.outbox = parseMergeOutbox(JSON.parse(await readFile(this.opts.outboxFile, "utf8")) as unknown);
    } catch {
      this.outbox = { entries: [], unreadable: [] };
    }
  }

  /**
   * Bind the daemon's own API (built after the services, on the unix app) and
   * deliver what is due. Until then a merge answers 503 HOST_UNAVAILABLE.
   */
  attachApi(api: DaemonApi): void {
    this.api = api;
    this.unsubscribe?.();
    this.unsubscribe = api.subscribe((event) => {
      if (event.channel !== "sessions") return;
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (typeof id === "string" && this.outbox.entries.some((entry) => entry.parentSessionId === id)) {
        void this.drain(id);
      }
    });
    this.armRecheck();
    this.drainAll();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    return this.writes;
  }

  /** Every merge waiting, for tests and the lineage read. */
  pending(): PendingMergeBack[] {
    return this.outbox.entries.map(pendingOf);
  }

  /** `GET …/lineage`: the session's parent, children (oldest first) and the merges waiting on or for it. */
  view(sessionId: string): SessionLineageResponse {
    const session = this.opts.sessions.get(sessionId);
    if (!session) throw new LineageError("No chat session with that id.", "THREAD_NOT_FOUND");
    const lineage = session.lineage ?? null;
    let parent: SessionLineageResponse["parent"] = null;
    if (lineage) {
      const found = this.opts.sessions.get(lineage.parentThreadId);
      parent = {
        sessionId: lineage.parentThreadId,
        title: found?.title ?? lineage.parentThreadId,
        exists: found !== undefined
      };
    }
    const children: LineageChild[] = this.opts.sessions
      .list()
      .filter((child) => child.lineage?.parentThreadId === sessionId)
      .sort((a, b) => (a.lineage!.createdAt || a.createdAt).localeCompare(b.lineage!.createdAt || b.createdAt))
      .map((child) => ({
        sessionId: child.id,
        title: child.title,
        exists: true,
        relation: child.lineage!.relation,
        createdAt: child.lineage!.createdAt || child.createdAt,
        ...(child.lineage!.forkedFrom ? { forkedFrom: { ...child.lineage!.forkedFrom } } : {}),
        ...(child.chatSessionStatus ? { chatSessionStatus: child.chatSessionStatus } : {}),
        ...(child.latestTurn ? { latestTurnState: child.latestTurn.state } : {})
      }));
    return {
      sessionId,
      lineage,
      parent,
      children,
      pendingMerges: this.outbox.entries
        .filter((entry) => entry.parentSessionId === sessionId || entry.childSessionId === sessionId)
        .map(pendingOf)
    };
  }

  /**
   * `POST …/merge-back` on the CHILD: send its result — `text`, else its final
   * reply — to the parent, now when the parent is idle, else once it is.
   */
  async mergeBack(childId: string, request: MergeBackRequest): Promise<MergeBackResponse> {
    const api = this.requireApi();
    const child = this.opts.sessions.get(childId);
    if (!child) throw new LineageError("No chat session with that id.", "THREAD_NOT_FOUND");
    const lineage = child.lineage;
    if (!lineage) {
      throw new LineageError("This session was not forked or delegated from another one.", "COMMAND_REJECTED");
    }
    const parent = this.opts.sessions.get(lineage.parentThreadId);
    if (!parent) {
      throw new LineageError("The session this one came from was closed.", "COMMAND_REJECTED");
    }
    const body = (request ?? {}) as Record<string, unknown>;
    const mergeId = optionalId(body.commandId) ?? (this.opts.newId ?? randomUUID)();
    const queued = this.outbox.entries.find((entry) => entry.mergeId === mergeId);
    if (queued) {
      return { parentSessionId: queued.parentSessionId, delivery: "queued", mergeId };
    }
    let text: string;
    if (body.text !== undefined && body.text !== null) {
      if (typeof body.text !== "string") throw new LineageError("text must be a string.", "INVALID_COMMAND");
      text = body.text.trim();
    } else {
      text = finalReply(await this.readThread(api, childId));
    }
    if (text.length === 0) {
      throw new LineageError("There is no reply to merge back yet: nothing finished in this session.", "COMMAND_REJECTED");
    }
    if (text.length > MERGE_BACK_MAX_TEXT_CHARS) {
      throw new LineageError(
        `The text to merge back is ${text.length} characters; at most ${MERGE_BACK_MAX_TEXT_CHARS} fit in a message.`,
        "INVALID_COMMAND"
      );
    }
    const entry: MergeOutboxEntry = {
      mergeId,
      parentSessionId: parent.id,
      childSessionId: childId,
      input: buildMergeBackMessage({ childTitle: child.title, relation: lineage.relation, text }),
      queuedAt: (this.opts.now?.() ?? new Date()).toISOString()
    };
    if (await this.isIdle(api, parent.id)) {
      const sent = await this.deliver(api, entry);
      if (sent.kind === "sent") {
        return { parentSessionId: parent.id, delivery: "sent", mergeId, seq: sent.seq };
      }
      if (sent.kind === "refused") throw new LineageError(sent.message, "COMMAND_REJECTED");
      // Unavailable: queued like a busy parent's.
    }
    this.outbox.entries.push(entry);
    await this.persist();
    this.armRecheck();
    // An idle point may have passed while this was written.
    void this.drain(parent.id);
    return { parentSessionId: parent.id, delivery: "queued", mergeId };
  }

  // -------------------------------------------------------------------------

  private requireApi(): DaemonApi {
    if (!this.api) throw new LineageError("Orquester is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    return this.api;
  }

  private async readThread(api: DaemonApi, sessionId: string): Promise<ThreadSnapshotPayload> {
    const res = await api.request("GET", agentChatRoutes.thread(sessionId));
    const body = res.body as ThreadReadResponse | null;
    if (res.status >= 400 || body?.kind !== "snapshot") {
      throw new LineageError("The session's conversation could not be read. Try again in a moment.", "HOST_UNAVAILABLE");
    }
    return body.thread;
  }

  private async isIdle(api: DaemonApi, parentId: string): Promise<boolean> {
    const summary = this.opts.sessions.get(parentId);
    if (!summary) return false;
    try {
      return acceptsMessage(summary, await this.readThread(api, parentId));
    } catch {
      return false;
    }
  }

  private async deliver(
    api: DaemonApi,
    entry: MergeOutboxEntry
  ): Promise<{ kind: "sent"; seq: number } | { kind: "unavailable" } | { kind: "refused"; message: string }> {
    try {
      const res = await api.request("POST", agentChatCommandPath(entry.parentSessionId, "turn"), {
        body: { commandId: entry.mergeId, input: entry.input, interactionMode: "default" }
      });
      if (res.status < 400) return { kind: "sent", seq: (res.body as { seq?: number } | null)?.seq ?? 0 };
      const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 503 || error?.code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
      return { kind: "refused", message: error?.message ?? `The parent refused the message (${res.status}).` };
    } catch {
      return { kind: "unavailable" };
    }
  }

  private drainAll(): void {
    for (const parentId of new Set(this.outbox.entries.map((entry) => entry.parentSessionId))) {
      void this.drain(parentId);
    }
  }

  /** Deliver the parent's oldest queued merge if the parent is idle — one, then wait for the next idle point. */
  private drain(parentId: string): Promise<void> {
    const running = this.draining.get(parentId);
    if (running) {
      this.dirty.add(parentId);
      return running;
    }
    const run = this.drainOnce(parentId).finally(() => {
      this.draining.delete(parentId);
      if (this.dirty.delete(parentId) && !this.stopped) void this.drain(parentId);
    });
    this.draining.set(parentId, run);
    return run;
  }

  private async drainOnce(parentId: string): Promise<void> {
    const api = this.api;
    if (!api || this.stopped) return;
    const entry = this.outbox.entries.find((candidate) => candidate.parentSessionId === parentId);
    if (!entry) return;
    if (!this.opts.sessions.get(parentId)) {
      // The parent tab was closed: nothing will ever take these.
      this.opts.logger?.warn?.("[lineage] dropping merges for a closed parent", { parentId });
      this.outbox.entries = this.outbox.entries.filter((candidate) => candidate.parentSessionId !== parentId);
      await this.persist();
      return;
    }
    if (!(await this.isIdle(api, parentId))) return;
    const sent = await this.deliver(api, entry);
    if (sent.kind === "unavailable") return;
    if (sent.kind === "refused") {
      this.opts.logger?.warn?.("[lineage] the parent refused a queued merge; dropping it", {
        parentId,
        mergeId: entry.mergeId,
        reason: sent.message
      });
    }
    this.outbox.entries = this.outbox.entries.filter((candidate) => candidate.mergeId !== entry.mergeId);
    await this.persist();
  }

  private armRecheck(): void {
    const ms = this.opts.recheckMs ?? DEFAULT_RECHECK_MS;
    if (ms <= 0 || this.stopped || this.recheck || this.outbox.entries.length === 0 || !this.api) return;
    this.recheck = setInterval(() => {
      if (this.outbox.entries.length === 0) {
        if (this.recheck) clearInterval(this.recheck);
        this.recheck = null;
        return;
      }
      this.drainAll();
    }, ms);
    this.recheck.unref?.();
  }

  /** Written in order, the latest state each time; unreadable entries go back as they came. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: 1, entries: [...this.outbox.entries, ...this.outbox.unreadable] },
      null,
      2
    );
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => writeAtomic(this.opts.outboxFile, snapshot))
      .catch((error: unknown) => {
        this.opts.logger?.warn?.("[lineage] could not write the merge outbox", error);
      });
    return this.writes;
  }
}

/** 0600, tmp + rename: a crash leaves the old queue or the new one, never half of one. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function pendingOf(entry: MergeOutboxEntry): PendingMergeBack {
  return {
    mergeId: entry.mergeId,
    parentSessionId: entry.parentSessionId,
    childSessionId: entry.childSessionId,
    queuedAt: entry.queuedAt
  };
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}
