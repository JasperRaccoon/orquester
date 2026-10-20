import assert from "node:assert/strict";
import test from "node:test";

import { boxGitConfigCommands, cloneUrlHost } from "./git-setup.ts";
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

test("the box's git uses orq-agent for credentials, the daemon's known_hosts for SSH, and the workspace identity", () => {
  const commands = boxGitConfigCommands({
    os: "linux",
    agentPath: "/var/lib/orq-agent/orq-agent",
    knownHostsPath: "/root/.ssh/orquester_known_hosts",
    identity: { name: "Octo Cat", email: "octo@example.com" }
  });
  assert.deepEqual(commands, [
    ["config", "--global", "--unset-all", "credential.helper"],
    ["config", "--global", "--add", "credential.helper", ""],
    ["config", "--global", "--add", "credential.helper", "!'/var/lib/orq-agent/orq-agent' git-credential"],
    ["config", "--global", "credential.useHttpPath", "true"],
    ["config", "--global", "core.sshCommand", "ssh -o UserKnownHostsFile='/root/.ssh/orquester_known_hosts' -o StrictHostKeyChecking=accept-new"],
    ["config", "--global", "user.name", "Octo Cat"],
    ["config", "--global", "user.email", "octo@example.com"]
  ]);
  const windows = boxGitConfigCommands({ os: "win32", agentPath: "C:\\orq\\agent\\orq-agent.exe", knownHostsPath: "C:\\Users\\a\\.ssh\\k", identity: null });
  assert.equal(windows[2]![4], '!"C:/orq/agent/orq-agent.exe" git-credential');
  assert.equal(windows.length, 5, "no identity without a git account");
});

test("clone URL hosts", () => {
  assert.deepEqual(cloneUrlHost("git@github.com:acme/app.git"), { host: "github.com", port: null });
  assert.deepEqual(cloneUrlHost("ssh://git@bitbucket.example.com:7999/p/r.git"), { host: "bitbucket.example.com", port: 7999 });
  assert.deepEqual(cloneUrlHost("https://github.com/acme/app"), { host: "github.com", port: null });
  assert.equal(cloneUrlHost("/srv/repos/app.git"), null);
});
