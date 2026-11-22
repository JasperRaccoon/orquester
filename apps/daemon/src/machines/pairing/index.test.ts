import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BoxLocalTailscale, MachineSummary } from "@orquester/api";

import { WINDOWS_PAIRING_COMMAND } from "../../boxes/bootstrap/bootstrap.ts";

import type { ByoSshPairingRequest } from "../../boxes/service/byo.ts";
import type { MachineTarget } from "../ports.ts";
import { createMachinePairing } from "./index.ts";
import type { SshRunOptions, SshRunResult } from "./runner.ts";

const TOKEN = "box-abc123456.TOKEN_must_never_reach_argv_0123456789";
const SCRIPT = `#!/bin/sh\nT='${TOKEN}'\n`;
const ADDRESS = "100.92.198.117";
const KEY_TYPE = "ssh-ed25519";

/** A real Ed25519 host key and the fingerprint `ssh-keygen -lf` printed for it. */
const HOST_KEY = { blob: "AAAAC3NzaC1lZDI1NTE5AAAAIF2yDQMxuTW0VR4E804wzM5NJ4Xa3tzQR+ahAyE/L2oR", fingerprint: "SHA256:jDUWHfSCT09ftdjDyqdZjIJqXXbSih8YbxSd+b/N60A" };

interface FakeMachine {
  /** What the daemon user's own known_hosts says about the machine. */
  known: "unknown" | "same" | "changed";
  /** `ssh -G`'s `user` (the daemon user's name when nothing in ~/.ssh/config sets one). */
  configUser: string;
  bootstrap: (input: string) => SshRunResult;
  /** Win32-OpenSSH with cmd.exe as the login shell, instead of a POSIX machine. */
  windows?: boolean;
}

interface Call {
  args: string[];
  input: string | undefined;
  /** The known_hosts file `ssh` was pointed at, as it was during the call. */
  knownHosts: string | null;
}

/** `ssh` as OpenSSH behaves for one machine at {@link ADDRESS}, from the options each run passes. */
function fakeSsh(machine: FakeMachine, key: { blob: string }) {
  const calls: Call[] = [];
  const ok = (stdout = ""): SshRunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const fail = (stderr: string): SshRunResult => ({ code: 255, stdout: "", stderr, timedOut: false });
  const run = async (file: string, args: readonly string[], options: SshRunOptions): Promise<SshRunResult> => {
    assert.equal(file, "ssh");
    const options_ = new Map<string, string>();
    for (let i = 0; i < args.length - 1; i++) if (args[i] === "-o") options_.set(args[i + 1]!.split("=")[0]!, args[i + 1]!.split("=").slice(1).join("="));
    const file_ = options_.get("UserKnownHostsFile")?.replace(/^"|"$/g, "") ?? null;
    const knownHosts = file_ ? await readFile(file_, "utf8").catch(() => "") : null;
    calls.push({ args: [...args], input: options.input, knownHosts });
    if (args[0] === "-G") return ok(`host ${ADDRESS}\nuser ${machine.configUser}\nhostname ${ADDRESS}\nport 22\n`);
    const line = `${ADDRESS} ${KEY_TYPE} ${key.blob}`;
    const strict = options_.get("StrictHostKeyChecking");
    if (strict === "accept-new") {
      await writeFile(file_!, `${line}\n`);
      return fail(`jasper@${ADDRESS}: Permission denied (publickey).\r\n`);
    }
    assert.equal(strict, "yes", "every run that logs in checks the host key strictly");
    const known = file_ === null ? machine.known : knownHosts!.includes(line) ? "same" : knownHosts!.trim() ? "changed" : "unknown";
    if (known === "unknown") return fail(`No ED25519 host key is known for ${ADDRESS} and you have requested strict checking.\r\nHost key verification failed.\r\n`);
    if (known === "changed") return fail(`@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\nHost key for ${ADDRESS} has changed and you have requested strict checking.\r\nHost key verification failed.\r\n`);
    const command = args.at(-1);
    if (machine.windows) {
      // cmd.exe: no uname; `echo %OS%` expands.
      if (command === "echo %OS%") return ok("Windows_NT\r\n");
      if (command === WINDOWS_PAIRING_COMMAND) return machine.bootstrap(options.input ?? "");
      return { code: 1, stdout: "", stderr: `"${command?.split(" ")[0]}" no se reconoce como un comando interno o externo,\r\n`, timedOut: false };
    }
    if (command === "uname -s") return ok("Linux\n");
    if (command === "sh -s") return machine.bootstrap(options.input ?? "");
    throw new Error(`unexpected remote command ${command}`);
  };
  return { calls, run };
}

