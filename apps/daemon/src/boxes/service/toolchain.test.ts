import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { boxGitConfigCommands } from "./git-setup.ts";
import { gitClientScript, nodeScript, planToolchain, type ToolchainInput } from "./toolchain.ts";

function plan(files: Record<string, string>, extra: Partial<ToolchainInput> = {}) {
  return planToolchain({
    os: "linux",
    docker: false,
    projectDir: "/w/acme/app",
    present: new Set(Object.keys(files)),
    contents: files,
    ...extra
  });
}

test("a devcontainer with working Docker wins; without Docker the repo installs natively", () => {
  const files = { ".devcontainer/devcontainer.json": "{}", "package-lock.json": "{}" };
  const docker = plan(files, { docker: true });
  assert.equal(docker.mode, "devcontainer");
  assert.match(docker.commands[0]!.script, /npx -y @devcontainers\/cli up --workspace-folder '\/w\/acme\/app'/);
  const native = plan(files);
  assert.equal(native.mode, "native");
  assert.deepEqual(
    native.commands.map((command) => command.label),
    ["npm ci"]
  );
  assert.match(native.notes.join("\n"), /Docker does not work/);
});

test("version files go through mise, packageManager through corepack, then the lockfile's install", () => {
  const result = plan({
    ".nvmrc": "v20.11.1\n",
    ".python-version": "3.12.4\n",
    "go.mod": "module x\n\ngo 1.22\n\ntoolchain go1.22.5\n",
    "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }),
    "pnpm-lock.yaml": "",
    "uv.lock": "",
    "Cargo.toml": ""
  });
  assert.deepEqual(
    result.commands.map((command) => command.label),
    [
      "install mise",
      "mise use -g node@20.11.1 python@3.12.4 go@1.22.5",
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "cargo fetch",
      "go mod download"
    ]
  );
  for (const command of result.commands) assert.match(command.script, /^export PATH=/);
});

test("a repo's own mise config is trusted and installed; odd versions are ignored with a note", () => {
  const result = plan({ "mise.toml": "[tools]\nnode = '22'\n", ".node-version": "$(rm -rf /)\n" });
  assert.deepEqual(
    result.commands.map((command) => command.label),
    ["install mise", "mise install"]
  );
  assert.match(result.notes.join("\n"), /Ignored the version in \.node-version/);
});

test("nothing to do, and Windows, are reported as such", () => {
  assert.equal(plan({ "README.md": "" }).mode, "none");
  assert.equal(plan({ "package.json": "{}" }).notes[0], "package.json has no lockfile: skipped the JavaScript install.");
  assert.equal(plan({ "package-lock.json": "" }, { os: "win32" }).mode, "unsupported");
});

test("the box's git is SSH only: no credential helper, the daemon's known_hosts, the URL rewrites and the workspace identity", () => {
  const entries = [{ key: "url.git@github.com:.insteadOf", value: "https://github.com/" }];
  const commands = boxGitConfigCommands({
    os: "linux",
    knownHostsPath: "/root/.ssh/orquester_known_hosts",
    strictHostKeys: true,
    entries,
    identity: { name: "Octo Cat", email: "octo@example.com" }
  });
  assert.deepEqual(commands, [
    { args: ["config", "--global", "--unset-all", "credential.helper"], mayBeMissing: true },
    { args: ["config", "--global", "--add", "credential.helper", ""] },
    { args: ["config", "--global", "core.sshCommand", "ssh -o UserKnownHostsFile='/root/.ssh/orquester_known_hosts' -o StrictHostKeyChecking=yes"] },
    { args: ["config", "--global", "--unset-all", "url.git@github.com:.insteadOf"], mayBeMissing: true },
    { args: ["config", "--global", "--add", "url.git@github.com:.insteadOf", "https://github.com/"] },
    { args: ["config", "--global", "user.name", "Octo Cat"] },
    { args: ["config", "--global", "user.email", "octo@example.com"] }
  ]);
  assert.ok(!JSON.stringify(commands).includes("git-credential"), "no orq-agent credential helper");
  const windows = boxGitConfigCommands({ os: "win32", knownHostsPath: "C:\\Users\\a\\.ssh\\k", strictHostKeys: false, entries: [], identity: null });
  assert.equal(windows[2]!.args[3], 'ssh -o UserKnownHostsFile="C:/Users/a/.ssh/k" -o StrictHostKeyChecking=accept-new');
  assert.equal(windows.length, 3, "no rewrites and no identity without a git account");
});

/**
 * A PATH holding only stub commands: `id` reports `uid`, `sudo -n` runs its command, and `apt-get`
 * logs its calls and (unless `install` fails) puts `git` and `ssh` on the PATH.
 */
