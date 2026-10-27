/**
 * The knowledge tools end to end (Knowledge Graph plugin spec, "Agent tools", goal 2): the real
 * `KnowledgeService` behind the daemon's own app (`createServer`, unix transport), driven through
 * the catalog executor and the in-process client with each chat's principal, as an in-chat call
 * runs. Real store, search (a fake embedder), Agent Profiles and visibility; the chats' tab records
 * are a map. Covers: collections, saving from a Global and a profile chat, visibility in search and
 * get, a relabel leaving the myKG mirror alone, deletes, the manifest read and the manifests the
 * session-tools refresher builds from it, the manifest pushes, the plugin switch — and a linking
 * run: the real linking service and a fake `mykg` child (`linking/fixtures/fake-mykg.mjs`), its
 * tasks answered by fake worker chats calling the real worker tools (executor → in-process client
 * with the worker's principal → worker routes → inbox broker), ending with the graph loaded and
 * `knowledge_search` returning concept hits, scoped like entries.
 */

import assert from "node:assert/strict";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE,
  knowledgeRoutes,
  type KnowledgeCollectionView,
  type KnowledgeStatus,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitResponse,
  type KnowledgeWorkerTask
} from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, knowledgeMykgInputDir } from "@orquester/config";

import { createServer } from "../index.ts";
import { catalogFor } from "../mcp/catalog/index.ts";
import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { chatSummary } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { SessionProfileService } from "../session-profiles/service.ts";
import { SessionProfileStore } from "../session-profiles/store.ts";
import { KNOWLEDGE_WORKER_TOOLS } from "../session-tools/manifest.ts";
import { SessionToolsRefresher } from "../session-tools/session-tools-refresh.ts";
import { FakeClock } from "../workflows/agent/testing/fake-clock.ts";
import { KNOWLEDGE_INDEXER_PROFILE_ID } from "./linking/indexer-profile.ts";
import { KnowledgeLinkingService } from "./linking/service.ts";
import { FAKE_RUNTIME, FakeWorkerPort, fakeSpawn } from "./linking/testing.ts";
import { silentLogger } from "./search/test-fakes.ts";
import { KnowledgeService, type KnowledgeSessionInfo } from "./service.ts";
import { FakeKnowledgePlugins, FakeRuntime, fakeEmbedders } from "./test-fakes.ts";

type CreateServerArgs = Parameters<typeof createServer>;

