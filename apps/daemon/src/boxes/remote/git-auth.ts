/**
 * Git authentication for boxes (spec §7 "Git"; owner decision: a box never
 * receives a git hosting token, in any form). Two box → host entry points,
 * registered on the hub:
 *
 * - `git.credential` (request): the git credential-helper protocol behind
 *   `orq-agent git-credential <get|store|erase>`. It ALWAYS answers nothing:
 *   HTTPS git in a box has no credentials. Box git reaches the account's host
 *   over SSH only — {@link boxGitConfig} gives the box setup the
 *   `url.<ssh>.insteadOf <https>` rewrites and the host keys to trust, and
 *   {@link boxCloneUrl} the SSH form of a clone URL.
 * - `ssh-agent` (channel): the OpenSSH agent protocol, served on the host with
 *   the bound account's key from `<appdir>/daemon/keys` (never sent to the box)
 *   and a RESTRICTED signer:
 *   - `REQUEST_IDENTITIES` lists the account's public key;
 *   - `SIGN_REQUEST` signs only an SSH public-key user-authentication request
 *     (RFC 4252 §7, or OpenSSH's `publickey-hostbound-v00@openssh.com`) for the
 *     provider's git user with that very key — never SSHSIG (`ssh-keygen -Y
 *     sign`, commit signing), never arbitrary data;
 *   - `session-bind@openssh.com` (extension) binds the connection to the
 *     server's host key once its signature over the session id verifies AND
 *     the key is a known_hosts key of the account's git host; a bind to any
 *     other key, a forwarding bind and a second bind are refused, and refuse
 *     every later signature on that connection. Once bound, a signature is
 *     only for that session (and, hostbound, that host key);
 *   - everything else is `SSH_AGENT_FAILURE`.
 *   A signature the box obtains can therefore only log in as the account (as
 *   the git user) — what SSH git at its host needs, and nothing more.
 *
 * Scope: a project box can use ONLY its own workspace's account. A temporary
 * box (no project) gets no git identity at all. Nothing here logs a key, a
 * credential request's fields or the data being signed.
 */

