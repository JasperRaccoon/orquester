import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { BoxChannelSpec } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxChannelHandler, BoxRawRequestHandler, BoxRequestContext } from "../contracts.ts";
import {
  SESSION_BIND_EXTENSION,
  SSH_AGENT_FAILURE,
  SSH_AGENT_RSA_SHA2_256,
  SSH_AGENT_RSA_SHA2_512,
  SSH_AGENT_SIGN_RESPONSE,
  SSH_AGENT_SUCCESS,
  SSH_AGENTC_EXTENSION,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  SSH_MSG_USERAUTH_REQUEST,
  SshAgentSession,
  boxCloneUrl,
  boxGitConfig,
  boxGitSshTarget,
  knownHostsFieldMatches,
  loadAccountIdentity,
  parseSshPrivateKey,
  parseUserauthRequest,
  publicKeyBlob,
  registerBoxGitAuth,
  serveSshAgent,
  trustedHostKeys,
  verifySshSignature,
  workspaceAccountFromFiles,
  type BoxGitAccount,
  type SshAgentPolicy
} from "./git-auth.ts";

const exec = promisify(execFile);

const projectRecord = (workspace: string): StoredBox => ({
  id: "box-1",
  purpose: "project",
  kind: "linux",
  provider: "hetzner",
  region: "fsn1",
  size: "cx22",
  name: "orq-box-1",
  createdAt: "2026-10-20T00:00:00.000Z",
  state: "ready",
  project: { workspace, name: "app", path: `/srv/ws/${workspace}/app` }
});

const temporaryRecord = (): StoredBox => ({ ...projectRecord("acme"), id: "box-2", purpose: "temporary", project: null, threadId: "t-1" });

interface FakeHub {
  credential(context: BoxRequestContext, params: { operation: "get" | "store" | "erase"; input: string }): Promise<{ output: string }>;
  agent: BoxChannelHandler;
}

/** Register on a hub double and hand back the two handlers. */
function register(accounts: Record<string, BoxGitAccount>, knownHosts = ""): FakeHub {
  const handlers: Record<string, unknown> = {};
  registerBoxGitAuth(
    {
      handle: (method, handler) => {
        handlers[method] = handler;
      },
      handleChannel: (kind, handler) => {
        handlers[`channel:${kind}`] = handler;
      }
    },
    { workspaceAccount: async (workspace) => accounts[workspace] ?? null, knownHosts: async () => knownHosts }
  );
  const credential = handlers["git.credential"] as BoxRawRequestHandler;
  return {
    credential: (context, params) => credential(context, params, new AbortController().signal) as Promise<{ output: string }>,
    agent: handlers["channel:ssh-agent"] as BoxChannelHandler
  };
}

async function keypair(dir: string, name: string, type: "ed25519" | "rsa"): Promise<{ keyPath: string; publicKey: string }> {
  const keyPath = join(dir, name);
  await exec("ssh-keygen", ["-q", "-t", type, ...(type === "rsa" ? ["-b", "2048"] : []), "-f", keyPath, "-N", "", "-C", `orquester:${name}`]);
  return { keyPath, publicKey: (await readFile(`${keyPath}.pub`, "utf8")).trim() };
}

function account(id: string, key: { keyPath: string; publicKey: string }, extra: Partial<BoxGitAccount> = {}): BoxGitAccount {
  return { id, provider: "github", login: "octo", publicKey: key.publicKey, keyPath: key.keyPath, ...extra };
}

/** A Unix-socket ssh-agent served for one box context through the registered channel handler. */
async function agentSocket(dir: string, hub: FakeHub, context: BoxRequestContext): Promise<{ path: string; server: Server }> {
  const path = join(dir, `agent-${context.boxId}.sock`);
  const server = createServer((socket: Socket) => hub.agent(context, { kind: "ssh-agent" } as BoxChannelSpec, socket));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server };
}

