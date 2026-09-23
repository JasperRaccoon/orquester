import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { agentChatRoutes, THREAD_SEARCH_MAX_QUERY_CHARS, THREAD_SEARCH_MAX_RESULTS, type ThreadSearchHit, type ThreadSearchResponse } from "@orquester/api/agent-chat";
import { chatSummary, shellSummary, stamp } from "../fixtures.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "../result.ts";
import { FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { SEARCH_SNIPPET_CHARS, SEARCH_TITLE_CHARS, searchTools } from "./search.ts";

const tool = searchTools.find((t) => t.name === "search_sessions")!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-23T12:00:00.000Z") });

/** A hit as the host sends it: an assistant message of turn 1 in session c1, unless overridden. */
function hit(over: Partial<ThreadSearchHit> = {}): ThreadSearchHit {
  return { threadId: "c1", projectPath: "/w/acme/api", title: "The index's own title", turnId: "t1", ordinal: 1, kind: "message", id: "m1", role: "assistant", activityKind: null, snippet: "the «build» is green", at: stamp(1), seq: 5, ...over };
}

function answer(hits: ThreadSearchHit[], over: Partial<ThreadSearchResponse> = {}): ThreadSearchResponse {
  return { query: "build", hits, truncated: false, indexed: true, ...over };
}

const searchCalls = (api: FakeDaemonApi) => api.calls.filter((c) => c.path === agentChatRoutes.search);

/** A fake whose sandbox holds the project directory acme/api, as resolveProject needs. */
async function projectApi(t: TestContext): Promise<{ api: FakeDaemonApi; projectPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "mcp-search-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  return { api, projectPath: join(root, "acme", "api") };
}

test("search_sessions keeps only the hits of chat sessions open now, in the host's order, titled as list_sessions titles them", async () => {
  const api = new FakeDaemonApi()
    .on("GET", agentChatRoutes.search, { status: 200, body: answer([
      hit({ threadId: "c1", id: "m1", ordinal: 2, role: "user", snippet: "why does the «build» fail?", at: stamp(3) }),
      hit({ threadId: "t1", id: "m2" }), // a terminal tab: the chat tools cannot address it
      hit({ threadId: "gone", id: "m3" }), // a tab closed since it was indexed
      hit({ threadId: "legacy", id: "m4" }), // a legacy terminal agent tab
      hit({ threadId: "c2", projectPath: "/w/acme/web", id: "a1", kind: "activity", role: null, activityKind: "tool.completed", turnId: null, ordinal: null, snippet: "pnpm «build»", at: stamp(4) })
    ], { truncated: true }) })
    .on("GET", "/api/sessions", { status: 200, body: [
      chatSummary({ title: "Fix the build" }),
      chatSummary({ id: "c2", title: "Release", projectPath: "/w/acme/web", cwd: "/w/acme/web" }),
      shellSummary(),
      shellSummary({ id: "legacy", kind: "agent", refId: "claude" })
    ] });
  const r = await tool.run({ query: "build", limit: 20 }, ctx(api));
  assert.deepEqual(r, {
    query: "build",
    hits: [
      { sessionId: "c1", title: "Fix the build", projectPath: "/w/acme/api", turn: 2, kind: "message", role: "user", snippet: "why does the «build» fail?", at: stamp(3) },
      // A turnless row: `turn` is null, never a guess.
      { sessionId: "c2", title: "Release", projectPath: "/w/acme/web", turn: null, kind: "activity", activityKind: "tool.completed", snippet: "pnpm «build»", at: stamp(4) }
    ],
    // The host's own "more matches than limit": no hit was cut here, so no omittedHits.
    truncated: true,
    indexed: true
  });
});

test("role is only on a message hit and activityKind only on an activity hit", async () => {
  const api = new FakeDaemonApi()
    .on("GET", agentChatRoutes.search, { status: 200, body: answer([
      hit({ id: "m1", role: "reasoning", activityKind: "tool.completed" }),
      hit({ id: "m2", role: null }),
      hit({ id: "a1", kind: "activity", role: "assistant", activityKind: "approval.requested" }),
      hit({ id: "a2", kind: "activity", role: null, activityKind: null })
    ]) })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const r = await tool.run({ query: "build", limit: 20 }, ctx(api));
  const fields = (r.hits as Record<string, unknown>[]).map((h) => [h.kind, h.role, h.activityKind, "role" in h, "activityKind" in h]);
  assert.deepEqual(fields, [
    ["message", "reasoning", undefined, true, false],
    ["message", undefined, undefined, false, false],
    ["activity", undefined, "approval.requested", false, true],
    ["activity", undefined, undefined, false, false]
  ]);
});

test("indexed:false is a normal answer: no hits and a hint that search is unavailable on this host right now", async () => {
  const api = new FakeDaemonApi().on("GET", agentChatRoutes.search, { status: 200, body: answer([], { indexed: false }) });
  const r = await tool.run({ query: "build", limit: 20 }, ctx(api));
  const { hint, ...rest } = r;
  assert.deepEqual(rest, { query: "build", hits: [], truncated: false, indexed: false });
  assert.match(String(hint), /^Search is unavailable on this host right now/);
  assert.ok(!api.calls.some((c) => c.path === "/api/sessions"), "no hit to check, so no session list is read");
  // A body that does not say `indexed: true` — none at all, say — reads the same way, never as a crash.
  api.on("GET", agentChatRoutes.search, { status: 200, body: null });
  const bare = await tool.run({ query: "build", limit: 20 }, ctx(api));
  assert.deepEqual([bare.hits, bare.indexed, bare.hint], [[], false, hint]);
});

test("the trimmed query, the limit and the resolved project path reach the search route; the sessions read is the project's", async (t) => {
  const { api, projectPath } = await projectApi(t);
  api.on("GET", agentChatRoutes.search, { status: 200, body: answer([hit({ projectPath })]) })
    .on("GET", "/api/sessions", ({ query }) => ({ status: 200, body: query?.projectPath === projectPath ? [chatSummary({ projectPath, cwd: projectPath })] : [] }));
  const r = await tool.run({ query: "  deploy  script\n", project: "acme/api", limit: 7 }, ctx(api));
  assert.deepEqual(searchCalls(api).map((c) => c.query), [{ q: "deploy  script", limit: "7", projectPath }]);
  assert.deepEqual(api.calls.filter((c) => c.path === "/api/sessions").map((c) => c.query), [{ projectPath }]);
  assert.equal(r.query, "deploy  script");
  assert.deepEqual((r.hits as { sessionId: string; projectPath: string }[]).map((h) => [h.sessionId, h.projectPath]), [["c1", projectPath]]);
  // The absolute path names the same project; without one, no projectPath is sent at all.
  await tool.run({ query: "x", project: projectPath, limit: 20 }, ctx(api));
  await tool.run({ query: "x", limit: THREAD_SEARCH_MAX_RESULTS }, ctx(api));
  assert.deepEqual(searchCalls(api).slice(1).map((c) => c.query), [{ q: "x", limit: "20", projectPath }, { q: "x", limit: String(THREAD_SEARCH_MAX_RESULTS) }]);
  // The palette's 20 is the default; the host's 50 is the most.
  const schema = z.object(tool.input).strict();
  assert.equal((schema.parse({ query: "x" }) as { limit: number }).limit, 20);
  assert.equal(schema.safeParse({ query: "x", limit: THREAD_SEARCH_MAX_RESULTS + 1 }).success, false);
  assert.equal(schema.safeParse({ query: "x", limit: 0 }).success, false);
});

test("a blank or over-long query and an unknown project are refused before anything is searched; the longest query is sent whole", async (t) => {
  const { api } = await projectApi(t);
  api.on("GET", agentChatRoutes.search, { status: 200, body: answer([]) });
  // THREAD_SEARCH_MAX_QUERY_CHARS counts UTF-16 code units after trimming: 101 emoji are 202 of them.
  for (const query of ["", "   \n\t", "x".repeat(THREAD_SEARCH_MAX_QUERY_CHARS + 1), "😀".repeat(101)]) {
    await assert.rejects(tool.run({ query, limit: 20 }, ctx(api)), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message.length < 200, `${query.length} code units`);
  }
  await assert.rejects(tool.run({ query: "x".repeat(THREAD_SEARCH_MAX_QUERY_CHARS + 1), limit: 20 }, ctx(api)), (e: { message: string }) => /201 characters; the limit is 200/.test(e.message));
  await assert.rejects(tool.run({ query: "build", project: "acme/nope", limit: 20 }, ctx(api)), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  // An empty project is refused, never read as "every project" — list_sessions' rule.
  await assert.rejects(tool.run({ query: "build", project: "", limit: 20 }, ctx(api)), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  assert.equal(searchCalls(api).length, 0, "nothing was searched");
  const longest = "x".repeat(THREAD_SEARCH_MAX_QUERY_CHARS);
  await tool.run({ query: `  ${longest}\n`, limit: 20 }, ctx(api));
  assert.equal(searchCalls(api)[0]!.query!.q, longest, "never clipped");
});

test("a result over the byte cap keeps the best hits: titles and snippets capped, the lowest-ranked dropped from the end", async () => {
  const wide = (n: number) => "語".repeat(n); // 3 bytes of UTF-8 each
  const hits = Array.from({ length: THREAD_SEARCH_MAX_RESULTS }, (_, i) => hit({ id: `m${i}`, ordinal: i + 1, snippet: `«build» ${wide(5_000)}` }));
  const api = new FakeDaemonApi()
    .on("GET", agentChatRoutes.search, { status: 200, body: answer(hits) })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ title: wide(1_000) })] });
  const r = await tool.run({ query: "build", limit: THREAD_SEARCH_MAX_RESULTS }, ctx(api)) as { hits: { turn: number; title: string; snippet: string }[]; truncated: boolean; omittedHits: number; indexed: boolean };
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.equal(ok(r).structuredContent, r, "the tool bounded itself: ok() had nothing to cut");
  assert.equal(r.truncated, true);
  assert.equal(r.indexed, true);
  assert.ok(r.hits.length > 0 && r.hits.length < hits.length, `${r.hits.length} kept`);
  assert.equal(r.omittedHits, hits.length - r.hits.length);
  assert.deepEqual(r.hits.map((h) => h.turn), hits.slice(0, r.hits.length).map((h) => h.ordinal), "the best-ranked are kept, in the host's order");
  for (const h of r.hits) {
    assert.equal(Array.from(h.title).length, SEARCH_TITLE_CHARS);
    assert.ok(h.title.endsWith("…"));
    assert.equal(Array.from(h.snippet).length, SEARCH_SNIPPET_CHARS);
    assert.ok(h.snippet.startsWith("«build» ") && h.snippet.endsWith("…"), "cut at its end, the match marks kept");
  }
  // Nothing more would fit: the next hit, with one fewer omitted, passes the cap.
  const next = { ...r.hits[0]!, turn: r.hits.length + 1 };
  assert.ok(resultBytes({ ...r, hits: [...r.hits, next], omittedHits: r.omittedHits - 1 }) > MAX_RESULT_BYTES);
});

test("a failed search goes through daemonError: the host's code passes through, a crash's text never does", async () => {
  const api = new FakeDaemonApi().on("GET", agentChatRoutes.search, { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting. Retry the same commandId." } } });
  await assert.rejects(tool.run({ query: "build", limit: 20 }, ctx(api)), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  api.on("GET", agentChatRoutes.search, { status: 500, body: { statusCode: 500, code: "ENOENT", error: "Internal Server Error", message: "ENOENT: no such file, open '/var/lib/orquester/daemon/agent/index.sqlite'" } });
  await assert.rejects(tool.run({ query: "build", limit: 20 }, ctx(api)), (e: { code: string; message: string }) => e.code === "INTERNAL" && !/index\.sqlite/.test(e.message));
});
