import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
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
  SSH_AGENT_FAILURE,
  SSH_AGENT_RSA_SHA2_256,
  SSH_AGENT_RSA_SHA2_512,
  SSH_AGENT_SIGN_RESPONSE,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  credentialAnswer,
  parseSshPrivateKey,
  publicKeyBlob,
  registerBoxGitAuth,
  workspaceAccountFromFiles,
  type BoxGitAccount
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
function register(accounts: Record<string, BoxGitAccount>): FakeHub {
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
    { workspaceAccount: async (workspace) => accounts[workspace] ?? null }
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
  return { id, provider: "github", login: "octo", publicKey: key.publicKey, keyPath: key.keyPath, token: "ghp_test_token", ...extra };
}

/** A Unix-socket ssh-agent served by the handler for one box context. */
async function agentSocket(dir: string, hub: FakeHub, context: BoxRequestContext): Promise<{ path: string; server: Server }> {
  const path = join(dir, `agent-${context.boxId}.sock`);
  const server = createServer((socket: Socket) => hub.agent(context, { kind: "ssh-agent" } as BoxChannelSpec, socket));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, server };
}

/** One raw request/response exchange with the agent. */
async function agentRequest(path: string, type: number, body: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  const socket = createConnection(path);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = type;
  socket.write(Buffer.concat([header, body]));
  let data = Buffer.alloc(0);
  return await new Promise<Buffer>((resolve, reject) => {
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 4 && data.length >= 4 + data.readUInt32BE(0)) {
        socket.end();
        resolve(data.subarray(4, 4 + data.readUInt32BE(0)));
      }
    });
    socket.on("error", reject);
  });
}

const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

