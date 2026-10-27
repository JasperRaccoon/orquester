/**
 * Knowledge Graph linking — the inbox broker between myKG's agent provider and the worker chats
 * (spec "Indexing on the subscription"; myKG 0.4.10 `llm/agent_adapter.py`, `docs/agent-mode.md`).
 *
 * myKG writes every LLM call as `intermediate/agent_inbox/<task_id>.task.json` (temp + rename) and
 * polls `intermediate/agent_outbox/<task_id>.done`; it then reads `<task_id>.answer.json`
 * (`{"task_id", "answer"}`) and strips code fences itself. A task file stays in the inbox after it
 * is answered: "pending" is "no `.done` yet". Answered tasks are cached by myKG (same id → same
 * answer), so a resumed run never asks again.
 *
 * The broker:
 * - finds tasks with `fs.watch` on the inbox plus a rescan whenever a worker asks for work;
 * - leases each pending task to ONE worker chat; a chat that ends or fails gets its lease
 *   released (`release`) and the task goes to the next asker;
 * - checks every answer: it must parse as JSON (an object or an array) once trimmed and stripped
 *   of an optional ```json fence — else `{accepted: false, error}` with the parse error and the
 *   chat keeps the task to redo it; after {@link MAX_REFUSALS} refusals of one task the chat is
 *   retired and the task goes to another chat (a chat that cannot answer it must not loop); an accepted answer is written as `<id>.answer.json` (temp +
 *   rename) and only THEN `<id>.done` (temp + rename), so myKG never reads half an answer;
 * - sends a task's instructions (myKG's system prompt) only the first time a chat sees that exact
 *   text; afterwards `instructions: null, sameInstructionsAs: <the task it came with>`;
 * - retires a chat at its budget (tasks served, or an estimate of the tokens its context took on):
 *   `{kind: "done", reason: "session-budget"}`, and the pool starts a fresh one while tasks remain;
 * - answers `done` with `run-finished` / `run-cancelled` once the run ends;
 * - answers a name-normalization task ({@link REUSABLE_STEPS}) from an answer a chat already gave
 *   to the very same prompt (system + user) in this session, without asking a chat again. myKG's
 *   own cache keys a task by its prompt AND its label, and normalization labels its calls
 *   `normalize_names batch i/n`: when a type is added or the types reorder, every batch's label
 *   moves and myKG would ask again for name lists that did not change. The answer reused is the
 *   one a Claude Code chat gave to exactly that prompt — what myKG's cache would return had the
 *   label stayed put. Accepted normalization answers are indexed in
 *   `intermediate/orquester-answer-reuse.ndjson` (prompt hash → task id), so the index outlives
 *   the run.
 *
 * A new myKG process on a session first gets an inbox with only answered tasks
 * ({@link clearUnansweredTasks}, before it is spawned): a task the previous process (failed,
 * cancelled, or left by a restart) asked for and nobody answered may never be asked again — its
 * entry was edited or deleted, a batch label moved — and a worker answering it would spend tokens
 * on nothing. myKG names a task by its prompt and label (`_make_task_id`), first returns a cached
 * answer (`.done` + `.answer.json`) and otherwise (re)writes the task file, so every task the new
 * process waits for reappears under the same id; the answers (the cache) are never touched.
 *
 * `next` long-polls: with no task waiting it holds the call until one appears, the run ends, or
 * `nextWaitMs` passes (then the chat is retired; the pool restarts one when work appears). Every
 * wait is an event or the injected clock — no sleeps.
 *
 * What a worker sees of a task (`view`) may say more than myKG's prompt: `contextFor` adds a block
 * after it (phase 2 spec, "Neighbour context": the concepts of similar entries for a Pass 2 task).
 * The task file, its id and so myKG's cache key stay as myKG wrote them. A step can have a stricter
 * answer check than "parses as JSON" (`validate`: the daemon's own pair-check tasks).
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch as fsWatch } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeWorkerNextResponse, KnowledgeWorkerSubmitResponse, KnowledgeWorkerTask } from "@orquester/api";
import type { Clock } from "../../workflows/contracts.ts";

export const INBOX_DIR = "agent_inbox";
export const OUTBOX_DIR = "agent_outbox";
const TASK_SUFFIX = ".task.json";
/** Steps whose answers are reused for an identical prompt under another label (see the module header). */
export const REUSABLE_STEPS: ReadonlySet<string> = new Set(["normalize_names"]);
export const REUSE_INDEX_FILE = "orquester-answer-reuse.ndjson";

