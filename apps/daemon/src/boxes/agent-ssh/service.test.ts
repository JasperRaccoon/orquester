import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";

import { SSH_CONFIG_INCLUDE_LINE, agentChatThreadSshDir, managedSshConfigPath, managedSshKnownHostsPath, sshProxySocketPath, type StoredBox } from "@orquester/config";

import type { BoxConnection, ProjectLocation } from "../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../testing.ts";
import type { ProjectBoxForward } from "../temporary/project-forwards.ts";
import { AgentSsh, SSH_PROXY_HELPER_PATH } from "./index.ts";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyOfTheBuiltInServer0000000000000000";

function record(id: string, overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "temporary",
    kind: "linux",
    provider: "hetzner",
    name: `orq-${id}`,
    state: "ready",
    threadId: "t-1",
    deadlineAt: null,
    project: null,
    ...overrides
  } as StoredBox;
}

class Registry {
  readonly records = new Map<string, StoredBox>();
  private readonly listeners = new Set<(boxId: string) => void>();
  get = (boxId: string) => this.records.get(boxId);
  list = () => [...this.records.values()];
  onChange = (listener: (boxId: string) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  locate = (path: string): ProjectLocation => {
    const box = [...this.records.values()].find((candidate) => candidate.purpose === "project" && candidate.project?.path === path);
    return box ? { kind: "box", boxId: box.id, record: box, connection: undefined } : { kind: "host" };
  };
  set(box: StoredBox): void {
    this.records.set(box.id, box);
    for (const listener of this.listeners) listener(box.id);
  }
}

class Hub {
  readonly connections = new Map<string, BoxConnection>();
  private readonly listeners = new Set<(boxId: string, connected: boolean) => void>();
  get = (boxId: string) => this.connections.get(boxId);
  onConnectionChange = (listener: (boxId: string, connected: boolean) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

async function echoServer(t: test.TestContext): Promise<number> {
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** What ssh would run: the config's ProxyCommand, through `/bin/sh -c` with ssh's `%%` unescaped. */
async function throughProxyCommand(confPath: string, input: string): Promise<Run> {
  const line = (await readFile(confPath, "utf8")).split("\n").find((candidate) => candidate.trimStart().startsWith("ProxyCommand "));
  assert.ok(line, "the config has a ProxyCommand");
  return run("/bin/sh", ["-c", `exec ${line.trim().slice("ProxyCommand ".length).replace(/%%/g, "%")}`], input);
}

async function setup(t: test.TestContext, options: { include?: boolean; projectForwards?: ConstructorParameters<typeof AgentSsh>[0]["projectForwards"]; projectPath?: (threadId: string) => string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-agent-ssh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseDir = join(dir, "appdir");
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  const registry = new Registry();
  const hub = new Hub();
  const open = new Set(["t-1", "t-2"]);
  const agentSsh = new AgentSsh({
    baseDir,
    home,
    hub,
    registry,
    chats: { isOpen: (threadId) => open.has(threadId), projectPath: options.projectPath ?? (() => null) },
    includeSetting: async () => options.include ?? false,
    ...(options.projectForwards ? { projectForwards: options.projectForwards } : {}),
    sshdHostKeyFiles: [join(dir, "sshd", "ssh_host_ed25519_key.pub")]
  });
  t.after(() => agentSsh.stop());
  return { dir, baseDir, home, registry, hub, agentSsh, open };
}

function builtInServerBox(t: test.TestContext, boxId: string, dir: string, port: number): LocalBoxConnection {
  return localBoxConnection({ boxId, sys: { home: join(dir, `${boxId}-home`), user: "worker" }, capabilities: ["ssh-server"], sshHostKey: `${HOST_KEY} orq-agent`, sshServerPort: port });
}

const keysPushed = (connection: LocalBoxConnection) =>
  (connection.calls.filter((call) => call.method === "ssh.keys").at(-1)?.params as { keys: { comment: string; publicKey: string }[] } | undefined)?.keys ?? null;

test("Phase 2: a chat's ready box gets an alias whose ProxyCommand reaches orq-agent's server; destroying the box revokes it", async (t) => {
  const port = await echoServer(t);
  const { dir, baseDir, home, registry, hub, agentSsh } = await setup(t);
  const box = builtInServerBox(t, "b1", dir, port);
  hub.connections.set("b1", box);
  registry.set(record("b1"));
  await agentSsh.start();

  const info = await agentSsh.settled("t-1", "b1");
  const conf = managedSshConfigPath(home, "b1");
  assert.deepEqual(info, { alias: "orq-b1", command: `ssh -F ${conf} orq-b1` });
  // Only this chat's key, tagged; the host key from hello pinned under the alias; nothing written in the box.
  assert.deepEqual(keysPushed(box)?.map((key) => key.comment), ["orquester chat=t-1 box=b1"]);
  assert.equal(await readFile(managedSshKnownHostsPath(home), "utf8"), `orq-b1 ${HOST_KEY}\n`);
  assert.equal(existsSync(join(dir, "b1-home", ".ssh")), false);
  const keyPath = join(agentChatThreadSshDir(baseDir, "t-1"), "orq-b1");
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(agentChatThreadSshDir(baseDir, "t-1"))).mode & 0o777, 0o700);
  assert.match(await readFile(conf, "utf8"), /\n {2}HostKeyAlias orq-b1\n {2}StrictHostKeyChecking yes\n/);

  const through = await throughProxyCommand(conf, "SSH-2.0-test\r\n");
  assert.deepEqual(through, { code: 0, stdout: "SSH-2.0-test\r\n", stderr: "" });

  registry.set(record("b1", { state: "destroyed" }));
  assert.equal(await agentSsh.settled("t-1", "b1"), null);
  assert.equal(existsSync(conf), false);
  assert.equal(existsSync(keyPath), false);
  assert.equal(await readFile(managedSshKnownHostsPath(home), "utf8"), "");
  assert.deepEqual(keysPushed(box), []);
  const refused = await run(process.execPath, [SSH_PROXY_HELPER_PATH, sshProxySocketPath(baseDir), "orq-b1", "t-1"], "");
  assert.equal(refused.code, 255);
  assert.match(refused.stderr, /^orq-b1: orq-b1 is not a live Orquester alias/);
});

test("the proxy serves a chat only its own alias, and every chat a live machine-level alias until the registry drops it", async (t) => {
  const port = await echoServer(t);
  const { dir, baseDir, registry, hub, agentSsh } = await setup(t);
  hub.connections.set("b1", builtInServerBox(t, "b1", dir, port));
  hub.connections.set("m1", builtInServerBox(t, "m1", dir, port));
  registry.set(record("b1"));
  registry.set(record("m1", { purpose: "machine", provider: "byo", machineName: "Jasper", threadId: null }));
  await agentSsh.start();
  await agentSsh.syncMachines([{ machineId: "ts:jasper", boxId: "m1", alias: "jasper" }]);
  await agentSsh.settled("t-1", "b1");
  const socket = sshProxySocketPath(baseDir);
  const helper = (alias: string, threadId?: string) => run(process.execPath, [SSH_PROXY_HELPER_PATH, socket, alias, ...(threadId ? [threadId] : [])], "hello");

  assert.deepEqual(await helper("orq-b1", "t-1"), { code: 0, stdout: "hello", stderr: "" });
  const other = await helper("orq-b1", "t-2");
  assert.equal(other.code, 255);
  assert.match(other.stderr, /belongs to another chat/);
  assert.deepEqual(await helper("orq-jasper"), { code: 0, stdout: "hello", stderr: "" });
  assert.deepEqual(agentSsh.machineAlias("m1")?.alias, "orq-jasper");

  await agentSsh.syncMachines([]);
  const revoked = await helper("orq-jasper");
  assert.equal(revoked.code, 255);
  assert.match(revoked.stderr, /not a live Orquester alias/);
  (hub.connections.get("b1") as LocalBoxConnection).setConnected(false);
  const offline = await helper("orq-b1", "t-1");
  assert.equal(offline.code, 255);
  assert.match(offline.stderr, /offline/);
});

test("Phase 1: a lent machine's authorized_keys gets one tagged line beside the owner's; handing it back removes exactly that line", async (t) => {
  const { dir, home, registry, hub, agentSsh } = await setup(t);
  await mkdir(join(dir, "sshd"));
  await writeFile(join(dir, "sshd", "ssh_host_ed25519_key.pub"), `${HOST_KEY} root@jasper\n`);
  const machineHome = join(dir, "jasper-home");
  await mkdir(join(machineHome, ".ssh"), { recursive: true, mode: 0o700 });
  const owners = "# the owner's keys\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnersLaptopKey000000000000000000000000 me@laptop\n";
  const authorized = join(machineHome, ".ssh", "authorized_keys");
  await writeFile(authorized, owners, { mode: 0o600 });
  hub.connections.set("m1", localBoxConnection({ boxId: "m1", sys: { home: machineHome } }));
  const deadline = Date.now() + 2 * 3_600_000;
  const lent = record("m1", { provider: "byo", machineName: "Jasper PC", deadlineAt: new Date(deadline).toISOString() });
  registry.set(lent);
  await agentSsh.start();

  const info = await agentSsh.settled("t-1", "m1");
  assert.equal(info?.alias, "orq-jasper-pc");
  const lines = (await readFile(authorized, "utf8")).split("\n");
  assert.equal(lines.slice(0, 2).join("\n") + "\n", owners);
  assert.match(lines[2]!, /^expiry-time="\d{12}" ssh-ed25519 \S+ orquester chat=t-1 box=m1$/);
  assert.equal(await readFile(managedSshKnownHostsPath(home), "utf8"), `orq-jasper-pc ${HOST_KEY}\n`);

  registry.set({ ...lent, purpose: "machine", threadId: null, deadlineAt: null });
  assert.equal(await agentSsh.settled("t-1", "m1"), null);
  assert.equal(await readFile(authorized, "utf8"), owners);
  assert.equal(existsSync(managedSshConfigPath(home, "jasper-pc")), false);
});

test("a machine that was away when it was handed back loses its line at its next connect", async (t) => {
  const { dir, registry, hub, agentSsh } = await setup(t);
  await mkdir(join(dir, "sshd"));
  await writeFile(join(dir, "sshd", "ssh_host_ed25519_key.pub"), `${HOST_KEY}\n`);
  const machineHome = join(dir, "away-home");
  const machine = localBoxConnection({ boxId: "m2", sys: { home: machineHome } });
  hub.connections.set("m2", machine);
  const lent = record("m2", { provider: "byo", machineName: "away" });
  registry.set(lent);
  await agentSsh.start();
  await agentSsh.settled("t-1", "m2");
  const authorized = join(machineHome, ".ssh", "authorized_keys");
  assert.match(await readFile(authorized, "utf8"), /orquester chat=t-1 box=m2/);

  machine.setConnected(false);
  registry.set({ ...lent, purpose: "machine", threadId: null, state: "offline" });
  await agentSsh.settled("t-1", "m2");
  assert.match(await readFile(authorized, "utf8"), /orquester chat=t-1 box=m2/, "unreachable while away");
  machine.setConnected(true);
  registry.set({ ...lent, purpose: "machine", threadId: null, state: "ready" });
  await agentSsh.settled("t-1", "m2");
  assert.equal(await readFile(authorized, "utf8"), "");
});

test("a closed chat's aliases go, and so does its thread ssh dir", async (t) => {
  const port = await echoServer(t);
  const { dir, baseDir, home, registry, hub, agentSsh, open } = await setup(t);
  const box = builtInServerBox(t, "b1", dir, port);
  hub.connections.set("b1", box);
  registry.set(record("b1"));
  await agentSsh.start();
  assert.ok(await agentSsh.settled("t-1", "b1"));

  open.delete("t-1");
  await agentSsh.chatClosed("t-1");
  assert.equal(agentSsh.aliasFor("t-1", "b1"), null);
  assert.equal(existsSync(agentChatThreadSshDir(baseDir, "t-1")), false);
  assert.equal(existsSync(managedSshConfigPath(home, "b1")), false);
  assert.deepEqual(keysPushed(box), []);
});

test("the Include setting adds one line on top of ~/.ssh/config and removes exactly it, keeping the file's mode", async (t) => {
  const port = await echoServer(t);
  const { dir, home, registry, hub, agentSsh } = await setup(t);
  hub.connections.set("b1", builtInServerBox(t, "b1", dir, port));
  registry.set(record("b1"));
  const owner = "Host work\n  User me\n";
  await mkdir(join(home, ".ssh"), { mode: 0o700 });
  const config = join(home, ".ssh", "config");
  await writeFile(config, owner);
  await chmod(config, 0o640);
  await agentSsh.start();

  await agentSsh.setIncludeEnabled(true);
  assert.equal(await readFile(config, "utf8"), `${SSH_CONFIG_INCLUDE_LINE}\n${owner}`);
  assert.equal((await stat(config)).mode & 0o777, 0o640);
  assert.equal((await agentSsh.settled("t-1", "b1"))?.command, "ssh orq-b1");

  await agentSsh.setIncludeEnabled(false);
  assert.equal(await readFile(config, "utf8"), owner);
  assert.equal((await stat(config)).mode & 0o777, 0o640);
  assert.match(agentSsh.aliasFor("t-1", "b1")?.command ?? "", /^ssh -F /);

  await rm(config);
  await agentSsh.setIncludeEnabled(true);
  assert.equal(await readFile(config, "utf8"), `${SSH_CONFIG_INCLUDE_LINE}\n`);
  assert.equal((await stat(config)).mode & 0o777, 0o600);
});

test("after a restart a live alias keeps its name and key, served before its box reconnects", async (t) => {
  const port = await echoServer(t);
  const first = await setup(t);
  const box = builtInServerBox(t, "b1", first.dir, port);
  first.hub.connections.set("b1", box);
  first.registry.set(record("b1"));
  await first.agentSsh.start();
  await first.agentSsh.settled("t-1", "b1");
  const keyPath = join(agentChatThreadSshDir(first.baseDir, "t-1"), "orq-b1");
  const key = await readFile(keyPath, "utf8");
  await first.agentSsh.stop();

  const hub = new Hub();
  const again = new AgentSsh({
    baseDir: first.baseDir,
    home: first.home,
    hub,
    registry: first.registry,
    chats: { isOpen: () => true, projectPath: () => null },
    includeSetting: async () => false
  });
  t.after(() => again.stop());
  await again.start();
  assert.equal(again.aliasFor("t-1", "b1")?.alias, "orq-b1");
  assert.equal(await readFile(keyPath, "utf8"), key);
});

test("a box project's chat gets the alias in its own box, dialling a forward that goes through the same checks", async (t) => {
  const port = await echoServer(t);
  const forwards: { close(): Promise<void> }[] = [];
  const projectForwards = {
    async open(projectBoxId: string, _preferredPort: number, upstream: () => Promise<Duplex>): Promise<ProjectBoxForward> {
      const server = createServer({ allowHalfOpen: true }, (client) => {
        upstream().then(
          (stream) => {
            client.pipe(stream).pipe(client);
          },
          () => client.destroy()
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const forward = {
        projectBoxId,
        boxPort: (server.address() as AddressInfo).port,
        alive: async () => server.listening,
        close: () => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))
      };
      forwards.push(forward);
      return forward;
    }
  };
  t.after(() => Promise.all(forwards.map((forward) => forward.close())));
  const { dir, registry, hub, agentSsh, open } = await setup(t, { projectForwards, projectPath: () => "/work/app" });
  const projectHome = join(dir, "project-home");
  hub.connections.set("p1", localBoxConnection({ boxId: "p1", sys: { home: projectHome } }));
  registry.set(record("p1", { purpose: "project", threadId: null, project: { path: "/work/app" } as StoredBox["project"] }));
  hub.connections.set("b1", builtInServerBox(t, "b1", dir, port));
  registry.set(record("b1"));
  await agentSsh.start();

  const info = await agentSsh.settled("t-1", "b1");
  const boxConf = join(projectHome, ".ssh", "orquester", "b1.conf");
  assert.deepEqual(info, { alias: "orq-b1", command: `ssh -F ${boxConf} orq-b1` });
  const conf = await readFile(boxConf, "utf8");
  const forwardPort = Number(/\n {2}Port (\d+)\n/.exec(conf)?.[1]);
  assert.match(conf, /HostName 127\.0\.0\.1/);
  assert.equal((await stat(join(projectHome, ".ssh", "orquester", "keys", "orq-b1"))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(projectHome, ".ssh", "orquester", "known_hosts"), "utf8"), `orq-b1 ${HOST_KEY}\n`);
  const echoed = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ port: forwardPort, host: "127.0.0.1" }, () => socket.end("via the project box"));
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
  assert.equal(echoed, "via the project box");

  open.delete("t-1");
  await agentSsh.chatClosed("t-1");
  assert.equal(existsSync(boxConf), false);
  assert.equal(existsSync(join(projectHome, ".ssh", "orquester", "keys", "orq-b1")), false);
});

test("with a real sshd (Phase 1), plain ssh -F <conf> orq-<name> logs in with the chat's key and the pinned host key", { skip: !existsSync("/usr/sbin/sshd") && "no sshd on this host" }, async (t) => {
  const { dir, home, registry, hub, agentSsh } = await setup(t);
  const sshdDir = join(dir, "sshd");
  await mkdir(sshdDir);
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(sshdDir, "ssh_host_ed25519_key")], "");
  const machineHome = join(dir, "machine-home");
  const sshdPort = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  await writeFile(
    join(sshdDir, "sshd_config"),
    [
      "ListenAddress 127.0.0.1",
      `Port ${sshdPort}`,
      `HostKey ${join(sshdDir, "ssh_host_ed25519_key")}`,
      `AuthorizedKeysFile ${join(machineHome, ".ssh", "authorized_keys")}`,
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PidFile none",
      ""
    ].join("\n")
  );
  const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(sshdDir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => void sshd.kill());
  let log = "";
  await new Promise<void>((resolve, reject) => {
    sshd.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes("Server listening")) resolve();
    });
    sshd.once("exit", () => reject(new Error(`sshd exited: ${log}`)));
  });
  const machine = localBoxConnection({ boxId: "m1", sys: { home: machineHome } });
  const openTcp = machine.openTcp.bind(machine);
  machine.openTcp = (port: number, host?: string) => (port === 22 ? openTcp(sshdPort, "127.0.0.1") : openTcp(port, host));
  hub.connections.set("m1", machine);
  registry.set(record("m1", { provider: "byo", machineName: "sshd box", deadlineAt: new Date(Date.now() + 3_600_000).toISOString() }));
  await agentSsh.start();
  const info = await agentSsh.settled("t-1", "m1");
  assert.equal(info?.alias, "orq-sshd-box");

  await run("ssh", ["-F", managedSshConfigPath(home, "sshd-box"), "-o", "BatchMode=yes", "orq-sshd-box", "true"], "");
  assert.match(log, /Accepted publickey for \S+ from 127\.0\.0\.1/);
});