/** A Unix-socket ssh-agent with an explicit policy. */
async function policySocket(dir: string, policy: SshAgentPolicy | null): Promise<{ path: string; server: Server }> {
  const path = join(dir, `agent-${randomBytes(4).toString("hex")}.sock`);
  const server = createServer((socket: Socket) => {
    serveSshAgent(socket, async () => policy);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server };
}

/** Request/response exchanges on ONE agent connection (bindings are per connection). */
async function agentConnection(path: string): Promise<{ request(type: number, body?: Buffer): Promise<Buffer>; close(): void }> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let data = Buffer.alloc(0);
  let waiter: ((reply: Buffer) => void) | null = null;
  socket.on("data", (chunk: Buffer) => {
    data = Buffer.concat([data, chunk]);
    if (waiter && data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) {
      const reply = data.subarray(4, 4 + data.readUInt32BE(0));
      data = data.subarray(4 + reply.length);
      const resolve = waiter;
      waiter = null;
      resolve(reply);
    }
  });
  return {
    request(type, body = Buffer.alloc(0)) {
      const header = Buffer.alloc(5);
      header.writeUInt32BE(body.length + 1, 0);
      header[4] = type;
      const reply = new Promise<Buffer>((resolve) => (waiter = resolve));
      socket.write(Buffer.concat([header, body]));
      return reply;
    },
    close: () => socket.end()
  };
}

async function agentRequest(path: string, type: number, body: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  const connection = await agentConnection(path);
  try {
    return await connection.request(type, body);
  } finally {
    connection.close();
  }
}

const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};

function readString(buffer: Buffer, offset: number): [Buffer, number] {
  const length = buffer.readUInt32BE(offset);
  return [buffer.subarray(offset + 4, offset + 4 + length), offset + 4 + length];
}

/** A user-authentication request as an SSH client asks its agent to sign it. */
function userauthData(options: { sessionId: Buffer; user: string; algorithm: string; keyBlob: Buffer; hostKey?: Buffer; method?: string; service?: string; trailing?: Buffer }): Buffer {
  const method = options.method ?? (options.hostKey ? "publickey-hostbound-v00@openssh.com" : "publickey");
  return Buffer.concat([
    sshString(options.sessionId),
    Buffer.from([SSH_MSG_USERAUTH_REQUEST]),
    sshString(options.user),
    sshString(options.service ?? "ssh-connection"),
    sshString(method),
    Buffer.from([1]),
    sshString(options.algorithm),
    sshString(options.keyBlob),
    ...(options.hostKey ? [sshString(options.hostKey)] : []),
    options.trailing ?? Buffer.alloc(0)
  ]);
}

const signRequest = (keyBlob: Buffer, data: Buffer, flags = 0): Buffer => Buffer.concat([sshString(keyBlob), sshString(data), uint32(flags)]);

/** An ed25519 "server host key": its SSH blob and a signer over session ids. */
function hostKey(): { blob: Buffer; line: (name: string) => string; sign(data: Buffer): Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(x)]);
  return {
    blob,
    line: (name) => `${name} ssh-ed25519 ${blob.toString("base64")}`,
    sign: (data) => Buffer.concat([sshString("ssh-ed25519"), sshString(cryptoSign(null, data, privateKey))])
  };
}

const sessionBind = (key: Buffer, sessionId: Buffer, signature: Buffer, forwarding = false): Buffer =>
  Buffer.concat([sshString(SESSION_BIND_EXTENSION), sshString(key), sshString(sessionId), sshString(signature), Buffer.from([forwarding ? 1 : 0])]);

const localUser = async (): Promise<string> => (await exec("id", ["-un"])).stdout.trim();

// ---------------------------------------------------------------------------
// The agent through the registered channel
// ---------------------------------------------------------------------------

