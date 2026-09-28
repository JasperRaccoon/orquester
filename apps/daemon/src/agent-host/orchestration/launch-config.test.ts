import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createFileLaunchConfigStore,
  parseThreadLaunchConfig
} from "./launch-config.ts";

describe("thread launch config (§3.1, §6.1)", () => {
  it("keeps only well-formed fields and drops the empty ones", () => {
    assert.deepEqual(
      parseThreadLaunchConfig({
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok", BAD: 7, "": "x" },
        unsetEnv: ["ANTHROPIC_API_KEY", 42],
        homePath: "/home/acc",
        proxyRefId: "claudex",
        extra: "ignored"
      }),
      {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/acc",
        proxyRefId: "claudex"
      }
    );
    assert.deepEqual(parseThreadLaunchConfig({ launchEnv: {}, unsetEnv: [] }), {});
    assert.equal(parseThreadLaunchConfig("nope"), null);
    assert.equal(parseThreadLaunchConfig(null), null);
  });

  it("round-trips through a 0600 file and survives a reread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "launch-config-"));
    try {
      const store = createFileLaunchConfigStore({ rootDir: dir });
      assert.equal(await store.load("t1"), null, "a thread with no file has no config");

      await store.save("t1", {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/proxy",
        proxyRefId: "claudex"
      });
      const path = join(dir, "threads", "t1", "launch.json");
      // It carries the proxy token, so it is as sensitive as the appdir.
      assert.equal((await stat(path)).mode & 0o777, 0o600);

      const reread = createFileLaunchConfigStore({ rootDir: dir });
      assert.deepEqual(await reread.load("t1"), {
        launchEnv: { ANTHROPIC_AUTH_TOKEN: "tok" },
        unsetEnv: ["ANTHROPIC_API_KEY"],
        homePath: "/home/proxy",
        proxyRefId: "claudex"
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