async function harness(t: TestContext) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "kg-e2e-")));
  const appdir = join(root, "appdir");
  const workspacesDir = join(root, "workspaces");
  const plugins = new FakeKnowledgePlugins(true);
  const profileStore = new SessionProfileStore({ appdir });
  await profileStore.init();
  const profiles = new SessionProfileService({ store: profileStore });
  const sessions = new Map<string, KnowledgeSessionInfo>();
  const embedders = fakeEmbedders();
  let pushes = 0;
  const logger = { ...silentLogger(), log() {} };
  const runtime = new FakeRuntime();
  runtime.set(FAKE_RUNTIME);
  const clock = new FakeClock("2026-10-24T09:00:00.000Z");
  // The indexing chats: they work the inbox through the real worker tools (`workerTools` below).
  const workers = new FakeWorkerPort(["acct-1"], () => clock.now(), { "acct-1": { invalidFirst: true } }, answerFor, {
    next: (id) => workerTools.next(id),
    submit: (id, taskId, answer) => workerTools.submit(id, taskId, answer)
  });
  /** A worker chat's tab: owned by the plugin for its run, on the managed indexer profile. */
  const workerTab = (id: string): KnowledgeSessionInfo | null => {
    const worker = workers.sessions.find((session) => session.id === id);
    return worker ? { profileId: KNOWLEDGE_INDEXER_PROFILE_ID, owner: { kind: "knowledge-indexer", runId: worker.runId } } : null;
  };
  let linking: KnowledgeLinkingService | null = null;
  const knowledge = new KnowledgeService({
    appdir,
    plugins,
    accounts: { list: () => ({ accounts: [] }) },
    session: (id) => sessions.get(id) ?? workerTab(id),
    profiles: profileStore,
    onProfileChange: (listener) => {
      const on = ({ profileId }: { profileId: string }) => listener(profileId);
      profiles.events.on("changed", on);
      profiles.events.on("deleted", on);
      return () => {
        profiles.events.off("changed", on);
        profiles.events.off("deleted", on);
      };
    },
    publisher: { publish() {} },
    toolsChanged: () => {
      pushes += 1;
    },
    linking: (ports) => {
      linking = new KnowledgeLinkingService({ appdir, ...ports, workers, clock, spawn: fakeSpawn, processProbe: { cmdline: async () => null, startTime: async () => null, signal: () => false } });
      return linking;
    },
    runtime,
    embedders: embedders.factory,
    logger
  });
  const resolved = { daemonDir: join(appdir, "daemon"), baseDir: appdir, workspacesDir, workspacesMetaFile: join(root, "workspaces.json"), fsRoot: workspacesDir };
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved as unknown as CreateServerArgs[1],
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    { knowledge } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await knowledge.stop();
    await rm(root, { recursive: true, force: true });
  });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: { add() {}, remove() {} } as never, fsRoot: workspacesDir, workspacesDir });
  // As in the daemon: started once the in-process API exists.
  await knowledge.start();
  const chat = (threadId: string): ThreadCaller => ({
    kind: "thread", threadId, title: "Landing page", projectPath: workspacesDir, workspace: "acme", cwd: workspacesDir, agentId: "claude", callId: "c1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null
  });
  const call = (threadId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    executeToolCall({ approvals: null }, { name, arguments: args }, { caller: chat(threadId), api, signal: new AbortController().signal });
  const text = async (threadId: string, name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await call(threadId, name, args);
    const out = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    assert.equal(result.isError, undefined, `${name}: ${out}`);
    return out;
  };
  const refusal = async (threadId: string, name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await call(threadId, name, args);
    assert.equal(result.isError, true, `${name} succeeded`);
    return (result.structuredContent as { code: string }).code;
  };
  // The worker chat's two tool calls, through the executor like an in-chat call; the rendered text
  // is read back into the protocol the fake chat works with.
  const toolCalls = { next: 0, submit: 0, refused: 0 };
  const workerTools = {
    next: async (sessionId: string): Promise<KnowledgeWorkerNextResponse> => {
      toolCalls.next += 1;
      return parseWorkerText(await text(sessionId, "knowledge_worker_next_task", {}));
    },
    submit: async (sessionId: string, taskId: string, answer: string): Promise<KnowledgeWorkerSubmitResponse> => {
      toolCalls.submit += 1;
      const result = await call(sessionId, "knowledge_worker_submit", { taskId, answer });
      const out = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      if (result.isError) {
        toolCalls.refused += 1;
        assert.equal((result.structuredContent as { code: string }).code, "KNOWLEDGE_INVALID", out);
        return { accepted: false, error: out };
      }
      assert.ok(out.startsWith("Accepted.\n"), out);
      return { accepted: true, next: parseWorkerText(out.slice("Accepted.\n".length)) };
    }
  };
  // The manifests the session-tools refresher builds for these chats from the service's read.
  const hostApi = new FakeDaemonApi()
    .on("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { status: 200, body: { servers: [] } })
    .on("GET", "/api/sessions", () => ({
      status: 200,
      body: [...sessions.keys(), ...workers.sessions.map((w) => w.id)].map((id) => chatSummary({ id, ...(workerTab(id) ? { owner: workerTab(id)!.owner } : {}) }))
    }));
  const refresher = new SessionToolsRefresher({
    thread: () => ({ agentId: "claude", home: "system", projectPath: "" }),
    openThreads: () => [],
    catalog: () => catalogFor("chat"),
    knowledgeForSession: (id) => knowledge.knowledgeForSession(id),
    api: () => hostApi,
    pushToHost: async () => null
  });
  const toolsOf = async (threadId: string): Promise<string[]> => {
    const manifest = await refresher.manifest(threadId);
    assert.ok(manifest && manifest !== "unavailable");
    return manifest.tools;
  };
  const user = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
  };
  const linkingOf = (): KnowledgeLinkingService => {
    assert.ok(linking, "linking was built");
    return linking;
  };
  /** Resolves once `predicate` holds, re-checked on every linking status event (never a sleep). */
  const until = (predicate: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!predicate()) return;
        linkingOf().events.off("status", check);
        resolve();
      };
      linkingOf().events.on("status", check);
      check();
    });
  return { appdir, plugins, profiles, sessions, knowledge, embedders, clock, workers, toolCalls, text, refusal, user, toolsOf, linkingOf, until, pushes: () => pushes };
}

