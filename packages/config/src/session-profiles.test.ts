import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SESSION_PROFILE_SHARED_ACCOUNT_KEY,
  agentThreadHeadSchema,
  assertSessionProfileSegment,
  emptySessionProfileDeleted,
  emptySessionProfileSecrets,
  parseSessionProfileDeleted,
  parseSessionProfileManifest,
  parseSessionProfileSecrets,
  readSessionProfilePluginSource,
  serializeSessionProfileDeleted,
  serializeSessionProfileManifest,
  serializeSessionProfileSecrets,
  sessionChatRecordSchema,
  sessionProfileAccountKey,
  sessionProfileDeletedFile,
  sessionProfileDir,
  sessionProfilePreparedDir,
  sessionProfilePreparedKeyDir,
  sessionProfileStagingDir,
  sessionProfilesDir
} from "./index.ts";

const MANIFEST = {
  version: 1,
  id: "p1",
  name: "Developer",
  description: "",
  revision: 3,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
  settings: { claudeWorkflowTool: false, futureSetting: { a: 1 } },
  futureTopLevel: ["kept"],
  items: [
    { id: "s1", kind: "skill", name: "review", enabled: true, agents: "all", futureItemField: 7 },
    {
      id: "m1",
      kind: "mcp",
      name: "github",
      enabled: false,
      agents: ["claude", "codex"],
      mcp: { transport: "stdio", command: "gh-mcp", envKeys: ["TOKEN"], futureMcpField: true }
    },
    { id: "x1", kind: "workflow", name: "from a newer build" },
    { id: "s1", kind: "skill", name: "duplicate id" },
    "not even an object"
  ]
};

describe("session profile manifest", () => {
  it("reads good items, keeps bad ones verbatim with a reason, and round-trips unknown fields", () => {
    const file = parseSessionProfileManifest(structuredClone(MANIFEST));
    assert.equal(file.items.length, 5);
    assert.deepEqual(
      file.items.map((entry) => entry.ok),
      [true, true, false, false, false]
    );
    const bad = file.items[2]!;
    assert.ok(!bad.ok && bad.id === "x1" && bad.error.length > 0);
    const dup = file.items[3]!;
    assert.ok(!dup.ok && /already has the id/.test(dup.error));

    const rewritten = JSON.parse(serializeSessionProfileManifest(file));
    assert.deepEqual(rewritten.futureTopLevel, ["kept"]);
    assert.deepEqual(rewritten.settings.futureSetting, { a: 1 });
    assert.equal(rewritten.items[0].futureItemField, 7);
    assert.equal(rewritten.items[1].mcp.futureMcpField, true);
    assert.deepEqual(rewritten.items.slice(2), MANIFEST.items.slice(2));
  });

  it("defaults what an older or hand-written manifest leaves out", () => {
    const file = parseSessionProfileManifest({
      version: 1,
      id: "p2",
      name: "Bare",
      revision: 0,
      createdAt: "t",
      updatedAt: "t",
      items: [{ id: "c1", kind: "command", name: "git/pr" }]
    });
    assert.equal(file.manifest.description, "");
    assert.deepEqual(file.manifest.settings, {});
    const item = file.items[0]!;
    assert.ok(item.ok);
    assert.equal(item.record.enabled, true);
    assert.equal(item.record.agents, "all");
  });

  it("keeps a setting it cannot read verbatim through a rewrite, never failing the profile", () => {
    for (const settings of [
      { hideBuiltinSkills: { claude: "auto", codex: false, future: 1 }, claudeWorkflowTool: "ask" },
      { hideBuiltinSkills: "all", claudeWorkflowTool: { mode: "on" } }
    ]) {
      const file = parseSessionProfileManifest({ ...MANIFEST, settings });
      assert.deepEqual(file.manifest.settings, settings);
      assert.deepEqual(JSON.parse(serializeSessionProfileManifest(file)).settings, settings);
    }
  });

  it("knowledgeCollections (Knowledge Graph): absent is fine; a list, stale ids or an unreadable value round-trip verbatim", () => {
    const bare = parseSessionProfileManifest({ ...MANIFEST, settings: { claudeWorkflowTool: true } });
    assert.equal("knowledgeCollections" in bare.manifest.settings, false);
    for (const knowledgeCollections of [["kc_aaaaaaaaaa", "kc_deleted00"], [], "all", [1, { id: "x" }]]) {
      const settings = { claudeWorkflowTool: false, knowledgeCollections, futureSetting: 2 };
      const file = parseSessionProfileManifest({ ...MANIFEST, settings });
      assert.deepEqual(file.manifest.settings, settings);
      assert.deepEqual(JSON.parse(serializeSessionProfileManifest(file)).settings, settings);
    }
  });

  it("keeps a plugin source it cannot read verbatim through a rewrite; reads it only at use", () => {
    const future = { type: "npm", package: "@x/y", copiedAt: "t" };
    const good = { type: "marketplace", marketplace: "official", copiedAt: "t", futureField: 1 };
    const file = parseSessionProfileManifest({
      ...MANIFEST,
      items: [
        { id: "p1", kind: "plugin", name: "a", agents: ["claude"], plugin: { source: future } },
        { id: "p2", kind: "plugin", name: "b", agents: ["claude"], plugin: { source: good } },
        { id: "p3", kind: "plugin", name: "c", agents: ["claude"], plugin: { source: "a string" } }
      ]
    });
    assert.deepEqual(file.items.map((entry) => entry.ok), [true, true, true]);
    const rewritten = JSON.parse(serializeSessionProfileManifest(file));
    assert.deepEqual(rewritten.items.map((item: { plugin: { source: unknown } }) => item.plugin.source), [future, good, "a string"]);
    const sources = file.items.map((entry) => (entry.ok && entry.record.kind === "plugin" ? readSessionProfilePluginSource(entry.record.plugin.source) : null));
    assert.deepEqual(sources, [undefined, good, undefined]);
  });

  it("throws on anything that is not a version-1 manifest", () => {
    assert.throws(() => parseSessionProfileManifest({ ...MANIFEST, version: 2 }), /version-1/);
    assert.throws(() => parseSessionProfileManifest({ ...MANIFEST, id: "../escape" }));
    assert.throws(() => parseSessionProfileManifest(null));
  });
});

