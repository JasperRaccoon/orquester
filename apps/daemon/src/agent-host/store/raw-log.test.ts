/**
 * `raw.ndjson` (§3.1): the transient-frame drop list, redaction, the record
 * caps, rotation and degrade-to-no-op.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  RAW_LOG_FLUSH_RECORDS,
  RAW_LOG_MAX_FILES,
  RAW_LOG_MAX_FILE_BYTES,
  RAW_LOG_MAX_STRING_CHARS,
  RawFrameLog,
  pruneRawLogDirectory
} from "./raw-log.ts";

async function tempFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-raw-log-"));
  return path.join(dir, "raw.ndjson");
}

/** A log whose batch timer never fires on its own, so flushes are explicit. */
function manualLog(filePath: string, now = () => Date.now()): RawFrameLog {
  return new RawFrameLog({
    filePath,
    now,
    setTimer: () => null,
    clearTimer: () => undefined
  });
}

function readLines(filePath: string): unknown[] {
  const contents = fs.readFileSync(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

test("a frame is written as one NDJSON line", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  log.write({ type: "session/new", params: { cwd: "/w/p" } });
  log.close();
  assert.deepEqual(readLines(filePath), [{ type: "session/new", params: { cwd: "/w/p" } }]);
});

test("high-rate delta frames are dropped, not written", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  log.write({ type: "content_block_delta" });
  log.write({ method: "session/update" });
  log.write({ messageType: "task.progress" });
  // The runtime envelope nests the provider frame under `raw`.
  log.write({ type: "envelope", raw: { method: "message.part.delta" } });
  log.write({ type: "turn/completed" });
  log.close();
  assert.equal(log.droppedTransient, 4);
  assert.deepEqual(readLines(filePath), [{ type: "turn/completed" }]);
});

test("an MCP env map is redacted key-wise — a token shape never matches it", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  log.write({
    method: "_x.ai/mcp/servers_updated",
    servers: [
      {
        name: "centur",
        env: { CENTUR_API_KEY: "plain-text-not-token-shaped", HOME: "/home/orquester" }
      }
    ]
  });
  log.close();
  const written = readLines(filePath)[0] as {
    servers: Array<{ env: Record<string, string> }>;
  };
  assert.deepEqual(written.servers[0]?.env, {
    CENTUR_API_KEY: "[redacted]",
    HOME: "[redacted]"
  });
});

test("credential-shaped keys and text are both scrubbed", async () => {
  const filePath = await tempFile();
  const log = new RawFrameLog({
    filePath,
    homeDirs: ["/var/lib/orquester"],
    setTimer: () => null,
    clearTimer: () => undefined
  });
  log.write({
    type: "auth",
    apiKey: "whatever",
    nested: { access_token: "x", note: "Authorization: Bearer abc.def-ghi" },
    cwd: "/var/lib/orquester/workspaces/p"
  });
  log.close();
  const written = readLines(filePath)[0] as Record<string, unknown>;
  assert.equal(written.apiKey, "[redacted]");
  const nested = written.nested as Record<string, unknown>;
  assert.equal(nested.access_token, "[redacted]");
  assert.equal(nested.note, "Authorization: [redacted]");
  assert.equal(written.cwd, "~/workspaces/p");
});

test("a long string is capped per record", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  log.write({ type: "result", text: "x".repeat(RAW_LOG_MAX_STRING_CHARS + 500) });
  log.close();
  const written = readLines(filePath)[0] as { text: string };
  assert.ok(written.text.endsWith("…[truncated]"));
  assert.ok(written.text.length < RAW_LOG_MAX_STRING_CHARS + 100);
});

test("a cyclic frame is bounded by the depth cap, not fatal", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  const cyclic: Record<string, unknown> = { type: "loop" };
  cyclic.self = cyclic;
  log.write(cyclic);
  log.write({ type: "fine" });
  log.close();
  const lines = readLines(filePath);
  assert.equal(lines.length, 2, "the cycle terminates at the depth cap and still writes");
  assert.match(JSON.stringify(lines[0]), /\[depth\]/);
  assert.deepEqual(lines[1], { type: "fine" });
});

test("deep nesting is bounded rather than serialised whole", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i += 1) {
    deep = { next: deep };
  }
  log.write({ type: "deep", body: deep });
  log.close();
  assert.match(fs.readFileSync(filePath, "utf8"), /\[depth\]/);
});

test("the file rotates past 10 MiB and keeps at most 10 generations", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  const chunk = { type: "payload", blob: "y".repeat(60 * 1024) };
  // Each flush writes ~60 KiB; force enough to cross the per-file bound twice.
  const perFile = Math.ceil(RAW_LOG_MAX_FILE_BYTES / (60 * 1024)) + 2;
  for (let round = 0; round < perFile * 2; round += 1) {
    log.write(chunk);
    log.flush();
  }
  log.close();

  const dir = path.dirname(filePath);
  const entries = fs.readdirSync(dir);
  assert.ok(entries.includes("raw.ndjson"));
  assert.ok(entries.includes("raw.ndjson.1"), `rotated generations: ${entries.join(", ")}`);
  assert.ok(entries.length <= RAW_LOG_MAX_FILES + 1);
  assert.ok(fs.statSync(filePath).size <= RAW_LOG_MAX_FILE_BYTES);
});