test("ssh-add -L lists exactly the workspace account's key through the agent channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "ed25519");
    const other = await keypair(dir, "other", "ed25519");
    const hub = register({ acme: account("acc-1", key), other: account("acc-2", other) });
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
    try {
      const { stdout } = await exec("ssh-add", ["-L"], { env: { ...process.env, SSH_AUTH_SOCK: path } });
      assert.equal(stdout.trim(), key.publicKey);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a temporary box gets no identity, and a sign request is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "ed25519");
    const hub = register({ acme: account("acc-1", key) });
    // A stale project field must never let a temporary box borrow a workspace identity.
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-2", record: { ...temporaryRecord(), project: projectRecord("acme").project } });
    try {
      await assert.rejects(exec("ssh-add", ["-L"], { env: { ...process.env, SSH_AUTH_SOCK: path } }), (error: { stdout?: string; code?: number }) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout ?? "", /no identities/);
        return true;
      });
      const blob = publicKeyBlob(key.publicKey)!.blob;
      const data = userauthData({ sessionId: randomBytes(32), user: "git", algorithm: "ssh-ed25519", keyBlob: blob });
      const reply = await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, signRequest(blob, data));
      assert.equal(reply[0], SSH_AGENT_FAILURE);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const type of ["ed25519", "rsa"] as const) {
  test(`ssh-keygen -Y sign through the agent is refused (${type})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
    try {
      const key = await keypair(dir, "acme", type);
      const hub = register({ acme: account("acc-1", key) });
      const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
      try {
        // Only the PUBLIC key is on the "box" side: ssh-keygen has to ask the agent, which must
        // refuse an SSHSIG blob (it is no user-authentication request).
        const pubOnly = join(dir, "box-key.pub");
        await writeFile(pubOnly, `${key.publicKey}\n`);
        const data = join(dir, "data.txt");
        await writeFile(data, "a commit to sign\n");
        await assert.rejects(exec("ssh-keygen", ["-Y", "sign", "-f", pubOnly, "-n", "git", data], { env: { ...process.env, SSH_AUTH_SOCK: path } }));
        await assert.rejects(readFile(`${data}.sig`), { code: "ENOENT" });
      } finally {
        server.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Real OpenSSH: a throwaway sshd on loopback
// ---------------------------------------------------------------------------

/** A throwaway sshd on loopback (non-root) that accepts `authorizedKey`; null when sshd cannot run here. */
async function startSshd(dir: string, authorizedKey: string): Promise<{ port: number; hostKeyLine: string; stop(): void } | null> {
  const sshd = "/usr/sbin/sshd";
  try {
    await exec(sshd, ["-V"]).catch((error: { stderr?: string }) => {
      if (!/OpenSSH/.test(error.stderr ?? "")) throw error;
    });
  } catch {
    return null;
  }
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-f", join(dir, "host_key"), "-N", ""]);
  await writeFile(join(dir, "authorized_keys"), `${authorizedKey}\n`, { mode: 0o600 });
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolve(address.port));
    });
  });
  const config = join(dir, "sshd_config");
  await writeFile(
    config,
    [
      `HostKey ${join(dir, "host_key")}`,
      `PidFile ${join(dir, "sshd.pid")}`,
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
      "ListenAddress 127.0.0.1",
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "ForceCommand echo orq-box-ok",
      ""
    ].join("\n")
  );
  const child = spawn(sshd, ["-D", "-e", "-f", config, "-p", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  const listening = await new Promise<boolean>((resolve) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += String(chunk);
      if (/Server listening on/.test(log)) resolve(true);
    });
    child.once("exit", () => resolve(false));
    child.once("error", () => resolve(false));
  });
  if (!listening) return null;
  const hostKeyLine = (await readFile(join(dir, "host_key.pub"), "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  return { port, hostKeyLine, stop: () => child.kill("SIGTERM") };
}

/** `ssh -v` to the throwaway sshd as `user`, through the agent at `agentPath`. */
async function sshLogin(sshd: { port: number; hostKeyLine: string }, dir: string, agentPath: string, user: string): Promise<{ stdout: string; stderr: string; code: unknown }> {
  // The CLIENT trusts the real sshd key (as the box's own known_hosts would); what the agent binds
  // to is decided by the policy under test.
  const clientKnownHosts = join(dir, `client_known_hosts_${randomBytes(4).toString("hex")}`);
  await writeFile(clientKnownHosts, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`);
  const result = await exec(
    "ssh",
    [
      "-v",
      "-T",
      "-F",
      "/dev/null",
      "-p",
      String(sshd.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${clientKnownHosts}`,
      "-o",
      "IdentityFile=none",
      "-o",
      `IdentityAgent=${agentPath}`,
      "-o",
      "PreferredAuthentications=publickey",
      `${user}@127.0.0.1`
    ],
    { env: { ...process.env, SSH_AUTH_SOCK: agentPath }, timeout: 30_000 }
  ).then(
    (output) => ({ ...output, code: 0 }),
    (error: { stdout?: string; stderr?: string; code?: unknown }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code })
  );
  return result;
}

async function policyFor(key: { keyPath: string; publicKey: string }, user: string, knownHosts: string, port: number): Promise<SshAgentPolicy> {
  const identity = await loadAccountIdentity(key);
  assert.ok(identity, "the test key loads");
  return { identity, user, hostKeys: trustedHostKeys({ host: "127.0.0.1", port }, knownHosts) };
}

for (const type of ["ed25519", "rsa"] as const) {
  test(`a real sshd login (session-bind + host-bound userauth) succeeds for the configured user (${type})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
    try {
      const key = await keypair(dir, "acme", type);
      const sshd = await startSshd(dir, key.publicKey);
      if (sshd === null) {
        t.skip("sshd cannot run on this machine");
        return;
      }
      try {
        // sshd running unprivileged authenticates only its own user: that is "the git user" here.
        const user = await localUser();
        const policy = await policyFor(key, user, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`, sshd.port);
        const agent = await policySocket(dir, policy);
        try {
          const result = await sshLogin(sshd, dir, agent.path, user);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.stdout, "orq-box-ok\n");
        } finally {
          agent.server.close();
        }
      } finally {
        sshd.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("a real sshd login is refused when the agent may sign only for another user, or the host key is not the git host's", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "ed25519");
    const sshd = await startSshd(dir, key.publicKey);
    if (sshd === null) {
      t.skip("sshd cannot run on this machine");
      return;
    }
    try {
      const user = await localUser();
      const trusted = `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`;

      // The server takes the key, but the agent signs only for "git".
      const gitOnly = await policySocket(dir, await policyFor(key, "git", trusted, sshd.port));
      try {
        const result = await sshLogin(sshd, dir, gitOnly.path, user);
        assert.equal(result.code, 255, result.stderr);
        assert.match(result.stderr, /Server accepts key: .*agent/);
        assert.match(result.stderr, /agent refused operation|signing failed/);
      } finally {
        gitOnly.server.close();
      }

      // The git host's known_hosts lists another key: the bind is refused, and so is every signature after it.
      const elsewhere = hostKey().line(`[127.0.0.1]:${sshd.port}`);
      const wrongHost = await policySocket(dir, await policyFor(key, user, `${elsewhere}\n`, sshd.port));
      try {
        const result = await sshLogin(sshd, dir, wrongHost.path, user);
        assert.equal(result.code, 255, result.stderr);
        assert.match(result.stderr, /Server accepts key: .*agent/);
        assert.match(result.stderr, /agent refused operation|signing failed/);
      } finally {
        wrongHost.server.close();
      }
    } finally {
      sshd.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The restricted signer, message by message
// ---------------------------------------------------------------------------

async function edPolicy(dir: string, knownHosts: string, user = "git"): Promise<{ policy: SshAgentPolicy; blob: Buffer; publicKey: KeyObject }> {
  const key = await keypair(dir, "acme", "ed25519");
  const identity = await loadAccountIdentity(key);
  assert.ok(identity);
  return {
    policy: { identity, user, hostKeys: trustedHostKeys({ host: "github.com", port: null }, knownHosts) },
    blob: identity.blob,
    publicKey: createPublicKey(identity.key)
  };
}

test("only a userauth request for the git user with the account key is signed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const { policy, blob, publicKey } = await edPolicy(dir, "");
    const session = new SshAgentSession(policy);
    const sessionId = randomBytes(32);
    const ok = userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob });
    const reply = session.reply(Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), signRequest(blob, ok)]));
    assert.equal(reply[4], SSH_AGENT_SIGN_RESPONSE);
    const [signature] = readString(reply, 5);
    const [, next] = readString(signature, 0);
    const [raw] = readString(signature, next);
    assert.ok(cryptoVerify(null, ok, publicKey, raw), "the signature is over the userauth request");

    const refused = (data: Buffer, keyBlob = blob, flags = 0): void => {
      const answer = session.reply(Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), signRequest(keyBlob, data, flags)]));
      assert.equal(answer[4], SSH_AGENT_FAILURE);
    };
    refused(userauthData({ sessionId, user: "octo", algorithm: "ssh-ed25519", keyBlob: blob }));
    refused(userauthData({ sessionId, user: "root", algorithm: "ssh-ed25519", keyBlob: blob }));
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, service: "ssh-userauth" }));
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, method: "hostbased" }));
    refused(userauthData({ sessionId, user: "git", algorithm: "rsa-sha2-256", keyBlob: blob }));
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, trailing: Buffer.from([0]) }));
    refused(userauthData({ sessionId: Buffer.alloc(0), user: "git", algorithm: "ssh-ed25519", keyBlob: blob }));
    // A host-bound request names a host key, but this connection was never bound.
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, hostKey: hostKey().blob }));
    // SSHSIG ("SSHSIG" magic, namespace, hash, message hash) and plain data.
    refused(Buffer.concat([Buffer.from("SSHSIG"), sshString("git"), sshString(""), sshString("sha512"), sshString(randomBytes(64))]));
    refused(Buffer.from("anything at all"));
    // Another key named in the request.
    const stranger = publicKeyBlob((await keypair(dir, "stranger", "ed25519")).publicKey)!.blob;
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: stranger }), stranger);
    refused(userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: stranger }));
    assert.equal(parseUserauthRequest(ok)?.method, "publickey");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session-bind: a known git-host key binds the connection; a wrong key, a bad signature or a forwarding bind are refused and poison it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const github = hostKey();
    const { policy, blob } = await edPolicy(dir, `${github.line("github.com")}\n`);
    const bind = (session: SshAgentSession, body: Buffer): number => session.reply(Buffer.concat([Buffer.from([SSH_AGENTC_EXTENSION]), body]))[4]!;
    const sign = (session: SshAgentSession, data: Buffer): number => session.reply(Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), signRequest(blob, data)]))[4]!;

    // Bound to github.com's key: signatures only for that session (and, host-bound, that key).
    const sessionId = randomBytes(32);
    const good = new SshAgentSession(policy);
    assert.equal(bind(good, sessionBind(github.blob, sessionId, github.sign(sessionId))), SSH_AGENT_SUCCESS);
    assert.equal(sign(good, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_SIGN_RESPONSE);
    assert.equal(sign(good, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, hostKey: github.blob })), SSH_AGENT_SIGN_RESPONSE);
    assert.equal(sign(good, userauthData({ sessionId: randomBytes(32), user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_FAILURE);
    assert.equal(sign(good, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob, hostKey: hostKey().blob })), SSH_AGENT_FAILURE);
    // One bind per connection.
    const again = randomBytes(32);
    assert.equal(bind(good, sessionBind(github.blob, again, github.sign(again))), SSH_AGENT_FAILURE);
    assert.equal(sign(good, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_FAILURE, "a refused bind poisons the connection");

    // A host key that is not the git host's (a correctly signed one).
    const mitm = hostKey();
    const wrong = new SshAgentSession(policy);
    assert.equal(bind(wrong, sessionBind(mitm.blob, sessionId, mitm.sign(sessionId))), SSH_AGENT_FAILURE);
    assert.equal(sign(wrong, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_FAILURE);

    // The git host's key, but a signature by another key.
    const forged = new SshAgentSession(policy);
    assert.equal(bind(forged, sessionBind(github.blob, sessionId, mitm.sign(sessionId))), SSH_AGENT_FAILURE);
    assert.equal(sign(forged, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_FAILURE);

    // A forwarding bind (the agent forwarded on to another machine).
    const forwarded = new SshAgentSession(policy);
    assert.equal(bind(forwarded, sessionBind(github.blob, sessionId, github.sign(sessionId), true)), SSH_AGENT_FAILURE);
    assert.equal(sign(forwarded, userauthData({ sessionId, user: "git", algorithm: "ssh-ed25519", keyBlob: blob })), SSH_AGENT_FAILURE);

    // Another extension.
    const other = new SshAgentSession(policy);
    assert.equal(bind(other, sshString("query")), SSH_AGENT_FAILURE);

    // A revoked key binds nothing even when also listed as trusted.
    const revoked = new SshAgentSession({ ...policy, hostKeys: trustedHostKeys({ host: "github.com", port: null }, `${github.line("github.com")}\n@revoked ${github.line("github.com")}\n`) });
    assert.equal(bind(revoked, sessionBind(github.blob, sessionId, github.sign(sessionId))), SSH_AGENT_FAILURE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RSA userauth signatures honour the rsa-sha2-256/512 flags and must match the requested algorithm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "rsa");
    const hub = register({ acme: account("acc-1", key) });
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
    try {
      const blob = publicKeyBlob(key.publicKey)!.blob;
      const publicKey = createPublicKey(parseSshPrivateKey(await readFile(key.keyPath, "utf8")).key);
      for (const [flags, algorithm, hash] of [
        [SSH_AGENT_RSA_SHA2_256, "rsa-sha2-256", "sha256"],
        [SSH_AGENT_RSA_SHA2_512, "rsa-sha2-512", "sha512"],
        [0, "ssh-rsa", "sha1"]
      ] as const) {
        const data = userauthData({ sessionId: randomBytes(32), user: "git", algorithm, keyBlob: blob });
        const reply = await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, signRequest(blob, data, flags));
        assert.equal(reply[0], SSH_AGENT_SIGN_RESPONSE);
        const [signature] = readString(reply, 1);
        const [name, next] = readString(signature, 0);
        const [raw] = readString(signature, next);
        assert.equal(name.toString(), algorithm);
        assert.ok(cryptoVerify(hash, data, publicKey, raw), `${algorithm} verifies`);
      }
      const mismatch = userauthData({ sessionId: randomBytes(32), user: "git", algorithm: "rsa-sha2-512", keyBlob: blob });
      assert.equal((await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, signRequest(blob, mismatch, SSH_AGENT_RSA_SHA2_256)))[0], SSH_AGENT_FAILURE);
      const addIdentity = await agentRequest(path, 17, sshString("ssh-ed25519"));
      assert.equal(addIdentity[0], SSH_AGENT_FAILURE);
      const identities = await agentRequest(path, SSH_AGENTC_REQUEST_IDENTITIES);
      assert.equal(identities.readUInt32BE(1), 1);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a key file that does not match the advertised public key is never offered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "ed25519");
    const other = await keypair(dir, "other", "ed25519");
    const hub = register({ acme: account("acc-1", { keyPath: other.keyPath, publicKey: key.publicKey }) });
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
    try {
      const identities = await agentRequest(path, SSH_AGENTC_REQUEST_IDENTITIES);
      assert.equal(identities.readUInt32BE(1), 0);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host-key signatures verify for ed25519, RSA and ECDSA keys (real ssh-keygen host keys)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    for (const [type, bits] of [["ed25519", null], ["rsa", "2048"], ["ecdsa", "256"], ["ecdsa", "384"], ["ecdsa", "521"]] as const) {
      const path = join(dir, `host_${type}_${bits ?? ""}`);
      await exec("ssh-keygen", ["-q", "-t", type, ...(bits ? ["-b", bits] : []), "-f", path, "-N", ""]);
      const blob = publicKeyBlob(await readFile(`${path}.pub`, "utf8"))!.blob;
      const data = join(dir, `data_${type}_${bits ?? ""}`);
      const sessionId = randomBytes(32);
      await writeFile(data, sessionId);
      // An SSHSIG carries the raw signature in the same (algorithm, bytes) blob a session-bind does.
      await exec("ssh-keygen", ["-Y", "sign", "-f", path, "-n", "file", data]);
      const armored = await readFile(`${data}.sig`, "utf8");
      const sshsig = Buffer.from(armored.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
      // MAGIC(6) version(4) publickey namespace reserved hash_algorithm signature.
      let offset = 10;
      [, offset] = readString(sshsig, offset);
      [, offset] = readString(sshsig, offset);
      [, offset] = readString(sshsig, offset);
      const [hashAlgorithm, afterHash] = readString(sshsig, offset);
      const [signature] = readString(sshsig, afterHash);
      const signedData = Buffer.concat([
        Buffer.from("SSHSIG"),
        sshString("file"),
        sshString(""),
        sshString(hashAlgorithm),
        sshString(createHash(hashAlgorithm.toString()).update(sessionId).digest())
      ]);
      assert.ok(verifySshSignature(blob, signedData, signature), `${type} ${bits ?? ""} verifies`);
      assert.ok(!verifySshSignature(blob, Buffer.concat([signedData, Buffer.from("x")]), signature), `${type} ${bits ?? ""} rejects other data`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No token, ever; SSH-only git config
// ---------------------------------------------------------------------------

test("git.credential answers nothing for every operation, host and box", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "ed25519");
    const hub = register({ acme: account("acc-1", key) });
    // Stand-in for `orq-agent git-credential <op>`: forwards stdin to the "host" over a socket
    // and prints the answer, as the real helper does over its box link.
    const socketPath = join(dir, "credential.sock");
    let context: BoxRequestContext = { boxId: "box-1", record: projectRecord("acme") };
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let body = "";
      socket.on("data", (chunk) => (body += String(chunk)));
      socket.on("end", () => {
        const { operation, input } = JSON.parse(body) as { operation: "get" | "store" | "erase"; input: string };
        void hub.credential(context, { operation, input }).then(({ output }) => socket.end(output));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const helper = join(dir, "helper.mjs");
    await writeFile(
      helper,
      [
        'import { createConnection } from "node:net";',
        "let input = '';",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        `  const socket = createConnection(${JSON.stringify(socketPath)}, () => socket.end(JSON.stringify({ operation: process.argv[2], input })));`,
        "  socket.pipe(process.stdout);",
        "});"
      ].join("\n")
    );
    const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const fill = (input: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn("git", ["-c", "credential.helper=", "-c", `credential.helper=!node ${helper}`, "credential", "fill"], { env, cwd: dir });
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.on("exit", (code) => resolve({ code, stdout }));
        child.stdin.end(input);
      });
    try {
      for (const input of ["protocol=https\nhost=github.com\npath=octo/app.git\n\n", "protocol=https\nhost=github.com\nusername=octo\n\n", "protocol=https\nhost=gitlab.com\n\n"]) {
        const answer = await fill(input);
        assert.notEqual(answer.code, 0);
        assert.doesNotMatch(answer.stdout, /password=/);
      }
      context = { boxId: "box-2", record: temporaryRecord() };
      assert.notEqual((await fill("protocol=https\nhost=github.com\n\n")).code, 0);
      for (const operation of ["get", "store", "erase"] as const) {
        assert.deepEqual(await hub.credential({ boxId: "box-1", record: projectRecord("acme") }, { operation, input: "protocol=https\nhost=github.com\n" }), { output: "" });
      }
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("boxGitConfig rewrites the account's HTTPS URLs to SSH (git applies it) and keeps only the git host's keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const github = { provider: "github", login: "octo" } as const;
    const salt = randomBytes(20);
    const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("github.com").digest("base64")}`;
    const userKey = hostKey();
    const otherHost = hostKey();
    const config = boxGitConfig(github, [userKey.line(hashed), otherHost.line("gitlab.com"), `@cert-authority *.github.com ${otherHost.line("x").split(" ").slice(1).join(" ")}`, ""].join("\n"))!;
    assert.deepEqual(config.target, { user: "git", host: "github.com", port: null, httpsPrefixes: ["https://github.com/"], sshBase: "git@github.com:" });
    assert.deepEqual(config.entries, [{ key: "url.git@github.com:.insteadOf", value: "https://github.com/" }]);
    const known = config.knownHosts.trim().split("\n");
    assert.equal(known[0], userKey.line("github.com"), "a hashed entry is kept, under the plain name");
    assert.equal(known.length, 4, "the user's key plus GitHub's three pinned keys");
    assert.ok(known.every((line) => line.startsWith("github.com ")));
    assert.ok(!config.knownHosts.includes(otherHost.blob.toString("base64")), "no other host's key, no CA");

    // git itself applies the rewrite (no network: `ls-remote --get-url` only expands the URL).
    const gitconfig = join(dir, "gitconfig");
    await writeFile(gitconfig, config.gitconfig);
    const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
    const { stdout } = await exec("git", ["ls-remote", "--get-url", "https://github.com/octo/app.git"], { env, cwd: dir });
    assert.equal(stdout.trim(), "git@github.com:octo/app.git");
    const elsewhere = await exec("git", ["ls-remote", "--get-url", "https://gitlab.com/octo/app.git"], { env, cwd: dir });
    assert.equal(elsewhere.stdout.trim(), "https://gitlab.com/octo/app.git");

    assert.equal(boxCloneUrl(github, "https://github.com/octo/app.git"), "git@github.com:octo/app.git");
    assert.equal(boxCloneUrl(github, "https://octo@github.com/octo/app"), "git@github.com:octo/app");
    assert.equal(boxCloneUrl(github, "git@github.com:octo/app.git"), "git@github.com:octo/app.git");
    assert.equal(boxCloneUrl(github, "https://gitlab.com/octo/app.git"), "https://gitlab.com/octo/app.git");

    const cloud = { provider: "bitbucket-cloud", login: "nick" } as const;
    assert.deepEqual(boxGitSshTarget(cloud), { user: "git", host: "ssh.bitbucket.org", port: null, httpsPrefixes: ["https://bitbucket.org/"], sshBase: "git@ssh.bitbucket.org:" });
    assert.equal(boxCloneUrl(cloud, "https://bitbucket.org/ws/r.git"), "git@ssh.bitbucket.org:ws/r.git");

    const dc = { provider: "bitbucket-server", login: "jdoe", baseUrl: "https://bb.corp.example/bitbucket/", sshHost: "bb.corp.example:7999" } as const;
    const dcConfig = boxGitConfig(dc, `[bb.corp.example]:7999 ${userKey.line("x").split(" ").slice(1).join(" ")}\nbb.corp.example ${otherHost.line("x").split(" ").slice(1).join(" ")}\n`)!;
    assert.deepEqual(dcConfig.target, { user: "git", host: "bb.corp.example", port: 7999, httpsPrefixes: ["https://bb.corp.example/bitbucket/scm/"], sshBase: "ssh://git@bb.corp.example:7999/" });
    assert.equal(dcConfig.knownHosts, `${userKey.line("[bb.corp.example]:7999")}\n`, "only the entry for that port");
    assert.equal(boxCloneUrl(dc, "https://jdoe@bb.corp.example/bitbucket/scm/KEY/repo.git"), "ssh://git@bb.corp.example:7999/KEY/repo.git");
    assert.equal(boxCloneUrl(dc, "https://bb.corp.example/bitbucket/scm/~jdoe/repo.git"), "ssh://git@bb.corp.example:7999/~jdoe/repo.git");
    await writeFile(gitconfig, dcConfig.gitconfig);
    const dcUrl = await exec("git", ["ls-remote", "--get-url", "https://bb.corp.example/bitbucket/scm/KEY/repo.git"], { env, cwd: dir });
    assert.equal(dcUrl.stdout.trim(), "ssh://git@bb.corp.example:7999/KEY/repo.git");

    // A Data Center instance with SSH off: no SSH endpoint, so nothing for the box.
    assert.equal(boxGitConfig({ provider: "bitbucket-server", login: "jdoe", baseUrl: "https://bb.corp.example" }, ""), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("known_hosts host fields: patterns, negation, hashed names", () => {
  assert.ok(knownHostsFieldMatches("github.com,140.82.112.3", "github.com"));
  assert.ok(knownHostsFieldMatches("*.github.com,github.com", "github.com"));
  assert.ok(!knownHostsFieldMatches("*,!github.com", "github.com"));
  assert.ok(!knownHostsFieldMatches("[github.com]:22", "github.com"));
  assert.ok(knownHostsFieldMatches("[bb.corp]:7999", "[bb.corp]:7999"));
  assert.ok(!knownHostsFieldMatches("bb.corp", "[bb.corp]:7999"));
  const salt = randomBytes(20);
  assert.ok(knownHostsFieldMatches(`|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("[bb.corp]:7999").digest("base64")}`, "[bb.corp]:7999"));
  assert.ok(!knownHostsFieldMatches(`|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("bb.corp").digest("base64")}`, "[bb.corp]:7999"));
});

test("workspaceAccountFromFiles reads the bound account from the daemon stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const accountsFile = join(dir, "accounts.json");
    const workspacesMetaFile = join(dir, "workspaces.json");
    await writeFile(
      accountsFile,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: "acc-1", label: "work", provider: "github", login: "octo", gitName: "O", gitEmail: "o@x", publicKey: "ssh-ed25519 AAAA", keyPath: "/k", token: "t", createdAt: "x" }
        ]
      })
    );
    await writeFile(
      workspacesMetaFile,
      JSON.stringify({ version: 1, workspaces: [{ name: "acme", gitAccountId: "acc-1", createdAt: "x" }, { name: "solo", createdAt: "x" }] })
    );
    const lookup = workspaceAccountFromFiles({ accountsFile, workspacesMetaFile });
    assert.equal((await lookup("acme"))?.id, "acc-1");
    assert.equal(await lookup("solo"), null);
    assert.equal(await lookup("missing"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
