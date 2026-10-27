/**
 * Test doubles for the linking module: a fake worker-chat port whose "chats" work the inbox the
 * way a real worker does (next → answer → submit … until done), with per-account behaviour (a
 * usage limit after N tasks, an invalid first answer), and helpers to write myKG-style task files.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeWorkerTask } from "@orquester/api";
import type { KnowledgeRuntime } from "../ports.ts";
import type { SpawnMykg } from "./runner.ts";
import type { FailoverMemory } from "../../workflows/agent/failover.ts";
import type { InboxBroker } from "./inbox.ts";
import type { WorkerCandidate, WorkerOutcome, WorkerPick, WorkerSessionPort } from "./workers.ts";

export interface FakeAccountBehaviour {
  /** After this many accepted answers the chat reports a usage limit (resetting at `resetsAt`). */
  limitAfter?: number;
  resetsAt?: string;
  /** The chat's first answer is prose (refused), then it answers properly. */
  invalidFirst?: boolean;
}

export interface FakeWorkerSession {
  id: string;
  accountId: string;
  runId: string;
  answered: string[];
  refused: number;
  seenInstructions: (string | null)[];
  /** Every task's `input` as the chat was shown it (`step` first), in order. */
  inputs: { step: string; input: string }[];
  /** Closed; `interrupt`: its turn was interrupted first (by `interrupt` or `stop`). */
  stopped: { interrupt: boolean } | null;
  /** The usage of the turn still running: reported (by `usage`) only once that turn ends. */
  runningTurn: { in: number; out: number } | null;
  /** Usage of turns that ended beside the answers (an interrupted turn's). */
  endedTurns: { in: number; out: number };
  interrupted: boolean;
  end(outcome: WorkerOutcome): void;
}

export type AnswerFor = (task: KnowledgeWorkerTask) => string;

/** A plausible myKG answer: Pass 2 extractions name the entry file of the task input; a pair check is consistent. */
export const defaultAnswer: AnswerFor = (task) => {
  if (task.step === "pair-check") return JSON.stringify({ verdict: "consistent", note: "Both say the same." });
  if (task.step === "concept-check") return JSON.stringify({ same: false, keep: "a", reason: "Different things." });
  if (task.step === "cluster-name") return JSON.stringify({ label: "Test topic" });
  if (task.step === "round-test") return JSON.stringify({ ok: true });
  const file = /^FILE (\S+)/m.exec(task.input)?.[1];
  if (task.step === "pass2" && file) {
    const stem = file.replace(/\.md$/, "");
    return JSON.stringify({ nodes: [{ id: `concept-${stem}`, name: `Concept ${stem}`, source_files: [file] }], edges: [] });
  }
  return JSON.stringify({ concepts: [], properties: [] });
};

export class FakeWorkerPort implements WorkerSessionPort<WorkerCandidate> {
  readonly sessions: FakeWorkerSession[] = [];
  readonly coolDowns: { accountId: string; resetsAt?: string }[] = [];
  readonly limited = new Map<string, number>();
  /** Starts that fail (non-fatal) before one succeeds. */
  failStarts = 0;
  /** `auto`: chats work the inbox; `manual`: the test drives them (`end`). */
  mode: "auto" | "manual" = "auto";
  broker: (() => InboxBroker | null) | null = null;
  running = new Set<string>();
  private n = 0;
  private readonly watches = new Map<string, { resolve: (outcome: WorkerOutcome) => void; promise: Promise<WorkerOutcome> }>();

  constructor(
    readonly accounts: string[],
    readonly now: () => Date,
    readonly behaviour: Record<string, FakeAccountBehaviour> = {},
    readonly answerFor: AnswerFor = defaultAnswer,
    /** Calls a chat's tools go through (the service's worker methods, or a broker). */
    readonly tools?: {
      next(sessionId: string): Promise<import("@orquester/api").KnowledgeWorkerNextResponse>;
      submit(sessionId: string, taskId: string, answer: string): Promise<import("@orquester/api").KnowledgeWorkerSubmitResponse>;
    }
  ) {}

