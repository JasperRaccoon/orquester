import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { localBoxConnection } from "../../boxes/testing.ts";
import { ensureBoxAgentCli } from "./box-tools.ts";
import { BoxLaunchError } from "./errors.ts";
import { createAgentHostBoxes } from "./index.ts";
import { recordingSync, recordingTokens } from "./testing.ts";

/**
 * A "box" with neither Node.js nor npm: its login PATH holds only stubs (with this machine's npm
 * out of reach), and its `mise` puts an `npm` in the shims dir (one whose `install` drops the CLI
 * under the prefix), or fails with `miseError`.
 */
async function boxWithoutNpm(t: TestContext, options: { miseError?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "box-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stubs = join(home, "stubs");
  const shims = join(home, ".local", "share", "mise", "shims");
  const miseBin = join(home, ".local", "bin");
  await mkdir(stubs);
  await mkdir(shims, { recursive: true });
  await mkdir(miseBin, { recursive: true });
  const log = join(home, "calls.log");
  await writeFile(log, "");
  const write = async (path: string, body: string): Promise<void> => {
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };
  await symlink("/bin/grep", join(stubs, "grep"));
  await symlink("/usr/bin/env", join(stubs, "env"));
  await write(join(home, "sh"), `printf "%s" "${stubs}"`);
  await write(join(stubs, "id"), "echo 0");
  await write(join(stubs, "apt-get"), `echo "apt-get $*" >> "${log}"`);
  await write(
    join(home, "npm-stub"),
    '[ "$1" = install ] || exit 0\n/bin/mkdir -p "$NPM_CONFIG_PREFIX/bin"\nprintf "#!/bin/sh\\n" > "$NPM_CONFIG_PREFIX/bin/codex"\n/bin/chmod +x "$NPM_CONFIG_PREFIX/bin/codex"'
  );
  const install = `/bin/cp "${join(home, "npm-stub")}" "${shims}/npm"; /bin/cp "${join(home, "npm-stub")}" "${shims}/node"`;
  await write(join(miseBin, "mise"), `echo "mise $*" >> "${log}"\n${options.miseError !== undefined ? `echo '${options.miseError}' >&2; exit 1` : install}`);
  const connection = localBoxConnection({ sys: { os: "linux", home, shell: join(home, "sh"), agentPath: "/opt/orq-agent" } });
  const exec = connection.exec.bind(connection);
  connection.exec = (exe) => {
    const path = exe.env?.PATH?.split(":").filter((dir) => dir !== "/usr/local/bin").join(":");
    return exec({ ...exe, env: { ...(exe.env ?? {}), HOME: home, ...(path !== undefined ? { PATH: path } : {}) } });
  };
  return { connection, log, path: `${stubs}:${shims}`, target: join(home, ".npm-global", "bin", "codex") };
}

test("a CLI that installs with npm, in a box without npm: Node.js goes in first, then the CLI", async (t) => {
  const box = await boxWithoutNpm(t);
  const progress: string[] = [];
  const found = await ensureBoxAgentCli(box.connection, "codex", { path: box.path, onProgress: (line) => progress.push(line) });
  assert.equal(found.bin, box.target);
  assert.equal(found.installed, true);
  const calls = await readFile(box.log, "utf8");
  assert.match(calls, /^mise use -g node@lts$/m);
  assert.doesNotMatch(calls, /apt-get/, "system packages are not asked for");
  assert.ok(progress.some((line) => /Node\.js/.test(line)));
});

test("a chat's launch in a box whose system is Orquester's to change: the Node.js install gets libatomic too", async (t) => {
  const box = await boxWithoutNpm(t);
  const boxes = createAgentHostBoxes({
    appdir: join(box.connection.sys.home, "appdir"),
    connector: () => box.connection,
    tokens: recordingTokens({ accessToken: "t", expiresAt: null }),
    sync: recordingSync(),
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  const launch = await boxes.launch({
    threadId: "t1",
    agent: "codex",
    box: {
      boxId: box.connection.boxId,
      socketPath: "/unused",
      sys: box.connection.sys,
      paths: box.connection.paths,
      tooling: { pathPrepend: [], env: {}, nodeRequire: [] },
      systemPackages: true
    },
    home: { kind: "account", accountId: "a", path: "/accounts/codex/a/home" },
    cwd: "/w/p"
  });
  assert.equal(launch.bin, box.target);
  assert.match(await readFile(box.log, "utf8"), /^apt-get install .*libatomic1$/m);
});

test("Node.js that cannot be installed is the chat's error, with its cause rather than npm's absence", async (t) => {
  const box = await boxWithoutNpm(t, { miseError: "node: error while loading shared libraries: libfoo.so.1" });
  await assert.rejects(
    ensureBoxAgentCli(box.connection, "codex", { path: box.path }),
    (error: unknown) =>
      error instanceof BoxLaunchError &&
      error.code === "BOX_CLI_INSTALL_FAILED" &&
      /installing Node\.js in the box failed/.test(error.message) &&
      /libfoo\.so\.1/.test(error.message) &&
      !/not found/.test(error.message)
  );
});