/**
 * Defaults for one worker chat's life (spec: "Each session is retired before its context grows
 * large"). Every tool round trip re-reads the whole conversation (prompt-cached), so a task's cost
 * grows with the tasks before it, while a fresh chat pays its fixed prompt (Claude Code's system
 * prompt, the tool list, the step instructions) once. With a ~10–20k token fixed part and ~4k
 * tokens per task (input + answer), the per-task cost under caching is lowest around 8–12 tasks;
 * 12 tasks or ~60k tokens of task text, whichever comes first, keeps it flat and far from the
 * window.
 */
export const DEFAULT_SESSION_BUDGET = { tasks: 12, tokens: 60_000 };
/** A task view above this estimate is logged: it may not fit the worker's tool-result limit (60k, see the Claude launch). */
export const MAX_TASK_TOKENS = 45_000;
/** Answers of one task a chat may have refused before it is retired and the task handed on. */
export const MAX_REFUSALS = 3;
/** How long `next` holds a call with nothing to hand out before it retires the chat. */
export const DEFAULT_NEXT_WAIT_MS = 10 * 60_000;

/** myKG's task envelope (`TaskEnvelope` in `llm/agent_adapter.py`). */
export interface InboxTaskEnvelope {
  task_id: string;
  step: string;
  context_label: string;
  system: string;
  user: string;
  max_tokens: number;
  timeout_seconds: number;
  created_at: string;
}

/** The fs operations the broker uses (tests record their order). */
export interface InboxFiles {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  appendFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(dir: string): Promise<void>;
}

export const nodeInboxFiles: InboxFiles = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, text) => writeFile(path, text, { mode: 0o600 }),
  appendFile: (path, text) => appendFile(path, text, { mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  }
};

export type InboxWatch = (dir: string, onEvent: () => void) => { close(): void };

const nodeWatch: InboxWatch = (dir, onEvent) => {
  const watcher = fsWatch(dir, { persistent: false }, () => onEvent());
  watcher.on("error", () => undefined);
  return watcher;
};

export interface InboxBrokerOptions {
  clock: Clock;
  budget?: { tasks: number; tokens: number };
  nextWaitMs?: number;
  files?: InboxFiles;
  /** `null` = no watcher (rescans on demand only). */
  watch?: InboxWatch | null;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  /**
   * Extra input shown to the worker after myKG's prompt (`null`: none), computed once per task
   * before it is first handed out. Never changes the task file, its id, or myKG's cache.
   */
  contextFor?: (envelope: InboxTaskEnvelope) => Promise<string | null>;
  /** A stricter check of a parsed answer for some steps (or tasks): an error message refuses it like a parse error. */
  validate?: (step: string, value: unknown, taskId: string) => string | null;
  /**
   * Chats that may give up on one task (refused {@link MAX_REFUSALS} times, or ended holding it)
   * before the broker hands it out no more (`abandoned`): one task no chat can answer then cannot
   * end every chat of the run. Absent: no limit (myKG waits for every task of a linking run).
   */
  maxGiveUpsPerTask?: number;
}

export type ParsedAnswer = { ok: true; text: string } | { ok: false; error: string };

