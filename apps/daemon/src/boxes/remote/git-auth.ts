/**
 * Git authentication for boxes without any key or token in the box (spec §7
 * "Git"). Two box → host entry points, registered on the hub:
 *
 * - `git.credential` (request): the git credential-helper protocol behind
 *   `orq-agent git-credential <get|store|erase>`. `get` answers with the HTTPS
 *   username + token of the Git hosting account bound to the box project's
 *   workspace — only for that account's own host (`credentialSpec`), and
 *   nothing for any other host. `store` and `erase` are accepted and ignored:
 *   the box never teaches the host a credential.
 * - `ssh-agent` (channel): the OpenSSH agent protocol, served on the host.
 *   `REQUEST_IDENTITIES` lists the bound account's public key; `SIGN_REQUEST`
 *   signs with its private key from `<appdir>/daemon/keys` (ed25519, and RSA
 *   with the `rsa-sha2-256`/`rsa-sha2-512` flags); every other message gets
 *   `SSH_AGENT_FAILURE`. The private key is read here and never leaves the
 *   daemon process — only signatures go to the box.
 *
 * Scope: a project box can use ONLY its own workspace's account. A temporary
 * box (no project) gets no git identity at all. Nothing here logs a token, a
 * key, a credential request's fields or the data being signed.
 */

import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import type { Account } from "@orquester/config";
import { parseAccountsConfig, parseWorkspacesConfig } from "@orquester/config";

import { providerFor } from "../../providers/index.ts";
import type { BoxHub, BoxRequestContext } from "../contracts.ts";

// ---------------------------------------------------------------------------
// Which account a box may use
// ---------------------------------------------------------------------------

/** The account fields git auth needs (a stored `Account`; host-only — it holds the key path and token). */
export type BoxGitAccount = Pick<Account, "id" | "provider" | "login" | "email" | "baseUrl" | "sshHost" | "publicKey" | "keyPath" | "token">;

export interface BoxGitAuthDeps {
  /** The Git hosting account bound to the workspace named `workspace` (`workspaces.json` `gitAccountId`), or null. */
  workspaceAccount(workspace: string): Promise<BoxGitAccount | null>;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * `workspaceAccount` over the daemon's own stores, read at every call (both are
 * small, and an account rebound or re-keyed in Settings applies at once).
 */
export function workspaceAccountFromFiles(files: { accountsFile: string; workspacesMetaFile: string }): BoxGitAuthDeps["workspaceAccount"] {
  return async (workspace) => {
    let accountId: string | undefined;
    try {
      const meta = parseWorkspacesConfig(JSON.parse(await readFile(files.workspacesMetaFile, "utf8")));
      accountId = meta.workspaces.find((entry) => entry.name === workspace)?.gitAccountId;
    } catch {
      return null;
    }
    if (!accountId) return null;
    try {
      const accounts = parseAccountsConfig(JSON.parse(await readFile(files.accountsFile, "utf8")));
      return accounts.accounts.find((account) => account.id === accountId) ?? null;
    } catch {
      return null;
    }
  };
}

/** The account a box may authenticate as: its project's workspace account; none for a temporary box. */
async function accountForBox(context: BoxRequestContext, deps: BoxGitAuthDeps): Promise<BoxGitAccount | null> {
  const project = context.record.project;
  if (context.record.purpose !== "project" || !project?.workspace) return null;
  return deps.workspaceAccount(project.workspace);
}

// ---------------------------------------------------------------------------
// git credential helper protocol
// ---------------------------------------------------------------------------

/** `key=value` lines of a credential request (the last value of a repeated key wins; `key[]` lists are ignored). */
export function parseCredentialRequest(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (line.length === 0) break;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (key.endsWith("[]")) continue;
    fields[key] = line.slice(eq + 1);
  }
  if ((!fields.protocol || !fields.host) && fields.url) {
    try {
      const url = new URL(fields.url);
      fields.protocol ??= url.protocol.replace(/:$/, "");
      fields.host ??= url.host;
      if (url.username && !fields.username) fields.username = decodeURIComponent(url.username);
    } catch {
      // not a URL: answer nothing below
    }
  }
  return fields;
}

