import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lchown, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import type { BootstrapInput } from "../contracts.ts";
import { bootstrapSecondStage, buildBootstrap, byoPairingScript, normalizeDaemonUrl } from "./bootstrap.ts";

const TOKEN = "obt_test-TOKEN.value_0123456789abcdef";
// Split so secret scanners do not read the fake key as a real one.
const TS_KEY = "tskey-auth-" + "kTEST1CNTRL-0123456789abcdefABCDEF";
const BOX_ID = "box-0123456789ab";

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    boxId: BOX_ID,
    daemonUrl: "https://orq.example.com:8443/base/",
    bootstrapToken: TOKEN,
    tailscaleAuthKey: null,
    container: false,
    ...overrides
  };
}

function cloudInitScript(cloudInit: string): string {
  const cloud = parse(cloudInit) as { write_files: { path: string; encoding?: string; content: string }[] };
  const script = cloud.write_files.find((file) => file.path === "/var/lib/orq-agent/bootstrap.sh");
  assert.ok(script, "cloud-init carries the bootstrap script");
  return script.encoding === "b64" ? Buffer.from(script.content, "base64").toString("utf8") : script.content;
}

function has(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

test("validates its input before anything reaches a script", () => {
  assert.throws(() => buildBootstrap(input({ boxId: "x" })), /box id/);
  assert.throws(() => buildBootstrap(input({ bootstrapToken: "short" })), /token/);
  assert.throws(() => buildBootstrap(input({ bootstrapToken: `${TOKEN}'; rm -rf /` })), /token/);
  assert.throws(() => buildBootstrap(input({ tailscaleAuthKey: "tskey $(id)" })), /Tailscale/);
  assert.throws(() => normalizeDaemonUrl("http://orq.example.com"), /https/);
  assert.throws(() => normalizeDaemonUrl("https://user:pw@orq.example.com"), /credentials/);
  assert.throws(() => normalizeDaemonUrl("https://orq.example.com/?a=1"), /query/);
  for (const path of ["/;id;/path", "/&id/path", "/|id/path", "/(id)/path"]) {
    assert.throws(() => normalizeDaemonUrl(`https://orq.example.com${path}`), /characters/);
  }
  assert.equal(normalizeDaemonUrl("https://orq.example.com/base%3Bdata%26part%7Cname/"), "https://orq.example.com/base%3Bdata%26part%7Cname");
  assert.equal(normalizeDaemonUrl("https://orq.example.com/`name`"), "https://orq.example.com/%60name%60");
  assert.equal(normalizeDaemonUrl("https://orq.example.com:8443/base/"), "https://orq.example.com:8443/base");
  assert.equal(normalizeDaemonUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
});

test("bootstrap serialization keeps secrets out of argv and writes cloud-init secret files privately", () => {
  const boot = buildBootstrap(input({ tailscaleAuthKey: TS_KEY }));
  assert.ok(boot.containerCommand.every((arg) => !arg.includes(TOKEN) && !arg.includes(TS_KEY)));
  assert.equal(boot.env.ORQ_DAEMON_URL, "https://orq.example.com:8443/base");
  assert.equal(boot.env.ORQ_BOX_ID, BOX_ID);
  assert.equal(boot.env.ORQ_BOOTSTRAP_TOKEN, TOKEN);
  assert.equal(boot.env.ORQ_TAILSCALE_AUTHKEY, TS_KEY);
  const cloud = parse(boot.cloudInit) as { write_files: { content: string; permissions: string }[]; runcmd: string[][] };
  for (const secret of [TOKEN, TS_KEY]) {
    const file = cloud.write_files.find((candidate) => candidate.content === secret);
    assert.equal(file?.permissions, "0600");
  }
  const script = cloudInitScript(boot.cloudInit);
  assert.ok(!script.includes(TOKEN) && !script.includes(TS_KEY));
  assert.ok(cloud.runcmd.some((command) => command[0] === "/bin/sh" && command[1] === "/var/lib/orq-agent/bootstrap.sh"));
  assert.ok(boot.powershellScript.startsWith("#ps1_sysnative\n"));
  assert.ok(boot.powershellScript.includes("/api/boxes/agent/win32-x64"));
});

test("containers use userspace tailscaled and hand orq-agent its proxy", () => {
  const boot = buildBootstrap(input({ tailscaleAuthKey: TS_KEY, container: true }));
  for (const script of [boot.posixScript, boot.containerCommand[2]!]) {
    assert.match(script, /--tun=userspace-networking/);
    assert.match(script, /ORQ_PROXY=/);
  }
  const vm = buildBootstrap(input({ tailscaleAuthKey: TS_KEY }));
  assert.match(vm.posixScript, /https:\/\/tailscale\.com\/install\.sh/);
});

test("the POSIX scripts parse under dash, bash and busybox sh", () => {
  const variants = [
    input(),
    input({ tailscaleAuthKey: TS_KEY }),
    input({ container: true }),
    input({ tailscaleAuthKey: TS_KEY, container: true })
  ];
  const scripts: string[] = (["posix", "container"] as const).map((variant) => bootstrapSecondStage(variant)!);
  for (const variant of variants) {
    const boot = buildBootstrap(variant);
    scripts.push(boot.posixScript, boot.containerCommand[2]!, cloudInitScript(boot.cloudInit), boot.stagedPosixScript!);
  }
  for (const kind of ["linux", "macos"] as const) {
    scripts.push(byoPairingScript({ boxId: BOX_ID, daemonUrl: "https://orq.example.com", bootstrapToken: TOKEN, kind, name: "Mac 'mini' $(x)" }));
  }
  const shells = [["dash", "-n"], ["bash", "-n"], ["busybox", "sh", "-n"]].filter(([shell]) => has(shell!));
  assert.ok(shells.length > 0, "at least one POSIX shell to check with");
  for (const script of new Set(scripts)) {
    for (const shell of shells) {
      const result = spawnSync(shell[0]!, [...shell.slice(1)], { input: script, encoding: "utf8" });
      assert.equal(result.status, 0, `${shell.join(" ")}: ${result.stderr}`);
    }
  }
});

// ---------------------------------------------------------------------------
// End to end: a local "daemon" serving a fake orq-agent
// ---------------------------------------------------------------------------

const FAKE_AGENT = `#!/bin/sh
case "$1" in
  --version) echo 0.0.0-test ;;
  run | install-service)
    {
      echo "cmd=$1"
      echo "url=$ORQ_DAEMON_URL"
      echo "box=$ORQ_BOX_ID"
      echo "file=$ORQ_BOOTSTRAP_TOKEN_FILE"
      echo "proxy=\${ORQ_PROXY:-}"
      echo "token=$(cat "$ORQ_BOOTSTRAP_TOKEN_FILE")"
      echo "mode=$(stat -c %a "$ORQ_BOOTSTRAP_TOKEN_FILE")"
    } >"$ORQ_TEST_RESULT"
    env >"$ORQ_TEST_RESULT.env" ;;
  *) exit 2 ;;
esac
`;

interface FakeDaemon {
  url: string;
  requests: Array<{ path: string; authorization: string | undefined }>;
  /** Status codes to answer before serving anything. */
  failFirst: number[];
  /** The token was spent by a first connect: every request is refused. */
  spent: boolean;
  /** How many requests to answer with a redirect to `/stolen` (on this same server) first. */
  redirectFirst: number;
  server: Server;
}

async function startFakeDaemon(t: test.TestContext): Promise<FakeDaemon> {
  const daemon: FakeDaemon = { url: "", requests: [], failFirst: [], spent: false, redirectFirst: 0, server: undefined as unknown as Server };
  daemon.server = createServer((request: IncomingMessage, response) => {
    daemon.requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    if (daemon.redirectFirst > 0 && request.url !== "/stolen") {
      daemon.redirectFirst -= 1;
      response.writeHead(302, { location: `${daemon.url}/stolen` }).end();
      return;
    }
    const fail = daemon.failFirst.shift();
    if (fail !== undefined) {
      response.writeHead(fail).end();
      return;
    }
    if (daemon.spent || request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const stage = /^\/api\/boxes\/bootstrap\/([^/]+)$/.exec(request.url ?? "");
    if (stage) {
      const script = bootstrapSecondStage(stage[1]!);
      response.writeHead(script === null ? 404 : 200, { "content-type": "text/x-shellscript" }).end(script ?? "");
      return;
    }
    if (!/^\/api\/boxes\/agent\/linux-(x64|arm64)(-musl)?$/.test(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(FAKE_AGENT);
  });
  await new Promise<void>((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => daemon.server.close(() => resolve())));
  daemon.url = `http://127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  return daemon;
}

interface Sandbox {
  dir: string;
  home: string;
  bin: string;
  result: string;
  log: string;
}

/**
 * A temp HOME and a shim bin dir: `id` always reports a non-root user (the scripts
 * then use ~/.orq-agent even if the tests run as root), `curl` and `tailscale`
 * record their argv. With `only`, PATH holds nothing but the shims and links to
 * those tools (to hide curl).
 */
async function sandbox(t: test.TestContext, only?: string[]): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "orq-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(home);
  await mkdir(bin);
  const log = join(dir, "argv.log");
  const shim = async (name: string, body: string): Promise<void> => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await shim("sleep", "exit 0"); // Retry behavior is exercised without waiting through shell backoffs.
  await shim("id", `if [ "\${1:-}" = -u ]; then echo 1000; else exec /usr/bin/id "$@"; fi`);
  await shim(
    "tailscale",
    `echo "tailscale $*" >>"${log}"
for a in "$@"; do case "$a" in --auth-key=file:*) f=\${a#--auth-key=file:}; echo "keyfile=$(cat "$f") mode=$(stat -c %a "$f")" >>"${log}" ;; esac; done`
  );
  if (only === undefined) {
    await shim("curl", `echo "curl $*" >>"${log}"\nexec /usr/bin/curl "$@"`);
  } else {
    for (const tool of only) {
      const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      assert.ok(resolved, `${tool} is available`);
      await symlink(resolved, join(bin, tool));
    }
  }
  return { dir, home, bin, result: join(dir, "result"), log };
}

async function runScript(
  box: Sandbox,
  argv: string[],
  options: { onlyPath?: boolean; env?: Record<string, string> } = {}
): Promise<{ code: number | null; output: string }> {
  const unprivileged = process.getuid?.() === 0;
  if (unprivileged) {
    // BusyBox may resolve its built-in id before PATH's shim. Run without root privileges so
    // no generated bootstrap can write the host's real /var/lib/orq-agent, under any shell.
    // lchown changes the sandbox's tool symlinks, never the system executables they point at.
    for (const path of [box.dir, ...(await readdir(box.dir, { recursive: true })).map((name) => join(box.dir, name))]) {
      await lchown(path, 65534, 65534);
    }
  }
  const child = spawn(argv[0]!, argv.slice(1), {
    ...(unprivileged ? { uid: 65534, gid: 65534 } : {}),
    env: {
      HOME: box.home,
      PATH: options.onlyPath ? box.bin : `${box.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ORQ_TEST_RESULT: box.result,
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, output };
}

async function readResult(box: Sandbox): Promise<Record<string, string>> {
  const text = await readFile(box.result, "utf8");
  return Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

async function assertAgentStarted(box: Sandbox, daemon: FakeDaemon, output: string): Promise<void> {
  const result = await readResult(box);
  const dataDir = join(box.home, ".orq-agent");
  assert.equal(result.cmd, "run");
  assert.equal(result.url, daemon.url);
  assert.equal(result.box, BOX_ID);
  assert.equal(result.file, join(dataDir, "bootstrap-token"));
  assert.equal(result.token, TOKEN);
  assert.equal(result.mode, "600");
  const agentEnv = await readFile(`${box.result}.env`, "utf8");
  assert.ok(!agentEnv.includes(TOKEN), "the token is not in orq-agent's environment");
  assert.ok(!output.includes(TOKEN), "the token is not in the bootstrap's output");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, "bin", "orq-agent"))).mode & 0o777, 0o755);
  assert.ok(daemon.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
}

test("posixScript downloads with the bearer token via curl, joins the tailnet by key file, and execs orq-agent", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url, tailscaleAuthKey: TS_KEY }));
  const scriptPath = join(box.dir, "user-data.sh");
  await writeFile(scriptPath, boot.posixScript);

  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.equal(code, 0, output);
  await assertAgentStarted(box, daemon, output);
  assert.equal(daemon.requests.length, 1);
  assert.match(daemon.requests[0]!.path, /^\/api\/boxes\/agent\/linux-(x64|arm64)(-musl)?$/);

  const argvLog = await readFile(box.log, "utf8");
  const argvLines = argvLog.split("\n").filter((line) => /^(curl|tailscale) /.test(line));
  assert.ok(argvLines.length >= 2 && argvLines.every((line) => !line.includes(TOKEN) && !line.includes(TS_KEY)), "no secret in any recorded argv");
  assert.match(argvLog, /^curl -K - /m);
  assert.match(argvLog, new RegExp(`^tailscale up --auth-key=file:\\S+ --hostname=orq-${BOX_ID} --timeout=180s$`, "m"));
  // The fake tailscale read the key from a 0600 file; the file is gone afterwards.
  assert.match(argvLog, /^keyfile=\S+ mode=600$/m);
  assert.ok(argvLog.includes(`keyfile=${TS_KEY} `));
  await assert.rejects(stat(join(box.home, ".orq-agent", "ts-authkey")), { code: "ENOENT" });
});

test("posixScript falls back to GNU wget and retries a failing daemon", async (t) => {
  if (!has("wget")) {
    t.skip("wget is not installed");
    return;
  }
  const daemon = await startFakeDaemon(t);
  daemon.failFirst = [503];
  const tools = ["sh", "uname", "ls", "ldd", "grep", "mkdir", "chmod", "mv", "rm", "cat", "date", "awk", "wget", "stat", "env"];
  const box = await sandbox(t, tools.filter(has));
  const boot = buildBootstrap(input({ daemonUrl: daemon.url }));
  const scriptPath = join(box.dir, "user-data.sh");
  await writeFile(scriptPath, boot.posixScript);

  const { code, output } = await runScript(box, ["sh", scriptPath], { onlyPath: true });
  assert.equal(code, 0, output);
  assert.match(output, /download failed \(HTTP 503\); retrying/);
  assert.equal(daemon.requests.length, 2);
  await assertAgentStarted(box, daemon, output);
});

test("the wget fallback never follows a redirect with the bearer token", async (t) => {
  if (!has("wget")) {
    t.skip("wget is not installed");
    return;
  }
  const daemon = await startFakeDaemon(t);
  daemon.redirectFirst = 1;
  const tools = ["sh", "uname", "ls", "ldd", "grep", "mkdir", "chmod", "mv", "rm", "cat", "date", "awk", "wget", "stat", "env"];
  const box = await sandbox(t, tools.filter(has));
  const boot = buildBootstrap(input({ daemonUrl: daemon.url }));
  const scriptPath = join(box.dir, "user-data.sh");
  await writeFile(scriptPath, boot.posixScript);

  const { code, output } = await runScript(box, ["sh", scriptPath], { onlyPath: true });
  assert.equal(code, 0, output);
  // The 302 is answered as a failed attempt and retried; its target is never asked.
  assert.match(output, /download failed \(HTTP 302\); retrying/);
  assert.deepEqual(
    daemon.requests.map((request) => request.path.replace(/linux-(x64|arm64)(-musl)?$/, "linux")),
    ["/api/boxes/agent/linux", "/api/boxes/agent/linux"]
  );
  await assertAgentStarted(box, daemon, output);
});

test("containerCommand takes its secrets from env, unsets them and stays in the foreground", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url, container: true }));
  const shell = has("busybox") ? ["busybox", "sh"] : ["sh"];
  const { code, output } = await runScript(box, [...shell, ...boot.containerCommand.slice(1)], { env: boot.env });
  assert.equal(code, 0, output);
  await assertAgentStarted(box, daemon, output);
  const agentEnv = await readFile(`${box.result}.env`, "utf8");
  assert.doesNotMatch(agentEnv, /^ORQ_BOOTSTRAP_TOKEN=/m);
});

test("the cloud-init script reads the token file written by write_files", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url }));
  const dataDir = join(box.home, ".orq-agent");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "bootstrap-token"), TOKEN, { mode: 0o600 });
  const scriptPath = join(box.dir, "bootstrap.sh");
  await writeFile(scriptPath, cloudInitScript(boot.cloudInit));

  const { code, output } = await runScript(box, ["bash", scriptPath]);
  assert.equal(code, 0, output);
  await assertAgentStarted(box, daemon, output);
});

test("a refused token stops the bootstrap without printing it", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url, bootstrapToken: "obt_wrong-token-0123456789" }));
  const scriptPath = join(box.dir, "user-data.sh");
  await writeFile(scriptPath, boot.posixScript);

  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.equal(code, 1);
  assert.match(output, /refused the bootstrap token \(HTTP 401\)/);
  assert.ok(!output.includes("obt_wrong-token"));
  await assert.rejects(stat(box.result), { code: "ENOENT" });
});

test("stagedPosixScript joins the tailnet, fetches the second stage with the bearer token, and that starts orq-agent", async (t) => {
  const daemon = await startFakeDaemon(t);
  daemon.failFirst = [502];
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url, tailscaleAuthKey: TS_KEY }));
  const scriptPath = join(box.dir, "user-data.sh");
  await writeFile(scriptPath, boot.stagedPosixScript!);

  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.equal(code, 0, output);
  assert.match(output, /download failed \(HTTP 502\); retrying/);
  await assertAgentStarted(box, daemon, output);
  assert.deepEqual(
    daemon.requests.map((request) => request.path.replace(/linux-(x64|arm64)(-musl)?$/, "linux")),
    ["/api/boxes/bootstrap/posix", "/api/boxes/bootstrap/posix", "/api/boxes/agent/linux"]
  );
  const argvLog = await readFile(box.log, "utf8");
  const argvLines = argvLog.split("\n").filter((line) => /^(curl|tailscale) /.test(line));
  assert.ok(argvLines.length >= 3 && argvLines.every((line) => !line.includes(TOKEN) && !line.includes(TS_KEY)), "no secret in any recorded argv");
  assert.match(argvLog, new RegExp(`^tailscale up --auth-key=file:\\S+ --hostname=orq-${BOX_ID} --timeout=180s$`, "m"));
  assert.ok(argvLog.includes(`keyfile=${TS_KEY} `));
  await assert.rejects(stat(join(box.home, ".orq-agent", "ts-authkey")), { code: "ENOENT" });
  // The second stage is kept for a restart, with nothing secret in it.
  const saved = await readFile(join(box.home, ".orq-agent", "bootstrap-stage2.sh"), "utf8");
  assert.equal(saved, bootstrapSecondStage("posix"));

  // Restart after the first connect spent the token: the saved stage and the installed orq-agent carry on.
  daemon.spent = true;
  await rm(box.result, { force: true });
  const again = await runScript(box, ["sh", scriptPath]);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /token already used; running the saved bootstrap/);
  assert.match(again.output, /token already used; keeping the installed orq-agent/);
  assert.equal((await readResult(box)).cmd, "run");
});

test("stagedPosixScript without the saved second stage stops on a refused token", async (t) => {
  const daemon = await startFakeDaemon(t);
  daemon.spent = true;
  const box = await sandbox(t);
  const boot = buildBootstrap(input({ daemonUrl: daemon.url, container: true }));
  const scriptPath = join(box.dir, "onstart.sh");
  await writeFile(scriptPath, boot.stagedPosixScript!);
  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.equal(code, 1);
  assert.match(output, /refused the bootstrap token \(HTTP 401\)/);
  assert.ok(!output.includes(TOKEN));
  assert.deepEqual(daemon.requests.map((request) => request.path), ["/api/boxes/bootstrap/container"]);
});

test("the container second stage runs from the first stage's environment and refuses to run without it", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const scriptPath = join(box.dir, "stage2.sh");
  await writeFile(scriptPath, bootstrapSecondStage("container")!);

  const missing = await runScript(box, ["sh", scriptPath], { env: { ORQ_DAEMON_URL: daemon.url } });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /must be set/);

  const dataDir = join(box.home, ".orq-agent");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "bootstrap-token"), TOKEN, { mode: 0o600 });
  const { code, output } = await runScript(box, ["sh", scriptPath], {
    env: { ORQ_DAEMON_URL: daemon.url, ORQ_BOX_ID: BOX_ID, ORQ_BOOTSTRAP_TOKEN_FILE: join(dataDir, "bootstrap-token") }
  });
  assert.equal(code, 0, output);
  await assertAgentStarted(box, daemon, output);
});

test("the pairing script installs orq-agent for the user and runs install-service with the token in a 0600 file", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  // sudo would try to link into /usr/local/bin: here it is refused (and recorded), like a user without sudo.
  await writeFile(join(box.bin, "sudo"), `#!/bin/sh\necho "sudo $*" >>"${box.log}"\nexit 1\n`);
  await chmod(join(box.bin, "sudo"), 0o755);
  const scriptPath = join(box.dir, "pair.sh");
  await writeFile(scriptPath, byoPairingScript({ boxId: BOX_ID, daemonUrl: daemon.url, bootstrapToken: TOKEN, kind: "linux", name: 'Build server $(touch "$HOME/pairing-injected")' }));

  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.equal(code, 0, output);
  const result = await readResult(box);
  assert.equal(result.cmd, "install-service");
  await assert.rejects(stat(join(box.home, "pairing-injected")), { code: "ENOENT" });
  assert.equal(result.url, daemon.url);
  assert.equal(result.box, BOX_ID);
  assert.equal(result.token, TOKEN);
  assert.equal(result.mode, "600");
  assert.equal(result.file, join(box.home, ".orq-agent", "bootstrap-token"));
  assert.ok(!output.includes(TOKEN), "the token is not in the output");
  assert.ok(!(await readFile(`${box.result}.env`, "utf8")).includes(TOKEN), "nor in orq-agent's environment");
  // A user without root: ~/.local/bin, the real file (the service runs it, and updates replace it).
  assert.equal((await stat(join(box.home, ".local", "bin", "orq-agent"))).mode & 0o777, 0o755);
  await assert.rejects(stat(join(box.home, ".orq-agent", "bin", "orq-agent")), { code: "ENOENT" });
});

test("a pairing script made for macOS refuses to run on Linux and leaves no token behind", async (t) => {
  const daemon = await startFakeDaemon(t);
  const box = await sandbox(t);
  const scriptPath = join(box.dir, "pair.sh");
  await writeFile(scriptPath, byoPairingScript({ boxId: BOX_ID, daemonUrl: daemon.url, bootstrapToken: TOKEN, kind: "macos", name: "Mac" }));
  const { code, output } = await runScript(box, ["sh", scriptPath]);
  assert.notEqual(code, 0);
  assert.match(output, /for a macOS machine, but this one runs linux/);
  assert.equal(daemon.requests.length, 0, "nothing was downloaded");
  await assert.rejects(stat(join(box.home, ".orq-agent", "bootstrap-token")), { code: "ENOENT" });
});

test("the pairing script refuses bad input and puts the macOS agent under Application Support", () => {
  const ok = { boxId: BOX_ID, daemonUrl: "https://orq.example.com", bootstrapToken: TOKEN, kind: "macos" as const, name: "Mac" };
  assert.throws(() => byoPairingScript({ ...ok, daemonUrl: "http://orq.example.com" }), /https/);
  assert.throws(() => byoPairingScript({ ...ok, bootstrapToken: "short" }), /token/);
  assert.throws(() => byoPairingScript({ ...ok, boxId: "x;rm" }), /box id/);
  const script = byoPairingScript({ ...ok, name: "Mac 'mini' $(reboot)" });
  assert.ok(script.includes('T="$HOME/Library/Application Support/Orquester/orq-agent"'));
});