function readString(buffer: Buffer, offset: number): [Buffer, number] {
  const length = buffer.readUInt32BE(offset);
  return [buffer.subarray(offset + 4, offset + 4 + length), offset + 4 + length];
}

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
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-2", record: temporaryRecord() });
    try {
      await assert.rejects(exec("ssh-add", ["-L"], { env: { ...process.env, SSH_AUTH_SOCK: path } }), (error: { stdout?: string; code?: number }) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout ?? "", /no identities/);
        return true;
      });
      const blob = publicKeyBlob(key.publicKey)!.blob;
      const reply = await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, Buffer.concat([sshString(blob), sshString("data"), Buffer.alloc(4)]));
      assert.equal(reply[0], SSH_AGENT_FAILURE);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const type of ["ed25519", "rsa"] as const) {
  test(`ssh-keygen -Y sign through the agent verifies against the account key (${type})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
    try {
      const key = await keypair(dir, "acme", type);
      const hub = register({ acme: account("acc-1", key) });
      const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
      try {
        // Only the PUBLIC key is on the "box" side: the private key file is moved out of reach of
        // ssh-keygen, which then has to ask the agent for the signature.
        const pubOnly = join(dir, "box-key.pub");
        await writeFile(pubOnly, `${key.publicKey}\n`);
        const data = join(dir, "data.txt");
        await writeFile(data, "signed through the host\n");
        const env = { ...process.env, SSH_AUTH_SOCK: path };
        await exec("ssh-keygen", ["-Y", "sign", "-f", pubOnly, "-n", "git", data], { env });
        const signers = join(dir, "allowed_signers");
        await writeFile(signers, `test@orquester ${key.publicKey}\n`);
        const verify = spawn("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", "test@orquester", "-n", "git", "-s", `${data}.sig`], { env });
        verify.stdin.end(await readFile(data));
        let output = "";
        verify.stdout.on("data", (chunk) => (output += String(chunk)));
        const code = await new Promise<number | null>((resolve) => verify.on("exit", resolve));
        assert.equal(code, 0, output);
        assert.match(output, /Good "git" signature/);
      } finally {
        server.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** A throwaway sshd on loopback (non-root) that accepts `authorizedKey`; null when sshd cannot run here. */
async function startSshd(dir: string, authorizedKey: string): Promise<{ port: number; stop(): void } | null> {
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
  return { port, stop: () => child.kill("SIGTERM") };
}

for (const type of ["ed25519", "rsa"] as const) {
  test(`ssh -T authenticates to a real sshd with the host-held key through the agent (${type})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
    try {
      const key = await keypair(dir, "acme", type);
      const sshd = await startSshd(dir, key.publicKey);
      if (sshd === null) {
        t.skip("sshd cannot run on this machine");
        return;
      }
      const hub = register({ acme: account("acc-1", key) });
      const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
      try {
        // The login shell of the test user may be nologin, so the remote command's own exit is not
        // the signal: ssh's verbose log says whether public-key auth (signed by the agent) passed.
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
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "IdentityFile=none",
            "-o",
            `IdentityAgent=${path}`,
            "-o",
            "PreferredAuthentications=publickey",
            `${(await exec("id", ["-un"])).stdout.trim()}@127.0.0.1`
          ],
          { env: { ...process.env, SSH_AUTH_SOCK: path }, timeout: 30_000 }
        ).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
        assert.match(result.stderr, /Server accepts key: .*agent/);
        assert.match(result.stderr, /Authenticated to 127\.0\.0\.1 .*using "publickey"/);
      } finally {
        server.close();
        sshd.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("RSA sign requests honour the rsa-sha2-256/512 flags (verified with node:crypto)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-git-auth-"));
  try {
    const key = await keypair(dir, "acme", "rsa");
    const hub = register({ acme: account("acc-1", key) });
    const { path, server } = await agentSocket(dir, hub, { boxId: "box-1", record: projectRecord("acme") });
    try {
      const blob = publicKeyBlob(key.publicKey)!.blob;
      const publicKey = createPublicKey(parseSshPrivateKey(await readFile(key.keyPath, "utf8")).key);
      const data = Buffer.from("session-id and userauth request");
      for (const [flags, algorithm, hash] of [
        [SSH_AGENT_RSA_SHA2_256, "rsa-sha2-256", "sha256"],
        [SSH_AGENT_RSA_SHA2_512, "rsa-sha2-512", "sha512"],
        [0, "ssh-rsa", "sha1"]
      ] as const) {
        const flagBytes = Buffer.alloc(4);
        flagBytes.writeUInt32BE(flags, 0);
        const reply = await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, Buffer.concat([sshString(blob), sshString(data), flagBytes]));
        assert.equal(reply[0], SSH_AGENT_SIGN_RESPONSE);
        const [signature] = readString(reply, 1);
        const [name, next] = readString(signature, 0);
        const [raw] = readString(signature, next);
        assert.equal(name.toString(), algorithm);
        assert.ok(cryptoVerify(hash, data, publicKey, raw), `${algorithm} verifies`);
      }
      // A key the agent does not hold, and an unsupported message, both fail.
      const stranger = publicKeyBlob((await keypair(dir, "stranger", "ed25519")).publicKey)!.blob;
      const refused = await agentRequest(path, SSH_AGENTC_SIGN_REQUEST, Buffer.concat([sshString(stranger), sshString(data), Buffer.alloc(4)]));
      assert.equal(refused[0], SSH_AGENT_FAILURE);
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

test("credential answers cover only the account's host over https", () => {
  const github = { id: "a", provider: "github", login: "octo", publicKey: "", keyPath: "", token: "tok" } as BoxGitAccount;
  assert.equal(credentialAnswer(github, "get", "protocol=https\nhost=github.com\n\n"), "username=octo\npassword=tok\n");
  assert.equal(credentialAnswer(github, "get", "protocol=https\nhost=GitHub.com\npath=o/r.git\n"), "username=octo\npassword=tok\n");
  assert.equal(credentialAnswer(github, "get", "url=https://github.com/o/r.git\n"), "username=octo\npassword=tok\n");
  assert.equal(credentialAnswer(github, "get", "protocol=https\nhost=gitlab.com\n"), "");
  assert.equal(credentialAnswer(github, "get", "protocol=http\nhost=github.com\n"), "");
  assert.equal(credentialAnswer(github, "get", "protocol=https\nhost=github.com\nusername=someone\n"), "");
  assert.equal(credentialAnswer(github, "store", "protocol=https\nhost=github.com\nusername=octo\npassword=x\n"), "");
  assert.equal(credentialAnswer({ ...github, token: undefined }, "get", "protocol=https\nhost=github.com\n"), "");
  assert.equal(credentialAnswer(null, "get", "protocol=https\nhost=github.com\n"), "");
  const cloud = { ...github, provider: "bitbucket-cloud" } as BoxGitAccount;
  assert.equal(credentialAnswer(cloud, "get", "protocol=https\nhost=bitbucket.org\n"), "username=x-bitbucket-api-token-auth\npassword=tok\n");
  const server = { ...github, provider: "bitbucket-server", baseUrl: "https://bb.corp.example:8443/scm" } as BoxGitAccount;
  assert.equal(credentialAnswer(server, "get", "protocol=https\nhost=bb.corp.example:8443\n"), "username=octo\npassword=tok\n");
  assert.equal(credentialAnswer(server, "get", "protocol=https\nhost=bb.corp.example\n"), "");
});

test("git credential fill gets the token through the box helper flow; other hosts and boxes get nothing", async () => {
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
      const ok = await fill("protocol=https\nhost=github.com\npath=octo/app.git\n\n");
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /^username=octo$/m);
      assert.match(ok.stdout, /^password=ghp_test_token$/m);

      const elsewhere = await fill("protocol=https\nhost=gitlab.com\n\n");
      assert.notEqual(elsewhere.code, 0);
      assert.doesNotMatch(elsewhere.stdout, /ghp_test_token/);

      context = { boxId: "box-2", record: temporaryRecord() };
      const temporary = await fill("protocol=https\nhost=github.com\n\n");
      assert.notEqual(temporary.code, 0);
      assert.doesNotMatch(temporary.stdout, /ghp_test_token/);
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
