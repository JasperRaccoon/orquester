import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CODEX_STATE_DB_FILE } from "../../agent-isolation/index.ts";
import { createProfileLaunchResolver } from "../launch.ts";
import type { SessionProfileReady } from "../lifecycle.ts";
import { writePreparedManifest } from "../manifest.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A published Codex version dir: its manifest and (unless `seeded: false`) its state DB. */
async function prepared(seeded = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-contribution-"));
  roots.push(root);
  const dir = join(root, "prepared", "p1", "codex", "acc-1", "v-1");
  await mkdir(dir, { recursive: true });
  await writePreparedManifest(dir, {
    schema: 1,
    profileId: "p1",
    revision: "7",
    agent: "codex",
    accountKey: "acc-1",
    preparedAt: "2026-10-18T00:00:00.000Z",
    agentSection: { stateDbFile: CODEX_STATE_DB_FILE }
  });
  if (seeded) await writeFile(join(dir, CODEX_STATE_DB_FILE), "");
  return dir;
}

function resolverFor(dir: string) {
  const ready: SessionProfileReady = { profileId: "p1", agent: "codex", accountKey: "acc-1", revision: "7", preparedDir: dir };
  return createProfileLaunchResolver({ lifecycle: { ensureReady: () => Promise.resolve(ready) } });
}

describe("Codex's launch contribution (the registry's)", () => {
  it("points CODEX_HOME and the resume home at the prepared home, over the account's launch", async () => {
    const dir = await prepared();
    const launch = await resolverFor(dir)({
      profileId: "p1",
      agent: "codex",
      accountId: "acc-1",
      projectPath: "/w/p",
      base: { launchEnv: { CODEX_HOME: "/homes/acc-1", PATH: "/bin" }, unsetEnv: ["OPENAI_API_KEY"], homePath: "/homes/acc-1" }
    });
    assert.deepEqual(launch.profile, { profileId: "p1", revision: "7", preparedDir: dir });
    assert.deepEqual(launch.fields, {
      launchEnv: { CODEX_HOME: dir, PATH: "/bin" },
      unsetEnv: ["OPENAI_API_KEY"],
      homePath: dir
    });
  });

  it("refuses an unseeded home: PROFILE_NOT_READY, never a launch", async () => {
    const dir = await prepared();
    await unlink(join(dir, CODEX_STATE_DB_FILE));
    await assert.rejects(
      resolverFor(dir)({ profileId: "p1", agent: "codex", accountId: "", projectPath: "", base: { launchEnv: {} } }),
      (error: unknown) => (error as { code?: string }).code === "PROFILE_NOT_READY" && /not seeded/.test(String((error as Error).message))
    );
  });
});