const FENCE = /^```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/;

/** The answer as myKG will read it: trimmed, an optional ```json fence removed, valid JSON. */
export function parseWorkerAnswer(raw: string): ParsedAnswer {
  let text = raw.trim();
  const fenced = FENCE.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (text === "") return { ok: false, error: "The answer is empty." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `The answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (value === null || typeof value !== "object") {
    return { ok: false, error: "The answer must be the JSON object (or array) the instructions describe, not a bare value." };
  }
  return { ok: true, text };
}

interface TaskEntry {
  id: string;
  envelope: InboxTaskEnvelope | null;
  /** What the worker is shown (`envelope.user` plus any context); null until first prepared. */
  input: string | null;
  instructionsHash: string | null;
  leasedTo: string | null;
  done: boolean;
  /** Being written (an accepted answer in flight). */
  writing: boolean;
  /** Chats that gave up on it while the run went on ({@link InboxBrokerOptions.maxGiveUpsPerTask}). */
  giveUps?: Set<string>;
  /** Handed out no more: too many chats gave up on it. */
  abandoned?: boolean;
}

interface SessionEntry {
  id: string;
  tasks: number;
  tokens: number;
  /** instructions hash → the task they were first sent with. */
  seen: Map<string, string>;
  lease: string | null;
  /** Refused answers to the task it holds now. */
  refusals: number;
  retired: boolean;
  /** It ended (or was retired) while holding a task it did not answer. */
  gaveUp: boolean;
}

export interface InboxCounts {
  /** Tasks seen this run (answered ones from before included). */
  known: number;
  pending: number;
  leased: number;
  /** Answers accepted by this broker. */
  answered: number;
  /** Tasks answered from an identical earlier prompt (no chat asked). */
  reused: number;
  /** Chats blocked in `next` right now. */
  waiting: number;
}

export interface InboxBrokerEvents {
  /** Tasks appeared, were answered, or a lease was released. */
  change: [];
  /** One accepted answer (`answer`: the JSON text written). */
  answered: [{ sessionId: string; taskId: string; step: string; answer: string }];
  /** A task too many chats gave up on is handed out no more ({@link InboxBrokerOptions.maxGiveUpsPerTask}). */
  abandoned: [{ taskId: string; step: string }];
}

export class InboxBroker {
  readonly events = new EventEmitter<InboxBrokerEvents>();
  private readonly clock: Clock;
  private readonly budget: { tasks: number; tokens: number };
  private readonly nextWaitMs: number;
  private readonly files: InboxFiles;
  private readonly watchFn: InboxWatch | null;
  private readonly logger: InboxBrokerOptions["logger"];
  private readonly contextFor: InboxBrokerOptions["contextFor"];
  private readonly validate: InboxBrokerOptions["validate"];
  private readonly maxGiveUps: number;
  private inbox: string | null = null;
  private outbox: string | null = null;
  private reuseIndex: string | null = null;
  /** Prompt hash → a done task with that prompt (reusable steps only). */
  private readonly reusable = new Map<string, string>();
  private reused = 0;
  private watcher: { close(): void } | null = null;
  private disposed = false;
  private readonly tasks = new Map<string, TaskEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly wakers = new Set<() => void>();
  private readonly waiting = new Set<string>();
  private finished: "run-finished" | "run-cancelled" | null = null;
  private scanning: Promise<void> | null = null;
  private rescanAgain = false;
  private answered = 0;

  constructor(options: InboxBrokerOptions) {
    this.clock = options.clock;
    this.budget = options.budget ?? DEFAULT_SESSION_BUDGET;
    this.nextWaitMs = options.nextWaitMs ?? DEFAULT_NEXT_WAIT_MS;
    this.files = options.files ?? nodeInboxFiles;
    this.watchFn = options.watch === undefined ? nodeWatch : options.watch;
    this.logger = options.logger;
    this.contextFor = options.contextFor;
    this.validate = options.validate;
    this.maxGiveUps = options.maxGiveUpsPerTask ?? Number.POSITIVE_INFINITY;
  }

  /** Points the broker at a myKG session's `intermediate/` directory and starts watching. */
  async attach(intermediateDir: string): Promise<void> {
    this.inbox = join(intermediateDir, INBOX_DIR);
    this.outbox = join(intermediateDir, OUTBOX_DIR);
    this.reuseIndex = join(intermediateDir, REUSE_INDEX_FILE);
    await this.files.mkdir(this.inbox);
    await this.files.mkdir(this.outbox);
    await this.loadReuseIndex();
    // The run may have ended while the dirs were made: no watcher outlives it.
    if (this.disposed) return;
    this.watcher?.close();
    this.watcher = this.watchFn ? this.watchFn(this.inbox, () => void this.rescan()) : null;
    await this.rescan();
  }

  get attached(): boolean {
    return this.inbox !== null;
  }

  /** The run ended (`finish`): no task is handed out any more. */
  get isFinished(): boolean {
    return this.finished !== null;
  }

  /** The chat registered with (or called) this broker. */
  knows(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** A worker chat of this run (also implicit on its first call). */
  register(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { id: sessionId, tasks: 0, tokens: 0, seen: new Map(), lease: null, refusals: 0, retired: false, gaveUp: false });
    }
  }

  /**
   * The chat ended or failed: its lease goes back to the queue, and it gets no more work. `blame`
   * (default true): it gave up on the task it held — false when the account, not the task, ended it
   * (a usage limit) or the run was stopped under it.
   */
  release(sessionId: string, options: { blame?: boolean } = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.retired = true;
    if (session.lease !== null) {
      session.gaveUp = true;
      if (options.blame !== false) this.gaveUpOn(session.lease, session.id);
    }
    this.dropLease(session);
    this.changed();
  }

  /** How many chats gave up on this task while the run went on (0 for an unknown one). */
  giveUpsOf(taskId: string): number {
    return this.tasks.get(taskId)?.giveUps?.size ?? 0;
  }

  /** The chat ended, or was retired, holding a task it never answered (the pool counts it as a failure). */
  gaveUp(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.gaveUp === true;
  }

  /** The chat holds a task or is waiting in `next` (so it needs no new chat beside it). */
  engaged(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && !session.retired && (session.lease !== null || this.waiting.has(sessionId));
  }

  /** Tasks served (accepted answers) by one chat. */
  tasksOf(sessionId: string): number {
    return this.sessions.get(sessionId)?.tasks ?? 0;
  }

  /** The run ended: every waiting and later call answers `done` with this reason. */
  finish(reason: "run-finished" | "run-cancelled"): void {
    if (this.finished) return;
    this.finished = reason;
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    if (!this.finished) this.finish("run-cancelled");
  }

  counts(): InboxCounts {
    let pending = 0;
    let leased = 0;
    for (const task of this.tasks.values()) {
      if (task.done || task.abandoned || !task.envelope) continue;
      if (task.leasedTo !== null) leased += 1;
      else pending += 1;
    }
    return { known: this.tasks.size, pending, leased, answered: this.answered, reused: this.reused, waiting: this.waiting.size };
  }

  /** Pending tasks no waiting chat will pick up: what new chats are needed for. */
  demand(): number {
    if (this.finished) return 0;
    const { pending, waiting } = this.counts();
    return Math.max(0, pending - waiting);
  }

  /** Rescans the inbox (serialized; a request during a scan scans once more after it). */
  rescan(): Promise<void> {
    if (!this.inbox) return Promise.resolve();
    if (this.scanning) {
      this.rescanAgain = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescanAgain = false;
          await this.scanOnce();
        } while (this.rescanAgain);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** The next task for `sessionId` (its current lease first), else wait; see the module header. */
  async next(sessionId: string, signal?: AbortSignal): Promise<KnowledgeWorkerNextResponse> {
    this.register(sessionId);
    const session = this.sessions.get(sessionId)!;
    const deadline = this.clock.now().getTime() + this.nextWaitMs;
    for (;;) {
      if (this.finished) return { kind: "done", reason: this.finished };
      if (session.retired) return { kind: "done", reason: "session-budget" };
      const held = session.lease !== null ? this.tasks.get(session.lease) : undefined;
      if (held && !held.done && held.leasedTo === session.id) return { kind: "task", task: this.view(session, held) };
      session.lease = null;
      if (session.tasks >= this.budget.tasks || session.tokens >= this.budget.tokens) {
        session.retired = true;
        return { kind: "done", reason: "session-budget" };
      }
      await this.rescan();
      // The run may have ended, or the chat been released, while the scan ran.
      if (this.finished || session.retired) continue;
      const task = this.firstPending();
      if (task && task.input === null) {
        // Its view is prepared once, before the lease; then everything is checked again.
        await this.prepare(task);
        continue;
      }
      if (task) {
        task.leasedTo = session.id;
        session.lease = task.id;
        session.refusals = 0;
        return { kind: "task", task: this.view(session, task) };
      }
      const left = deadline - this.clock.now().getTime();
      if (left <= 0 || signal?.aborted) {
        session.retired = true;
        this.changed();
        return { kind: "done", reason: "session-budget" };
      }
      await this.waitForChange(session.id, left, signal);
    }
  }

  /** Validates and writes one answer, then hands out the next task (see the module header). */
  async submit(sessionId: string, taskId: string, answer: string, signal?: AbortSignal): Promise<KnowledgeWorkerSubmitResponse> {
    this.register(sessionId);
    const session = this.sessions.get(sessionId)!;
    let task = this.tasks.get(taskId);
    if (!task) {
      await this.rescan();
      task = this.tasks.get(taskId);
    }
    if (!task || (!task.envelope && !task.done)) {
      return { accepted: false, error: `There is no task "${taskId.slice(0, 80)}". Call knowledge_worker_next_task for your next task.` };
    }
    if (task.done || task.writing) {
      // Answered already (by this chat's earlier call, or another chat's): nothing to redo.
      if (session.lease === task.id) session.lease = null;
      return { accepted: true, next: await this.next(sessionId, signal) };
    }
    let parsed = parseWorkerAnswer(answer);
    if (parsed.ok && this.validate) {
      const error = this.validate(task.envelope!.step, JSON.parse(parsed.text), task.id);
      if (error !== null) parsed = { ok: false, error };
    }
    if (!parsed.ok) {
      // The chat keeps the task and redoes it.
      if (task.leasedTo === null) task.leasedTo = session.id;
      if (task.leasedTo === session.id) session.lease = task.id;
      session.refusals += 1;
      if (session.refusals >= MAX_REFUSALS && session.lease === task.id) {
        // This chat cannot answer it: the task goes to a fresh chat (or no more), this one ends.
        session.retired = true;
        session.gaveUp = true;
        this.gaveUpOn(task.id, session.id);
        this.dropLease(session);
        this.changed();
        return { accepted: false, error: `${parsed.error} This task goes to another worker: end your turn now.` };
      }
      return { accepted: false, error: `${parsed.error} Answer with only the JSON the task's instructions ask for, then submit it again.` };
    }
    task.writing = true;
    try {
      await this.writeAnswer(task.id, parsed.text);
    } catch (error) {
      task.writing = false;
      this.logger?.warn("knowledge inbox: an answer could not be written", { taskId: task.id, error: String(error) });
      return { accepted: false, error: "The answer could not be stored. Submit it again." };
    }
    task.writing = false;
    task.done = true;
    const holder = task.leasedTo !== null ? this.sessions.get(task.leasedTo) : undefined;
    if (holder && holder.lease === task.id) holder.lease = null;
    task.leasedTo = null;
    if (session.lease === task.id) session.lease = null;
    session.tasks += 1;
    session.tokens += estimateTokens(task.input ?? task.envelope!.user) + estimateTokens(parsed.text);
    this.answered += 1;
    await this.indexForReuse(task);
    this.events.emit("answered", { sessionId, taskId: task.id, step: task.envelope!.step, answer: parsed.text });
    this.changed();
    return { accepted: true, next: await this.next(sessionId, signal) };
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Computes what the worker is shown (`contextFor`); a context that fails costs only the context. */
  private async prepare(task: TaskEntry): Promise<void> {
    const envelope = task.envelope!;
    let extra: string | null = null;
    if (this.contextFor) {
      try {
        extra = await this.contextFor(envelope);
      } catch (error) {
        this.logger?.warn("knowledge inbox: a task's context could not be built", { taskId: task.id, error: String(error) });
      }
    }
    task.input ??= extra ? `${envelope.user}\n\n${extra}` : envelope.user;
  }

  private view(session: SessionEntry, task: TaskEntry): KnowledgeWorkerTask {
    const envelope = task.envelope!;
    const hash = task.instructionsHash!;
    const first = session.seen.get(hash);
    let instructions: string | null = envelope.system;
    let sameAs: string | null = null;
    if (first !== undefined && first !== task.id) {
      instructions = null;
      sameAs = first;
    } else if (first === undefined) {
      session.seen.set(hash, task.id);
      session.tokens += estimateTokens(envelope.system);
    }
    const input = task.input ?? envelope.user;
    const size = estimateTokens(input) + (instructions ? estimateTokens(instructions) : 0);
    if (size > MAX_TASK_TOKENS) {
      // myKG's chunk and batch sizes (`mykg-config.ts`) keep tasks far below this; say so if one is not.
      this.logger?.warn("knowledge inbox: a task is larger than a worker's tool result should be", { taskId: task.id, step: envelope.step, tokens: size });
    }
    const { pending } = this.counts();
    return {
      taskId: task.id,
      step: envelope.step,
      instructions,
      sameInstructionsAs: sameAs,
      input,
      maxTokens: envelope.max_tokens,
      remaining: pending
    };
  }

  /** A chat gave up on a task while the run goes on: after `maxGiveUpsPerTask` chats did, it is handed out no more. */
  private gaveUpOn(taskId: string, sessionId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.done || this.finished) return;
    (task.giveUps ??= new Set()).add(sessionId);
    if (task.giveUps.size < this.maxGiveUps || task.abandoned) return;
    task.abandoned = true;
    this.logger?.warn("knowledge inbox: chats keep giving up on a task; it is handed out no more this run", { taskId, step: task.envelope?.step ?? null });
    this.events.emit("abandoned", { taskId, step: task.envelope?.step ?? "" });
  }

  private firstPending(): TaskEntry | undefined {
    let best: TaskEntry | undefined;
    for (const task of this.tasks.values()) {
      if (task.done || task.writing || task.abandoned || task.leasedTo !== null || !task.envelope) continue;
      if (!best || compareTasks(task, best) < 0) best = task;
    }
    return best;
  }

  private dropLease(session: SessionEntry): void {
    if (session.lease === null) return;
    const task = this.tasks.get(session.lease);
    if (task && task.leasedTo === session.id) task.leasedTo = null;
    session.lease = null;
  }

  private async scanOnce(): Promise<void> {
    const inbox = this.inbox;
    const outbox = this.outbox;
    if (!inbox || !outbox) return;
    let names: string[];
    try {
      names = await this.files.readdir(inbox);
    } catch {
      return;
    }
    let added = false;
    for (const name of names) {
      if (!name.endsWith(TASK_SUFFIX)) continue;
      const id = name.slice(0, -TASK_SUFFIX.length);
      if (!id || this.tasks.has(id)) continue;
      if (await this.files.exists(join(outbox, `${id}.done`))) {
        this.tasks.set(id, { id, envelope: null, input: null, instructionsHash: null, leasedTo: null, done: true, writing: false });
        continue;
      }
      let envelope: InboxTaskEnvelope | null = null;
      try {
        envelope = readEnvelope(JSON.parse(await this.files.readFile(join(inbox, name))), id);
      } catch {
        envelope = null;
      }
      if (!envelope) {
        // A task file this broker cannot read: left for a later scan (never answered blindly).
        this.logger?.warn("knowledge inbox: a task file did not read", { taskId: id });
        continue;
      }
      const entry: TaskEntry = {
        id,
        envelope,
        input: null,
        instructionsHash: createHash("sha256").update(envelope.system).digest("hex"),
        leasedTo: null,
        done: false,
        writing: false
      };
      this.tasks.set(id, entry);
      if (await this.answerFromReuse(entry)) continue;
      added = true;
    }
    if (added) this.changed();
  }

  private async writeAnswer(taskId: string, text: string): Promise<void> {
    const outbox = this.outbox!;
    const answerPath = join(outbox, `${taskId}.answer.json`);
    const answerTmp = `${answerPath}.${randomUUID()}.tmp`;
    await this.files.writeFile(answerTmp, JSON.stringify({ task_id: taskId, answer: text }));
    await this.files.rename(answerTmp, answerPath);
    const donePath = join(outbox, `${taskId}.done`);
    const doneTmp = `${donePath}.${randomUUID()}.tmp`;
    await this.files.writeFile(doneTmp, "");
    await this.files.rename(doneTmp, donePath);
  }

  private async loadReuseIndex(): Promise<void> {
    if (!this.reuseIndex) return;
    let text: string;
    try {
      text = await this.files.readFile(this.reuseIndex);
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { prompt?: unknown; taskId?: unknown };
        if (typeof value.prompt === "string" && typeof value.taskId === "string" && /^[0-9a-f]{64}$/.test(value.taskId)) this.reusable.set(value.prompt, value.taskId);
      } catch {
        // A torn last line (a crash mid-append): the rest still counts.
      }
    }
  }

  /** Records an accepted answer of a reusable step (best effort: a lost line only costs a later re-ask). */
  private async indexForReuse(task: TaskEntry): Promise<void> {
    const envelope = task.envelope;
    if (!envelope || !REUSABLE_STEPS.has(envelope.step) || !this.reuseIndex) return;
    const prompt = promptHash(envelope);
    if (this.reusable.has(prompt)) return;
    this.reusable.set(prompt, task.id);
    await this.files.appendFile(this.reuseIndex, `${JSON.stringify({ prompt, taskId: task.id })}\n`).catch(() => undefined);
  }

  /** A new task of a reusable step whose exact prompt was answered before: answered with that answer. */
  private async answerFromReuse(task: TaskEntry): Promise<boolean> {
    const envelope = task.envelope;
    if (!envelope || !REUSABLE_STEPS.has(envelope.step) || !this.outbox) return false;
    const source = this.reusable.get(promptHash(envelope));
    if (source === undefined || source === task.id) return false;
    let answer: string;
    try {
      if (!(await this.files.exists(join(this.outbox, `${source}.done`)))) return false;
      const value = JSON.parse(await this.files.readFile(join(this.outbox, `${source}.answer.json`))) as { answer?: unknown };
      if (typeof value.answer !== "string") return false;
      answer = value.answer;
    } catch {
      return false;
    }
    task.writing = true;
    try {
      await this.writeAnswer(task.id, answer);
    } catch {
      task.writing = false;
      return false;
    }
    task.writing = false;
    task.done = true;
    this.reused += 1;
    return true;
  }

  private changed(): void {
    const wakers = [...this.wakers];
    this.wakers.clear();
    for (const wake of wakers) wake();
    this.events.emit("change");
  }

  private waitForChange(sessionId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.add(sessionId);
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.waiting.delete(sessionId);
        timer.cancel();
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = this.clock.setTimeout(done, ms);
      this.wakers.add(done);
      signal?.addEventListener("abort", done);
      // The pool counts waiting chats when it decides how many to start.
      this.events.emit("change");
    });
  }
}

