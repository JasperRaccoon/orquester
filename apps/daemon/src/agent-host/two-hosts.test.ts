/**
 * Host updates (spec 2026-11-01 P2.7): two real agent host processes on one appdir — the retiring
 * generation 0 and its replacement, generation 1 — each the real host (`startAgentHost`) with a
 * scripted provider (`two-hosts.fixture.ts`). A thread keeps running on the old host while a new
 * thread runs on the new one; at the end of its turn the old host releases it (session closed),
 * the new host adopts it, and its log shows one writer throughout. Every wait is on a process's
 * own line, a stream's end or an exit — never a timer.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import {
  agentChatIndexPath,
  agentChatThreadAttachmentsDir,
  agentChatThreadDir,
  agentHostForeignThreadsPath,
  agentHostSocketPath,
  agentHostTokenPath
} from "@orquester/config";

import { AGENT_HOST_ENV, agentHostRoutes, type AgentHostHealthResponse } from "./host-protocol.ts";

const FIXTURE = join(import.meta.dirname, "two-hosts.fixture.ts");

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  socketPath: string;
  token: string;
  /** Resolves with the first stdout line `match` accepts (lines already seen included). */
  line(match: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  lines: Array<Record<string, unknown>>;
  emit(event: Record<string, unknown>): void;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** An open `GET …/events`; resolves `ended` when the host closes it. */
  stream(path: string): Promise<{ ended: Promise<void>; close(): void }>;
}

async function startHost(appdir: string, generation: number, foreignThreadIds?: string[]): Promise<HostProcess> {
  const socketPath = agentHostSocketPath(appdir, "linux", generation);
  const tokenPath = agentHostTokenPath(appdir, generation);
  const env: NodeJS.ProcessEnv = {
    HOME: appdir,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ORQUESTER_APPDIR: appdir,
    TMPDIR: join(appdir, "tmp"),
    TSX_DISABLE_CACHE: "1",
    [AGENT_HOST_ENV.socket]: socketPath,
    [AGENT_HOST_ENV.tokenPath]: tokenPath,
    [AGENT_HOST_ENV.generation]: String(generation)
  };
  if (foreignThreadIds !== undefined) {
    const foreignPath = agentHostForeignThreadsPath(appdir, generation);
    await writeFile(foreignPath, JSON.stringify({ threadIds: foreignThreadIds }));
    env[AGENT_HOST_ENV.foreignThreads] = foreignPath;
  }
  const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, appdir], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<{ match: (line: Record<string, unknown>) => boolean; resolve: (line: Record<string, unknown>) => void }> = [];
  createInterface({ input: child.stdout }).on("line", (text) => {
    const line = JSON.parse(text) as Record<string, unknown>;
    lines.push(line);
    for (const waiter of [...waiters]) {
      if (waiter.match(line)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  });
  const line: HostProcess["line"] = (match) =>
    new Promise((resolve, reject) => {
      const seen = lines.find(match);
      if (seen !== undefined) {
        resolve(seen);
        return;
      }
      waiters.push({ match, resolve });
      child.once("exit", (code) => reject(new Error(`host ${generation} exited (${code}) before the line came`)));
    });
  await line((entry) => entry.ready === true);
  const token = (await readFile(tokenPath, "utf8")).trim();

  const call: HostProcess["call"] = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: response.statusCode ?? 0, body: text.length > 0 ? (JSON.parse(text) as unknown) : null });
          });
        }
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const stream: HostProcess["stream"] = (path) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method: "GET", path, headers: { authorization: `Bearer ${token}` } }, (response) => {
        response.resume();
        resolve({ ended: once(response, "close").then(() => undefined), close: () => req.destroy() });
      });
      req.on("error", reject);
      req.end();
    });

  return {
    child,
    socketPath,
    token,
    line,
    lines,
    emit: (event) => child.stdin.write(`${JSON.stringify({ emit: event })}\n`),
    call,
    stream
  };
}

let eventSeq = 0;
const runtimeEvent = (threadId: string, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  eventId: `two-hosts-${(eventSeq += 1)}`,
  threadId,
  createdAt: new Date().toISOString(),
  type,
  payload,
  ...extra
});

const errorCode = (body: unknown): string | undefined => (body as { error?: { code?: string } } | null)?.error?.code;

async function stopHost(host: HostProcess): Promise<void> {
  const exited = once(host.child, "exit");
  const stopped = await host.call("POST", agentHostRoutes.stop);
  assert.equal(stopped.status, 200);
  await exited;
}

/** Every complete line of a thread's log, in file order. */
async function logSeqs(appdir: string, threadId: string): Promise<number[]> {
  const text = await readFile(join(agentChatThreadDir(appdir, threadId), "events.ndjson"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { seq: number }).seq);
}