describe("session profile secrets", () => {
  it("round-trips readable entries, unreadable ones and unknown keys", () => {
    const file = parseSessionProfileSecrets({
      version: 1,
      future: true,
      items: { m1: { env: { TOKEN: "s3cret" } }, m2: { env: { BAD: 5 } } }
    });
    assert.deepEqual(file.items, { m1: { env: { TOKEN: "s3cret" } } });
    assert.deepEqual(Object.keys(file.unreadable), ["m2"]);
    const again = JSON.parse(serializeSessionProfileSecrets(file));
    assert.equal(again.future, true);
    assert.deepEqual(again.items.m2, { env: { BAD: 5 } });
    assert.deepEqual(JSON.parse(serializeSessionProfileSecrets(emptySessionProfileSecrets())), { version: 1, items: {} });
  });

  it("never quotes a value when it throws", () => {
    assert.throws(
      () => parseSessionProfileSecrets({ version: 9, items: { m1: { env: { TOKEN: "s3cret" } } } }),
      (error: Error) => !error.message.includes("s3cret")
    );
  });
});

describe("deleted profile names", () => {
  it("round-trips readable entries, unreadable ones and unknown keys; refuses another version", () => {
    const file = parseSessionProfileDeleted({
      version: 1,
      future: true,
      profiles: { p1: { name: "Developer", deletedAt: "2026-10-18T00:00:00.000Z", extra: 1 }, p2: { name: "" } }
    });
    assert.equal(file.profiles.p1?.name, "Developer");
    assert.deepEqual(Object.keys(file.unreadable), ["p2"]);
    const again = JSON.parse(serializeSessionProfileDeleted(file));
    assert.equal(again.future, true);
    assert.equal(again.profiles.p1.extra, 1);
    assert.deepEqual(again.profiles.p2, { name: "" });
    assert.deepEqual(JSON.parse(serializeSessionProfileDeleted(emptySessionProfileDeleted())), { version: 1, profiles: {} });
    assert.throws(() => parseSessionProfileDeleted({ version: 2, profiles: {} }));
    assert.equal(sessionProfileDeletedFile("/app"), "/app/daemon/session-profiles/deleted.json");
  });
});

describe("session profile paths", () => {
  it("lays the profiles, prepared and staging dirs under <appdir>/daemon/session-profiles", () => {
    assert.equal(sessionProfilesDir("/app"), "/app/daemon/session-profiles");
    assert.equal(sessionProfileDir("/app", "p1"), "/app/daemon/session-profiles/profiles/p1");
    assert.equal(
      sessionProfilePreparedKeyDir("/app", "p1", "grok", SESSION_PROFILE_SHARED_ACCOUNT_KEY),
      "/app/daemon/session-profiles/prepared/p1/grok/shared"
    );
    assert.equal(
      sessionProfilePreparedDir("/app", "p1", "codex", "acc-1", "v-0123456789ab-k1-deadbeef"),
      "/app/daemon/session-profiles/prepared/p1/codex/acc-1/v-0123456789ab-k1-deadbeef"
    );
    assert.throws(() => sessionProfilePreparedDir("/app", "p1", "codex", "acc-1", ".."));
    assert.equal(sessionProfileStagingDir("/app"), "/app/daemon/session-profiles/staging");
  });

  it("keys the system identity as `system` and refuses unsafe segments", () => {
    assert.equal(sessionProfileAccountKey(undefined), "system");
    assert.equal(sessionProfileAccountKey(""), "system");
    assert.equal(sessionProfileAccountKey("system"), "system");
    assert.equal(sessionProfileAccountKey("2b0c-uuid"), "2b0c-uuid");
    for (const bad of ["", ".", "..", "../x", "a/b", ".hidden", "a..b"]) {
      assert.throws(() => assertSessionProfileSegment(bad), bad);
    }
    assert.throws(() => sessionProfileDir("/app", "../../etc"));
  });
});

describe("profileId on persisted chat records", () => {
  it("keeps a profileId on the tab's chat block and drops one that does not read", () => {
    const base = { threadId: "t", accountId: "", home: "system" };
    assert.equal(sessionChatRecordSchema.parse({ ...base, profileId: "p1" }).profileId, "p1");
    assert.equal(sessionChatRecordSchema.parse({ ...base, profileId: 5 }).profileId, undefined);
    assert.equal(sessionChatRecordSchema.parse(base).profileId, undefined);
  });

  it("keeps a profileId on the thread head (the schema strips unknown keys)", () => {
    const head = {
      id: "t",
      projectPath: "/p",
      cwd: "/p",
      title: "x",
      adapter: "claude",
      refId: "claude",
      accountId: "",
      home: "system",
      modelSelection: { model: "m" },
      runtimeMode: "auto",
      session: { status: "idle" },
      createdAt: "t",
      updatedAt: "t"
    };
    assert.equal(agentThreadHeadSchema.parse({ ...head, profileId: "p1" }).profileId, "p1");
    assert.equal(agentThreadHeadSchema.parse({ ...head, profileId: "" }).profileId, undefined);
    assert.equal(agentThreadHeadSchema.parse(head).profileId, undefined);
  });
});