/**
 * Removes the task files of a session's inbox (`<intermediate>/agent_inbox`) that have no `.done`
 * (see the module header). Only while no myKG process runs on the session: the caller runs it
 * before spawning one. Answers its ids. A missing inbox clears nothing.
 */
export async function clearUnansweredTasks(intermediateDir: string): Promise<string[]> {
  const inbox = join(intermediateDir, INBOX_DIR);
  const outbox = join(intermediateDir, OUTBOX_DIR);
  let names: string[];
  try {
    names = await readdir(inbox);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(TASK_SUFFIX)) continue;
    const id = name.slice(0, -TASK_SUFFIX.length);
    if (!id || (await nodeInboxFiles.exists(join(outbox, `${id}.done`)))) continue;
    await rm(join(inbox, name), { force: true });
    removed.push(id);
  }
  return removed;
}

/**
 * Removes the answered tasks whose envelope `match`es — their `.done`, answer and task file — so
 * myKG asks again instead of reusing the cached answer (phase 2 spec, "Automatic re-linking": an
 * unchanged entry re-linked with neighbour context). Only while no myKG process runs on the session:
 * the caller runs it before spawning one. Answers the ids removed.
 */
export async function clearAnsweredTasks(intermediateDir: string, match: (envelope: InboxTaskEnvelope) => boolean): Promise<string[]> {
  const inbox = join(intermediateDir, INBOX_DIR);
  const outbox = join(intermediateDir, OUTBOX_DIR);
  let names: string[];
  try {
    names = await readdir(inbox);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(TASK_SUFFIX)) continue;
    const id = name.slice(0, -TASK_SUFFIX.length);
    if (!id) continue;
    let envelope: InboxTaskEnvelope | null;
    try {
      envelope = readEnvelope(JSON.parse(await readFile(join(inbox, name), "utf8")), id);
    } catch {
      envelope = null;
    }
    if (!envelope || !match(envelope)) continue;
    // `.done` first: myKG only reads an answer whose `.done` exists.
    await rm(join(outbox, `${id}.done`), { force: true });
    await rm(join(outbox, `${id}.answer.json`), { force: true });
    await rm(join(inbox, name), { force: true });
    removed.push(id);
  }
  return removed;
}

function compareTasks(a: TaskEntry, b: TaskEntry): number {
  const at = a.envelope!.created_at;
  const bt = b.envelope!.created_at;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function readEnvelope(value: unknown, id: string): InboxTaskEnvelope | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.system !== "string" || typeof v.user !== "string") return null;
  if (typeof v.task_id === "string" && v.task_id !== id) return null;
  return {
    task_id: id,
    step: typeof v.step === "string" ? v.step : "",
    context_label: typeof v.context_label === "string" ? v.context_label : "",
    system: v.system,
    user: v.user,
    max_tokens: typeof v.max_tokens === "number" && Number.isFinite(v.max_tokens) ? v.max_tokens : 32000,
    timeout_seconds: typeof v.timeout_seconds === "number" ? v.timeout_seconds : 0,
    created_at: typeof v.created_at === "string" ? v.created_at : ""
  };
}

/** What the model is shown (myKG's task id adds the label to it). */
function promptHash(envelope: InboxTaskEnvelope): string {
  return createHash("sha256").update(`${envelope.system}\n--user--\n${envelope.user}`).digest("hex");
}

/** A rough token count (4 characters a token) for the session budget. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
