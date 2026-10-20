import assert from "node:assert/strict";
import test from "node:test";

import { boxGitConfigCommands } from "./git-setup.ts";
import { planToolchain, type ToolchainInput } from "./toolchain.ts";

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