  async pick(_memory: FailoverMemory): Promise<WorkerPick<WorkerCandidate>> {
    const nowMs = this.now().getTime();
    for (const accountId of this.accounts) {
      const until = this.limited.get(accountId);
      if (until === undefined || until <= nowMs) return { kind: "chosen", candidate: { accountId, model: "sonnet" } };
    }
    if (this.accounts.length === 0) return { kind: "none", reason: "no-account", resumesAt: null, message: "No Claude account." };
    const earliest = Math.min(...this.accounts.map((id) => this.limited.get(id) ?? Number.POSITIVE_INFINITY));
    return { kind: "none", reason: "usage-limit", resumesAt: new Date(earliest).toISOString(), message: "Every account is at its limit." };
  }

  async start(input: { candidate: WorkerCandidate; runId: string }): Promise<{ sessionId: string }> {
    if (this.failStarts > 0) {
      this.failStarts -= 1;
      throw new Error("create refused");
    }
    const id = `w${++this.n}`;
    let resolve!: (outcome: WorkerOutcome) => void;
    const promise = new Promise<WorkerOutcome>((r) => (resolve = r));
    const session: FakeWorkerSession = {
      id,
      accountId: input.candidate.accountId,
      runId: input.runId,
      answered: [],
      refused: 0,
      seenInstructions: [],
      inputs: [],
      stopped: null,
      runningTurn: null,
      endedTurns: { in: 0, out: 0 },
      interrupted: false,
      end: (outcome) => {
        this.running.delete(id);
        resolve(outcome);
      }
    };
    this.watches.set(id, { resolve, promise });
    this.sessions.push(session);
    this.running.add(id);
    if (this.mode === "auto") void this.work(session);
    return { sessionId: id };
  }

  watch(sessionId: string, signal: AbortSignal): Promise<WorkerOutcome> {
    const watch = this.watches.get(sessionId);
    if (!watch) {
      // An adopted chat (from before a restart): it works too.
      let resolve!: (outcome: WorkerOutcome) => void;
      const promise = new Promise<WorkerOutcome>((r) => (resolve = r));
      this.watches.set(sessionId, { resolve, promise });
      const session: FakeWorkerSession = {
        id: sessionId,
        accountId: this.accounts[0] ?? "",
        runId: "",
        answered: [],
        refused: 0,
        seenInstructions: [],
        inputs: [],
        stopped: null,
        runningTurn: null,
        endedTurns: { in: 0, out: 0 },
        interrupted: false,
        end: (outcome) => {
          this.running.delete(sessionId);
          resolve(outcome);
        }
      };
      this.sessions.push(session);
      if (this.mode === "auto") void this.work(session);
      return this.withAbort(promise, signal);
    }
    return this.withAbort(watch.promise, signal);
  }