/** Pass 2 answers: one concept per entry file, named after what the entry is about. */
const CONCEPTS: Record<string, { id: string; type: string; name: string }> = {
  "Ads learning phase": { id: "tactic-learningphase", type: "Tactic", name: "Learning phase budget cap" },
  "Alternatives pages": { id: "tactic-alternativespages", type: "Tactic", name: "Alternatives pages" },
  Screenshots: { id: "tactic-storescreenshots", type: "Tactic", name: "Outcome-first store screenshots" }
};

function answerFor(task: KnowledgeWorkerTask): string {
  const file = /^FILE (\S+)/m.exec(task.input)?.[1];
  if (task.step !== "pass2" || !file) return JSON.stringify({ concepts: [], properties: [] });
  const title = Object.keys(CONCEPTS).find((key) => task.input.includes(key));
  const concept = title ? CONCEPTS[title]! : { id: `topic-${file.slice(3, 15)}`, type: "Topic", name: file };
  return JSON.stringify({
    nodes: [{ id: concept.id, type: concept.type, confidence: 0.9, attributes: { name: { value: concept.name, confidence: 0.9 } }, source_files: [file] }],
    edges: []
  });
}

/** The worker tools' text, read back into the protocol (`renderWorkerNext`). */
function parseWorkerText(out: string): KnowledgeWorkerNextResponse {
  const done = /^No task \((run-finished|session-budget|run-cancelled)\)\./.exec(out);
  if (done) return { kind: "done", reason: done[1] as "run-finished" };
  const head = /^Task (\S+) · step (\S+) · answer ≤ (\d+) tokens · (\d+) more waiting/.exec(out);
  assert.ok(head, out);
  const same = /\nInstructions: the same as task (\S+)\.\n/.exec(out);
  const inputAt = out.indexOf("\n\nInput:\n");
  const replyAt = out.lastIndexOf("\n\nReply with knowledge_worker_submit");
  return {
    kind: "task",
    task: {
      taskId: head[1]!,
      step: head[2]!,
      instructions: same ? null : out.slice(out.indexOf("\nInstructions:\n") + "\nInstructions:\n".length, inputAt),
      sameInstructionsAs: same ? same[1]! : null,
      input: out.slice(inputAt + "\n\nInput:\n".length, replyAt),
      maxTokens: Number(head[3]),
      remaining: Number(head[4])
    }
  };
}

const savedIds = (out: string): string[] => [...out.matchAll(/(?:saved|already saved as) (ke_[a-z0-9]{12})/g)].map((match) => match[1]!);