import { createHmac, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

import type { Account } from "@orquester/config";
import { parseAccountsConfig, parseWorkspacesConfig } from "@orquester/config";

import { providerFor } from "../../providers/index.ts";
import type { BoxHub, BoxRequestContext } from "../contracts.ts";

// ---------------------------------------------------------------------------
// Which account a box may use
// ---------------------------------------------------------------------------

/** The account fields git auth needs (a stored `Account`; host-only — it holds the key path). No token: a box never gets one. */
export type BoxGitAccount = Pick<Account, "id" | "provider" | "login" | "email" | "baseUrl" | "sshHost" | "publicKey" | "keyPath">;

/** The account fields that say where its git traffic goes. */
export type BoxGitEndpoint = Pick<BoxGitAccount, "provider" | "login" | "email" | "baseUrl" | "sshHost">;

export interface BoxGitAuthDeps {
  /** The Git hosting account bound to the workspace named `workspace` (`workspaces.json` `gitAccountId`), or null. */
  workspaceAccount(workspace: string): Promise<BoxGitAccount | null>;
  /**
   * known_hosts text the host trusts for `host` (`port` null = 22): the daemon's pinned file and
   * the daemon user's own entries (`service/known-hosts.ts` `knownHostsForBox`). Lines for other
   * hosts are ignored here.
   */
  knownHosts(host: string, port: number | null): Promise<string>;
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
async function accountForBox(context: BoxRequestContext, deps: Pick<BoxGitAuthDeps, "workspaceAccount">): Promise<BoxGitAccount | null> {
  const project = context.record.project;
  if (context.record.purpose !== "project" || !project?.workspace) return null;
  return deps.workspaceAccount(project.workspace);
}

// ---------------------------------------------------------------------------
// SSH-only git: the account's SSH endpoint, the box's git config, clone URLs
// ---------------------------------------------------------------------------

/** Where an account's git traffic goes over SSH, and as whom. */
export interface BoxGitSshTarget {
  /** The SSH user the git host authenticates ("git" on GitHub, Bitbucket Cloud and Data Center). */
  user: string;
  /** Lower-case host name of the SSH endpoint. */
  host: string;
  /** Non-default SSH port (Data Center: 7999 by default); null = 22. */
  port: number | null;
  /** HTTPS URL prefixes of the account's repositories, each rewritten to {@link BoxGitSshTarget.sshBase}. */
  httpsPrefixes: string[];
  /** The SSH form those prefixes become: `git@github.com:` or `ssh://git@bb.corp.example:7999/`. */
  sshBase: string;
}

const SSH_USER = /^[A-Za-z0-9._-]+$/;
const SSH_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The SSH endpoint of an account (from its provider's `sshProbe`), or null when the account has
 * none (a Data Center instance with SSH turned off): git in its boxes then has no remote access.
 */
export function boxGitSshTarget(account: BoxGitEndpoint): BoxGitSshTarget | null {
  const ctx = {
    ...(account.baseUrl !== undefined ? { baseUrl: account.baseUrl } : {}),
    ...(account.sshHost !== undefined ? { sshHost: account.sshHost } : {}),
    login: account.login,
    ...(account.email !== undefined ? { email: account.email } : {})
  };
  try {
    const provider = providerFor(account.provider);
    const probe = provider.sshProbe(ctx);
    if (!probe) return null;
    const at = probe.target.lastIndexOf("@");
    const user = probe.target.slice(0, at);
    const host = probe.target.slice(at + 1).toLowerCase();
    const port = probe.port !== undefined && probe.port !== 22 ? probe.port : null;
    if (at <= 0 || !SSH_USER.test(user) || !SSH_HOST.test(host)) return null;
    if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) return null;
    const authority = port === null ? host : `${host}:${port}`;
    if (account.provider === "bitbucket-server") {
      // `{base}/scm/KEY/slug.git` ⇄ `ssh://git@{sshHost}/KEY/slug.git` (personal `~user` repos too).
      if (!account.baseUrl) return null;
      return { user, host, port, httpsPrefixes: [`${account.baseUrl.replace(/\/+$/, "")}/scm/`], sshBase: `ssh://${user}@${authority}/` };
    }
    // GitHub and Bitbucket Cloud: `https://<web host>/owner/repo.git` ⇄ `git@<ssh host>:owner/repo.git`.
    const webHost = provider.credentialSpec(ctx).host.toLowerCase();
    return { user, host, port, httpsPrefixes: [`https://${webHost}/`], sshBase: port === null ? `${user}@${host}:` : `ssh://${user}@${authority}/` };
  } catch {
    return null;
  }
}

/** A git config value or subsection name, quoted as git's config parser reads it. */
function gitConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The box's git configuration for an account: SSH only, with the host keys it may trust. */
export interface BoxGitConfig {
  target: BoxGitSshTarget;
  /** In order, for `git config --global --add <key> <value>`: the `url.<ssh>.insteadOf <https>` rewrites. */
  entries: { key: string; value: string }[];
  /** The same entries as gitconfig text (a file for `[include] path = …`, or appended to `~/.gitconfig`). */
  gitconfig: string;
  /**
   * known_hosts content for the box: the git host's keys from `knownHosts` (and Orquester's pins
   * for github.com), nothing for any other host. Empty when the host knows none — the box then
   * cannot verify the host, and the host-side agent refuses to bind to it.
   */
  knownHosts: string;
}

/**
 * What the box setup writes for a project box whose workspace has `account` (`knownHosts`: the
 * host's known_hosts text for the account's SSH host, as `BoxGitAuthDeps.knownHosts` returns it).
 * Null when the account offers no SSH endpoint. No token or key is involved: only public data.
 */
export function boxGitConfig(account: BoxGitEndpoint, knownHosts: string): BoxGitConfig | null {
  const target = boxGitSshTarget(account);
  if (!target) return null;
  const entries = target.httpsPrefixes.map((prefix) => ({ key: `url.${target.sshBase}.insteadOf`, value: prefix }));
  const gitconfig = `[url ${gitConfigQuote(target.sshBase)}]\n${target.httpsPrefixes.map((prefix) => `\tinsteadOf = ${gitConfigQuote(prefix)}\n`).join("")}`;
  return { target, entries, gitconfig, knownHosts: knownHostsText(target, knownHosts) };
}

/**
 * The SSH form of a clone URL of the account's host (`https://github.com/o/r.git` →
 * `git@github.com:o/r.git`; any `user@` in the HTTPS URL is dropped). Any other URL — already
 * SSH, or another host — is returned unchanged.
 */
export function boxCloneUrl(account: BoxGitEndpoint, url: string): string {
  const target = boxGitSshTarget(account);
  if (!target) return url;
  const plain = url.trim().replace(/^(https?:\/\/)[^@/?#]*@/i, "$1");
  for (const prefix of target.httpsPrefixes) {
    if (plain.toLowerCase().startsWith(prefix.toLowerCase())) return `${target.sshBase}${plain.slice(prefix.length)}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Host keys: known_hosts entries for the git host
// ---------------------------------------------------------------------------

/**
 * GitHub's published SSH host keys (docs.github.com "GitHub's SSH key fingerprints", checked
 * against `ssh-keyscan github.com` on 2026-10-20), so a daemon user that never connected to
 * github.com still verifies it.
 */
const GITHUB_HOST_KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk="
];

/** One host key of the git host. */
interface HostKeyEntry {
  revoked: boolean;
  type: string;
  blob: Buffer;
}

/** The git host's keys a session may be bound to, and the revoked ones (`@revoked` wins). */
export interface TrustedHostKeys {
  trusted: Buffer[];
  revoked: Buffer[];
}

/** `host` or `[host]:port`, as known_hosts names a host. */
function knownHostsName(target: Pick<BoxGitSshTarget, "host" | "port">): string {
  return target.port === null ? target.host : `[${target.host}]:${target.port}`;
}

/** A shell-style pattern (`*`, `?`) against a name, as OpenSSH's `match_pattern`. */
function globMatch(pattern: string, name: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(name);
}

/** Whether a known_hosts host field names `name` (plain patterns with `!` negation, or one hashed `|1|salt|hash`). */
export function knownHostsFieldMatches(field: string, name: string): boolean {
  if (field.startsWith("|1|")) {
    const [, , salt, hash] = field.split("|");
    if (!salt || !hash) return false;
    return createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest().equals(Buffer.from(hash, "base64"));
  }
  let matched = false;
  for (const pattern of field.toLowerCase().split(",")) {
    if (pattern.startsWith("!")) {
      if (globMatch(pattern.slice(1), name)) return false;
    } else if (globMatch(pattern, name)) {
      matched = true;
    }
  }
  return matched;
}

/** The known_hosts entries for the target (and the github.com pins), in order, deduplicated. */
function hostKeyEntries(target: Pick<BoxGitSshTarget, "host" | "port">, knownHosts: string): HostKeyEntry[] {
  const name = knownHostsName(target);
  const out: HostKeyEntry[] = [];
  const seen = new Set<string>();
  const add = (revoked: boolean, type: string, data: string): void => {
    const parsed = publicKeyBlob(`${type} ${data}`);
    const id = `${revoked ? "@revoked " : ""}${type} ${data}`;
    if (!parsed || seen.has(id)) return;
    seen.add(id);
    out.push({ revoked, type, blob: parsed.blob });
  };
  for (const raw of knownHosts.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    let revoked = false;
    if (fields[0]!.startsWith("@")) {
      const marker = fields.shift();
      // A host CA vouches for keys no line lists: not something this agent can check.
      if (marker !== "@revoked") continue;
      revoked = true;
    }
    const [hosts, type, data] = fields;
    if (!hosts || !type || !data) continue;
    if (knownHostsFieldMatches(hosts, name)) add(revoked, type, data);
  }
  if (target.host === "github.com" && target.port === null) {
    for (const line of GITHUB_HOST_KEYS) {
      const [type, data] = line.split(" ");
      add(false, type!, data!);
    }
  }
  return out;
}

/** The keys of the git host from a known_hosts text (see {@link TrustedHostKeys}). */
export function trustedHostKeys(target: Pick<BoxGitSshTarget, "host" | "port">, knownHosts: string): TrustedHostKeys {
  const entries = hostKeyEntries(target, knownHosts);
  const revoked = entries.filter((entry) => entry.revoked).map((entry) => entry.blob);
  const trusted = entries.filter((entry) => !entry.revoked && !revoked.some((blob) => blob.equals(entry.blob))).map((entry) => entry.blob);
  return { trusted, revoked };
}

/** known_hosts text for the box: the git host's entries only, under its known_hosts name. */
function knownHostsText(target: BoxGitSshTarget, knownHosts: string): string {
  const name = knownHostsName(target);
  const lines = hostKeyEntries(target, knownHosts).map((entry) => `${entry.revoked ? "@revoked " : ""}${name} ${entry.type} ${entry.blob.toString("base64")}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
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
// Signatures by a host key (session-bind)
// ---------------------------------------------------------------------------

const ECDSA_CURVES: Readonly<Record<string, { crv: string; size: number; hash: string }>> = {
  nistp256: { crv: "P-256", size: 32, hash: "sha256" },
  nistp384: { crv: "P-384", size: 48, hash: "sha384" },
  nistp521: { crv: "P-521", size: 66, hash: "sha512" }
};

/** An mpint magnitude left-padded (or trimmed of sign bytes) to `size` bytes. */
function fixedWidth(mpint: Buffer, size: number): Buffer | null {
  let start = 0;
  while (start < mpint.length - 1 && mpint[start] === 0) start += 1;
  const magnitude = mpint.subarray(start);
  if (magnitude.length > size) return null;
  return Buffer.concat([Buffer.alloc(size - magnitude.length), magnitude]);
}

/** A public key from its SSH blob (ed25519, RSA, ECDSA nistp256/384/521), or null. */
export function publicKeyFromBlob(blob: Buffer): { type: string; key: KeyObject; curve?: { size: number; hash: string } } | null {
  try {
    const reader = new SshReader(blob);
    const type = reader.string().toString("utf8");
    if (type === "ssh-ed25519") {
      const x = reader.string();
      if (x.length !== 32 || reader.remaining !== 0) return null;
      return { type, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: x.toString("base64url") }, format: "jwk" }) };
    }
    if (type === "ssh-rsa") {
      const e = reader.string();
      const n = reader.string();
      if (reader.remaining !== 0) return null;
      return { type, key: createPublicKey({ key: { kty: "RSA", n: mpintToBase64Url(n), e: mpintToBase64Url(e) }, format: "jwk" }) };
    }
    const ecdsa = /^ecdsa-sha2-(nistp(?:256|384|521))$/.exec(type);
    if (ecdsa) {
      const curve = ECDSA_CURVES[ecdsa[1]!]!;
      if (reader.string().toString("utf8") !== ecdsa[1]) return null;
      const point = reader.string();
      if (reader.remaining !== 0 || point.length !== 1 + 2 * curve.size || point[0] !== 0x04) return null;
      const x = point.subarray(1, 1 + curve.size).toString("base64url");
      const y = point.subarray(1 + curve.size).toString("base64url");
      return { type, key: createPublicKey({ key: { kty: "EC", crv: curve.crv, x, y }, format: "jwk" }), curve };
    }
  } catch {
    // malformed blob
  }
  return null;
}

/** Whether `signature` (an SSH signature blob: algorithm + bytes) is `keyBlob`'s over `data`. */
export function verifySshSignature(keyBlob: Buffer, data: Buffer, signature: Buffer): boolean {
  const key = publicKeyFromBlob(keyBlob);
  if (!key) return false;
  try {
    const reader = new SshReader(signature);
    const algorithm = reader.string().toString("utf8");
    const bytes = reader.string();
    if (reader.remaining !== 0) return false;
    if (key.type === "ssh-ed25519") return algorithm === "ssh-ed25519" && cryptoVerify(null, data, key.key, bytes);
    if (key.type === "ssh-rsa") {
      const hash = algorithm === "rsa-sha2-512" ? "sha512" : algorithm === "rsa-sha2-256" ? "sha256" : algorithm === "ssh-rsa" ? "sha1" : null;
      return hash !== null && cryptoVerify(hash, data, key.key, bytes);
    }
    if (key.curve && algorithm === key.type) {
      const parts = new SshReader(bytes);
      const r = fixedWidth(parts.string(), key.curve.size);
      const s = fixedWidth(parts.string(), key.curve.size);
      if (!r || !s || parts.remaining !== 0) return false;
      return cryptoVerify(key.curve.hash, data, { key: key.key, dsaEncoding: "ieee-p1363" }, Buffer.concat([r, s]));
    }
  } catch {
    // malformed signature
  }
  return false;
}

// ---------------------------------------------------------------------------
// The agent protocol
// ---------------------------------------------------------------------------

export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENT_SUCCESS = 6;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;
export const SSH_AGENTC_EXTENSION = 27;
export const SSH_AGENT_RSA_SHA2_256 = 0x02;
export const SSH_AGENT_RSA_SHA2_512 = 0x04;
/** RFC 4252 §5: the message number a user-authentication request starts with. */
export const SSH_MSG_USERAUTH_REQUEST = 50;
export const SESSION_BIND_EXTENSION = "session-bind@openssh.com";
const HOSTBOUND_METHOD = "publickey-hostbound-v00@openssh.com";

/** OpenSSH's own ceiling for one agent message. */
const MAX_AGENT_MESSAGE = 256 * 1024;

/** What one box's agent may sign: the account key, for the git user, at the git host. */
export interface SshAgentPolicy {
  identity: SshIdentity;
  /** The only SSH user a user-authentication request may name. */
  user: string;
  /** Host keys a connection may be bound to (`session-bind@openssh.com`). */
  hostKeys: TrustedHostKeys;
}

/** The fields of a public-key user-authentication request (the data an SSH client asks its agent to sign). */
export interface UserauthRequest {
  sessionId: Buffer;
  user: Buffer;
  method: "publickey" | typeof HOSTBOUND_METHOD;
  algorithm: string;
  keyBlob: Buffer;
  /** `publickey-hostbound-v00@openssh.com`: the server host key the client saw. */
  hostKey: Buffer | null;
}

/**
 * `data` as an SSH public-key user-authentication request with a signature (RFC 4252 §7:
 * session id, `SSH_MSG_USERAUTH_REQUEST`, user, "ssh-connection", "publickey" or the hostbound
 * method, TRUE, algorithm, key blob [, host key]) and nothing after it; null for anything else —
 * an SSHSIG blob (`ssh-keygen -Y sign`) included.
 */
export function parseUserauthRequest(data: Buffer): UserauthRequest | null {
  try {
    const reader = new SshReader(data);
    const sessionId = reader.string();
    if (sessionId.length === 0) return null;
    if (reader.bytes(1)[0] !== SSH_MSG_USERAUTH_REQUEST) return null;
    const user = reader.string();
    if (reader.string().toString("latin1") !== "ssh-connection") return null;
    const method = reader.string().toString("latin1");
    if (method !== "publickey" && method !== HOSTBOUND_METHOD) return null;
    if (reader.bytes(1)[0] !== 1) return null;
    const algorithm = reader.string().toString("latin1");
    const keyBlob = reader.string();
    const hostKey = method === HOSTBOUND_METHOD ? reader.string() : null;
    if (reader.remaining !== 0) return null;
    return { sessionId: Buffer.from(sessionId), user: Buffer.from(user), method, algorithm, keyBlob: Buffer.from(keyBlob), hostKey: hostKey && Buffer.from(hostKey) };
  } catch {
    return null;
  }
}

/** Whether a request's signature algorithm is the one this key and the request's flags produce. */
function algorithmMatches(identity: SshIdentity, algorithm: string, flags: number): boolean {
  if (identity.type === "ssh-ed25519") return algorithm === "ssh-ed25519";
  if (flags & SSH_AGENT_RSA_SHA2_512) return algorithm === "rsa-sha2-512";
  if (flags & SSH_AGENT_RSA_SHA2_256) return algorithm === "rsa-sha2-256";
  return algorithm === "ssh-rsa";
}

function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([sshUint32(body.length + 1), Buffer.from([type]), body]);
}

/** One signature by `identity` (RSA: the hash the `rsa-sha2-*` flags ask for). */
export function signForAgent(identity: SshIdentity, data: Buffer, flags: number): Buffer {
  if (identity.type === "ssh-ed25519") {
    return Buffer.concat([sshString("ssh-ed25519"), sshString(cryptoSign(null, data, identity.key))]);
  }
  const [algorithm, hash] =
    flags & SSH_AGENT_RSA_SHA2_512 ? ["rsa-sha2-512", "sha512"] : flags & SSH_AGENT_RSA_SHA2_256 ? ["rsa-sha2-256", "sha256"] : ["ssh-rsa", "sha1"];
  return Buffer.concat([sshString(algorithm), sshString(cryptoSign(hash, data, identity.key))]);
}

/**
 * The agent state of ONE box-side agent connection (OpenSSH binds per connection: an `ssh`
 * process opens its own). `policy` null = no identity (a temporary box, or no usable key).
 */
export class SshAgentSession {
  private binding: { hostKey: Buffer; sessionId: Buffer } | null = null;
  /** A refused bind: this connection signs nothing any more. */
  private poisoned = false;

  constructor(private readonly policy: SshAgentPolicy | null) {}

  /** The reply to one request (`message` = type byte + body). */
  reply(message: Buffer): Buffer {
    try {
      switch (message[0]) {
        case SSH_AGENTC_REQUEST_IDENTITIES: {
          const keys = this.policy ? [Buffer.concat([sshString(this.policy.identity.blob), sshString(this.policy.identity.comment)])] : [];
          return frame(SSH_AGENT_IDENTITIES_ANSWER, Buffer.concat([sshUint32(keys.length), ...keys]));
        }
        case SSH_AGENTC_SIGN_REQUEST:
          return this.sign(message.subarray(1));
        case SSH_AGENTC_EXTENSION:
          return this.extension(message.subarray(1));
      }
    } catch {
      // a malformed request
    }
    return frame(SSH_AGENT_FAILURE);
  }

  private sign(body: Buffer): Buffer {
    const policy = this.policy;
    if (!policy || this.poisoned) return frame(SSH_AGENT_FAILURE);
    const reader = new SshReader(body);
    const blob = reader.string();
    const data = reader.string();
    const flags = reader.remaining >= 4 ? reader.uint32() : 0;
    if (!blob.equals(policy.identity.blob)) return frame(SSH_AGENT_FAILURE);
    const request = parseUserauthRequest(data);
    if (!request) return frame(SSH_AGENT_FAILURE);
    if (!request.user.equals(Buffer.from(policy.user, "utf8"))) return frame(SSH_AGENT_FAILURE);
    if (!request.keyBlob.equals(policy.identity.blob) || !algorithmMatches(policy.identity, request.algorithm, flags)) return frame(SSH_AGENT_FAILURE);
    if (this.binding) {
      if (!request.sessionId.equals(this.binding.sessionId)) return frame(SSH_AGENT_FAILURE);
      if (request.hostKey && !request.hostKey.equals(this.binding.hostKey)) return frame(SSH_AGENT_FAILURE);
    } else if (request.hostKey) {
      // A host-bound request names a host key: only one this connection was bound to.
      return frame(SSH_AGENT_FAILURE);
    }
    return frame(SSH_AGENT_SIGN_RESPONSE, sshString(signForAgent(policy.identity, data, flags)));
  }

  private extension(body: Buffer): Buffer {
    const reader = new SshReader(body);
    if (reader.string().toString("latin1") !== SESSION_BIND_EXTENSION) return frame(SSH_AGENT_FAILURE);
    const hostKey = Buffer.from(reader.string());
    const sessionId = Buffer.from(reader.string());
    const signature = reader.string();
    const forwarding = reader.bytes(1)[0] !== 0;
    if (reader.remaining !== 0) return this.refuseBind();
    const keys = this.policy?.hostKeys;
    if (
      !this.policy ||
      this.poisoned ||
      this.binding !== null ||
      // This agent never travels further: a forwarded hop is refused.
      forwarding ||
      sessionId.length === 0 ||
      !keys ||
      keys.revoked.some((key) => key.equals(hostKey)) ||
      !keys.trusted.some((key) => key.equals(hostKey)) ||
      !verifySshSignature(hostKey, sessionId, signature)
    ) {
      return this.refuseBind();
    }
    this.binding = { hostKey, sessionId };
    return frame(SSH_AGENT_SUCCESS);
  }

  private refuseBind(): Buffer {
    this.poisoned = true;
    return frame(SSH_AGENT_FAILURE);
  }
}

/**
 * Serve the agent protocol on one stream (one box-side agent connection).
 * The policy is resolved once, on the first request; requests are answered in
 * order. An oversized frame ends the stream.
 */
export function serveSshAgent(stream: Duplex, resolvePolicy: () => Promise<SshAgentPolicy | null>, onError?: (error: unknown) => void): void {
  let pending = Buffer.alloc(0);
  let session: Promise<SshAgentSession> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const sessionOnce = (): Promise<SshAgentSession> => {
    session ??= resolvePolicy().then(
      (policy) => new SshAgentSession(policy),
      (error: unknown) => {
        onError?.(error);
        return new SshAgentSession(null);
      }
    );
    return session;
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
        const reply = (await sessionOnce()).reply(message);
        if (!stream.destroyed && stream.writable) stream.write(reply);
      });
    }
  });
  stream.on("error", () => {
    // the box side went away; nothing to answer
  });
}

