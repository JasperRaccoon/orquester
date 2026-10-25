import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFileLaunchConfigStore, parseHostThreadProfile } from "./launch-config.ts";

describe("thread launch config (§3.1, §6.1)", () => {
  it("keeps only well-formed persisted fields and drops the empty ones", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "threads", "t1"), { recursive: true });
    const file = join(dir, "threads", "t1", "launch.json");
    const store = createFileLaunchConfigStore({ rootDir: dir });
    await writeFile(file, JSON.stringify({
      launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok", BAD: 7, "": "x" },
      unsetEnv: ["ANTHROPIC_API_KEY", 42],
      homePath: "/home/acc",
      proxyRefId: "claudex",
      extra: "ignored"
    }));
    assert.deepEqual(
      await store.load("t1"),
      {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/acc"
      }
    );
    await writeFile(file, '{"launchEnv":{},"unsetEnv":[]}');
    assert.deepEqual(await store.load("t1"), {});
    for (const malformed of ['"nope"', "null"]) {
      await writeFile(file, malformed);
      assert.equal(await store.load("t1"), null);
    }
  });

  it("round-trips through a 0600 file and survives a reread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    try {
      const store = createFileLaunchConfigStore({ rootDir: dir });
      assert.equal(await store.load("t1"), null, "a thread with no file has no config");

      await store.save("t1", {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/proxy"
      });
      const path = join(dir, "threads", "t1", "launch.json");
      // A launcher env can carry a credential, so it is as sensitive as the appdir.
      assert.equal((await stat(path)).mode & 0o777, 0o600);

      const reread = createFileLaunchConfigStore({ rootDir: dir });
      assert.deepEqual(await reread.load("t1"), {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/proxy"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to no launcher env on an unreadable file rather than failing the thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    try {
      await mkdir(join(dir, "threads", "t1"), { recursive: true });
      await writeFile(join(dir, "threads", "t1", "launch.json"), "{not json");
      const store = createFileLaunchConfigStore({ rootDir: dir });
      assert.equal(await store.load("t1"), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("thread launch config — the keyed provider server", () => {
  it("round-trips serverPool through a reread, so a restarted host restores the thread's key and env", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const serverPool = {
      key: "profile-a",
      env: { XDG_CONFIG_HOME: "/profiles/a/xdg", OPENCODE_CONFIG_DIR: "/profiles/a/opencode" },
      unsetEnv: ["OPENCODE_DISABLE_CLAUDE_CODE"]
    };
    await createFileLaunchConfigStore({ rootDir: dir }).save("t1", { launchEnv: { A: "1" }, serverPool });
    assert.deepEqual(await createFileLaunchConfigStore({ rootDir: dir }).load("t1"), { launchEnv: { A: "1" }, serverPool });
  });

  it("keeps a well-formed spec's valid entries and drops a spec without a key", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "threads", "t1"), { recursive: true });
    const file = join(dir, "threads", "t1", "launch.json");
    const store = createFileLaunchConfigStore({ rootDir: dir });
    await writeFile(file, JSON.stringify({
      serverPool: { key: "k", env: { GOOD: "v", BAD: 1, "": "x" }, unsetEnv: ["U", 3, ""], extra: true }
    }));
    assert.deepEqual(await store.load("t1"), { serverPool: { key: "k", env: { GOOD: "v" }, unsetEnv: ["U"] } });
    await writeFile(file, JSON.stringify({ serverPool: { key: "k", env: {}, unsetEnv: [] } }));
    assert.deepEqual(await store.load("t1"), { serverPool: { key: "k" } });
    for (const malformed of [{ env: { A: "1" } }, { key: "" }, { key: 7 }, "k", null]) {
      await writeFile(file, JSON.stringify({ homePath: "/h", serverPool: malformed }));
      assert.deepEqual(await store.load("t1"), { homePath: "/h" }, JSON.stringify(malformed));
    }
  });
});

describe("thread launch config — the Agent Profile", () => {
  const profile = { profileId: "p1", revision: "3", preparedDir: "/appdir/session-profiles/prepared/p1/codex/acc1" };

  it("round-trips profile beside launchEnv, homePath and serverPool, so a restarted host launches with it", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = {
      launchEnv: { CODEX_HOME: profile.preparedDir },
      homePath: "/homes/acc1",
      serverPool: { key: "profile-p1" },
      profile
    };
    await createFileLaunchConfigStore({ rootDir: dir }).save("t1", config);
    assert.deepEqual(await createFileLaunchConfigStore({ rootDir: dir }).load("t1"), config);
  });

  it("marks a profile that does not read as unreadable — never drops it to Global — and keeps the mark on a rewrite", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "threads", "t1"), { recursive: true });
    const file = join(dir, "threads", "t1", "launch.json");
    const store = createFileLaunchConfigStore({ rootDir: dir });
    for (const malformed of [
      { ...profile, preparedDir: "relative/dir" },
      { ...profile, revision: "" },
      { profileId: "p1" },
      "p1",
      7
    ]) {
      await writeFile(file, JSON.stringify({ homePath: "/h", profile: malformed }));
      const loaded = await store.load("t1");
      assert.deepEqual(loaded, { homePath: "/h", profileUnreadable: true }, JSON.stringify(malformed));
      // A rolled-back switch writes the loaded config back: the mark survives it.
      await store.save("t1", loaded!);
      assert.deepEqual(await store.load("t1"), { homePath: "/h", profileUnreadable: true });
    }
    await writeFile(file, JSON.stringify({ homePath: "/h", profile: null }));
    assert.deepEqual(await store.load("t1"), { homePath: "/h" }, "an explicit null is Global");
    await writeFile(file, JSON.stringify({ profile: { ...profile, extra: true } }));
    assert.deepEqual(await store.load("t1"), { profile }, "extra fields are dropped");
  });

  it("parseHostThreadProfile accepts exactly a profile id, a revision and an absolute directory", () => {
    assert.deepEqual(parseHostThreadProfile({ ...profile, more: 1 }), profile);
    for (const bad of [null, [], {}, { ...profile, profileId: "" }, { ...profile, preparedDir: "x" }, { ...profile, revision: 3 }]) {
      assert.equal(parseHostThreadProfile(bad), undefined, JSON.stringify(bad));
    }
  });
});