test("knowledge tools end to end: save from Global and profile chats, visibility in search and get, relabel, delete, manifests, the plugin switch, and a linking run through the worker tools", async (t) => {
  const h = await harness(t);

  // --- collections, as the user makes them in the Knowledge tab ------------------------------
  const make = async (name: string, description: string) => {
    const res = await h.user("POST", knowledgeRoutes.collections, { name, description });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as KnowledgeCollectionView;
  };
  const seo = await make("SEO", "Ranking in search engines and AI answers.");
  const ads = await make("Ads", "Paid acquisition.");
  const saas = await make("SaaS", "Running a SaaS.");
  await h.knowledge.settled();
  assert.equal(h.pushes(), 3, "every new collection name pushes the chats' manifests");

  // --- chats: Global, an Ads-only profile, a profile without collections, a worker -----------
  const adsExpert = await h.profiles.create({ name: "Ads expert", settings: { knowledgeCollections: [ads.id] } });
  const plain = await h.profiles.create({ name: "Plain" });
  await h.knowledge.settled();
  assert.equal(h.pushes(), 4, "a profile that ticks collections pushes the manifests; one that ticks none does not");
  h.sessions.set("global", { profileId: null });
  h.sessions.set("ads-chat", { profileId: adsExpert.id });
  h.sessions.set("plain-chat", { profileId: plain.id });
  // A chat that says it is an indexer, but of no run in flight.
  h.sessions.set("worker", { owner: { kind: "knowledge-indexer", runId: "kr_000000000000" } });

  assert.deepEqual(await h.knowledge.knowledgeForSession("global"), { enabled: true, worker: false, searchable: true, visibleCollectionNames: ["SEO", "Ads", "SaaS"] });
  assert.deepEqual(await h.knowledge.knowledgeForSession("ads-chat"), { enabled: true, worker: false, searchable: true, visibleCollectionNames: ["Ads"] });
  assert.deepEqual(await h.knowledge.knowledgeForSession("plain-chat"), { enabled: true, worker: false, searchable: false, visibleCollectionNames: [] });
  assert.equal((await h.knowledge.knowledgeForSession("worker")).worker, true);

  // --- saving ----------------------------------------------------------------------------------
  const cloudflare = "Case study: Cloudflare got cited by AI answer engines after publishing original data and comparison tables.";
  const fromGlobal = await h.text("global", "knowledge_save", {
    entries: [{ body: cloudflare, title: "Cloudflare case study", author: "Kevin", handle: "@kev", kind: "case study", collections: ["SEO"] }]
  });
  assert.match(fromGlobal, /^Saved 1 entry; linking queued\./, "no runtime: linking is paused as not installed, reported as queued");
  const [cloudflareId] = savedIds(fromGlobal);
  assert.ok(cloudflareId);

  // A profile chat files by content: into SEO, which it cannot see, and into a collection it creates.
  const fromAds = await h.text("ads-chat", "knowledge_save", {
    entries: [
      { body: "Cap the daily budget while a campaign learns; raise spend after 50 conversions.", title: "Ads learning phase", collections: ["Ads"] },
      { body: "Alternatives pages: one page per competitor, [competitor] vs [you], with honest tables.", title: "Alternatives pages", collections: ["seo"] },
      { body: "App store screenshots: lead with the outcome, not the feature list.", title: "Screenshots", collections: ["Mobile apps"] }
    ],
    newCollections: [{ name: "Mobile apps", description: "Building and publishing mobile apps." }]
  });
  assert.match(fromAds, /Created collection "Mobile apps": tell the user\./);
  const [learningId, alternativesId, screenshotsId] = savedIds(fromAds);
  assert.ok(learningId && alternativesId && screenshotsId);
  await h.knowledge.settled();
  assert.equal(h.pushes(), 5, "a collection created by a save pushes the manifests too");

  // knowledge_collections lists every collection, for choosing where to save.
  const listed = await h.text("ads-chat", "knowledge_collections", {});
  for (const name of ["SEO (2)", "Ads (1)", "SaaS (0)", "Mobile apps (1)"]) assert.ok(listed.includes(`- ${name}`), listed);

  // --- visibility in search and get ------------------------------------------------------------
  const globalHits = await h.text("global", "knowledge_search", { query: "ranking in chatgpt" });
  assert.ok(globalHits.includes(cloudflareId!), `by meaning, not words: ${globalHits}`);
  const adsHits = await h.text("ads-chat", "knowledge_search", { query: "comparison tables competitor cloudflare budget" });
  assert.ok(adsHits.includes(learningId!), adsHits);
  assert.ok(!adsHits.includes(cloudflareId!) && !adsHits.includes(alternativesId!), `no SEO entry for the Ads chat: ${adsHits}`);
  assert.match(adsHits, /over Ads\)/);
  assert.equal(await h.refusal("ads-chat", "knowledge_get", { id: cloudflareId! }), "KNOWLEDGE_NOT_FOUND", "a hidden entry answers like an unknown one");
  assert.equal(await h.refusal("ads-chat", "knowledge_search", { query: "tables", collections: ["SEO"] }), "KNOWLEDGE_UNKNOWN_COLLECTION");
  const read = await h.text("ads-chat", "knowledge_get", { id: learningId! });
  assert.match(read, /cite: \[Ads learning phase\]\(orquester-knowledge:entry\/ke_/);
  assert.ok(read.endsWith("Cap the daily budget while a campaign learns; raise spend after 50 conversions."));
  // A chat whose profile ticks nothing, and a session the daemon does not know, see nothing.
  assert.match(await h.text("plain-chat", "knowledge_search", { query: "budget" }), /^No knowledge found \(over no collection\)/);
  assert.match(await h.text("stranger", "knowledge_search", { query: "budget" }), /^No knowledge found/);

  // --- relabelling never touches the myKG mirror -----------------------------------------------
  const mirror = join(knowledgeMykgInputDir(h.appdir), `${cloudflareId}.md`);
  const mirrorBefore = await readFile(mirror, "utf8");
  const mtimeBefore = (await stat(mirror)).mtimeMs;
  assert.match(mirrorBefore, /^Author: Kevin \(@kev\)/);
  assert.ok(!mirrorBefore.includes("SEO"), "collections are not in the mirror");
  // A duplicate save (same text) adds its collections to the entry that exists.
  const duplicate = await h.text("global", "knowledge_save", { entries: [{ body: cloudflare, collections: ["SEO", "SaaS"] }] });
  assert.match(duplicate, /already saved as ke_[a-z0-9]{12} \(not saved again; the collections it is in now\) · in SEO, SaaS/);
  assert.deepEqual(savedIds(duplicate), [cloudflareId]);
  // The user ticks Ads on it in the Knowledge tab.
  const patched = await h.user("PATCH", knowledgeRoutes.entry(cloudflareId!), { collections: [seo.id, saas.id, ads.id] });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(await readFile(mirror, "utf8"), mirrorBefore);
  assert.equal((await stat(mirror)).mtimeMs, mtimeBefore, "the mirror file was not rewritten");
  // …and the Ads chat sees it on its next call.
  assert.ok((await h.text("ads-chat", "knowledge_search", { query: "cloudflare" })).includes(cloudflareId!));

  // --- a profile's collections change: the next call sees it, and manifests are pushed ----------
  const pushesBefore = h.pushes();
  await h.profiles.update(adsExpert.id, { revision: adsExpert.revision, settings: { knowledgeCollections: [ads.id, seo.id] } });
  await h.knowledge.settled();
  assert.equal(h.pushes(), pushesBefore + 1);
  assert.ok((await h.text("ads-chat", "knowledge_search", { query: "alternatives pages competitor" })).includes(alternativesId!));
  const views = (await h.user("GET", knowledgeRoutes.collections)).body as { collections: KnowledgeCollectionView[] };
  assert.deepEqual(views.collections.find((c) => c.id === seo.id)!.profiles, [{ id: adsExpert.id, name: "Ads expert" }], "the profile cache was refreshed by the event");
  // A profile edit that leaves its collections alone pushes nothing.
  const renamed = await h.profiles.update(plain.id, { revision: plain.revision, name: "Plain 2" });
  await h.knowledge.settled();
  assert.equal(renamed.name, "Plain 2");
  assert.equal(h.pushes(), pushesBefore + 1);

  // --- deletes -----------------------------------------------------------------------------------
  assert.equal((await h.user("DELETE", knowledgeRoutes.collection(saas.id))).status, 204);
  await h.knowledge.settled();
  assert.equal(h.pushes(), pushesBefore + 2, "a deleted collection pushes the manifests");
  assert.deepEqual((await h.knowledge.knowledgeForSession("global")).visibleCollectionNames, ["SEO", "Ads", "Mobile apps"]);
  assert.equal((await h.user("DELETE", knowledgeRoutes.entry(cloudflareId!))).status, 204);
  assert.ok(!(await h.text("global", "knowledge_search", { query: "cloudflare" })).includes(cloudflareId!));
  assert.equal(await h.refusal("global", "knowledge_get", { id: cloudflareId! }), "KNOWLEDGE_NOT_FOUND");
  await assert.rejects(stat(mirror), { code: "ENOENT" }, "the mirror file goes with the entry");

  // --- worker routes: only the indexing chats of the run in flight ------------------------------
  for (const who of ["worker", "global", "ads-chat"]) {
    assert.equal(await h.refusal(who, "knowledge_worker_next_task", {}), "KNOWLEDGE_NOT_A_WORKER", who);
    assert.equal(await h.refusal(who, "knowledge_worker_submit", { taskId: "t1", answer: "{}" }), "KNOWLEDGE_NOT_A_WORKER", who);
  }
  // The manifests: knowledge tools by what each chat sees; an indexer gets the two worker tools alone.
  const globalTools = await h.toolsOf("global");
  for (const name of ["knowledge_search", "knowledge_get", "knowledge_save", "knowledge_collections", "knowledge_insights"]) assert.ok(globalTools.includes(name), name);
  assert.ok(!globalTools.some((name) => KNOWLEDGE_WORKER_TOOLS.includes(name)));
  const plainTools = await h.toolsOf("plain-chat");
  assert.ok(plainTools.includes("knowledge_save") && !plainTools.includes("knowledge_search") && !plainTools.includes("knowledge_insights"), "a profile that ticks nothing can save, not search");
  assert.deepEqual(await h.toolsOf("worker"), [...KNOWLEDGE_WORKER_TOOLS]);

  // --- the plugin switch -----------------------------------------------------------------------
  const before = h.pushes();
  h.plugins.set(false);
  await h.knowledge.settled();
  assert.equal(h.pushes(), before + 1, "switching off pushes the manifests (the tools go)");
  assert.equal(h.embedders.released, 1, "the embedder is released");
  assert.equal(await h.refusal("global", "knowledge_search", { query: "budget" }), "KNOWLEDGE_DISABLED");
  assert.deepEqual(await h.knowledge.knowledgeForSession("global"), { enabled: false, worker: false, searchable: false, visibleCollectionNames: [] });
  assert.deepEqual(await h.toolsOf("worker"), [...KNOWLEDGE_WORKER_TOOLS], "an indexer keeps only its two tools with the plugin off too");
  assert.ok(!(await h.toolsOf("global")).some((name) => name.startsWith("knowledge_")));
  const off = (await h.user("GET", knowledgeRoutes.status)).body as KnowledgeStatus;
  assert.equal(off.enabled, false);
  assert.equal(off.linking.state === "paused" && off.linking.reason, "plugin-off");

  h.plugins.set(true);
  await h.knowledge.settled();
  assert.equal(h.pushes(), before + 2);
  assert.equal(h.embedders.made.length, 1, "the same knowledge base, not reopened");
  assert.ok((await h.text("ads-chat", "knowledge_search", { query: "budget campaign" })).includes(learningId!));
  const on = (await h.user("GET", knowledgeRoutes.status)).body as KnowledgeStatus;
  assert.equal(on.entries, 3);
  assert.equal(on.collections, 3);
  assert.equal(on.linking.state, "queued", "the saves wait for the debounce");

  // --- a linking run: fake myKG, answered through the worker tools --------------------------------
  const linking = h.linkingOf();
  await h.clock.advance(20_000);
  await h.until(() => linking.snapshot().recentRuns.some((run) => run.outcome !== "running"));
  const run = linking.snapshot().lastRun!;
  assert.equal(run.outcome, "ok", JSON.stringify(linking.snapshot()));
  assert.equal(run.mode, "full");
  assert.ok(h.workers.sessions.length >= 1);
  assert.ok(h.toolCalls.next >= 1 && h.toolCalls.submit >= 4, JSON.stringify(h.toolCalls));
  assert.equal(h.toolCalls.refused, h.workers.sessions.length, "each chat's invalid first answer was refused through the tool and redone");
  assert.ok(h.workers.sessions[0]!.seenInstructions.slice(1).some((instructions) => instructions === null), "instructions are sent once per step and chat");
  await h.knowledge.settled();
  const linked = (await h.user("GET", knowledgeRoutes.status)).body as KnowledgeStatus;
  assert.equal(linked.concepts, 3);
  assert.equal(linked.linking.state, "idle");
  // The concepts are searchable, scoped like their entries.
  const conceptHits = await h.text("ads-chat", "knowledge_search", { query: "learning phase budget cap" });
  assert.match(conceptHits, /concept tactic-learningphase "Learning phase budget cap" \(Tactic\)/, conceptHits);
  assert.match(conceptHits, new RegExp(`entries ${learningId}`));
  assert.doesNotMatch(await h.text("ads-chat", "knowledge_search", { query: "outcome-first store screenshots" }), /tactic-storescreenshots/, "a concept only a hidden entry supports is hidden");
  assert.match(await h.text("global", "knowledge_search", { query: "outcome-first store screenshots" }), /concept tactic-storescreenshots/);
  const concept = await h.text("ads-chat", "knowledge_get", { id: "tactic-learningphase" });
  assert.match(concept, /^concept tactic-learningphase "Learning phase budget cap" \(Tactic\)/);
  assert.ok(concept.includes(learningId!));
  const entry = await h.text("ads-chat", "knowledge_get", { id: learningId! });
  assert.match(entry, /Concepts: Learning phase budget cap \(Tactic\) \[tactic-learningphase\]/);
  assert.doesNotMatch(entry.split("\n")[1]!, /linking pending/, "the entry is linked");
  // The run's worker chats are refused once it is over.
  assert.equal(await h.refusal(h.workers.sessions[0]!.id, "knowledge_worker_next_task", {}), "KNOWLEDGE_NOT_A_WORKER");
});

