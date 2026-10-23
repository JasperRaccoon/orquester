/**
 * Knowledge Graph — what a calling chat sees (spec goal 2, "Collections and profiles"): no session
 * and Global chats see everything, a profile chat exactly its ticked collections, a worker
 * nothing, an unknown session or an unreadable profile nothing (fail closed) — read fresh on every
 * call — and the manifest's knowledge view built from it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createKnowledgeForSession, KnowledgeSessionVisibility, ownerKindOf, type KnowledgeSessionRecord } from "./visibility.ts";

function world() {
  const sessions = new Map<string, KnowledgeSessionRecord>([
    ["global", {}],
    ["global-null", { profileId: null }],
    ["workflow", { ownerKind: "workflow" }],
    ["saas", { profileId: "p-saas" }],
    ["blind", { profileId: "p-blind" }],
    ["orphan", { profileId: "p-deleted" }],
    ["broken", { profileId: "p-broken" }],
    ["worker", { profileId: "p-indexer", ownerKind: "knowledge-indexer" }]
  ]);
  const profiles = new Map<string, readonly string[]>([
    ["p-saas", ["kc_seo", "kc_saas", "kc_seo"]],
    ["p-blind", []],
    ["p-indexer", ["kc_seo"]]
  ]);
  const reads: string[] = [];
  const warnings: string[] = [];
  const visibility = new KnowledgeSessionVisibility({
    session: async (id) => (id === "throws" ? Promise.reject(new Error("tabs unreadable")) : (sessions.get(id) ?? null)),
    profileCollections: async (id) => {
      reads.push(id);
      if (id === "p-broken") throw new Error("profile.json is not JSON");
      return profiles.get(id) ?? "missing";
    },
    logger: { warn: (message) => warnings.push(message) }
  });
  return { sessions, profiles, reads, warnings, visibility };
}

test("forSession: no session and Global chats see all; a profile chat its ticked ids; a worker, an unknown session and an unreadable profile nothing", async () => {
  const { visibility, warnings } = world();
  for (const id of [undefined, "", "global", "global-null", "workflow", "orphan"]) assert.deepEqual(await visibility.forSession(id), { kind: "all" }, String(id));
  assert.deepEqual(await visibility.forSession("saas"), { kind: "collections", ids: ["kc_seo", "kc_saas"] });
  for (const id of ["blind", "worker", "nobody", "throws", "broken"]) assert.deepEqual(await visibility.forSession(id), { kind: "collections", ids: [] }, id);
  assert.equal(warnings.length, 2, "an unreadable session and an unreadable profile are warned");
});

test("forSession is fresh: a profile edit or a profile switch shows on the next call", async () => {
  const { visibility, profiles, sessions, reads } = world();
  assert.deepEqual(await visibility.forSession("saas"), { kind: "collections", ids: ["kc_seo", "kc_saas"] });
  profiles.set("p-saas", ["kc_ads"]);
  assert.deepEqual(await visibility.forSession("saas"), { kind: "collections", ids: ["kc_ads"] });
  sessions.set("saas", { profileId: null });
  assert.deepEqual(await visibility.forSession("saas"), { kind: "all" });
  assert.deepEqual(reads, ["p-saas", "p-saas"]);
});

test("isWorker and ownerKindOf read the owner's kind whatever the owner union holds", async () => {
  const { visibility } = world();
  assert.equal(await visibility.isWorker("worker"), true);
  for (const id of ["global", "workflow", "saas", "nobody", "throws"]) assert.equal(await visibility.isWorker(id), false, id);
  assert.equal(ownerKindOf({ kind: "knowledge-indexer", runId: "r1" }), "knowledge-indexer");
  assert.equal(ownerKindOf({ kind: "workflow", workflowId: "w", runId: "r" }), "workflow");
  for (const owner of [undefined, null, "workflow", { kind: 3 }, {}]) assert.equal(ownerKindOf(owner), undefined);
});

test("createKnowledgeForSession: off, Global, a profile with and without collections, deleted ids dropped, a worker", async () => {
  const { visibility } = world();
  let enabled = true;
  const collections = [
    { id: "kc_seo", name: "SEO" },
    { id: "kc_ads", name: "Ads" },
    { id: "kc_saas", name: "SaaS" }
  ];
  const forSession = createKnowledgeForSession({ enabled: () => enabled, visibility, collections: async () => collections });
  assert.deepEqual(await forSession("global"), { enabled: true, worker: false, searchable: true, visibleCollectionNames: ["SEO", "Ads", "SaaS"] });
  assert.deepEqual(await forSession("saas"), { enabled: true, worker: false, searchable: true, visibleCollectionNames: ["SEO", "SaaS"] });
  assert.deepEqual(await forSession("blind"), { enabled: true, worker: false, searchable: false, visibleCollectionNames: [] });
  assert.deepEqual(await forSession("worker"), { enabled: true, worker: true, searchable: false, visibleCollectionNames: [] });
  // Only deleted collections ticked: nothing to search.
  const stale = createKnowledgeForSession({ enabled: () => true, visibility, collections: () => [{ id: "kc_ads", name: "Ads" }] });
  assert.deepEqual(await stale("saas"), { enabled: true, worker: false, searchable: false, visibleCollectionNames: [] });
  enabled = false;
  assert.deepEqual(await forSession("global"), { enabled: false, worker: false, searchable: false, visibleCollectionNames: [] });
  // A worker stays a worker with the plugin off: it keeps only its two tools.
  assert.deepEqual(await forSession("worker"), { enabled: false, worker: true, searchable: false, visibleCollectionNames: [] });
});
