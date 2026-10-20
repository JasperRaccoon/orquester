/**
 * Agent Profiles — what a Grok profile thread launches with (`profile-launch.ts`): `config.toml`
 * rendered before every spawn with fresh exclusion lists (symlinked, real and dangling Global
 * skills; every discovered plugin but the profile's own), `--no-leader` / `--plugin-dir` after the
 * `agent` subcommand, a start that fails when inspect fails, and Global starts unchanged — through
 * the real adapter and spawn path against the mock ACP peer, with a fake `grok inspect`.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { parse as parseToml } from "@decimalturn/toml-patch";

import type { RuntimeMode } from "@orquester/api/agent-chat";
import { GROK_PROFILE_ENV, GROK_USER_SKILL_ROOTS, type GrokPluginNamesResult } from "../../../agent-isolation/grok.ts";
import { localBoxConnection } from "../../../boxes/testing.ts";
import { createAgentHostBoxes } from "../../boxes/index.ts";
import { recordingSync, recordingTokens } from "../../boxes/testing.ts";
import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import { grokPreparer } from "../../../session-profiles/preparers/grok.ts";
import { GROK_FIXTURE_SECRETS, makeGrokProfileFixture } from "../../../session-profiles/preparers/grok.testing.ts";
import type { AdapterContext } from "../../adapter.ts";
import type { HostThreadProfile } from "../../host-protocol.ts";
import { ProfileLaunchError } from "../profile-manifest.ts";
import { boxGrokPluginNames } from "./box-launch.ts";
import { createGrokAdapter } from "./index.ts";
import { grokSpawnArgs } from "./launch.ts";
import { prepareGrokProfileSpawn, withAgentOptions } from "./profile-launch.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");
const INSPECT = fileURLToPath(new URL("../../../agent-isolation/testing/fake-grok-inspect.mjs", import.meta.url));

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** TOML read back as plain objects (the parser answers null-prototype ones). */
const readToml = async (path: string): Promise<Record<string, any>> => JSON.parse(JSON.stringify(parseToml(await readFile(path, "utf8"))));

/** A published prepared version of the fixture profile, with the manifest the daemon writes. */
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-grok-profile-launch-")));
  roots.push(root);
  const fixture = await makeGrokProfileFixture(root);
  const preparedDir = join(root, "appdir", "prepared", "p1", "grok", "shared", "v-1");
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const section = await grokPreparer.prepare(fixture.context({ stagingDir: preparedDir, preparedDir }));
  await writePreparedManifest(preparedDir, {
    schema: 1,
    profileId: "p1",
    revision: "4",
    agent: "grok",
    accountKey: "shared",
    preparedAt: "2026-10-18T00:00:00.000Z",
    agentSection: section
  });
  const profile: HostThreadProfile = { profileId: "p1", revision: "4", preparedDir };
  const accountHome = join(root, "account-home");
  await mkdir(accountHome);
  const env = { HOME: fixture.home, PATH: process.env.PATH ?? "", GROK_AUTH_PATH: join(accountHome, "auth.json") };
  return { root, fixture, preparedDir, profile, env, accountHome };
}

/** A `grok inspect` stand-in that reports `names` and records how it was run. */
function fakeInspect(names: string[]) {
  const calls: Array<{ env: Readonly<Record<string, string>>; cwd: string }> = [];
  const inspect = async (options: { env: Readonly<Record<string, string>>; cwd: string }): Promise<GrokPluginNamesResult> => {
    calls.push({ env: options.env, cwd: options.cwd });
    return await Promise.resolve({ ok: true, names });
  };
  return { calls, inspect };
}