test("knowledge_update and knowledge_delete end to end: edits by collection name, clearing a field, visibility, per-id delete outcomes, and who is advertised them", async (t) => {
  const h = await harness(t);
  const make = async (name: string) => {
    const res = await h.user("POST", knowledgeRoutes.collections, { name, description: `${name} notes.` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as KnowledgeCollectionView;
  };
  await make("SEO");
  const ads = await make("Ads");
  const adsOnly = await h.profiles.create({ name: "Ads only", settings: { knowledgeCollections: [ads.id] } });
  const plain = await h.profiles.create({ name: "Plain" });
  await h.knowledge.settled();
  h.sessions.set("global", { profileId: null });
  h.sessions.set("ads-chat", { profileId: adsOnly.id });
  h.sessions.set("plain-chat", { profileId: plain.id });

  const saved = await h.text("global", "knowledge_save", {
    entries: [
      { body: "Playbook v1: boost proven posts with paid reach.", title: "Playbook v1", author: "Claude", handle: "claude", collections: ["SEO"] },
      { body: "Cap the daily budget while a campaign learns.", title: "Learning phase", collections: ["Ads"] },
      { body: "Search pages answer the question in the first 100 words.", title: "Answer first", collections: ["SEO"] }
    ]
  });
  const [playbookId, learningId, answerId] = savedIds(saved);
  assert.ok(playbookId && learningId && answerId, saved);

  // An edit in place: collections by name (any case), text, title; the next read shows it.
  const edited = await h.text("global", "knowledge_update", { id: playbookId, title: "Playbook v2", body: "Playbook v2: organic only.", collections: ["seo", "Ads"] });
  assert.match(edited, /^Updated title, body, collections\.\n/);
  assert.match(edited, /in SEO, Ads/);
  assert.match(edited, /cite: \[Playbook v2 · @claude\]\(orquester-knowledge:entry\/ke_/, "the citation carries the new title");
  const read = await h.text("ads-chat", "knowledge_get", { id: playbookId! });
  assert.ok(read.endsWith("Playbook v2: organic only."), read);
  assert.match(read, /Claude \(@claude\)/);
  assert.ok((await h.text("global", "knowledge_search", { query: "organic only playbook" })).includes(playbookId!), "the new text is searchable");
  // null clears a metadata field.
  await h.text("global", "knowledge_update", { id: playbookId, author: null, handle: null });
  assert.doesNotMatch((await h.text("global", "knowledge_get", { id: playbookId! })).split("\n")[1]!, /Claude|@claude/);
  assert.equal(await h.refusal("global", "knowledge_update", { id: playbookId, collections: ["Nope"] }), "KNOWLEDGE_UNKNOWN_COLLECTION");
  assert.equal(await h.refusal("global", "knowledge_update", { id: playbookId }), "INVALID_ARGUMENT");

  // A chat edits and deletes only what it can see: an SEO-only entry is unknown to the Ads chat.
  assert.equal(await h.refusal("ads-chat", "knowledge_update", { id: answerId, title: "x" }), "KNOWLEDGE_NOT_FOUND");
  assert.equal(await h.refusal("ads-chat", "knowledge_delete", { ids: [answerId] }), "KNOWLEDGE_NOT_FOUND");
  const mixed = await h.text("ads-chat", "knowledge_delete", { ids: [learningId, answerId, learningId] });
  assert.match(mixed, /^Deleted 1 entry; 1 not deleted\./);
  assert.ok(mixed.includes(`- deleted ${learningId} "Learning phase"`), mixed);
  assert.ok(mixed.includes(`- not deleted ${answerId}: No such entry.`), mixed);
  assert.equal(await h.refusal("global", "knowledge_get", { id: learningId! }), "KNOWLEDGE_NOT_FOUND");
  assert.ok((await h.text("global", "knowledge_get", { id: answerId! })).endsWith("Search pages answer the question in the first 100 words."), "the hidden entry is untouched");

  // Advertised with search and get: to a chat that sees a collection, not to one that sees none.
  const globalTools = await h.toolsOf("global");
  for (const name of ["knowledge_update", "knowledge_delete"]) assert.ok(globalTools.includes(name), name);
  const plainTools = await h.toolsOf("plain-chat");
  assert.ok(plainTools.includes("knowledge_save") && !plainTools.includes("knowledge_update") && !plainTools.includes("knowledge_delete"));
});

test("knowledge_merge end to end: a hidden id refuses the whole merge; the kept entry gets every collection, the rest leave search; who is advertised it", async (t) => {
  const h = await harness(t);
  const make = async (name: string) => {
    const res = await h.user("POST", knowledgeRoutes.collections, { name, description: `${name} notes.` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as KnowledgeCollectionView;
  };
  await make("SEO");
  const ads = await make("Ads");
  const adsOnly = await h.profiles.create({ name: "Ads only", settings: { knowledgeCollections: [ads.id] } });
  const plain = await h.profiles.create({ name: "Plain" });
  await h.knowledge.settled();
  h.sessions.set("global", { profileId: null });
  h.sessions.set("ads-chat", { profileId: adsOnly.id });
  h.sessions.set("plain-chat", { profileId: plain.id });

  const first = savedIds(await h.text("global", "knowledge_save", { entries: [{ body: "Cap the daily budget while a campaign learns.", title: "Learning phase", collections: ["Ads"] }] }))[0];
  const second = savedIds(await h.text("global", "knowledge_save", { entries: [{ body: "Comparison pages win high-intent searches every time.", title: "Comparison pages", collections: ["SEO"] }] }))[0];
  assert.ok(first && second);

  // The Ads chat cannot see the SEO entry: the merge is refused and nothing changes.
  assert.equal(await h.refusal("ads-chat", "knowledge_merge", { ids: [first, second] }), "KNOWLEDGE_NOT_FOUND");
  assert.ok((await h.text("global", "knowledge_get", { id: second! })).endsWith("Comparison pages win high-intent searches every time."));
  assert.match((await h.text("global", "knowledge_get", { id: first! })).split("\n")[1]!, /in Ads(?!,)/);

  // The whole-base chat merges: the kept entry gets both collections and the combined text.
  const merged = await h.text("global", "knowledge_merge", { ids: [second, first], keep: first, body: "Cap the budget while learning; comparison pages win high-intent searches." });
  assert.ok(merged.startsWith(`Merged 2 entries into ${first}; deleted ${second}.`), merged);
  assert.match(merged, /in Ads, SEO/);
  assert.match(merged, /cite: \[Learning phase\]\(orquester-knowledge:entry\/ke_/);
  assert.equal(await h.refusal("global", "knowledge_get", { id: second! }), "KNOWLEDGE_NOT_FOUND");
  assert.ok(!(await h.text("global", "knowledge_search", { query: "comparison pages high-intent" })).includes(second!), "the deleted entry left search");
  assert.ok((await h.text("ads-chat", "knowledge_get", { id: first! })).endsWith("comparison pages win high-intent searches."), "still visible where it was");

  assert.ok((await h.toolsOf("global")).includes("knowledge_merge"));
  assert.ok(!(await h.toolsOf("plain-chat")).includes("knowledge_merge"));
});
