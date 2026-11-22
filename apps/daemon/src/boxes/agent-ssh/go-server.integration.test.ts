/**
 * Agent SSH Phase 2 against the real `orq-agent` (built from apps/box-agent with Go, its built-in
 * SSH server on `ssh` channels) dialling a hub on a loopback port; the "box" is this machine. Plain
 * `ssh -F <conf> orq-<name>` must log in with the chat's key pushed by `ssh.keys` and the host key
 * pinned from hello. Skipped when Go is not installed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { managedSshConfigPath } from "@orquester/config";

import type { BoxAgentBuilds } from "../hub/builds.ts";
import { createBoxHub } from "../hub/hub.ts";
import { MemoryRecords, buildTestAgent, startHubServer } from "../hub/test-helpers.ts";
import { AgentSsh } from "./index.ts";

const BOX_ID = "box-ssh-000001";

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Phase 2 with the real orq-agent: ssh -F <conf> orq-<name> runs a command through its built-in server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-agent-ssh-go-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentBin = join(root, "bin", "orq-agent");
  await mkdir(join(root, "bin"));
  if (!(await buildTestAgent(agentBin, "ssh-it-1"))) return t.skip("Go toolchain not installed");

  const records = new MemoryRecords();
  records.add(BOX_ID, { state: "ready", threadId: "t-1", deadlineAt: null, project: null });
  const builds: BoxAgentBuilds = { current: async () => ({ version: "ssh-it-1" }), resolve: async () => null };
  const hub = createBoxHub({ appdir: root, records, verifyGithubOidc: async () => ({ ok: false, message: "unused" }), daemonUrls: () => [], builds, relay: false });
  const server = await startHubServer(hub);
  t.after(async () => {
    await hub.close();
    await server.app.close();
  });
  const tokenFile = join(root, "bootstrap-token");
  await writeFile(tokenFile, await hub.issueBootstrapToken(BOX_ID, 10 * 60_000), { mode: 0o600 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ORQ_")));
  // SHELL: the server runs commands with the login shell, and this host's service user may have none.
  const agent = spawn(agentBin, ["run"], {
    env: { ...inherited, ORQ_DAEMON_URL: server.url, ORQ_BOOTSTRAP_TOKEN_FILE: tokenFile, ORQ_DATA_DIR: join(root, "agent-data"), SHELL: "/bin/sh" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  t.after(() => void agent.kill("SIGKILL"));
  const connection = await hub.waitConnected(BOX_ID, { timeoutMs: 120_000 });
  assert.ok(connection.capabilities?.includes("ssh-server"), "this orq-agent build serves ssh channels");

  const home = join(root, "home");
  await mkdir(home);
  const registry = {
    get: (boxId: string) => records.get(boxId),
    list: () => [...records.records.values()],
    onChange: () => () => undefined,
    locate: () => ({ kind: "host" as const })
  };
  const agentSsh = new AgentSsh({
    baseDir: join(root, "appdir"),
    home,
    hub,
    registry: registry as unknown as ConstructorParameters<typeof AgentSsh>[0]["registry"],
    chats: { isOpen: () => true, projectPath: () => null },
    includeSetting: async () => false
  });
  t.after(() => agentSsh.stop());
  await agentSsh.start();
  const info = await agentSsh.settled("t-1", BOX_ID);
  assert.equal(info?.alias, `orq-${BOX_ID}`);

  const ssh = await run("ssh", ["-F", managedSshConfigPath(home, BOX_ID), "-o", "BatchMode=yes", `orq-${BOX_ID}`, "echo hello-$((1+1))"]);
  assert.deepEqual({ code: ssh.code, stdout: ssh.stdout }, { code: 0, stdout: "hello-2\n" }, ssh.stderr);
});
