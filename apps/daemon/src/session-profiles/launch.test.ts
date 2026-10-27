import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { SessionProfileAgentId } from "@orquester/api";

import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import {
  applyProfileContribution,
  createProfileLaunchResolver,
  type ProfileLaunchContext,
  type ProfileLaunchContributors,
  SessionProfileNames
} from "./launch.ts";
import { writePreparedManifest } from "./manifest.ts";
import type { SessionProfileReady } from "./lifecycle.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function preparedDir(agent: SessionProfileAgentId, section: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-launch-"));
  roots.push(dir);
  await writePreparedManifest(dir, {
    schema: 1,
    profileId: "p1",
    revision: "7",
    agent,
    accountKey: "acc-1",
    preparedAt: "2026-10-18T00:00:00.000Z",
    agentSection: section
  } as never);
  return dir;
}

function fakeLifecycle(answer: (profileId: string, agent: SessionProfileAgentId, accountId: string | null) => SessionProfileReady | Error) {
  const calls: Array<[string, SessionProfileAgentId, string | null]> = [];
  return {
    calls,
    ensureReady: async (profileId: string, agent: SessionProfileAgentId, accountId: string | null) => {
      calls.push([profileId, agent, accountId]);
      const result = answer(profileId, agent, accountId);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

const none = (): object => ({});
const contributors = (codex: ProfileLaunchContributors["codex"]): ProfileLaunchContributors => ({
  claude: none,
  codex,
  grok: none,
  opencode: none
});

describe("the per-agent launch contributions", () => {
  it("apply over the account's launch: env wins, unset merges, home follows the home variable, serverPool replaces", () => {
    const base = {
      launchEnv: { CODEX_HOME: "/homes/acc-1", A: "1", KEEP: "k" },
      unsetEnv: ["OPENAI_API_KEY", "B"],
      homePath: "/homes/acc-1",
      serverPool: { key: "account" }
    };
    const applied = applyProfileContribution(
      base,
      { env: { CODEX_HOME: "/prepared/p1", B: "2" }, unsetEnv: ["A"], serverPool: { key: "profile:p1", env: { X: "1" } } },
      "CODEX_HOME"
    );
    assert.deepEqual(applied, {
      launchEnv: { CODEX_HOME: "/prepared/p1", B: "2", KEEP: "k" },
      // B is the profile's now; A is removed.
      unsetEnv: ["OPENAI_API_KEY", "A"],
      homePath: "/prepared/p1",
      serverPool: { key: "profile:p1", env: { X: "1" } }
    });
    assert.deepEqual(base.launchEnv, { CODEX_HOME: "/homes/acc-1", A: "1", KEEP: "k" }, "the input is not modified");
    assert.equal(applyProfileContribution(base, { homePath: "/explicit" }, "CODEX_HOME").homePath, "/explicit");
    assert.deepEqual(applyProfileContribution(base, {}, "CODEX_HOME"), base, "nothing contributed = the account's launch");
  });
});

describe("createProfileLaunchResolver", () => {
  it("ensures the profile is ready for the agent and account, reads its section and applies the contribution", async () => {
    const dir = await preparedDir("codex", { codexHome: "/prepared/p1/home" });
    const lifecycle = fakeLifecycle(() => ({ profileId: "p1", agent: "codex", accountKey: "acc-1", revision: "7", preparedDir: dir }));
    const seen: ProfileLaunchContext<"codex">[] = [];
    const resolve = createProfileLaunchResolver({
      lifecycle,
      contributors: contributors((ctx) => {
        seen.push(ctx);
        return { env: { CODEX_HOME: String(ctx.manifestSection.codexHome) } };
      })
    });
    const resolved = await resolve({
      profileId: "p1",
      agent: "codex",
      accountId: "acc-1",
      projectPath: "/w/p",
      base: { launchEnv: { CODEX_HOME: "/homes/acc-1" }, homePath: "/homes/acc-1" }
    });
    assert.deepEqual(lifecycle.calls, [["p1", "codex", "acc-1"]]);
    assert.deepEqual(resolved.profile, { profileId: "p1", revision: "7", preparedDir: dir });
    assert.deepEqual(resolved.fields, { launchEnv: { CODEX_HOME: "/prepared/p1/home" }, homePath: "/prepared/p1/home" });
    assert.equal(seen[0]!.accountId, "acc-1");
    assert.equal(seen[0]!.accountHome, "/homes/acc-1");
    assert.equal(seen[0]!.projectPath, "/w/p");
    assert.deepEqual(seen[0]!.manifestSection, { codexHome: "/prepared/p1/home" });
  });

  it("asks the System account as null, and names its home through accountHome", async () => {
    const dir = await preparedDir("grok");
    const lifecycle = fakeLifecycle(() => ({ profileId: "p1", agent: "grok", accountKey: "system", revision: "7", preparedDir: dir }));
    let home: string | null | undefined;
    const resolve = createProfileLaunchResolver({
      lifecycle,
      accountHome: (agent, accountId) => (accountId === null ? `/system/${agent}` : null),
      contributors: { ...contributors(none), grok: (ctx) => ((home = ctx.accountHome), {}) }
    });
    await resolve({ profileId: "p1", agent: "grok", accountId: "", projectPath: "", base: { launchEnv: {} } });
    assert.deepEqual(lifecycle.calls, [["p1", "grok", null]]);
    assert.equal(home, "/system/grok");
  });

  it("passes the lifecycle's refusals through and turns a bad manifest or a failing contributor into PROFILE_NOT_READY", async () => {
    const base = { launchEnv: {} };
    for (const error of [
      sessionProfileErrors.notFound("p1"),
      sessionProfileErrors.notReady("Preparing Codex failed: boom"),
      sessionProfileErrors.unsupportedAgent("Codex")
    ]) {
      const resolve = createProfileLaunchResolver({ lifecycle: fakeLifecycle(() => error) });
      await assert.rejects(resolve({ profileId: "p1", agent: "codex", accountId: "a", projectPath: "", base }), error);
    }
    const missing = await mkdtemp(join(tmpdir(), "orq-launch-"));
    roots.push(missing);
    const noManifest = createProfileLaunchResolver({
      lifecycle: fakeLifecycle(() => ({ profileId: "p1", agent: "codex", accountKey: "a", revision: "7", preparedDir: missing }))
    });
    await assert.rejects(
      noManifest({ profileId: "p1", agent: "codex", accountId: "a", projectPath: "", base }),
      (error: unknown) => error instanceof SessionProfileError && error.code === "PROFILE_NOT_READY" && /manifest is missing/.test(error.message)
    );
    const dir = await preparedDir("codex");
    const throwing = createProfileLaunchResolver({
      lifecycle: fakeLifecycle(() => ({ profileId: "p1", agent: "codex", accountKey: "a", revision: "7", preparedDir: dir })),
      contributors: contributors(() => {
        throw new Error("no state DB");
      })
    });
    await assert.rejects(
      throwing({ profileId: "p1", agent: "codex", accountId: "a", projectPath: "", base }),
      (error: unknown) => error instanceof SessionProfileError && error.code === "PROFILE_NOT_READY" && /no state DB/.test(error.message)
    );
    const unknownAgent = createProfileLaunchResolver({ lifecycle: fakeLifecycle(() => new Error("never asked")) });
    await assert.rejects(
      unknownAgent({ profileId: "p1", agent: "pi", accountId: "", projectPath: "", base }),
      (error: unknown) => error instanceof SessionProfileError && error.code === "PROFILE_UNSUPPORTED_AGENT"
    );
  });
});

describe("SessionProfileNames", () => {
  it("liveIds: unknown until the first list lands, then the existing profiles (unreadable ones too), following creates and deletes", async () => {
    const events = new EventEmitter<{ changed: [{ profileId: string }]; deleted: [{ profileId: string }] }>();
    const names = new SessionProfileNames();
    let answer!: (value: { profiles: { id: string; name: string }[]; errors: { profileId: string }[] }) => void;
    const tracked = names.track({
      list: () => new Promise((resolve) => (answer = resolve)),
      events
    });
    assert.equal(names.liveIds(), undefined, "not listed yet: unknown, never none");
    events.emit("changed", { profileId: "p3" });
    events.emit("deleted", { profileId: "p2" });
    answer({ profiles: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }], errors: [{ profileId: "p-broken" }] });
    await tracked;
    assert.deepEqual(names.liveIds()?.sort(), ["p-broken", "p1", "p3"], "a list read older than the delete does not revive p2");
    events.emit("deleted", { profileId: "p1" });
    assert.deepEqual(names.liveIds()?.sort(), ["p-broken", "p3"]);
    events.emit("changed", { profileId: "p1" });
    assert.deepEqual(names.liveIds()?.sort(), ["p-broken", "p1", "p3"], "a recreated profile becomes live again");
  });

  it("liveIds stays unknown when the list cannot be read", async () => {
    const names = new SessionProfileNames();
    await names.track({ list: () => Promise.reject(new Error("EACCES")), events: new EventEmitter<{ changed: [{ profileId: string }]; deleted: [{ profileId: string }] }>() });
    assert.equal(names.liveIds(), undefined);
  });
});