describe("prepareGrokProfileSpawn", () => {
  it("answers null for a Global thread and touches nothing", async () => {
    const { inspect, calls } = fakeInspect([]);
    assert.equal(await prepareGrokProfileSpawn({ env: {}, command: "grok", inspect }), null);
    assert.equal(calls.length, 0);
  });

  it("renders config.toml with fresh exclusion lists and answers the env and the agent options", async () => {
    const { root, fixture, preparedDir, profile, env } = await setup();
    // A Global skill linked in AFTER the preparation: it must be listed at the spawn.
    await mkdir(join(root, "late-target"));
    await symlink(join(root, "late-target"), join(fixture.home, ".claude", "skills", "late-link"));
    const { inspect, calls } = fakeInspect(["superpowers", "toolbox", "orquester-profile-hooks", "hookify"]);
    const before = await stat(join(preparedDir, "config.toml"));

    const spawn = await prepareGrokProfileSpawn({ profile, env, command: "grok", inspect });

    assert.deepEqual(spawn, {
      env: { ...GROK_PROFILE_ENV, GROK_HOME: preparedDir },
      agentArgs: [
        "--no-leader",
        "--plugin-dir",
        join(preparedDir, "profile/plugins/pl1/toolbox"),
        "--plugin-dir",
        join(preparedDir, "profile/hooks-plugin/orquester-profile-hooks")
      ]
    });
    assert.equal((spawn.env as Record<string, string>).GROK_CLAUDE_SKILLS_ENABLED, undefined, "Claude skills compat stays on (the repo's .claude/skills)");
    // inspect ran under the profile home, with the home as cwd (no project layer).
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, preparedDir);
    assert.equal(calls[0].env.GROK_HOME, preparedDir);
    assert.equal(calls[0].env.GROK_CLAUDE_HOOKS_ENABLED, "false");

    const config = await readToml(join(preparedDir, "config.toml"));
    const skills = join(fixture.home, ".claude", "skills");
    assert.deepEqual(config.skills.ignore, [
      ...GROK_USER_SKILL_ROOTS,
      join(skills, "dangling"),
      join(skills, "late-link"),
      join(root, "late-target"),
      join(skills, "linked-one"),
      join(root, "shared-skills", "linked-one"),
      join(skills, "real-one"),
      join(preparedDir, "bundled", "skills")
    ]);
    assert.deepEqual(config.plugins, { disabled: ["superpowers", "hookify"] }, "every discovered plugin but the profile's own");
    assert.deepEqual(config.cli, { installer: "npm", auto_update: false, use_leader: false });
    assert.equal(config.compat.claude.skills, true);
    assert.equal(config.compat.claude.hooks, false);
    assert.deepEqual(config.ui, { permission_mode: "always-approve" }, "runtime settings carried over");
    assert.equal(config.mcp_servers.search.env.API_KEY, GROK_FIXTURE_SECRETS.env, "the profile's MCP servers");
    assert.equal(config.mcp_servers["global-one"], undefined, "never the Global ones");
    const after = await stat(join(preparedDir, "config.toml"));
    assert.equal(after.mode & 0o777, 0o600);
    assert.notEqual(after.ino, before.ino, "swapped in by rename");
    assert.deepEqual((await readdir(preparedDir)).filter((name) => name.endsWith(".tmp")), []);
  });

  it("regenerates over a config.toml the CLI rewrote", async () => {
    const { preparedDir, profile, env } = await setup();
    await writeFile(join(preparedDir, "config.toml"), "[cli]\nuse_leader = true\n[compat.claude]\nhooks = true\n");
    await prepareGrokProfileSpawn({ profile, env, command: "grok", inspect: fakeInspect([]).inspect });
    const config = await readToml(join(preparedDir, "config.toml"));
    assert.equal(config.cli.use_leader, false);
    assert.equal(config.compat.claude.hooks, false);
  });

  it("runs the real inspect path: the profile home as GROK_HOME and cwd", async () => {
    const { root, preparedDir, profile, env } = await setup();
    const bin = join(root, "grok");
    await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(INSPECT)} "$@"\n`);
    await chmod(bin, 0o755);
    await prepareGrokProfileSpawn({ profile, env, command: bin });
    // The fake reports $GROK_HOME and its cwd as plugin names: both the home.
    assert.deepEqual((await readToml(join(preparedDir, "config.toml"))).plugins, { disabled: [preparedDir] });
  });

  it("boxes: a box thread's inspect runs the box's grok in the box, under the profile home; the home is synced again", async () => {
    const { root, preparedDir, profile, env, accountHome } = await setup();
    // The box's own `grok` in `~/.local/bin` (its login PATH has none, nor does this machine's).
    const boxHome = join(root, "box-home");
    await mkdir(join(boxHome, ".local", "bin"), { recursive: true });
    await writeFile(join(boxHome, "sh"), '#!/bin/sh\nprintf "%s" "/usr/bin:/bin"\n');
    await chmod(join(boxHome, "sh"), 0o755);
    const boxGrok = join(boxHome, ".local", "bin", "grok");
    const script = (code: number) =>
      `#!/bin/sh\nprintf '{"plugins":[{"name":"in-box"},{"name":"%s"},{"name":"%s"},{"name":"toolbox"}]}' "$GROK_HOME" "$(pwd)"\nexit ${code}\n`;
    await writeFile(boxGrok, script(0));
    await chmod(boxGrok, 0o755);
    const connection = localBoxConnection({ sys: { home: boxHome, shell: join(boxHome, "sh"), agentPath: "/opt/orq-agent" } });
    const sync = recordingSync();
    const boxes = createAgentHostBoxes({
      appdir: join(root, "host-appdir"),
      connector: () => connection,
      tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
      sync,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    });
    const launch = await boxes.launch({
      threadId: "t1",
      agent: "grok",
      box: { boxId: connection.boxId, socketPath: "/nonexistent/relay.sock", sys: connection.sys, paths: connection.paths, tooling: { pathPrepend: [], env: {}, nodeRequire: [] } },
      home: { kind: "account", accountId: "acct-1", path: accountHome },
      cwd: root,
      profile
    });
    assert.equal(launch.bin, boxGrok);

    await prepareGrokProfileSpawn({ profile, env, command: launch.bin, inspect: boxGrokPluginNames(launch) });
    // The box's plugins, inspected with GROK_HOME and cwd the profile home (as the box knows it);
    // the profile's own stays enabled.
    assert.deepEqual((await readToml(join(preparedDir, "config.toml"))).plugins, { disabled: ["in-box", preparedDir] });
    await launch.syncProfile();
    assert.deepEqual(sync.calls.at(-1), { op: "ensureSynced", boxId: connection.boxId, detail: { agent: "grok", configRoots: [preparedDir], threadId: "t1" } });

    // A failing inspect in the box fails the start, as on this machine.
    await writeFile(boxGrok, script(3));
    await assert.rejects(
      prepareGrokProfileSpawn({ profile, env, command: launch.bin, inspect: boxGrokPluginNames(launch) }),
      (error: unknown) => error instanceof ProfileLaunchError && /grok inspect --json in the box exited with code 3/.test(error.message)
    );
    await launch.close();
  });

  it("fails the start when inspect fails, and leaves the config as it was", async () => {
    const { preparedDir, profile, env } = await setup();
    const before = await readFile(join(preparedDir, "config.toml"), "utf8");
    const inspect = async (): Promise<GrokPluginNamesResult> => await Promise.resolve({ ok: false, error: "grok inspect --json exit 1: boom" });
    await assert.rejects(
      prepareGrokProfileSpawn({ profile, env, command: "grok", inspect }),
      (error: unknown) => error instanceof ProfileLaunchError && /plugin list could not be read \(grok inspect --json exit 1: boom\)/.test(error.message)
    );
    assert.equal(await readFile(join(preparedDir, "config.toml"), "utf8"), before);
  });

  it("fails without the account's sign-in path, or with one inside the profile home", async () => {
    const { preparedDir, profile, env } = await setup();
    const { inspect } = fakeInspect([]);
    await assert.rejects(prepareGrokProfileSpawn({ profile, env: { ...env, GROK_AUTH_PATH: "" }, command: "grok", inspect }), /GROK_AUTH_PATH/);
    await assert.rejects(
      prepareGrokProfileSpawn({ profile, env: { ...env, GROK_AUTH_PATH: join(preparedDir, "auth.json") }, command: "grok", inspect }),
      /cannot live in the profile's home/
    );
  });

  it("fails when the prepared manifest names another revision", async () => {
    const { profile, env } = await setup();
    await assert.rejects(
      prepareGrokProfileSpawn({ profile: { ...profile, revision: "5" }, env, command: "grok", inspect: fakeInspect([]).inspect }),
      ProfileLaunchError
    );
  });

  it("serializes concurrent renders of one home", async () => {
    const { profile, env, preparedDir } = await setup();
    let running = 0;
    let overlapped = false;
    const gates: Array<() => void> = [];
    const inspect = async (): Promise<GrokPluginNamesResult> => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
      return { ok: true, names: ["x"] };
    };
    const first = prepareGrokProfileSpawn({ profile, env, command: "grok", inspect });
    const second = prepareGrokProfileSpawn({ profile, env, command: "grok", inspect });
    // Release whichever inspect is waiting, until both renders are done.
    const both = Promise.all([first, second]);
    let done = false;
    void both.then(() => (done = true));
    while (!done) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      gates.shift()?.();
    }
    await both;
    assert.equal(overlapped, false);
    assert.deepEqual((await readToml(join(preparedDir, "config.toml"))).plugins, { disabled: ["x"] });
  });
});

