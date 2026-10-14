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
 * only while something is queued, for an event that never came. Every
 * delivery to a parent runs in that parent's lane, oldest merge first.
 *
 * Nothing a caller was told is "queued" disappears silently: a parent that
 * refuses it (after a few tries for a refusal of the moment) or is closed
 * leaves it `failed`, shown on both tabs (`SessionSummary.pendingMerges`) for
 * the user to deliver anyway or discard.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  MergeBackActionRequest,
  MergeBackActionResponse,
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
  MERGE_PREVIEW_CHARS,
  parseMergeBackMessage,
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
  /** Publish a tab's pending merges (`SessionSummary.pendingMerges`, never persisted). */
  setPendingMerges?: (sessionId: string, merges: PendingMergeBack[]) => void;
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
  /**
   * One lane per parent: every delivery to a parent — a merge sent at once, a
   * queued one drained, a "deliver now" — runs in it, one after another, so a
   * newer merge never overtakes (or steers into) an older one.
   */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Parents with a drain already waiting in their lane: one is enough. */
  private readonly drainWaiting = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Sessions whose pending merges were last published as non-empty. */
  private published = new Set<string>();

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
      if (typeof id === "string" && this.queuedFor(id).length > 0) {
        void this.drain(id);
      }
    });
    this.publish();
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

  /** Every merge the parents have not taken, for tests and the lineage read. */
  pending(): PendingMergeBack[] {
    return this.outbox.entries.map(pendingOf);
  }

  /** The merges a session sent that are still pending, and those addressed to it. */
  pendingFor(sessionId: string): PendingMergeBack[] {
    return this.outbox.entries
      .filter((entry) => entry.parentSessionId === sessionId || entry.childSessionId === sessionId)
      .map(pendingOf);
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
    return { sessionId, lineage, parent, children, pendingMerges: this.pendingFor(sessionId) };
  }

  /**
   * `POST …/merge-back` on the CHILD: send its result — `text`, else its final
   * reply — to the parent, now when the parent is idle and nothing older waits
   * for it, else once it is. Runs in the parent's lane, so it is ordered with
   * every other delivery to that parent.
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
    const known = this.outbox.entries.find((entry) => entry.mergeId === mergeId);
    if (known) {
      return { parentSessionId: known.parentSessionId, delivery: "queued", mergeId };
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
      queuedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      state: "queued",
      attempts: 0
    };
    const response = await this.lane(parent.id, async (): Promise<MergeBackResponse> => {
      // A repeat that raced the first into the lane is the same merge.
      if (this.outbox.entries.some((other) => other.mergeId === mergeId)) {
        return { parentSessionId: parent.id, delivery: "queued", mergeId };
      }
      // Only with nothing older waiting for this parent: a newer merge never overtakes one.
      if (this.queuedFor(parent.id).length === 0 && (await this.isIdle(api, parent.id))) {
        const sent = await this.deliver(api, entry);
        if (sent.kind === "sent") {
          this.delivered.set(mergeId, sent.seq);
          return { parentSessionId: parent.id, delivery: "sent", mergeId, seq: sent.seq };
        }
        // The caller hears a refusal at once; nothing was queued for it.
        if (sent.kind === "refused") throw new LineageError(sent.message, "COMMAND_REJECTED");
        // Unavailable (the host restarting): queued like a busy parent's.
      }
      this.outbox.entries.push(entry);
      await this.persist([parent.id, childId]);
      this.armRecheck();
      return { parentSessionId: parent.id, delivery: "queued", mergeId };
    });
    if (response.delivery === "queued") void this.drain(parent.id);
    return response;
  }

  /**
   * `POST …/merge-back/:mergeId` from the fork that sent a pending merge or
   * the parent it is addressed to: `deliver` sends it now, whatever the parent
   * is doing — an ordinary `/turn`, so a running turn is steered, as any
   * message sent then would be (the one way past a parent whose goal keeps it
   * busy); a failed merge is tried afresh. `discard` drops it.
   */
  async actOnMerge(
    sessionId: string,
    mergeId: string,
    request: MergeBackActionRequest
  ): Promise<MergeBackActionResponse> {
    const action = (request as { action?: unknown } | undefined)?.action;
    if (action !== "deliver" && action !== "discard") {
      throw new LineageError('action must be "deliver" or "discard".', "INVALID_COMMAND");
    }
    const find = (): MergeOutboxEntry | undefined =>
      this.outbox.entries.find(
        (entry) =>
          entry.mergeId === mergeId &&
          (entry.parentSessionId === sessionId || entry.childSessionId === sessionId)
      );
    const entry = find();
    if (!entry) throw new LineageError("No pending merge with that id for this session.", "THREAD_NOT_FOUND");
    if (action === "discard") {
      return this.lane(entry.parentSessionId, async (): Promise<MergeBackActionResponse> => {
        // Looked up again in the lane: a drain may have delivered it meanwhile, and the
        // answer is what happened to it, never "discarded" for a message the parent has.
        const current = find();
        if (!current) return this.settledOutcome(mergeId);
        this.outbox.entries = this.outbox.entries.filter((other) => other.mergeId !== mergeId);
        this.retryAfterSeq.delete(mergeId);
        await this.persist([current.parentSessionId, current.childSessionId]);
        return { mergeId, outcome: "discarded" };
      });
    }
    const api = this.requireApi();
    if (!this.opts.sessions.get(entry.parentSessionId)) {
      throw new LineageError("The session this merge is for was closed. Discard it instead.", "COMMAND_REJECTED");
    }
    return this.lane(entry.parentSessionId, async (): Promise<MergeBackActionResponse> => {
      const current = find();
      if (!current) return this.settledOutcome(mergeId);
      const sent = await this.deliver(api, current);
      if (sent.kind === "unavailable") {
        throw new LineageError("The agent host is restarting; the merge stays queued.", "HOST_UNAVAILABLE");
      }
      if (sent.kind === "refused") {
        this.markFailed(current, sent.message);
        await this.persist([current.parentSessionId, current.childSessionId]);
        throw new LineageError(sent.message, "COMMAND_REJECTED");
      }
      this.settle(current, sent.seq);
      await this.persist([current.parentSessionId, current.childSessionId]);
      return { mergeId, outcome: "sent", seq: sent.seq };
    });
  }

  /** What happened to a merge no longer pending: delivered (said with its seq), else not found. */
  private settledOutcome(mergeId: string): MergeBackActionResponse {
    const seq = this.delivered.get(mergeId);
    if (seq !== undefined) return { mergeId, outcome: "sent", seq };
    throw new LineageError("That merge was already delivered or discarded.", "THREAD_NOT_FOUND");
  }

  /** A merge the parent took: off the queue, and remembered as delivered for a late action on it. */
  private settle(entry: MergeOutboxEntry, seq: number): void {
    this.outbox.entries = this.outbox.entries.filter((other) => other.mergeId !== entry.mergeId);
    this.retryAfterSeq.delete(entry.mergeId);
    this.delivered.set(entry.mergeId, seq);
    if (this.delivered.size > DELIVERED_MEMORY) {
      this.delivered.delete(this.delivered.keys().next().value as string);
    }
  }

  // -------------------------------------------------------------------------

  private requireApi(): DaemonApi {
    if (!this.api) throw new LineageError("Orquester is still starting. Try again in a moment.", "HOST_UNAVAILABLE");
    return this.api;
  }

  /** The parent's merges still waiting to be delivered (a failed one waits for the user), oldest first. */
  private queuedFor(parentId: string): MergeOutboxEntry[] {
    return this.outbox.entries.filter((entry) => entry.parentSessionId === parentId && entry.state !== "failed");
  }

  private lane<T>(parentId: string, task: () => Promise<T>): Promise<T> {
    const before = this.lanes.get(parentId) ?? Promise.resolve();
    const run = before.then(task, task);
    const tail = run.catch(() => undefined);
    this.lanes.set(parentId, tail);
    void tail.then(() => {
      if (this.lanes.get(parentId) === tail) this.lanes.delete(parentId);
    });
    return run;
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
    return (await this.idleParent(api, parentId)) !== null;
  }

  /** The parent's thread when it can take a message now, else null. */
  private async idleParent(api: DaemonApi, parentId: string): Promise<ThreadSnapshotPayload | null> {
    const summary = this.opts.sessions.get(parentId);
    if (!summary) return null;
    try {
      const snap = await this.readThread(api, parentId);
      return acceptsMessage(summary, snap) ? snap : null;
    } catch {
      return null;
    }
  }

  private async deliver(api: DaemonApi, entry: MergeOutboxEntry): Promise<Delivery> {
    try {
      const res = await api.request("POST", agentChatCommandPath(entry.parentSessionId, "turn"), {
        body: { commandId: attemptCommandId(entry), input: entry.input, interactionMode: "default" }
      });
      if (res.status < 400) return { kind: "sent", seq: (res.body as { seq?: number } | null)?.seq ?? 0 };
      const error = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
      if (res.status === 503 || error?.code === "HOST_UNAVAILABLE") return { kind: "unavailable" };
      return {
        kind: "refused",
        message: error?.message ?? `The parent refused the message (${res.status}).`,
        // A host refusal of the moment (compaction running, a session starting) may pass;
        // a malformed command, a thread gone or an id clash will not.
        retryable: res.status === 409 && (error?.code === "COMMAND_REJECTED" || error?.code === "COMPACTION_UNAVAILABLE")
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  private markFailed(entry: MergeOutboxEntry, message: string): void {
    entry.state = "failed";
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.error = message.slice(0, 2_000);
  }

  /** The parent's thread `seq` at a merge's last passing refusal: it is retried only past it. */
  private readonly retryAfterSeq = new Map<string, number>();
  /** Merges delivered lately and the parent's seq then, for an action that arrives after. */
  private readonly delivered = new Map<string, number>();

  private drainAll(): void {
    for (const parentId of new Set(this.outbox.entries.map((entry) => entry.parentSessionId))) {
      void this.drain(parentId);
    }
  }

  /** Deliver the parent's oldest queued merge if the parent is idle — one, then wait for the next idle point. */
  private drain(parentId: string): Promise<void> {
    if (this.drainWaiting.has(parentId)) return Promise.resolve();
    this.drainWaiting.add(parentId);
    return this.lane(parentId, async () => {
      this.drainWaiting.delete(parentId);
      await this.drainOnce(parentId);
    });
  }

  private async drainOnce(parentId: string): Promise<void> {
    const api = this.api;
    if (!api || this.stopped) return;
    const entry = this.queuedFor(parentId)[0];
    if (!entry) return;
    if (!this.opts.sessions.get(parentId)) {
      // The parent tab was closed: nothing will take these. Kept, failed and said so, for
      // the fork to see and discard — never dropped behind a caller told "queued".
      for (const queued of this.queuedFor(parentId)) {
        queued.state = "failed";
        queued.error = "The session this merge was for was closed.";
      }
      this.opts.logger?.warn?.("[lineage] merges for a closed parent marked failed", { parentId });
      await this.persist(this.involved(parentId));
      return;
    }
    const snap = await this.idleParent(api, parentId);
    if (snap === null) return;
    // A retry after a passing refusal waits for a genuine next idle point: the parent's
    // log must have moved past the refusal (the refused /turn wrote nothing to it). Our
    // own persist's tab update is no such point, so the attempts never run back to back.
    const refusedAt = this.retryAfterSeq.get(entry.mergeId);
    if (refusedAt !== undefined && snap.seq <= refusedAt) return;
    const sent = await this.deliver(api, entry);
    if (sent.kind === "unavailable") return;
    if (sent.kind === "refused") {
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.error = sent.message.slice(0, 2_000);
      this.retryAfterSeq.set(entry.mergeId, snap.seq);
      if (!sent.retryable || entry.attempts >= MAX_DRAIN_ATTEMPTS) {
        entry.state = "failed";
        this.opts.logger?.warn?.("[lineage] the parent refused a queued merge; kept as failed", {
          parentId,
          mergeId: entry.mergeId,
          attempts: entry.attempts,
          reason: sent.message
        });
      }
      await this.persist([parentId, entry.childSessionId]);
      return;
    }
    this.settle(entry, sent.seq);
    await this.persist([parentId, entry.childSessionId]);
  }

  /** Every session with a merge to or from `parentId`'s queue. */
  private involved(parentId: string): string[] {
    return [
      parentId,
      ...this.outbox.entries.filter((entry) => entry.parentSessionId === parentId).map((entry) => entry.childSessionId)
    ];
  }

  private armRecheck(): void {
    const ms = this.opts.recheckMs ?? DEFAULT_RECHECK_MS;
    if (ms <= 0 || this.stopped || this.recheck || this.outbox.entries.length === 0 || !this.api) return;
    this.recheck = setInterval(() => {
      if (!this.outbox.entries.some((entry) => entry.state !== "failed")) {
        if (this.recheck) clearInterval(this.recheck);
        this.recheck = null;
        return;
      }
      this.drainAll();
    }, ms);
    this.recheck.unref?.();
  }

  /**
   * Tell the tabs what is pending for them (`SessionSummary.pendingMerges`):
   * the ones `touched`, or — with none — every tab with something pending and
   * every one that had something before.
   */
  private publish(touched?: readonly string[]): void {
    const set = this.opts.setPendingMerges;
    if (!set) return;
    const ids = new Set(touched ?? []);
    if (touched === undefined) {
      for (const entry of this.outbox.entries) {
        ids.add(entry.parentSessionId);
        ids.add(entry.childSessionId);
      }
      for (const id of this.published) ids.add(id);
    }
    for (const id of ids) {
      const merges = this.pendingFor(id);
      if (merges.length > 0) this.published.add(id);
      else this.published.delete(id);
      set(id, merges);
    }
  }

  /** Written in order, the latest state each time; unreadable entries go back as they came. */
  private persist(touched: readonly string[]): Promise<void> {
    this.publish(touched);
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

type Delivery =
  | { kind: "sent"; seq: number }
  | { kind: "unavailable" }
  | { kind: "refused"; message: string; retryable: boolean };

/**
 * How often a parent's passing refusal (a compaction running, a session
 * starting) is tried again at its idle points before the merge is marked
 * failed for the user to deliver or discard.
 */
export const MAX_DRAIN_ATTEMPTS = 3;

/** How many delivered merges are remembered for a late deliver/discard on them. */
const DELIVERED_MEMORY = 256;

/** The longest merge id a caller may choose: room is left for an attempt suffix. */
export const MAX_MERGE_ID_CHARS = 180;

/**
 * The `/turn` command id of a merge's current attempt. The host keeps a receipt
 * per command id and REPLAYS a recorded rejection for the same id, so a retry
 * after a refusal must be a new command: the first attempt is the merge's own id
 * and each refused attempt moves it on (`<mergeId>:<n>`). A re-post after a 503
 * (nothing was recorded) keeps the id it had, and so does a re-post after a
 * crash between the send and the queue's write — the host's receipt answers it.
 */
export function attemptCommandId(entry: Pick<MergeOutboxEntry, "mergeId" | "attempts">): string {
  const attempts = entry.attempts ?? 0;
  return attempts === 0 ? entry.mergeId : `${entry.mergeId}:${attempts}`;
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
  const body = parseMergeBackMessage(entry.input)?.body ?? entry.input;
  return {
    mergeId: entry.mergeId,
    parentSessionId: entry.parentSessionId,
    childSessionId: entry.childSessionId,
    queuedAt: entry.queuedAt,
    state: entry.state === "failed" ? "failed" : "queued",
    preview: body.length > MERGE_PREVIEW_CHARS ? `${body.slice(0, MERGE_PREVIEW_CHARS - 1)}…` : body,
    attempts: entry.attempts ?? 0,
    ...(entry.error ? { error: entry.error } : {})
  };
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MERGE_ID_CHARS ? trimmed : undefined;
}