const SAFE_CREDENTIAL_VALUE = /^[^\0\r\n]*$/;

/**
 * The helper's stdout for one request: `username=…\npassword=…\n` when the
 * account covers the request's host over HTTPS, else "" (git then tries its
 * next helper or fails without prompting).
 */
export function credentialAnswer(account: BoxGitAccount | null, operation: string, input: string): string {
  if (operation !== "get" || !account?.token) return "";
  const request = parseCredentialRequest(input);
  if ((request.protocol ?? "").toLowerCase() !== "https" || !request.host) return "";
  let spec: { host: string; username: string };
  try {
    spec = providerFor(account.provider).credentialSpec({
      ...(account.baseUrl !== undefined ? { baseUrl: account.baseUrl } : {}),
      ...(account.sshHost !== undefined ? { sshHost: account.sshHost } : {}),
      login: account.login,
      ...(account.email !== undefined ? { email: account.email } : {})
    });
  } catch {
    return "";
  }
  if (request.host.toLowerCase() !== spec.host.toLowerCase()) return "";
  // A URL naming another user (https://someone@host/…) is not this account's to answer, as with
  // git's own credential store.
  if (request.username !== undefined && request.username !== "" && request.username !== spec.username) return "";
  if (!SAFE_CREDENTIAL_VALUE.test(spec.username) || !SAFE_CREDENTIAL_VALUE.test(account.token)) return "";
  return `username=${spec.username}\npassword=${account.token}\n`;
}

// ---------------------------------------------------------------------------
// SSH wire encoding
// ---------------------------------------------------------------------------

class SshReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  uint32(): number {
    if (this.remaining < 4) throw new Error("truncated uint32");
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length: number): Buffer {
    if (this.remaining < length) throw new Error("truncated field");
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function sshUint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

/** An mpint's magnitude without the sign-padding zero bytes, base64url (JWK). */
function mpintToBase64Url(mpint: Buffer): string {
  let start = 0;
  while (start < mpint.length - 1 && mpint[start] === 0) start += 1;
  return mpint.subarray(start).toString("base64url");
}

function mpintToBigInt(mpint: Buffer): bigint {
  return mpint.length === 0 ? 0n : BigInt(`0x${mpint.toString("hex")}`);
}

function bigIntToBase64Url(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type SshKeyType = "ssh-ed25519" | "ssh-rsa";

export interface SshIdentity {
  type: SshKeyType;
  /** The public key blob, as `ssh-add -L` prints it base64-encoded. */
  blob: Buffer;
  comment: string;
  key: KeyObject;
}

/** The blob of an OpenSSH public key line (`ssh-ed25519 AAAA… comment`). */
export function publicKeyBlob(line: string): { type: string; blob: Buffer; comment: string } | null {
  const [type, data, ...comment] = line.trim().split(/\s+/);
  if (!type || !data) return null;
  const blob = Buffer.from(data, "base64");
  try {
    const embedded = new SshReader(blob).string().toString("utf8");
    if (embedded !== type) return null;
  } catch {
    return null;
  }
  return { type, blob, comment: comment.join(" ") };
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "latin1");

/**
 * Parse an UNENCRYPTED private key file as `ssh-keygen -N ""` writes it: the
 * `openssh-key-v1` container (ed25519 and RSA), or a PEM RSA key from an older
 * `ssh-keygen -m PEM`. Throws on anything else (an encrypted key included —
 * the daemon's keys are generated without a passphrase).
 */
export function parseSshPrivateKey(text: string): { type: SshKeyType; key: KeyObject; publicBlob: Buffer | null } {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!match) {
    // PEM (PKCS#1 / PKCS#8): node reads it directly.
    const key = createPrivateKey({ key: text, format: "pem" });
    if (key.asymmetricKeyType === "rsa") return { type: "ssh-rsa", key, publicBlob: null };
    if (key.asymmetricKeyType === "ed25519") return { type: "ssh-ed25519", key, publicBlob: null };
    throw new Error(`Unsupported private key type: ${key.asymmetricKeyType ?? "unknown"}`);
  }
  const data = Buffer.from(match[1]!.replace(/\s+/g, ""), "base64");
  if (!data.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) throw new Error("Not an openssh-key-v1 file");
  const reader = new SshReader(data.subarray(OPENSSH_MAGIC.length));
  const cipher = reader.string().toString("utf8");
  const kdf = reader.string().toString("utf8");
  reader.string(); // kdf options
  if (cipher !== "none" || kdf !== "none") throw new Error("Encrypted private keys are not supported");
  const count = reader.uint32();
  if (count !== 1) throw new Error(`Expected one key, found ${count}`);
  const publicBlob = Buffer.from(reader.string());
  const section = new SshReader(reader.string());
  if (section.uint32() !== section.uint32()) throw new Error("Private key check bytes do not match");
  const type = section.string().toString("utf8");
  if (type === "ssh-ed25519") {
    const pub = section.string();
    const priv = section.string();
    if (pub.length !== 32 || priv.length !== 64) throw new Error("Malformed ed25519 key");
    const key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: priv.subarray(0, 32).toString("base64url"), x: pub.toString("base64url") },
      format: "jwk"
    });
    return { type, key, publicBlob };
  }
  if (type === "ssh-rsa") {
    const n = section.string();
    const e = section.string();
    const d = section.string();
    const iqmp = section.string();
    const p = section.string();
    const q = section.string();
    const dBig = mpintToBigInt(d);
    const key = createPrivateKey({
      key: {
        kty: "RSA",
        n: mpintToBase64Url(n),
        e: mpintToBase64Url(e),
        d: mpintToBase64Url(d),
        p: mpintToBase64Url(p),
        q: mpintToBase64Url(q),
        dp: bigIntToBase64Url(dBig % (mpintToBigInt(p) - 1n)),
        dq: bigIntToBase64Url(dBig % (mpintToBigInt(q) - 1n)),
        qi: mpintToBase64Url(iqmp)
      },
      format: "jwk"
    });
    return { type, key, publicBlob };
  }
  throw new Error(`Unsupported private key type: ${type}`);
}

/**
 * The identity of an account: its public key (from the account record) and
 * private key (from `keyPath`). Null when the account has no usable key or the
 * key file does not match the public key it advertises.
 */
export async function loadAccountIdentity(account: Pick<BoxGitAccount, "publicKey" | "keyPath">): Promise<SshIdentity | null> {
  const advertised = publicKeyBlob(account.publicKey);
  if (!advertised || (advertised.type !== "ssh-ed25519" && advertised.type !== "ssh-rsa")) return null;
  let parsed: ReturnType<typeof parseSshPrivateKey>;
  try {
    parsed = parseSshPrivateKey(await readFile(account.keyPath, "utf8"));
  } catch {
    return null;
  }
  if (parsed.type !== advertised.type) return null;
  if (parsed.publicBlob !== null && !parsed.publicBlob.equals(advertised.blob)) return null;
  return { type: parsed.type, blob: advertised.blob, comment: advertised.comment, key: parsed.key };
}

// ---------------------------------------------------------------------------
// The agent protocol
// ---------------------------------------------------------------------------

export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;
export const SSH_AGENT_RSA_SHA2_256 = 0x02;
export const SSH_AGENT_RSA_SHA2_512 = 0x04;

/** OpenSSH's own ceiling for one agent message. */
const MAX_AGENT_MESSAGE = 256 * 1024;

function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([sshUint32(body.length + 1), Buffer.from([type]), body]);
}

