import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexSource } from "./usage-sources.ts";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const tokenCount = (percent: number) => JSON.stringify({
  type: "event_msg",
  payload: { type: "token_count", rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } }
});

async function fixture(t: test.TestContext, text: string) {
  const home = await mkdtemp(join(tmpdir(), "codex-usage-tail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  const path = join(sessions, "rollout-current.jsonl");
  await writeFile(path, text);
  return { home, sessions, path, source: createCodexSource({ userhome: home, codexHome: home, now: () => NOW }) };
}

test("Codex fallback finds a reading before multiple chunks of newer non-usage events", async (t) => {
  const noise = JSON.stringify({ type: "response_item", payload: { text: "tool result".repeat(200) } });
  const w = await fixture(t, `${tokenCount(10)}\r\n${tokenCount(12)}\r\n` + `${noise}\r\n`.repeat(200) + "\r\n{unfinished");
  assert.equal((await w.source())?.session?.percent, 12);
});

test("Codex fallback handles a long token-count record with a split UTF-8 plan", async (t) => {
  const record = JSON.stringify({
    type: "event_msg",
    ignored: "🦝".repeat(80_000),
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 42 }, plan_type: "pro🦝" } }
  });
  const split = Buffer.from(record).lastIndexOf(Buffer.from("🦝")) + 2;
  const text = record + "\n" + "x".repeat(64 * 1024 + split - Buffer.byteLength(record) - 1);
  const w = await fixture(t, text);
  const reading = await w.source();
  assert.equal(reading?.plan, "Pro🦝");
  assert.equal(reading?.session?.percent, 42);
});

test("Codex fallback preserves the newest matching event even when its rate limits are unusable", async (t) => {
  const invalid = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { unexpected: true } } });
  const w = await fixture(t, `${tokenCount(7)}\n${invalid}\n`);
  assert.equal(await w.source(), null, "an older reading in the same rollout must not replace the newest matching event");
  await writeFile(join(w.home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  assert.deepEqual(await w.source(), { id: "codex", available: true, stale: true, session: null, weekly: null });
  const older = join(w.sessions, "rollout-older.jsonl");
  await writeFile(older, `${tokenCount(19)}\n`);
  await utimes(older, new Date(NOW - 3600_000), new Date(NOW - 3600_000));
  await utimes(w.path, new Date(NOW), new Date(NOW));
  assert.equal((await w.source())?.session?.percent, 19, "the existing fallback to the next rollout still applies");
});