describe("two agent hosts on one appdir (host updates P2.7)", () => {
  it("a running thread stays on the retiring host, new work runs on the new one, then it moves with one writer", async () => {
    const appdir = await mkdtemp(join(tmpdir(), "agent-host-two-"));
    const hosts: HostProcess[] = [];
    try {
      const work = join(appdir, "work");
      await mkdir(work, { recursive: true });
      const create = (host: HostProcess, threadId: string) =>
        host.call("POST", agentHostRoutes.createThread, {
          threadId,
          projectPath: work,
          cwd: work,
          title: threadId,
          refId: "claude",
          accountId: "acc1",
          home: "account",
          modelSelection: { model: "test-model" },
          runtimeMode: "approval-required"
        });
      let commandSeq = 0;
      const turn = (host: HostProcess, threadId: string) =>
        host.call("POST", agentHostRoutes.turn(threadId), { commandId: `two-hosts-cmd-${(commandSeq += 1)}`, input: "work" });

      // ---- generation 0: a running thread, and one with nothing running -------------------
      const old = await startHost(appdir, 0);
      hosts.push(old);
      assert.equal((await create(old, "busy")).status, 200);
      assert.equal((await create(old, "zz-idle")).status, 200);
      assert.equal((await turn(old, "busy")).status, 200);
      await old.line((entry) => entry.call === "sendTurn" && entry.threadId === "busy");
      old.emit(runtimeEvent("busy", "turn.started", {}, { turnId: "turn-1" }));

      const retired = await old.call("POST", agentHostRoutes.retire);
      assert.deepEqual(retired.body, { ownedThreadIds: ["busy"] }, "only the thread with a turn running stays");
      const oldHealth = (await old.call("GET", agentHostRoutes.health)).body as AgentHostHealthResponse;
      assert.equal(oldHealth.retiring, true);
      assert.deepEqual(oldHealth.ownedThreadIds, ["busy"]);
      assert.equal(errorCode((await create(old, "late")).body), "HOST_RETIRING");
      const indexedAtRetire = new Database(agentChatIndexPath(appdir), { readonly: true });
      const atRetire = (indexedAtRetire.prepare("SELECT last_seq FROM threads WHERE thread_id = ?").get("busy") as { last_seq: number } | undefined)?.last_seq ?? 0;
      indexedAtRetire.close();
      assert.ok(atRetire > 0, "the old host indexed it until it retired, and flushed that at the retire");

      // A partial upload left behind in each thread: the new host's boot sweep takes only its own.
      for (const threadId of ["busy", "zz-idle"]) {
        const dir = agentChatThreadAttachmentsDir(appdir, threadId);
        await mkdir(dir, { recursive: true });
        const part = join(dir, "attachment-stale.part");
        await writeFile(part, "half an upload");
        const long = new Date(Date.now() - 6 * 60 * 60_000);
        await utimes(part, long, long);
      }
      const ownSwept = new Promise<void>((resolve) => {
        const watcher = watch(agentChatThreadAttachmentsDir(appdir, "zz-idle"), (_event, file) => {
          if (file === "attachment-stale.part") {
            watcher.close();
            resolve();
          }
        });
      });

      // ---- generation 1, booted beside it with the running thread foreign -----------------
      const next = await startHost(appdir, 1, ["busy"]);
      hosts.push(next);
      await ownSwept;
      assert.ok(await stat(join(agentChatThreadAttachmentsDir(appdir, "busy"), "attachment-stale.part")), "a foreign thread is never swept");
      assert.equal(errorCode((await next.call("GET", agentHostRoutes.read("busy"))).body), "THREAD_NOT_OWNED");
      assert.equal((await next.call("GET", agentHostRoutes.read("zz-idle"))).status, 200, "the released idle thread is the new host's");
      assert.equal((await create(next, "fresh")).status, 200);
      assert.equal((await turn(next, "fresh")).status, 200);
      await next.line((entry) => entry.call === "sendTurn" && entry.threadId === "fresh");
      assert.equal(old.lines.some((entry) => entry.threadId === "fresh"), false, "the new thread never reached the old host");

      // ---- the old host's turn ends: it releases the thread -------------------------------
      const watching = await old.stream(agentHostRoutes.events("busy"));
      old.emit(runtimeEvent("busy", "turn.completed", { state: "completed" }, { turnId: "turn-1" }));
      await watching.ended;
      await old.line((entry) => entry.call === "stopSession" && entry.threadId === "busy");
      assert.deepEqual(((await old.call("GET", agentHostRoutes.health)).body as AgentHostHealthResponse).ownedThreadIds, []);
      assert.equal(errorCode((await old.call("GET", agentHostRoutes.read("busy"))).body), "THREAD_NOT_OWNED");
      const releasedSeqs = await logSeqs(appdir, "busy");
      const indexBeforeAdopt = new Database(agentChatIndexPath(appdir), { readonly: true });
      const beforeAdopt = (indexBeforeAdopt.prepare("SELECT last_seq FROM threads WHERE thread_id = ?").get("busy") as { last_seq: number } | undefined)?.last_seq ?? 0;
      indexBeforeAdopt.close();
      assert.equal(beforeAdopt, atRetire, "neither the retiring host (index closed) nor the new one (foreign) indexed it meanwhile");
      assert.ok(beforeAdopt < releasedSeqs.at(-1)!, "the turn's end and the release were written after the retire");

      // ---- the new host adopts it, and serves it from its own session ---------------------
      const adopted = await next.call("POST", agentHostRoutes.adopt("busy"));
      assert.deepEqual(adopted.body, { adopted: true });
      assert.equal((await next.call("GET", agentHostRoutes.read("busy"))).status, 200);
      assert.equal((await turn(next, "busy")).status, 200);
      await next.line((entry) => entry.call === "sendTurn" && entry.threadId === "busy");
      assert.equal(old.lines.filter((entry) => entry.threadId === "busy" && entry.call === "sendTurn").length, 1, "one turn there, none since");

      // One writer: the log's sequence never repeats or skips across the hand-over.
      const seqs = await logSeqs(appdir, "busy");
      assert.deepEqual(seqs, seqs.map((_seq, index) => index + 1));
      assert.ok(seqs.length > releasedSeqs.length, "the new host continued the same log");

      await stopHost(old);
      await stopHost(next);
      hosts.length = 0;
    } finally {
      for (const host of hosts) host.child.kill("SIGKILL");
      await rm(appdir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
