import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { chatSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { byAttention, watchTools } from "./watch.ts";

const tool = watchTools[0]!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] };
function ctx(api: FakeDaemonApi): ToolContext { return { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") }; }
function api(sessions: unknown[]) {
  return new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: sessions }).on("GET", "/api/registry", { status: 200, body: registry })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
}
const ids = (r: Record<string, unknown>) => (r.sessions as { id: string }[]).map((s) => s.id);

test("wait_for_session returns flagged sessions after the cursor, newest first, with a new cursor", async () => {
  const a = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  const b = chatSummary({ id: "b", hasPendingApprovals: true, activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(7) } });
  const r = await tool.run({ after: stamp(1), timeoutMs: 1000 }, ctx(api([a, b])));
  assert.deepEqual((r.sessions as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [["b", "approval"], ["a", "completed"]]);
  assert.equal(r.cursor, stamp(7)); assert.equal(r.timedOut, false);
  const quiet = api([a, b]);
  const again = await tool.run({ after: r.cursor as string, timeoutMs: 20 }, ctx(quiet));
  assert.deepEqual(again, { sessions: [], cursor: stamp(7), timedOut: true });
  assert.deepEqual(quiet.calls.map((c) => c.path), ["/api/sessions"], "a timeout reads no view context");
});

test("wait_for_session orders by the attention instant, newest first, a tie going to the newer tab", async () => {
  const older = chatSummary({ id: "older", createdAt: stamp(0), activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(6) } });
  const newer = chatSummary({ id: "newer", createdAt: stamp(2), activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(6) } });
  // 2026-09-21T23:00:05Z: the oldest instant of the three, yet the greatest string.
  const offset = chatSummary({ id: "offset", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: "2026-09-22T01:00:05.000+02:00" } });
  const r = await tool.run({ after: "2026-09-21T00:00:00.000Z", timeoutMs: 20 }, ctx(api([offset, older, newer])));
  assert.deepEqual(ids(r), ["newer", "older", "offset"]);
  assert.equal(r.cursor, stamp(6));
});

test("byAttention is the one Attention Center order: the attention instant, newest first, a tie to the newer tab, no stamp counting from the tab's creation", () => {
  const at = (id: string, needsAttentionAt: string | null, createdAt: string) => chatSummary({ id, createdAt, activity: { state: "waiting", attention: null, lastOutputAt: null, needsAttentionAt } });
  const sessions = [
    at("offset", "2026-09-22T01:00:05.000+02:00", stamp(0)), // 2026-09-21T23:00:05Z: the oldest instant, the greatest string
    at("older", stamp(6), stamp(0)),
    at("newer", stamp(6), stamp(2)),
    at("unstamped", null, stamp(8)), // a waiting tab the daemon never stamped: its creation, as the GUI's flaggedAt
    at("unparseable", "yesterday", stamp(1))
  ];
  assert.deepEqual([...sessions].sort(byAttention).map((s) => s.id), ["unstamped", "newer", "older", "unparseable", "offset"]);
  assert.deepEqual([...sessions].reverse().sort(byAttention).map((s) => s.id), ["unstamped", "newer", "older", "unparseable", "offset"], "whatever the input order");
});