describe("withAgentOptions", () => {
  it("puts the options right after `agent` for every runtime mode", () => {
    const extra = ["--no-leader", "--plugin-dir", "/p"];
    const modes: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
    for (const mode of modes) {
      const args = withAgentOptions(grokSpawnArgs(mode), extra);
      const at = args.indexOf("agent");
      assert.deepEqual(args.slice(at + 1, at + 4), extra, mode);
      assert.equal(args.at(-1), "stdio", mode);
    }
    assert.deepEqual(withAgentOptions(["agent", "stdio"], []), ["agent", "stdio"]);
  });
});

/**
 * The adapter, through the real spawn path: a wrapper `grok` answers `inspect` itself and records
 * the ACP spawn's argv and env before handing over to the mock ACP peer.
 */
describe("Grok adapter — profile starts", () => {
  async function adapterRig(root: string, env: Record<string, string>, inspectExit = 0) {
    const record = join(root, "spawn-record");
    const bin = join(root, "grok-wrapper");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = inspect ]; then',
        `  printf '%s' '{"plugins":[{"name":"superpowers"},{"name":"toolbox"}]}'`,
        `  exit ${inspectExit}`,
        "fi",
        `printf '%s\\n' "$@" > ${JSON.stringify(`${record}.argv`)}`,
        `printf 'GROK_HOME=%s\\nGROK_AUTH_PATH=%s\\nGROK_CLAUDE_HOOKS_ENABLED=%s\\nGROK_CLAUDE_SKILLS_ENABLED=%s\\n' "$GROK_HOME" "$GROK_AUTH_PATH" "$GROK_CLAUDE_HOOKS_ENABLED" "$GROK_CLAUDE_SKILLS_ENABLED" > ${JSON.stringify(`${record}.env`)}`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK)} "$@"`,
        ""
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const controller = new AbortController();
    let ids = 0;
    const quiet = (): void => undefined;
    const context: AdapterContext = {
      logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
      clock: { now: () => new Date(0), nowIso: () => "2026-10-18T00:00:00.000Z" },
      ids: { eventId: () => `e${(ids += 1)}`, messageId: (prefix) => `${prefix}-${(ids += 1)}`, uuid: () => `u${(ids += 1)}` },
      resolveAttachmentPath: async () => await Promise.resolve(root),
      attachmentsDir: () => root,
      logRawFrame: () => undefined,
      buildEnv: () => ({ PATH: process.env.PATH ?? "", TMPDIR: root, GROK_MOCK_SCENARIO: "happy", ...env }),
      resolveBin: async () => await Promise.resolve(bin),
      sessionPath: () => process.env.PATH ?? "",
      tmpDir: () => root,
      signal: controller.signal
    };
    const adapter = await createGrokAdapter(context);
    const drain = (async () => {
      for await (const _event of adapter.events) {
        // consumed so the adapter's queue never grows
      }
    })();
    const stop = async (): Promise<void> => {
      controller.abort();
      await adapter.stopAll();
      await drain;
    };
    return {
      adapter,
      stop,
      argv: async () => (await readFile(`${record}.argv`, "utf8")).trim().split("\n"),
      env: async () => Object.fromEntries((await readFile(`${record}.env`, "utf8")).trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)))
    };
  }

  const startInput = (cwd: string, profile?: HostThreadProfile) => ({
    threadId: "t1",
    cwd,
    home: { kind: "system" as const, path: profile?.preparedDir ?? cwd },
    modelSelection: { model: "grok-4.6" },
    runtimeMode: "full-access" as const,
    ...(profile !== undefined ? { profile } : {})
  });

  it("a profile start spawns `agent --no-leader --plugin-dir … ` with the profile env, after rendering the config", async () => {
    const { root, profile, preparedDir, env } = await setup();
    const rig = await adapterRig(root, { ...env, GROK_HOME: preparedDir });
    try {
      await rig.adapter.startSession(startInput(root, profile));
      assert.deepEqual(await rig.argv(), [
        "agent",
        "--no-leader",
        "--plugin-dir",
        join(preparedDir, "profile/plugins/pl1/toolbox"),
        "--plugin-dir",
        join(preparedDir, "profile/hooks-plugin/orquester-profile-hooks"),
        "--always-approve",
        "stdio"
      ]);
      assert.deepEqual(await rig.env(), {
        GROK_HOME: preparedDir,
        GROK_AUTH_PATH: env.GROK_AUTH_PATH,
        GROK_CLAUDE_HOOKS_ENABLED: "false",
        GROK_CLAUDE_SKILLS_ENABLED: ""
      });
      assert.deepEqual((await readToml(join(preparedDir, "config.toml"))).plugins, { disabled: ["superpowers"] });
    } finally {
      await rig.stop();
    }
  });

  it("a profile start fails when inspect fails — the agent is never spawned", async () => {
    const { root, profile, preparedDir, env } = await setup();
    const rig = await adapterRig(root, { ...env, GROK_HOME: preparedDir }, 3);
    try {
      await assert.rejects(rig.adapter.startSession(startInput(root, profile)), /plugin list could not be read/);
      await assert.rejects(rig.argv(), /ENOENT/, "no ACP child was started");
      assert.equal(rig.adapter.hasSession("t1"), false);
    } finally {
      await rig.stop();
    }
  });

  it("a Global start is unchanged: the plain argv, no profile env, no inspect", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "orq-grok-global-")));
    roots.push(root);
    // An inspect would fail the start: a Global one must never run it.
    const rig = await adapterRig(root, { HOME: root }, 3);
    try {
      await rig.adapter.startSession(startInput(root));
      assert.deepEqual(await rig.argv(), ["agent", "--always-approve", "stdio"]);
      assert.deepEqual(await rig.env(), {
        GROK_HOME: "",
        GROK_AUTH_PATH: "",
        GROK_CLAUDE_HOOKS_ENABLED: "",
        GROK_CLAUDE_SKILLS_ENABLED: ""
      });
    } finally {
      await rig.stop();
    }
  });
});
