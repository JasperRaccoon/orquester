import assert from "node:assert/strict";
import test from "node:test";

import { classifySshFailure, type SshFailureContext } from "./classify.ts";

const CONTEXT: SshFailureContext = {
  machineId: "ts:nJasper",
  machineName: "jasper",
  destination: "100.92.198.117",
  user: "jasper",
  port: null,
  identityFile: "/home/orquester/.ssh/id_ed25519"
};

const failure = (stderr: string) => ({ code: 255, stdout: "", stderr, timedOut: false });

// OpenSSH 9.x stderr (LC_ALL=C, LogLevel=ERROR) for each failure pairing meets.
const CASES: Array<[string, string, string]> = [
  [
    "changed host key",
    `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
The fingerprint for the ED25519 key sent by the remote host is
SHA256:jDUWHfSCT09ftdjDyqdZjIJqXXbSih8YbxSd+b/N60A.
Offending ED25519 key in /home/orquester/.ssh/known_hosts:12
Host key for 100.92.198.117 has changed and you have requested strict checking.
Host key verification failed.
`,
    "ssh-host-key-changed"
  ],
  ["unknown host key", "No ED25519 host key is known for 100.92.198.117 and you have requested strict checking.\r\nHost key verification failed.\r\n", "ssh-host-key-unknown"],
  ["key refused", "jasper@100.92.198.117: Permission denied (publickey).\r\n", "ssh-auth-refused"],
  ["key refused, password offered", "jasper@100.92.198.117: Permission denied (publickey,password).\r\n", "ssh-auth-refused"],
  ["unreadable key", "Load key \"/home/orquester/.ssh/id_ed25519\": bad permissions\r\njasper@100.92.198.117: Permission denied (publickey).\r\n", "ssh-auth-refused"],
  ["unknown name", "ssh: Could not resolve hostname jasper.tail1234.ts.net: Name or service not known\r\n", "ssh-resolve-failed"],
  ["DNS down", "ssh: Could not resolve hostname jasper: Temporary failure in name resolution\r\n", "ssh-resolve-failed"],
  ["macOS resolver", "ssh: Could not resolve hostname jasper: nodename nor servname provided, or not known\r\n", "ssh-resolve-failed"],
  ["no sshd", "ssh: connect to host 100.92.198.117 port 22: Connection refused\r\n", "ssh-unreachable"],
  ["asleep", "ssh: connect to host 100.124.210.7 port 22: Connection timed out\r\n", "ssh-unreachable"],
  ["no route", "ssh: connect to host 100.92.198.117 port 22: No route to host\r\n", "ssh-unreachable"],
  ["dropped before banner", "kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 100.92.198.117 port 22\r\n", "ssh-unreachable"],
  ["ProxyJump down", "channel 0: open failed: connect failed: Connection refused\r\nstdio forwarding failed\r\nConnection closed by UNKNOWN port 65535\r\n", "ssh-unreachable"]
];

test("ssh's own failures map to the problem code that names their fix, never echoing stderr", () => {
  for (const [label, stderr, code] of CASES) {
    const problem = classifySshFailure(failure(stderr), CONTEXT);
    assert.equal(problem?.code, code, label);
    assert.equal(problem?.machineId, "ts:nJasper", label);
    assert.match(problem!.message, /jasper/, `${label}: the message names the machine`);
    assert.ok(problem!.fix, `${label}: a fix is given`);
    assert.ok(!`${problem!.message} ${problem!.fix}`.includes("SHA256:jDUW"), `${label}: nothing from stderr is repeated`);
  }
  const auth = classifySshFailure(failure(CASES[2]![1]), CONTEXT)!;
  assert.match(auth.message, /must log in without a password/);
  assert.match(auth.fix!, /\/home\/orquester\/\.ssh\/id_ed25519\.pub.*jasper's ~\/\.ssh\/authorized_keys/);
});

test("a timeout is an unreachable machine; a remote command's own exit status is not an ssh failure", () => {
  assert.equal(classifySshFailure({ code: null, stdout: "", stderr: "", timedOut: true }, CONTEXT)?.code, "ssh-unreachable");
  // The script's stderr may hold anything (here a key-like value): with exit 1 it is not classified at all.
  assert.equal(classifySshFailure({ code: 1, stdout: "", stderr: "Permission denied (publickey) tskey-auth-x", timedOut: false }, CONTEXT), null);
  assert.equal(classifySshFailure({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }, CONTEXT)?.code, "ssh-unreachable");
});
