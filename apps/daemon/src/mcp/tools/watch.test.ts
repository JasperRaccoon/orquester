import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { chatSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { watchTools } from "./watch.ts";

const tool = watchTools[0]!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] };
function ctx(api: FakeDaemonApi): ToolContext { return { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") }; }
function api(sessions: unknown[]) {
  return new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: sessions }).on("GET", "/api/registry", { status: 200, body: registry })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
}

test("wait_for_session returns flagged sessions after the cursor, newest first, with a new cursor", async () => {
  const a = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  const b = chatSummary({ id: "b", hasPendingApprovals: true, activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(7) } });
  const r = await tool.run({ after: stamp(1), timeoutMs: 1000 }, ctx(api([a, b])));
  assert.deepEqual((r.sessions as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [["b", "approval"], ["a", "completed"]]);
  assert.equal(r.cursor, stamp(7)); assert.equal(r.timedOut, false);
  const again = await tool.run({ after: r.cursor as string, timeoutMs: 20 }, ctx(api([a, b])));
  assert.deepEqual(again, { sessions: [], cursor: stamp(7), timedOut: true });
});

test("wait_for_session defaults `after` to now, honours session and project filters, and rejects both", async (t) => {
  const stale = chatSummary({ id: "a", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(5) } });
  assert.equal((await tool.run({ timeoutMs: 20 }, ctx(api([stale])))).timedOut, true, "an old finish before `now` does not count");
  const fresh = { ...stale, activity: { ...stale.activity!, needsAttentionAt: "2026-09-22T12:00:01.000Z" } };
  const live = api([stale]);
  const p = tool.run({ sessionId: "a", timeoutMs: 1000 }, ctx(live));
  await new Promise((r) => setTimeout(r, 5));
  live.on("GET", "/api/sessions", { status: 200, body: [fresh] });
  live.emit(busEvent("session.activity", { id: "a", activity: fresh.activity }));
  const r = await p;
  assert.deepEqual((r.sessions as { id: string }[]).map((s) => s.id), ["a"]); assert.equal(r.cursor, "2026-09-22T12:00:01.000Z");
  const root = await mkdtemp(join(tmpdir(), "mcp-watch-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const elsewhere = { ...fresh, projectPath: "/w/other" };
  const proj = api([elsewhere]); proj.fsRoot = root; proj.workspacesDir = root;
  assert.equal((await tool.run({ project: "acme/api", after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, true, "another project's session is not watched");
  assert.equal((await tool.run({ after: stamp(0), timeoutMs: 20 }, ctx(proj))).timedOut, false);
  await assert.rejects(tool.run({ sessionId: "a", project: "x/y", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(tool.run({ sessionId: "zz", timeoutMs: 1000 }, ctx(api([stale]))), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});