async function gitStubs(t: TestContext, options: { uid: number; sudo: boolean; aptGet: boolean; installFails?: boolean }): Promise<{ bin: string; log: string }> {
  const bin = await mkdtemp(join(tmpdir(), "orq-git-stubs-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const log = join(bin, "calls.log");
  const stub = async (name: string, body: string): Promise<void> => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await symlink("/usr/bin/env", join(bin, "env"));
  await stub("true", "exit 0");
  await stub("id", `echo ${options.uid}`);
  if (options.sudo) await stub("sudo", '[ "$1" = -n ] && shift; exec "$@"');
  if (options.aptGet) {
    // A successful install drops `git` and `ssh` stubs next to it, as a real one puts them on PATH.
    const install = options.installFails ? "exit 100" : `for tool in git ssh; do /usr/bin/printf '#!/bin/sh\\n' > "${bin}/$tool"; /usr/bin/chmod 755 "${bin}/$tool"; done`;
    await stub("apt-get", `echo "apt-get $*" >> "${log}"\n[ "$1" = install ] || exit 0\n${install}`);
  }
  return { bin, log };
}

function runGitClientScript(bin: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", gitClientScript()], { env: { PATH: bin } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

test("git and ssh missing: root installs them with apt (no recommends) and the script succeeds", async (t) => {
  const { bin, log } = await gitStubs(t, { uid: 0, sudo: false, aptGet: true });
  const { code, out } = await runGitClientScript(bin);
  assert.equal(code, 0, out);
  assert.match(out, /Installing git and the SSH client/);
  assert.match(await readFile(log, "utf8"), /^apt-get install -y -q --no-install-recommends git openssh-client$/m);
});

test("a non-root user installs git through sudo -n; without sudo the script says why it cannot", async (t) => {
  const withSudo = await gitStubs(t, { uid: 1000, sudo: true, aptGet: true });
  assert.equal((await runGitClientScript(withSudo.bin)).code, 0);
  const without = await gitStubs(t, { uid: 1000, sudo: false, aptGet: true });
  const { code, out } = await runGitClientScript(without.bin);
  assert.equal(code, 1);
  assert.match(out, /no root access/);
});

test("a failed install refreshes the package lists, retries, then fails with a message; no package manager fails too", async (t) => {
  const failing = await gitStubs(t, { uid: 0, sudo: false, aptGet: true, installFails: true });
  const failed = await runGitClientScript(failing.bin);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /Installing git and the SSH client failed/);
  assert.deepEqual((await readFile(failing.log, "utf8")).trim().split("\n").map((line) => line.split(" ")[1]), ["install", "update", "install"]);
  const none = await gitStubs(t, { uid: 0, sudo: false, aptGet: false });
  const missing = await runGitClientScript(none.bin);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no known package manager/);
});

/**
 * A home and a PATH of stubs for {@link nodeScript}: `grep`, and `mise` (logging its calls), whose
 * `use -g node@lts` puts `node` and `npm` stubs in its shims dir. `node: true` puts them on PATH first.
 */
async function nodeStubs(t: TestContext, options: { node: boolean; miseFails?: boolean }): Promise<{ home: string; bin: string; log: string }> {
  const home = await mkdtemp(join(tmpdir(), "orq-node-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "stubs");
  await mkdir(bin);
  const log = join(home, "mise.log");
  const stub = async (dir: string, name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(dir, name), 0o755);
  };
  await symlink("/bin/grep", join(bin, "grep"));
  const shims = join(home, ".local", "share", "mise", "shims");
  const install = options.miseFails
    ? "exit 1"
    : `/bin/mkdir -p "${shims}"; for tool in node npm; do /usr/bin/printf '#!/bin/sh\\n' > "${shims}/$tool"; /bin/chmod 755 "${shims}/$tool"; done`;
  await stub(bin, "mise", `echo "mise $*" >> "${log}"\n${install}`);
  if (options.node) for (const tool of ["node", "npm"]) await stub(bin, tool, "exit 0");
  return { home, bin, log };
}

function runNodeScript(home: string, bin: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", nodeScript()], { env: { HOME: home, PATH: bin } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

test("Node.js already on PATH: the node script changes nothing", async (t) => {
  const { home, bin, log } = await nodeStubs(t, { node: true });
  const { code, out } = await runNodeScript(home, bin);
  assert.equal(code, 0, out);
  assert.match(out, /Node\.js is installed/);
  await assert.rejects(readFile(log, "utf8"), "mise is never called");
  await assert.rejects(readFile(join(home, ".profile"), "utf8"));
});

test("no Node.js: mise installs the LTS globally and the profiles get its shims and npm's global bin, once", async (t) => {
  const { home, bin, log } = await nodeStubs(t, { node: false });
  const first = await runNodeScript(home, bin);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Installing Node\.js LTS with mise/);
  assert.equal(await readFile(log, "utf8"), "mise use -g node@lts\n");
  // A second run finds the shims and leaves the profiles as they are.
  assert.equal((await runNodeScript(home, bin)).code, 0);
  for (const file of [".profile", ".bashrc", ".zshrc"]) {
    const profile = await readFile(join(home, file), "utf8");
    assert.equal(profile.match(/\.local\/share\/mise\/shims/g)?.length, 1, file);
    assert.equal(profile.match(/\.npm-global\/bin/g)?.length, 1, file);
  }
});

test("a failed Node.js install fails the node script", async (t) => {
  const { home, bin } = await nodeStubs(t, { node: false, miseFails: true });
  assert.notEqual((await runNodeScript(home, bin)).code, 0);
});