const TARGET: MachineTarget = {
  machineId: "ts:nJasper",
  name: "jasper",
  hostname: "jasper",
  dnsName: null,
  tailnetIps: [ADDRESS],
  os: "linux",
  boxId: null,
  ssh: { user: "jasper" }
};

function servingTailscale(serving: boolean): { state(): Promise<BoxLocalTailscale> } {
  return {
    state: async () => ({
      installed: true,
      running: true,
      dnsName: "orq-host.tail1234.ts.net",
      tailnetIp: "100.64.0.1",
      servePort: 10000,
      serving,
      suggestedUrl: "https://orq-host.tail1234.ts.net:10000",
      serveCommand: null
    })
  };
}

async function setup(t: test.TestContext, machine: Partial<FakeMachine>, options: { serving?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-pairing-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = HOST_KEY;
  const ssh = fakeSsh(
    {
      known: "unknown",
      configUser: "orquester",
      bootstrap: () => ({ code: 0, stdout: "", stderr: "orq-bootstrap: done\n", timedOut: false }),
      ...machine
    },
    key
  );
  const added: ByoSshPairingRequest[] = [];
  const removed: string[] = [];
  const events: string[] = [];
  const temp = join(dir, "tmp");
  await mkdir(temp);
  const pairing = createMachinePairing({
    byo: {
      addForSsh: async (request) => {
        added.push(request);
        return { boxId: "box-abc123456", script: SCRIPT };
      },
      remove: async (boxId) => {
        removed.push(boxId);
        return { uninstalled: false };
      }
    },
    byoRoute: () => ({ mode: "public-url", daemonUrl: "https://orq.example.com" }),
    localTailscale: servingTailscale(options.serving ?? false),
    summarize: (machineId) => ({ id: machineId, name: "jasper" }) as MachineSummary,
    linkBox: (machineId, boxId) => void events.push(`link ${machineId} ${boxId} after ${ssh.calls.length} runs`),
    home: join(dir, "home"),
    localUser: "orquester",
    run: ssh.run,
    tempDir: temp,
    now: () => Date.parse("2026-11-22T12:00:00.000Z"),
    logger: { warn: () => undefined }
  });
  return { pairing, ssh, key, added, removed, events, temp };
}

test("an unknown host key is shown for confirmation first; the confirmed key alone is pinned, and the bootstrap's secret goes over stdin only", async (t) => {
  const probes = ["orq-probe: sudo=no", "orq-probe: linger=off", "orq-probe: oom.tailscaled=missing", "orq-probe: oom.sshd=ok", "orq-probe: oom.orq-agent=missing"].join("\n");
  const { pairing, ssh, key, added, events, temp } = await setup(t, { bootstrap: () => ({ code: 0, stdout: "", stderr: `${probes}\n`, timedOut: false }) }, { serving: true });

  const first = await pairing.pairOverSsh(TARGET, {});
  assert.deepEqual(first, { status: "confirm-host-key", hostKey: { keyType: KEY_TYPE, fingerprint: key.fingerprint, host: ADDRESS } });
  assert.equal(added.length, 0, "nothing is created before the owner confirmed");
  assert.ok(!ssh.calls.some((call) => call.args.at(-1) === "sh -s"));

  const second = await pairing.pairOverSsh(TARGET, { acceptHostKeyFingerprint: key.fingerprint });
  assert.equal(second.status, "pairing");
  // A tailnet peer while `tailscale serve` routes to the daemon: its tailnet HTTPS URL.
  assert.deepEqual(added, [{ kind: "linux", name: "jasper", daemonUrl: "https://orq-host.tail1234.ts.net:10000", connectRoute: "tailscale" }]);
  const bootstrap = ssh.calls.find((call) => call.args.at(-1) === "sh -s")!;
  assert.equal(bootstrap.knownHosts, `${ADDRESS} ${KEY_TYPE} ${key.blob}\n`, "exactly the confirmed key is trusted");
  assert.ok(bootstrap.args.includes("BatchMode=yes"));
  assert.equal(bootstrap.input, SCRIPT);
  for (const call of ssh.calls) assert.ok(!call.args.some((arg) => arg.includes("TOKEN")), `no secret in argv: ${call.args.join(" ")}`);
  assert.deepEqual(events, [`link ${TARGET.machineId} box-abc123456 after ${ssh.calls.length - 1} runs`], "the record is linked before the bootstrap runs");
  assert.deepEqual(await readdir(temp), [], "the throwaway known_hosts files are gone");

  const probe = pairing.lastProbe(TARGET.machineId)!;
  assert.deepEqual(probe.sudo, { passwordless: false });
  assert.deepEqual(
    probe.problems.map((problem) => problem.code),
    ["sudo-unavailable", "linger-off", "oom-protection-missing"]
  );
  assert.match(probe.problems[1]!.fix!, /sudo loginctl enable-linger jasper/);
  assert.match(probe.problems[2]!.message, /^tailscaled, orq-agent on jasper aren't protected/);
  assert.equal(pairing.lastProbe("ts:other"), null);
});

test("a changed host key blocks pairing, and so does a key that is no longer the confirmed one", async (t) => {
  const changed = await setup(t, { known: "changed" });
  const blocked = await changed.pairing.pairOverSsh(TARGET, {});
  assert.equal(blocked.status === "failed" && blocked.problem.code, "ssh-host-key-changed");
  assert.equal(changed.added.length, 0);
  assert.ok(!changed.ssh.calls.some((call) => call.args.includes("StrictHostKeyChecking=accept-new")), "a changed key is never fetched to be offered again");

  const swapped = await setup(t, { known: "unknown" });
  const result = await swapped.pairing.pairOverSsh(TARGET, { acceptHostKeyFingerprint: "SHA256:theOneTheOwnerSawBefore0000000000000000000" });
  assert.equal(result.status === "failed" && result.problem.code, "ssh-host-key-changed");
  assert.equal(swapped.added.length, 0);
});

test("a known host goes straight to the bootstrap; when it fails its record is removed and the script's own error is named", async (t) => {
  const { pairing, ssh, added, removed } = await setup(t, {
    known: "same",
    bootstrap: () => ({ code: 1, stdout: "", stderr: "orq-bootstrap: downloading orq-agent (linux-x64)\norq-bootstrap: error: could not download orq-agent (linux-x64) (last HTTP status 000)\n", timedOut: false })
  });
  const result = await pairing.pairOverSsh(TARGET, {});
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.problem.code, "pair-bootstrap-failed");
  assert.match(result.problem.message, /^Pairing jasper failed: could not download orq-agent \(linux-x64\) \(last HTTP status 000\)\.$/);
  assert.ok(!ssh.calls.some((call) => call.args.includes("StrictHostKeyChecking=accept-new")));
  // Not serving over the tailnet: the configured route.
  assert.equal(added[0]?.daemonUrl, "https://orq.example.com");
  assert.deepEqual(removed, ["box-abc123456"]);
  assert.equal(pairing.lastProbe(TARGET.machineId), null, "no probe line, no probe");
});

test("with no user given or configured, the owner is asked for one instead of this server's own user name being guessed", async (t) => {
  const { pairing, ssh } = await setup(t, { known: "same", configUser: "orquester" });
  const result = await pairing.pairOverSsh({ ...TARGET, ssh: {} }, {});
  assert.equal(result.status === "failed" && result.problem.code, "ssh-auth-refused");
  assert.match(result.status === "failed" ? result.problem.message : "", /which user to log in to jasper as/);
  assert.deepEqual(ssh.calls.map((call) => call.args[0]), ["-G"], "nothing but the config lookup ran");

  // ~/.ssh/config naming a user for that host is the owner's choice.
  const configured = await setup(t, { known: "same", configUser: "jasper" });
  assert.equal((await configured.pairing.pairOverSsh({ ...TARGET, ssh: {} }, {})).status, "pairing");
});

const MINI_PC: MachineTarget = {
  machineId: "ts:nMiniPc",
  name: "minipc",
  hostname: "minipc-desktop-11fqvre",
  dnsName: null,
  tailnetIps: [ADDRESS],
  os: "windows",
  boxId: null,
  ssh: { user: "user" }
};

test("a Windows machine is confirmed by cmd.exe and paired by PowerShell reading the script on stdin; its probe reads like the real mini PC's", async (t) => {
  const observed = await readFile(new URL("../fixtures/windows-pairing-probe.stderr.txt", import.meta.url), "utf8");
  const { pairing, ssh, added } = await setup(t, { known: "same", windows: true, bootstrap: () => ({ code: 0, stdout: "", stderr: observed, timedOut: false }) });
  const result = await pairing.pairOverSsh(MINI_PC, {});
  assert.equal(result.status, "pairing");
  assert.deepEqual(
    ssh.calls.slice(1).map((call) => call.args.at(-1)),
    ["echo %OS%", WINDOWS_PAIRING_COMMAND]
  );
  assert.equal(added[0]?.kind, "windows");
  const bootstrap = ssh.calls.at(-1)!;
  assert.equal(bootstrap.input, SCRIPT);
  for (const call of ssh.calls) assert.ok(!call.args.some((arg) => arg.includes("TOKEN")), `no secret in argv: ${call.args.join(" ")}`);
  const probe = pairing.lastProbe(MINI_PC.machineId)!;
  // An administrator over SSH is elevated without a prompt: Windows' passwordless sudo.
  assert.deepEqual(probe.sudo, { passwordless: true });
  assert.deepEqual(probe.problems, []);
});

test("Windows gaps are named with their fixes, and a non-administrator is refused naming the account", async (t) => {
  const gaps = ["orq-probe: sudo=yes", "orq-probe: whpx=off", "orq-probe: autologon=off", "orq-probe: desktop=none", "orq-probe: desktop-helper=installed"].join("\r\n");
  const machine = await setup(t, { known: "same", windows: true, bootstrap: () => ({ code: 0, stdout: "", stderr: `${gaps}\r\n`, timedOut: false }) });
  assert.equal((await machine.pairing.pairOverSsh(MINI_PC, {})).status, "pairing");
  const problems = machine.pairing.lastProbe(MINI_PC.machineId)!.problems;
  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["whpx-off", "no-desktop-session"]
  );
  assert.match(problems[0]!.fix!, /Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform/);
  assert.match(problems[1]!.fix!, /Autologon.*DefaultUserName=user/s);
  assert.ok(!/password=|DefaultPassword/i.test(JSON.stringify(problems)), "no fix asks to store a password in the registry");

  const refused = await setup(t, {
    known: "same",
    windows: true,
    bootstrap: () => ({ code: 1, stdout: "", stderr: "orq-probe: sudo=no\r\norq-bootstrap: error: run the pairing command in PowerShell as Administrator: orq-agent installs a Windows service\r\n", timedOut: false })
  });
  const result = await refused.pairing.pairOverSsh(MINI_PC, {});
  assert.equal(result.status === "failed" && result.problem.code, "sudo-unavailable");
  assert.match(result.status === "failed" ? result.problem.message : "", /^user isn't an administrator on minipc/);
  assert.deepEqual(refused.removed, ["box-abc123456"], "the failed pairing's record is removed");
});
