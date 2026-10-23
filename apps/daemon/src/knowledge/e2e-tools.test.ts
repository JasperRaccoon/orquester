/**
 * The knowledge tools end to end (Knowledge Graph plugin spec, "Agent tools", goal 2): the real
 * `KnowledgeService` behind the daemon's own app (`createServer`, unix transport), driven through
 * the catalog executor and the in-process client with each chat's principal, as an in-chat call
 * runs. Real store, search (a fake embedder), Agent Profiles and visibility; the chats' tab records
 * are a map. Covers: collections, saving from a Global and a profile chat, visibility in search and
 * get, a relabel leaving the myKG mirror alone, deletes, the manifest read, the manifest pushes, the
 * worker routes and the plugin switch.
 */

import assert from "node:assert/strict";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { knowledgeRoutes, type KnowledgeCollectionView, type KnowledgeStatus } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, knowledgeMykgInputDir } from "@orquester/config";

import { createServer } from "../index.ts";
import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { SessionProfileService } from "../session-profiles/service.ts";
import { SessionProfileStore } from "../session-profiles/store.ts";
import { silentLogger } from "./search/test-fakes.ts";
import { KnowledgeService } from "./service.ts";
import { FakeKnowledgePlugins, fakeEmbedders } from "./test-fakes.ts";
import type { KnowledgeSessionRecord } from "./visibility.ts";

type CreateServerArgs = Parameters<typeof createServer>;

async function harness(t: TestContext) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "kg-e2e-")));
  const appdir = join(root, "appdir");
  const workspacesDir = join(root, "workspaces");
  const plugins = new FakeKnowledgePlugins(true);
  const profileStore = new SessionProfileStore({ appdir });
  await profileStore.init();
  const profiles = new SessionProfileService({ store: profileStore });
  const sessions = new Map<string, KnowledgeSessionRecord>();
  const embedders = fakeEmbedders();
  let pushes = 0;
  const logger = { ...silentLogger(), log() {} };
  const knowledge = new KnowledgeService({
    appdir,
    plugins,
    accounts: { getRecord: () => undefined },
    session: (id) => sessions.get(id) ?? null,
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
    embedders: embedders.factory,
    logger
  });
  await knowledge.start();
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
  const user = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as unknown) : null };
  };
  return { appdir, plugins, profiles, sessions, knowledge, embedders, text, refusal, user, pushes: () => pushes };
}

const savedIds = (out: string): string[] => [...out.matchAll(/(?:saved|already saved as) (ke_[a-z0-9]{12})/g)].map((match) => match[1]!);

test("knowledge tools end to end: save from Global and profile chats, visibility in search and get, relabel, delete, worker routes, the plugin switch", async (t) => {
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
  h.sessions.set("worker", { ownerKind: "knowledge-indexer" });

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
  assert.match(duplicate, /already saved as ke_[a-z0-9]{12} \(new collections added\) · in SEO, SaaS/);
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

  // --- worker routes: only the plugin's indexing sessions, and no linking module yet -----------
  assert.match(await h.text("worker", "knowledge_worker_next_task", {}), /^No task \(run-cancelled\)\. End your turn now\./);
  assert.equal(await h.refusal("global", "knowledge_worker_next_task", {}), "KNOWLEDGE_NOT_A_WORKER");
  assert.equal(await h.refusal("global", "knowledge_worker_submit", { taskId: "t1", answer: "{}" }), "KNOWLEDGE_NOT_A_WORKER");

  // --- the plugin switch -----------------------------------------------------------------------
  const before = h.pushes();
  h.plugins.set(false);
  await h.knowledge.settled();
  assert.equal(h.pushes(), before + 1, "switching off pushes the manifests (the tools go)");
  assert.equal(h.embedders.disposed, 1, "the embedder is released");
  assert.equal(await h.refusal("global", "knowledge_search", { query: "budget" }), "KNOWLEDGE_DISABLED");
  assert.deepEqual(await h.knowledge.knowledgeForSession("global"), { enabled: false, worker: false, searchable: false, visibleCollectionNames: [] });
  const off = (await h.user("GET", knowledgeRoutes.status)).body as KnowledgeStatus;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.linking, { state: "paused", reason: "plugin-off", message: "The Knowledge Graph plugin is off.", resumesAt: null, pendingEntries: 0 });

  h.plugins.set(true);
  await h.knowledge.settled();
  assert.equal(h.pushes(), before + 2);
  assert.equal(h.embedders.made.length, 2, "a new opening, read back from disk");
  assert.ok((await h.text("ads-chat", "knowledge_search", { query: "budget campaign" })).includes(learningId!));
  const on = (await h.user("GET", knowledgeRoutes.status)).body as KnowledgeStatus;
  assert.equal(on.entries, 3);
  assert.equal(on.collections, 3);
  assert.equal(on.linking.state, "paused");
});