/** The agent policy of a box: its workspace account's key, git user and git host keys; null when it has none. */
export async function boxAgentPolicy(context: BoxRequestContext, deps: Pick<BoxGitAuthDeps, "workspaceAccount" | "knownHosts">): Promise<SshAgentPolicy | null> {
  const account = await accountForBox(context, deps);
  if (!account) return null;
  const target = boxGitSshTarget(account);
  if (!target) return null;
  const identity = await loadAccountIdentity(account);
  if (!identity) return null;
  return { identity, user: target.user, hostKeys: trustedHostKeys(target, await deps.knownHosts(target.host, target.port)) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the `git.credential` handler and the `ssh-agent` channel on the hub. */
export function registerBoxGitAuth(hub: Pick<BoxHub, "handle" | "handleChannel">, deps: BoxGitAuthDeps): void {
  // A box never gets a git hosting token: every helper operation answers nothing (git then
  // fails an HTTPS auth without prompting). Box git uses SSH through the agent below.
  hub.handle("git.credential", async () => ({ output: "" }));

  hub.handleChannel("ssh-agent", (context, _spec, stream) => {
    serveSshAgent(
      stream,
      () => boxAgentPolicy(context, deps),
      (error) => deps.logger?.warn("box ssh-agent key load failed", { boxId: context.boxId, error: error instanceof Error ? error.name : "error" })
    );
  });
}
