/**
 * Agent Profiles × Knowledge Graph: `settings.knowledgeCollections` — created, replaced, validated,
 * shown on the wire, kept by duplicate and export/import, tolerated when missing, stale or
 * unreadable — and the plugin's reads of it (`profilesForCollection`, `profileKnowledgeCollections`).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import Fastify from "fastify";
import { sessionProfileRoutes, type SessionProfileDetail } from "@orquester/api";
import { sessionProfileDir } from "@orquester/config";

import { SessionProfileImports, type SessionProfileGlobalConfig, type SessionProfileScanner } from "./imports.ts";
import { profileKnowledgeCollections, profilesForCollection } from "./knowledge.ts";
import { profileLayout } from "./layout.ts";
import { registerSessionProfileRoutes } from "./routes.ts";
import { SessionProfileService } from "./service.ts";
import { SessionProfileStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const appdir = await mkdtemp(join(tmpdir(), "orq-profile-knowledge-"));
  roots.push(appdir);
  let n = 0;
  const store = new SessionProfileStore({ appdir, now: () => new Date("2026-10-23T12:00:00.000Z"), newId: () => `id-${++n}` });
  await store.init();
  // Export / import only reach the store and the work dir.
  const imports = new SessionProfileImports({ store, global: {} as SessionProfileGlobalConfig, scanner: {} as SessionProfileScanner, workDir: join(appdir, "imports") });
  const service = new SessionProfileService({ store, imports });
  return { appdir, store, service };
}

const SEO = "kc_seo0000000";
const ADS = "kc_ads0000000";

describe("settings.knowledgeCollections", () => {
  it("absent is none ticked; create and update replace the list (deduplicated); the wire shows it", async () => {
    const { store, service } = await setup();
    const bare = await service.create({ name: "Plain" });
    assert.equal("knowledgeCollections" in bare.settings, false, "never set: absent on the wire (none ticked)");
    assert.deepEqual(await profileKnowledgeCollections(store, bare.id), []);

    const created = await service.create({ name: "SaaS expert", settings: { knowledgeCollections: [SEO, ADS, SEO] } });
    assert.deepEqual(created.settings.knowledgeCollections, [SEO, ADS]);
    assert.equal(created.settings.claudeWorkflowTool, true, "the other settings keep their defaults");

    const updated = await service.update(created.id, { revision: created.revision, settings: { knowledgeCollections: [ADS] } });
    assert.deepEqual(updated.settings.knowledgeCollections, [ADS]);
    // Another setting changed alone leaves the list as it was.
    const other = await service.update(created.id, { revision: updated.revision, settings: { claudeWorkflowTool: false } });
    assert.deepEqual(other.settings.knowledgeCollections, [ADS]);
    const cleared = await service.update(created.id, { revision: other.revision, settings: { knowledgeCollections: [] } });
    assert.deepEqual(cleared.settings.knowledgeCollections, []);
    assert.deepEqual(await profileKnowledgeCollections(store, created.id), []);
  });

  it("refuses what is not a list of collection ids, or too many", async () => {
    const { store } = await setup();
    const profile = await store.create({ name: "P" });
    for (const bad of [["../x"], ["has space"], [""], Array.from({ length: 101 }, (_, index) => `kc_${index}`)]) {
      await assert.rejects(store.update(profile.manifest.id, String(profile.manifest.revision), { settings: { knowledgeCollections: bad } }), (error: { code?: string }) => error.code === "INVALID_REQUEST");
    }
  });

  it("the route validates the field (400) and saves a good one", async () => {
    const { appdir, service } = await setup();
    const app = Fastify();
    registerSessionProfileRoutes(app, { service, importsDir: join(appdir, "uploads") });
    await app.ready();
    try {
      const created = (await app.inject({ method: "POST", url: sessionProfileRoutes.list, payload: { name: "Mobile", settings: { knowledgeCollections: [SEO] } } })).json() as SessionProfileDetail;
      assert.deepEqual(created.settings.knowledgeCollections, [SEO]);
      for (const knowledgeCollections of ["kc_seo0000000", [1], ["a/b"]]) {
        const bad = await app.inject({ method: "PUT", url: sessionProfileRoutes.profile(created.id), payload: { revision: created.revision, settings: { knowledgeCollections } } });
        assert.equal(bad.statusCode, 400, JSON.stringify(knowledgeCollections));
      }
      const ok = await app.inject({ method: "PUT", url: sessionProfileRoutes.profile(created.id), payload: { revision: created.revision, settings: { knowledgeCollections: [ADS, SEO] } } });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual((ok.json() as SessionProfileDetail).settings.knowledgeCollections, [ADS, SEO]);
    } finally {
      await app.close();
    }
  });

  it("duplicate and export/import keep the ticked ids (stale ones too: they are ignored where used)", async () => {
    const { appdir, store, service } = await setup();
    const profile = await service.create({ name: "Growth", settings: { knowledgeCollections: [SEO, "kc_deleted000"] } });
    const copy = await service.duplicate(profile.id);
    assert.deepEqual(copy.settings.knowledgeCollections, [SEO, "kc_deleted000"]);
    const { fileName, data } = await service.exportProfile(profile.id);
    const zipPath = join(appdir, fileName);
    await writeFile(zipPath, data);
    const imported = await service.importProfile(fileName, zipPath);
    assert.deepEqual(imported.profile.settings.knowledgeCollections, [SEO, "kc_deleted000"]);
    assert.deepEqual(await profileKnowledgeCollections(store, imported.profile.id), [SEO, "kc_deleted000"]);
  });

  it("a hand-edited or newer value is kept through a rewrite and reads as none ticked (or its ids only)", async () => {
    const { appdir, store, service } = await setup();
    const profile = await store.create({ name: "Edited" });
    const file = profileLayout(sessionProfileDir(appdir, profile.manifest.id)).manifest;
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.settings = { knowledgeCollections: "all", futureSetting: 1 };
    await writeFile(file, JSON.stringify(raw));
    assert.deepEqual(await profileKnowledgeCollections(store, profile.manifest.id), []);
    assert.deepEqual((await service.get(profile.manifest.id)).settings.knowledgeCollections, []);
    await store.update(profile.manifest.id, String(raw.revision), { description: "touched" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).settings, { knowledgeCollections: "all", futureSetting: 1 });

    raw.settings = { knowledgeCollections: [SEO, 7, "bad id", SEO] };
    raw.revision += 1;
    await writeFile(file, JSON.stringify(raw));
    assert.deepEqual(await profileKnowledgeCollections(store, profile.manifest.id), [SEO]);
  });
});

describe("the plugin's reads", () => {
  it("profilesForCollection: per collection id, the profiles ticking it, by name", async () => {
    const { store } = await setup();
    await store.create({ name: "SaaS expert", settings: { knowledgeCollections: [SEO, ADS] } });
    await store.create({ name: "Mobile expert", settings: { knowledgeCollections: [SEO] } });
    await store.create({ name: "Global-ish" });
    const map = await profilesForCollection(store);
    assert.deepEqual(map.get(SEO), [{ id: "id-2", name: "Mobile expert" }, { id: "id-1", name: "SaaS expert" }]);
    assert.deepEqual(map.get(ADS), [{ id: "id-1", name: "SaaS expert" }]);
    assert.equal(map.size, 2);
  });

  it("profileKnowledgeCollections: a deleted profile is missing; an unreadable one throws (the caller fails closed)", async () => {
    const { appdir, store } = await setup();
    assert.equal(await profileKnowledgeCollections(store, "nope"), "missing");
    const profile = await store.create({ name: "Broken" });
    await writeFile(profileLayout(sessionProfileDir(appdir, profile.manifest.id)).manifest, "{ not json");
    await assert.rejects(profileKnowledgeCollections(store, profile.manifest.id));
  });
});