test("a plain flush leaves the directory alone; the age prune rides rotation", async () => {
  // Q1 #51: `pruneSiblings` ran on EVERY flush, putting a synchronous
  // readdirSync + statSync on the host's event loop once a second per live
  // thread. The 14-day prune now happens when a file actually rotates, and the
  // host-wide sweep (`pruneRawLogDirectory`) catches the rest.
  const filePath = await tempFile();
  const stale = `${filePath}.3`;
  fs.writeFileSync(filePath, "");
  fs.writeFileSync(stale, "old\n");
  const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(stale, ancient / 1000, ancient / 1000);

  const log = manualLog(filePath);
  log.write({ type: "turn/completed" });
  log.flush();
  log.close();
  assert.equal(fs.existsSync(stale), true, "a plain flush does not scan or prune");

  // The host-wide sweep is what collects it.
  pruneRawLogDirectory({ threadsRoot: path.dirname(path.dirname(filePath)) });
  assert.equal(fs.existsSync(stale), false);
});

test("a writer that cannot open its file degrades to a no-op", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-raw-log-"));
  // A directory where the file should be: every write fails.
  const filePath = path.join(dir, "raw.ndjson");
  fs.mkdirSync(filePath);
  const log = manualLog(filePath);
  log.write({ type: "turn/completed" });
  log.flush();
  assert.equal(log.isDisabled, true);
  // And it stays quiet rather than throwing on every later frame.
  log.write({ type: "turn/completed" });
  log.close();
});

test("the buffer thresholds flush without waiting for the timer", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  // Each record is capped at 64 K chars, so the byte threshold needs ~17 of
  // them — which is still well under the record threshold.
  const big = { type: "payload", blob: "z".repeat(RAW_LOG_MAX_STRING_CHARS * 2) };
  log.write(big);
  assert.equal(fs.existsSync(filePath), false, "one record is still buffered");
  for (let i = 0; i < 20; i += 1) {
    log.write(big);
  }
  assert.ok(fs.statSync(filePath).size > 0, "past 1 MiB the buffer flushes itself");
  log.close();
});

test("the record threshold flushes on its own too", async () => {
  const filePath = await tempFile();
  const log = manualLog(filePath);
  for (let i = 0; i < RAW_LOG_FLUSH_RECORDS; i += 1) {
    log.write({ type: "turn/completed", i });
  }
  assert.equal(readLines(filePath).length, RAW_LOG_FLUSH_RECORDS);
  log.close();
});

// --- the host-wide ceiling (S1 #5) ----------------------------------------

async function seedThreadLog(
  threadsRoot: string,
  threadId: string,
  fileName: string,
  bytes: number,
  ageMs = 0
): Promise<string> {
  const dir = path.join(threadsRoot, threadId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, when, when);
  }
  return file;
}

test("the ceiling is enforced ACROSS threads, which rotation alone cannot do", async () => {
  // S1 #5: `pruneSiblings` only ever saw one thread's own directory, where
  // rotation already caps the set at 9 x 10 MiB — so the 512 MiB test was
  // unconditionally true and the prune was unreachable. 100 threads were
  // 10 GiB in the one writable appdir.
  const threadsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-raw-ceiling-"));
  for (let i = 0; i < 6; i += 1) {
    // t0 is the OLDEST, so oldest-first eviction takes it before t5.
    await seedThreadLog(threadsRoot, `t${i}`, "raw.ndjson.1", 4_000, (6 - i) * 60_000);
  }
  const before = fs.readdirSync(threadsRoot).length;
  assert.equal(before, 6);

  const result = pruneRawLogDirectory({ threadsRoot, ceilingBytes: 10_000 });
  assert.ok(result.deleted >= 3, `expected rungs to be deleted, got ${result.deleted}`);
  assert.ok(result.totalBytes <= 10_000, `still over the ceiling: ${result.totalBytes}`);

  // Oldest first: t0's rung goes before t5's.
  assert.equal(fs.existsSync(path.join(threadsRoot, "t0", "raw.ndjson.1")), false);
  assert.equal(fs.existsSync(path.join(threadsRoot, "t5", "raw.ndjson.1")), true);
});

test("a live file whose thread has an open writer is never unlinked", async () => {
  const threadsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-raw-ceiling-"));
  const live = await seedThreadLog(threadsRoot, "live", "raw.ndjson", 8_000, 600_000);
  const idle = await seedThreadLog(threadsRoot, "idle", "raw.ndjson", 8_000, 300_000);

  pruneRawLogDirectory({
    threadsRoot,
    ceilingBytes: 1_000,
    liveThreadIds: new Set(["live"])
  });
  assert.equal(fs.existsSync(live), true, "a file the host is appending to must survive");
  assert.equal(fs.existsSync(idle), false, "an idle thread's live file is fair game");
});

test("a rung past the age bound is removed even when the ceiling is not reached", async () => {
  const threadsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "orq-raw-ceiling-"));
  const stale = await seedThreadLog(
    threadsRoot,
    "t1",
    "raw.ndjson.2",
    100,
    30 * 24 * 60 * 60 * 1000
  );
  const fresh = await seedThreadLog(threadsRoot, "t1", "raw.ndjson.1", 100);
  const result = pruneRawLogDirectory({ threadsRoot });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(result.deleted, 1);
});

test("a missing threads root is not an error", () => {
  const result = pruneRawLogDirectory({ threadsRoot: path.join(os.tmpdir(), "orq-nope-xyz") });
  assert.deepEqual(result, { deleted: 0, totalBytes: 0 });
});