  async coolDown(candidate: WorkerCandidate, _memory: FailoverMemory, outcome: Extract<WorkerOutcome, { kind: "limit" }>): Promise<void> {
    this.coolDowns.push({ accountId: candidate.accountId, ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}) });
    const until = outcome.resetsAt ? Date.parse(outcome.resetsAt) : this.now().getTime() + 3_600_000;
    this.limited.set(candidate.accountId, until);
  }

  /** `interrupt`, `usage` and `stop` calls in order (`interrupt:<id>`, `usage:<id>`, `stop:<id>`). */
  readonly calls: string[] = [];
  /** Usage of chats this port did not start (a previous daemon's), until they are stopped. */
  readonly foreignUsage = new Map<string, { in: number; out: number }>();

  /**
   * Like the daemon's port: a stopped chat's tab is deleted, and its turns' usage with it; a turn
   * still running has not reported its usage yet.
   */
  async usage(sessionId: string): Promise<{ in: number; out: number }> {
    this.calls.push(`usage:${sessionId}`);
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return this.foreignUsage.get(sessionId) ?? { in: 0, out: 0 };
    if (session.stopped) return { in: 0, out: 0 };
    return { in: 1000 * session.answered.length + session.endedTurns.in, out: 100 * session.answered.length + session.endedTurns.out };
  }

  /** The running turn ends (interrupted): its usage is reported from now on. */
  async interrupt(sessionId: string): Promise<void> {
    this.calls.push(`interrupt:${sessionId}`);
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.interrupted = true;
    if (session.runningTurn) {
      session.endedTurns = { in: session.endedTurns.in + session.runningTurn.in, out: session.endedTurns.out + session.runningTurn.out };
      session.runningTurn = null;
    }
  }

  async stop(sessionId: string, options: { interrupt: boolean }): Promise<void> {
    this.calls.push(`stop:${sessionId}`);
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && !session.stopped) session.stopped = { interrupt: options.interrupt || session.interrupted };
    this.foreignUsage.delete(sessionId);
    this.running.delete(sessionId);
    this.watches.get(sessionId)?.resolve({ kind: "closed" });
  }

  async isRunning(sessionId: string): Promise<boolean> {
    return this.running.has(sessionId);
  }

  private withAbort(promise: Promise<WorkerOutcome>, signal: AbortSignal): Promise<WorkerOutcome> {
    if (signal.aborted) return Promise.resolve({ kind: "cancelled" });
    return new Promise<WorkerOutcome>((resolve) => {
      signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true });
      void promise.then(resolve);
    });
  }

  private toolsFor(): NonNullable<FakeWorkerPort["tools"]> {
    if (this.tools) return this.tools;
    const broker = this.broker?.();
    if (!broker) throw new Error("FakeWorkerPort: no broker to work");
    return { next: (id) => broker.next(id), submit: (id, taskId, answer) => broker.submit(id, taskId, answer) };
  }

  /** The chat's one turn: next → answer → submit … until done (or its account's limit). */
  private async work(session: FakeWorkerSession): Promise<void> {
    const behaviour = this.behaviour[session.accountId] ?? {};
    const tools = this.toolsFor();
    let reply = await tools.next(session.id);
    let refusedOnce = false;
    while (reply.kind === "task") {
      if (session.stopped) return;
      const task = reply.task;
      session.seenInstructions.push(task.instructions);
      session.inputs.push({ step: task.step, input: task.input });
      if (behaviour.limitAfter !== undefined && session.answered.length >= behaviour.limitAfter) {
        session.end({ kind: "limit", reason: "usage_limit", ...(behaviour.resetsAt ? { resetsAt: behaviour.resetsAt } : {}), message: "You've hit your limit" });
        return;
      }
      const answer = behaviour.invalidFirst && !refusedOnce ? "Sure! Here is what I found." : this.answerFor(task);
      const submitted = await tools.submit(session.id, task.taskId, answer);
      if (!submitted.accepted) {
        // Told to stop (it refused too often: the task goes to another chat), it ends its turn.
        if (/end your turn now/.test(submitted.error)) break;
        refusedOnce = true;
        session.refused += 1;
        reply = { kind: "task", task: { ...task, instructions: null } };
        continue;
      }
      session.answered.push(task.taskId);
      reply = submitted.next;
    }
    session.end({ kind: "done" });
  }
}

/** myKG's task id (`AgentAdapter._make_task_id`). */
export function mykgTaskId(system: string, user: string, context: string): string {
  return createHash("sha256").update(`${system}\n--user--\n${user}\n--ctx--\n${context}`).digest("hex");
}

/** Writes a task envelope into an inbox as myKG does (temp + rename). */
export async function writeMykgTask(inbox: string, input: { system: string; user: string; step: string; context: string; createdAt: string }): Promise<string> {
  const id = mykgTaskId(input.system, input.user, input.context);
  const envelope = {
    task_id: id,
    step: input.step,
    context_label: input.context,
    system: input.system,
    user: input.user,
    max_tokens: 32000,
    timeout_seconds: 172800,
    created_at: input.createdAt
  };
  const path = join(inbox, `${id}.task.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(envelope, null, 2));
  await rename(`${path}.tmp`, path);
  return id;
}

/** The fake `mykg extract-graph` (`fixtures/fake-mykg.mjs`). */
export const FAKE_MYKG = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mykg.mjs");

/** Runs the fake myKG with this node, whatever binary path the runner was given. */
export const fakeSpawn: SpawnMykg = (_file, args, options) => spawn(process.execPath, [FAKE_MYKG, ...args], options);

export const FAKE_RUNTIME: KnowledgeRuntime = {
  mykgVersion: "0.4.10",
  mykgBin: "/plugin/runtime/versions/0.4.10/venv/bin/mykg",
  pythonBin: "/plugin/runtime/versions/0.4.10/venv/bin/python",
  embeddingModelDir: "/plugin/runtime/model",
  embeddingModelId: "Xenova/all-MiniLM-L6-v2",
  embeddingDimensions: 384,
  tiktokenCacheDir: "/plugin/runtime/versions/0.4.10/tiktoken"
};