/** One SIGN_REQUEST answered with `identity`, or null (→ FAILURE). */
export function signForAgent(identity: SshIdentity, data: Buffer, flags: number): Buffer | null {
  if (identity.type === "ssh-ed25519") {
    return Buffer.concat([sshString("ssh-ed25519"), sshString(cryptoSign(null, data, identity.key))]);
  }
  const [algorithm, hash] =
    flags & SSH_AGENT_RSA_SHA2_512 ? ["rsa-sha2-512", "sha512"] : flags & SSH_AGENT_RSA_SHA2_256 ? ["rsa-sha2-256", "sha256"] : ["ssh-rsa", "sha1"];
  return Buffer.concat([sshString(algorithm), sshString(cryptoSign(hash, data, identity.key))]);
}

/** The reply to one agent request (`message` = type byte + body). */
export function agentReply(identity: SshIdentity | null, message: Buffer): Buffer {
  const type = message[0];
  try {
    if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
      const keys = identity ? [Buffer.concat([sshString(identity.blob), sshString(identity.comment)])] : [];
      return frame(SSH_AGENT_IDENTITIES_ANSWER, Buffer.concat([sshUint32(keys.length), ...keys]));
    }
    if (type === SSH_AGENTC_SIGN_REQUEST && identity) {
      const reader = new SshReader(message.subarray(1));
      const blob = reader.string();
      const data = reader.string();
      const flags = reader.remaining >= 4 ? reader.uint32() : 0;
      if (!blob.equals(identity.blob)) return frame(SSH_AGENT_FAILURE);
      const signature = signForAgent(identity, data, flags);
      return signature ? frame(SSH_AGENT_SIGN_RESPONSE, sshString(signature)) : frame(SSH_AGENT_FAILURE);
    }
  } catch {
    // a malformed request
  }
  return frame(SSH_AGENT_FAILURE);
}

/**
 * Serve the agent protocol on one stream (one box-side agent connection).
 * The identity is resolved once, on the first request that needs it; requests
 * are answered in order. An oversized frame ends the stream.
 */
export function serveSshAgent(stream: Duplex, resolveIdentity: () => Promise<SshIdentity | null>, onError?: (error: unknown) => void): void {
  let pending = Buffer.alloc(0);
  let identity: Promise<SshIdentity | null> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const identityOnce = (): Promise<SshIdentity | null> => {
    identity ??= resolveIdentity().catch((error: unknown) => {
      onError?.(error);
      return null;
    });
    return identity;
  };

  stream.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length === 0 || length > MAX_AGENT_MESSAGE) {
        stream.destroy();
        return;
      }
      if (pending.length < 4 + length) break;
      const message = pending.subarray(4, 4 + length);
      pending = pending.subarray(4 + length);
      queue = queue.then(async () => {
        const needsKey = message[0] === SSH_AGENTC_REQUEST_IDENTITIES || message[0] === SSH_AGENTC_SIGN_REQUEST;
        const reply = agentReply(needsKey ? await identityOnce() : null, message);
        if (!stream.destroyed && stream.writable) stream.write(reply);
      });
    }
  });
  stream.on("error", () => {
    // the box side went away; nothing to answer
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the `git.credential` handler and the `ssh-agent` channel on the hub. */
export function registerBoxGitAuth(hub: Pick<BoxHub, "handle" | "handleChannel">, deps: BoxGitAuthDeps): void {
  hub.handle("git.credential", async (context, params) => {
    if (params.operation !== "get") return { output: "" };
    try {
      return { output: credentialAnswer(await accountForBox(context, deps), params.operation, params.input) };
    } catch (error) {
      deps.logger?.warn("box git credential lookup failed", { boxId: context.boxId, error: error instanceof Error ? error.name : "error" });
      return { output: "" };
    }
  });

  hub.handleChannel("ssh-agent", (context, _spec, stream) => {
    serveSshAgent(
      stream,
      async () => {
        const account = await accountForBox(context, deps);
        return account ? loadAccountIdentity(account) : null;
      },
      (error) => deps.logger?.warn("box ssh-agent key load failed", { boxId: context.boxId, error: error instanceof Error ? error.name : "error" })
    );
  });
}
