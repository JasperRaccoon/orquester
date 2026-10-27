import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { localSysInfo } from "../../boxes/testing.ts";
import { createFileLaunchConfigStore, launchConfigFromRequest } from "../orchestration/launch-config.ts";
import { buildBoxProviderEnv } from "./box-env.ts";
import { joinBoxPath, mapHostValue, parseHostThreadBox } from "./launch-info.ts";

const WINDOWS = { kind: "windows-prefix", prefix: "C:\\orq" } as const;

function box(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boxId: "box-1",
    socketPath: "/appdir/daemon/boxes/sockets/box-1.sock",
    sys: localSysInfo({ os: "linux", home: "/root", agentPath: "/usr/local/bin/orq-agent" }),
    paths: { kind: "identity" },
    tooling: { pathPrepend: ["/var/lib/orq-agent/tools/bin"], env: { TSRS: "1" }, nodeRequire: ["/var/lib/orq-agent/preload.cjs"] },
    ...overrides
  };
}

test("a box launch field reads field-wise; one without its facts is refused", () => {
  const parsed = parseHostThreadBox(box());
  assert.equal(parsed?.boxId, "box-1");
  assert.deepEqual(parsed?.paths, { kind: "identity" });
  assert.deepEqual(parsed?.tooling.pathPrepend, ["/var/lib/orq-agent/tools/bin"]);
  assert.equal(parseHostThreadBox(box({ boxId: "../x" })), undefined);
  assert.equal(parseHostThreadBox(box({ sys: { os: "linux" } })), undefined);
  assert.equal(parseHostThreadBox(box({ paths: { kind: "future" } })), undefined);
  // A tooling block that does not read is no tooling, never a refusal.
  assert.deepEqual(parseHostThreadBox(box({ tooling: "nope" }))?.tooling, { pathPrepend: [], env: {}, nodeRequire: [] });
});

test("host paths map unchanged into a POSIX box and under C:\\orq into a Windows one", () => {
  assert.equal(mapHostValue({ kind: "identity" }, "/var/lib/orquester/x"), "/var/lib/orquester/x");
  assert.equal(mapHostValue(WINDOWS, "/var/lib/orquester/workspaces/w/p"), "C:\\orq\\var\\lib\\orquester\\workspaces\\w\\p");
  // A PATH-like list maps entry by entry, with the box's delimiter.
  assert.equal(mapHostValue(WINDOWS, "/a/bin:/b/bin"), "C:\\orq\\a\\bin;C:\\orq\\b\\bin");
  // Anything that is not an absolute path is not a path.
  assert.equal(mapHostValue(WINDOWS, "1"), "1");
  assert.equal(mapHostValue(WINDOWS, "https://example.com/x"), "https://example.com/x");
  assert.equal(joinBoxPath("win32", "C:\\Users\\box\\", ".local", "bin"), "C:\\Users\\box\\.local\\bin");
  assert.equal(joinBoxPath("linux", "/home/box", ".local/", "bin"), "/home/box/.local/bin");
});

test("launch.json keeps the box; one that no longer reads marks the config so the start fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "box-launch-config-"));
  const store = createFileLaunchConfigStore({ rootDir: root });
  const config = launchConfigFromRequest({ launchEnv: { A: "1" }, box: box() });
  assert.equal(config.box?.boxId, "box-1");
  await store.save("t1", config);
  const loaded = await store.load("t1");
  assert.equal(loaded?.box?.socketPath, "/appdir/daemon/boxes/sockets/box-1.sock");
  assert.equal(loaded?.boxUnreadable, undefined);
  // A field that is there but does not read is never "no box" (the CLI would run here instead).
  const broken = launchConfigFromRequest({ box: { boxId: "box-1" } });
  assert.equal(broken.box, undefined);
  assert.equal(broken.boxUnreadable, true);
  await store.save("t2", broken);
  assert.equal((await store.load("t2"))?.boxUnreadable, true);
  assert.match(await readFile(join(root, "threads", "t1", "launch.json"), "utf8"), /"boxId": "box-1"/);
});

test("the box env drops the host's own variables and credentials and applies the box's tooling", () => {
  const parsed = parseHostThreadBox(box())!;
  const { env, unset } = buildBoxProviderEnv({
    hostEnv: {
      PATH: "/host/bin",
      HOME: "/var/lib/orquester",
      TMPDIR: "/var/lib/orquester/tmp",
      NODE_OPTIONS: '--require "/var/lib/orquester/plugins/ts-rust/preload.cjs"',
      CLAUDE_CONFIG_DIR: "/var/lib/orquester/daemon/agent-accounts/claude/a1/home",
      ANTHROPIC_API_KEY: "sk-ant-host-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "host-token",
      ORQUESTER_SESSION_ID: "thread-1",
      ORQUESTER_AGENT_LAUNCH: "launch-1",
      CLAUDE_CODE_NO_FLICKER: "1"
    },
    adapter: "claude",
    box: parsed,
    boxPath: "/usr/local/bin:/usr/bin:/bin"
  });
  assert.equal(env.PATH, "/var/lib/orq-agent/tools/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.TMPDIR, undefined);
  assert.equal(env.NODE_OPTIONS, '--require "/var/lib/orq-agent/preload.cjs"');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/var/lib/orquester/daemon/agent-accounts/claude/a1/home");
  assert.equal(env.ORQUESTER_SESSION_ID, "thread-1");
  assert.equal(env.ORQUESTER_AGENT_LAUNCH, "launch-1");
  assert.equal(env.CLAUDE_CODE_NO_FLICKER, "1");
  assert.equal(env.TSRS, "1");
  assert.equal(env.DISABLE_AUTOUPDATER, "1", "plugins update on the host and sync down");
  // What the box's own agent environment may hold is removed too.
  assert.ok(unset.includes("ANTHROPIC_API_KEY"));
  assert.ok(unset.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.ok(!unset.includes("NODE_OPTIONS"));
});

test("a Windows box gets its Path in its own syntax, its homes mapped, and no host NODE_OPTIONS", () => {
  const parsed = parseHostThreadBox(
    box({
      sys: localSysInfo({ os: "win32", home: "C:\\Users\\box", agentPath: "C:\\orq\\agent\\orq-agent.exe" }),
      paths: WINDOWS,
      tooling: { pathPrepend: ["C:\\orq\\agent\\tools\\bin"], env: {}, nodeRequire: [] }
    })
  )!;
  const { env, unset } = buildBoxProviderEnv({
    hostEnv: { PATH: "/host/bin", NODE_OPTIONS: "--require /host/preload.cjs", CODEX_HOME: "/var/lib/orquester/daemon/agent-accounts/codex/a1/home" },
    adapter: "codex",
    box: parsed,
    boxPath: "C:\\Windows\\System32;C:\\Windows"
  });
  assert.equal(env.Path, "C:\\orq\\agent\\tools\\bin;C:\\Windows\\System32;C:\\Windows");
  assert.equal(env.PATH, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.CODEX_HOME, "C:\\orq\\var\\lib\\orquester\\daemon\\agent-accounts\\codex\\a1\\home");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DISABLE_AUTOUPDATER, undefined, "Claude's own switch only");
  assert.ok(unset.includes("NODE_OPTIONS"));
});
