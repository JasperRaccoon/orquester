import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  PREPARED_MANIFEST_FILE,
  PreparedManifestError,
  parsePreparedManifest,
  readPreparedManifest,
  writePreparedManifest,
  type PreparedManifest
} from "./manifest.ts";
import { preparerFor, sessionProfilePreparers } from "./preparer.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const MANIFEST: PreparedManifest = {
  schema: 1,
  profileId: "p1",
  revision: "4",
  agent: "codex",
  accountKey: "acc-1",
  preparedAt: "2026-10-18T12:00:00.000Z",
  agentSection: { codexHome: "/x", future: [1] }
};

describe("prepared manifest", () => {
  it("round-trips through the file, 0600, unknown fields kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-prepared-"));
    roots.push(dir);
    await writePreparedManifest(dir, { ...MANIFEST, futureEnvelope: true } as PreparedManifest);
    assert.equal((await stat(join(dir, PREPARED_MANIFEST_FILE))).mode & 0o777, 0o600);
    const read = await readPreparedManifest(dir, { profileId: "p1", revision: "4", agent: "codex" });
    assert.equal(read.agent, "codex");
    assert.deepEqual(read.agentSection, { codexHome: "/x", future: [1] });
    assert.equal((read as Record<string, unknown>).futureEnvelope, true);
    assert.ok(!(await readFile(join(dir, PREPARED_MANIFEST_FILE), "utf8")).includes(".tmp"));
  });

  it("fails a launch whose prepared dir is missing, unreadable, or for another profile, revision or agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-prepared-"));
    roots.push(dir);
    const expected = { profileId: "p1", revision: "4", agent: "codex" as const };
    await assert.rejects(readPreparedManifest(dir, expected), PreparedManifestError);
    await writeFile(join(dir, PREPARED_MANIFEST_FILE), "{nope");
    await assert.rejects(readPreparedManifest(dir, expected), /not valid JSON/);
    await writePreparedManifest(dir, MANIFEST);
    await assert.rejects(readPreparedManifest(dir, { ...expected, revision: "5" }), /another version/);
    await assert.rejects(readPreparedManifest(dir, { ...expected, profileId: "p2" }), /another version/);
    await assert.rejects(readPreparedManifest(dir, { ...expected, agent: "grok" }), /for codex, not grok/);
  });

  it("refuses an unknown schema or agent", () => {
    assert.throws(() => parsePreparedManifest({ ...MANIFEST, schema: 2 }), PreparedManifestError);
    assert.throws(() => parsePreparedManifest({ ...MANIFEST, agent: "cursor" }), PreparedManifestError);
    assert.throws(() => parsePreparedManifest({ ...MANIFEST, agentSection: "x" }), PreparedManifestError);
  });
});

describe("preparer registry", () => {
  it("has one slot per agent, each empty or that agent's preparer", () => {
    assert.deepEqual(Object.keys(sessionProfilePreparers).sort(), ["claude", "codex", "grok", "opencode"]);
    for (const agent of ["claude", "codex", "grok", "opencode"] as const) {
      const preparer = preparerFor(agent);
      assert.ok(preparer === null || preparer.agent === agent, agent);
    }
  });
});
