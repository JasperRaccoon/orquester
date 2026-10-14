// Test-only harness for pull request watches: the service on a manual clock with a fake host
// (`pulls`), fake thread summaries (`sessions`), a recording `/turn` delivery and the event bus.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventMessage, SessionSummary } from "@orquester/api";
import type { PullRequestWatchesChangedEvent } from "@orquester/api/agent-chat";
import { parsePullRequestWatchFile } from "@orquester/config";

import { GitRemoteError, type PullRequestCheck, type PullRequestStatus } from "../providers/types.ts";
import { ManualClock } from "../workflows/testing/manual-trigger-clock.ts";
import { advance, silentLogger } from "../workflows/triggers/test-support.ts";
import { createPullRequestWatchService, type PullRequestWatchRead, type WakeDelivery } from "./service.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const START = "2026-10-14T10:00:00.000Z";
export const PROJECT = "/ws/acme/app";
export const REMOTE = "git@github.com:acme/app.git";
export const SHA = "a".repeat(40);

const dirs: string[] = [];
export function cleanupHarnesses(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({ name, status, url: `https://ci/${name}`, required: null });

export function prStatus(over: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 12,
    title: "Add retries",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    author: "agent-bot",
    headSha: SHA,
    headBranch: "feature",
    baseBranch: "main",
    mergeability: "clean",
    checks: [check("build", "pending"), check("lint", "success")],
    remarks: [],
    ...over
  };
}

export function chat(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    kind: "agent-chat",
    projectPath: PROJECT,
    chatSessionStatus: "ready",
    latestTurn: { turnId: "t1", state: "completed", startedAt: START, completedAt: START },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    goal: null,
    ...over
  } as SessionSummary;
}

export interface Harness {
  clock: ManualClock;
  file: string;
  sessions: Map<string, SessionSummary>;
  /** What the fake host answers for `<repoUrl>#<number>`. */
  pulls: Map<string, PullRequestStatus | Error>;
  /** Keys whose reads never answer. */
  hang: Set<string>;
  /** Resolves when the next read starts. */
  nextRead(): Promise<void>;
  /** While set, every save of the store fails. */
  saves: { fail: boolean; loaded: boolean; reject?: (content: string) => boolean };
  /** Warning lines the service logged. */
  warnings: string[];
  reads: Array<{ accountId: string | null; repoUrl: string; number: number; remarksSince?: string }>;
  delivered: Array<{ sessionId: string; commandId: string; input: string; fileHadIt: boolean }>;
  published: PullRequestWatchesChangedEvent[];
  outcome: { next: (sessionId: string) => WakeDelivery };
  emit(event: EventMessage): void;
  service: ReturnType<typeof createPullRequestWatchService>;
  run(ms: number): Promise<void>;
  restart(): Promise<void>;
}

export async function harness(
  opts: { viewer?: string[]; account?: string | null; accountOf?: (projectPath: string) => string | null } = {}
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "orq-prw-"));
  dirs.push(dir);
  const file = join(dir, "daemon", "pr-watches.json");
  const clock = new ManualClock(START);
  const sessions = new Map<string, SessionSummary>([["s1", chat("s1")]]);
  const pulls = new Map<string, PullRequestStatus | Error>();
  const hang = new Set<string>();
  const readWaiters: Array<() => void> = [];
  const saves: Harness["saves"] = { fail: false, loaded: true };
  const warnings: string[] = [];
  const reads: Harness["reads"] = [];
  const delivered: Harness["delivered"] = [];
  const published: PullRequestWatchesChangedEvent[] = [];
  const outcome = { next: (_sessionId: string): WakeDelivery => ({ kind: "sent" }) };
  const listeners = new Set<(event: EventMessage) => void>();
  let seq = 0;
  const build = () =>
    createPullRequestWatchService({
      file,
      read: async (input): Promise<PullRequestWatchRead> => {
        reads.push(input);
        for (const wake of readWaiters.splice(0)) wake();
        if (hang.has(`${input.repoUrl}#${input.number}`)) return new Promise<never>(() => undefined);
        const answer = pulls.get(`${input.repoUrl}#${input.number}`);
        if (!answer) throw new GitRemoteError(404, "not found", "not_found", 404);
        if (answer instanceof Error) throw answer;
        return { status: structuredClone(answer), viewer: opts.viewer ?? ["agent-bot"] };
      },
      projectRemote: async () => REMOTE,
      projectAccount: async (projectPath) => (opts.accountOf ? opts.accountOf(projectPath) : opts.account === undefined ? "acct-1" : opts.account),
      session: (id) => sessions.get(id),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      deliver: async (sessionId, body) => {
        const onDisk = parsePullRequestWatchFile(JSON.parse(readFileSync(file, "utf8")));
        delivered.push({ ...body, sessionId, fileHadIt: onDisk.watches.some((watch) => watch.pendingWake?.commandId === body.commandId) });
        return outcome.next(sessionId);
      },
      publish: (event) => published.push(event),
      sessionsLoaded: () => saves.loaded,
      write: async (path, content) => {
        if (saves.fail || saves.reject?.(content)) throw new Error("disk full");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, content, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      },
      clock,
      logger: { ...silentLogger, warn: (msg) => warnings.push(msg) },
      mintId: () => `id-${(seq += 1)}`,
      random: () => 0.5
    });
  const h: Harness = {
    clock,
    file,
    sessions,
    pulls,
    hang,
    saves,
    warnings,
    nextRead: () => new Promise<void>((resolve) => readWaiters.push(resolve)),
    reads,
    delivered,
    published,
    outcome,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    service: build(),
    run: (ms) => advance(clock, () => h.service.idle(), ms),
    restart: async () => {
      h.service.stop();
      await h.service.idle();
      listeners.clear();
      h.service = build();
      await h.service.start();
      await h.service.idle();
    }
  };
  await h.service.start();
  return h;
}

export const sessionEvent = (type: string, id: string): EventMessage => ({ id: "e", channel: "sessions", type, createdAt: START, payload: { id } });
