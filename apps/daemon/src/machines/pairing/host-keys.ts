/**
 * Host keys as `ssh` itself records them: pairing lets `ssh` write the key it was offered into a
 * throwaway known_hosts file (so `~/.ssh/config` aliases, ports, `HostKeyAlias` and ProxyJump all
 * resolve exactly as in the real run), then reads it back here.
 */

import { createHash } from "node:crypto";

export interface KnownHostKey {
  /** The known_hosts line, as `ssh` wrote it (host field, key type, base64 key). */
  line: string;
  keyType: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

/** `ssh-keygen -l`'s SHA256 fingerprint of a base64 public key blob. */
export function sshFingerprint(base64Key: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

const KEY_TYPE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

/** The plain host-key lines of a known_hosts file (no `@cert-authority` or `@revoked` markers). */
export function parseKnownHosts(text: string): KnownHostKey[] {
  const keys: KnownHostKey[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    const [hosts, keyType, key] = line.split(/\s+/);
    if (!hosts || !keyType || !key || !KEY_TYPE.test(keyType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    keys.push({ line: `${hosts} ${keyType} ${key}`, keyType, fingerprint: sshFingerprint(key) });
  }
  return keys;
}

/** Ed25519 first, then ECDSA, then RSA: the order OpenSSH prefers host keys in. */
export function preferredHostKey(keys: readonly KnownHostKey[]): KnownHostKey | null {
  const rank = (type: string) => (type.includes("ed25519") ? 0 : type.includes("ecdsa") ? 1 : 2);
  return [...keys].sort((a, b) => rank(a.keyType) - rank(b.keyType))[0] ?? null;
}