test("wait_for_session defaults `after` to now, honours session and project filters, and rejects both", async (t) => {
  const stale = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  assert.equal((await tool.run({ timeoutMs: 20 }, ctx(api([stale])))).timedOut, true, "an old finish before `now` does not count");
  const fresh = { ...stale, activity: { ...stale.activity!, needsAttentionAt: "2026-09-22T12:00:01.000Z" } };
  // A barrier, not a sleep: the watch subscribes before its first read, so the first read made while a
  // listener is registered is the watch's own. That read still returns the stale list, so only the bus
  // event can end the wait before its timeout. The barrier resumes this test BEFORE that read answers, so
  // the event lands while the watch holds no session yet. A `session.updated` carries the whole summary,
  // which the watch takes as it comes; a `session.activity` carries only the activity, which counts because
  // the watch merges activity published during a read into what that read returns (wait.ts) — the next
  // test emits that one. The list turns fresh for the settle window's re-read, which confirms the hit.
  let watching!: () => void;
  const subscribed = new Promise<void>((resolve) => { watching = resolve; });
  const live: FakeDaemonApi = api([stale]).on("GET", "/api/sessions", () => { if (live.listenerCount() > 0) watching(); return { status: 200, body: [stale] }; });
  const p = tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(live));
  await subscribed;
  live.on("GET", "/api/sessions", { status: 200, body: [fresh] });
  live.emit(busEvent("session.updated", fresh));
  const r = await p;
  assert.deepEqual((r.sessions as { id: string }[]).map((s) => s.id), ["a"]); assert.equal(r.cursor, "2026-09-22T12:00:01.000Z");
  const root = await mkdtemp(join(tmpdir(), "mcp-watch-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const elsewhere = { ...fresh, projectPath: "/w/other" };
  const proj = api([elsewhere]); proj.fsRoot = root; proj.workspacesDir = root;
  assert.equal((await tool.run({ project: "acme/api", after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, true, "another project's session is not watched");
  assert.equal((await tool.run({ after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, false);
  const here = { ...fresh, id: "h", projectPath: join(root, "acme", "api") };
  const mixed = api([elsewhere, here]); mixed.fsRoot = root; mixed.workspacesDir = root;
  assert.deepEqual(ids(await tool.run({ project: "acme/api", after: stamp(0), timeoutMs: 20 }, ctx(mixed))), ["h"], "the project's own session is returned");
  await assert.rejects(tool.run({ sessionId: "a", project: "x/y", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(tool.run({ sessionId: "zz", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});

test("wait_for_session: a session.activity published while the watch's first read is in flight ends the wait", async () => {
  const stale = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  const fresh = { ...stale, activity: { ...stale.activity!, needsAttentionAt: "2026-09-22T12:00:01.000Z" } };
  // The barrier of the test above: the first read made while a listener is registered is the watch's own.
  let watching!: () => void;
  const subscribed = new Promise<void>((resolve) => { watching = resolve; });
  const live: FakeDaemonApi = api([stale]).on("GET", "/api/sessions", () => { if (live.listenerCount() > 0) watching(); return { status: 200, body: [stale] }; });
  const p = tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(live));
  await subscribed;
  live.on("GET", "/api/sessions", { status: 200, body: [fresh] });
  live.emit(busEvent("session.activity", { id: "a", activity: fresh.activity }));
  const r = await p;
  assert.deepEqual([ids(r), r.cursor, r.timedOut], [["a"], "2026-09-22T12:00:01.000Z", false]);
});

test("wait_for_session on one session ends with SESSION_NOT_FOUND when it closes, or is gone by the watch's first read", async () => {
  const notFound = (e: { code: string }) => e.code === "SESSION_NOT_FOUND";
  const a = chatSummary({ id: "a" });
  let watching!: () => void;
  const subscribed = new Promise<void>((resolve) => { watching = resolve; });
  const live: FakeDaemonApi = api([a]).on("GET", "/api/sessions", () => { if (live.listenerCount() > 0) watching(); return { status: 200, body: [a] }; });
  const p = tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(live));
  await subscribed;
  live.emit(busEvent("session.closed", { id: "a" }));
  await assert.rejects(p, notFound);
  // Closed after the lookup, before the watch subscribed: only its absence from the watch's read says so.
  const vanished: FakeDaemonApi = api([a]).on("GET", "/api/sessions", () => ({ status: 200, body: vanished.listenerCount() > 0 ? [] : [a] }));
  await assert.rejects(tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(vanished)), notFound);
  assert.deepEqual([live.listenerCount(), vanished.listenerCount()], [0, 0]);
});

test("wait_for_session checks `after` before any lookup and never reads an empty id or project as absent", async () => {
  const invalid = (e: { code: string }) => e.code === "INVALID_ARGUMENT";
  await assert.rejects(tool.run({ after: "yesterday", timeoutMs: 1000 }, ctx(api([]))), invalid);
  await assert.rejects(tool.run({ sessionId: "zz", after: "yesterday", timeoutMs: 1000 }, ctx(api([]))), invalid, "a bad `after` is reported even for an unknown session");
  assert.equal(z.object(tool.input).safeParse({ sessionId: "" }).success, false, "the schema refuses an empty sessionId");
  await assert.rejects(tool.run({ sessionId: "", timeoutMs: 1000 }, ctx(api([]))), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  await assert.rejects(tool.run({ project: "", timeoutMs: 1000 }, ctx(api([]))), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
});
