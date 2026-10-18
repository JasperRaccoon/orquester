import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { writePreparedManifest } from "../../session-profiles/manifest.ts";
import { loadProfileManifest, ProfileLaunchError } from "./profile-manifest.ts";

describe("loadProfileManifest — what an adapter launches a profile thread from", () => {
  it("answers null for a Global thread, without touching the disk", async () => {
    assert.equal(await loadProfileManifest({}, "codex"), null);
  });

  it("answers the agent's section of a matching manifest", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "profile-manifest-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writePreparedManifest(dir, {
      schema: 1,
      profileId: "p1",
      revision: "3",
      agent: "codex",
      accountKey: "acc1",
      preparedAt: "2026-10-18T00:00:00.000Z",
      agentSection: { codexHome: "/x" }
    });
    const profile = { profileId: "p1", revision: "3", preparedDir: dir };
    assert.deepEqual(await loadProfileManifest({ profile }, "codex"), { codexHome: "/x" });

    // Everything else FAILS the start with a message the thread shows — never Global.
    for (const [label, input, agent] of [
      ["another revision", { profile: { ...profile, revision: "4" } }, "codex"],
      ["another profile", { profile: { ...profile, profileId: "p2" } }, "codex"],
      ["another agent", { profile }, "grok"],
      ["no manifest", { profile: { ...profile, preparedDir: join(dir, "missing") } }, "codex"]
    ] as const) {
      await assert.rejects(
        () => loadProfileManifest(input, agent),
        (error: unknown) =>
          error instanceof ProfileLaunchError && /Agent Profile could not be loaded/.test(error.message),
        label
      );
    }
  });
});
