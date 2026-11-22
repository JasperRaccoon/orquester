/**
 * Agent SSH (spec 2026-11-22 §4.3): the text of the files Orquester writes for an `orq-<name>`
 * alias — its `~/.ssh/orquester/<name>.conf`, the pinned `known_hosts` lines — and the opt-in
 * `Include` line in the owner's `~/.ssh/config`. Pure; the service does the I/O.
 */

import { agentSshKeyComment, parseAgentSshKeyComment, type AgentSshKeyTag } from "@orquester/api";
import { SSH_CONFIG_INCLUDE_LINE } from "@orquester/config";

/** The first line of every config Orquester writes; a `.conf` without it is not touched. */
export const MANAGED_CONF_MARKER = "# Managed by Orquester (agent SSH): rewritten or removed without notice.";

/** How the connection is made: a ProxyCommand through the daemon (host), or a forward in a project box. */
export type AliasTransport =
  | { kind: "proxy"; command: readonly string[] }
  | { kind: "forward"; port: number };

export interface AliasConfig {
  /** `orq-<name>`. */
  alias: string;
  tag: AgentSshKeyTag;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  transport: AliasTransport;
}

function assertPlain(value: string, what: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error(`The ${what} holds a character an ssh config cannot carry.`);
  return value;
}

/** An ssh_config argument: `%` doubled (ssh's token escape), quoted when it holds whitespace. */
function configArg(value: string, what: string): string {
  const escaped = assertPlain(value, what).replace(/%/g, "%%");
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

/** One POSIX shell word (ssh runs a ProxyCommand with `/bin/sh -c`), `%` doubled for ssh. */
function shellWord(value: string): string {
  assertPlain(value, "ProxyCommand");
  return `'${value.replace(/'/g, `'\\''`)}'`.replace(/%/g, "%%");
}

/** The whole `<name>.conf`: one `Host orq-<name>` block, every path absolute. */
export function renderAliasConfig(config: AliasConfig): string {
  const alias = assertPlain(config.alias, "alias");
  const lines = [
    MANAGED_CONF_MARKER,
    `# ${agentSshKeyComment(config.tag)}`,
    `Host ${alias}`,
    `  HostName ${config.transport.kind === "forward" ? "127.0.0.1" : alias}`,
    ...(config.transport.kind === "forward" ? [`  Port ${config.transport.port}`] : []),
    `  User ${configArg(config.user, "user name")}`,
    `  IdentityFile ${configArg(config.identityFile, "key path")}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${configArg(config.knownHostsFile, "known_hosts path")}`,
    `  HostKeyAlias ${alias}`,
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    "  ServerAliveInterval 30",
    ...(config.transport.kind === "proxy" ? [`  ProxyCommand ${config.transport.command.map(shellWord).join(" ")}`] : [])
  ];
  return `${lines.join("\n")}\n`;
}

/** What a managed config says about itself: its alias, tag and `User`; null when it is not ours. */
export function parseManagedConfig(content: string): { alias: string; tag: AgentSshKeyTag; user: string | null } | null {
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[0] !== MANAGED_CONF_MARKER) return null;
  const tag = parseAgentSshKeyComment((lines[1] ?? "").replace(/^#\s*/, ""));
  const host = lines.map((line) => /^Host\s+(\S+)\s*$/.exec(line)?.[1]).find((value) => value !== undefined);
  if (!tag || !host) return null;
  const user = lines.map((line) => /^\s+User\s+"?([^"]+?)"?\s*$/.exec(line)?.[1]).find((value) => value !== undefined) ?? null;
  return { alias: host, tag, user: user === null ? null : user.replace(/%%/g, "%") };
}

/** A host public key (`<type> <base64>[ comment]`) as `<type> <base64>`; null when it is not one. */
export function normalizeHostKey(text: string): string | null {
  const [type, key] = text.trim().split(/\s+/);
  if (!type || !key || !/^[a-z0-9@.-]+$/i.test(type) || !/^[A-Za-z0-9+/]+={0,3}$/.test(key)) return null;
  return `${type} ${key}`;
}

/** The pinned `known_hosts` file: one line per host key of every alias, sorted by alias. */
export function renderKnownHosts(pins: ReadonlyMap<string, readonly string[]>): string {
  const lines: string[] = [];
  for (const alias of [...pins.keys()].sort()) for (const key of pins.get(alias) ?? []) lines.push(`${alias} ${key}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The pins of a `known_hosts` file written by {@link renderKnownHosts}: alias → its keys. */
export function parseKnownHosts(content: string): Map<string, string[]> {
  const pins = new Map<string, string[]>();
  for (const line of content.split("\n")) {
    const [alias, ...rest] = line.trim().split(/\s+/);
    const key = normalizeHostKey(rest.join(" "));
    if (!alias || !key || alias.startsWith("#")) continue;
    pins.set(alias, [...(pins.get(alias) ?? []), key]);
  }
  return pins;
}

const isIncludeLine = (line: string) => line.replace(/\r$/, "").trim() === SSH_CONFIG_INCLUDE_LINE;

/**
 * `~/.ssh/config` with {@link SSH_CONFIG_INCLUDE_LINE} as its first line (an `Include` after a
 * `Host` block would apply only inside it). Nothing else changes; an occurrence lower down moves up.
 */
export function withIncludeLine(content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && isIncludeLine(lines[0]!) && !lines.slice(1).some(isIncludeLine)) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const rest = lines.filter((line) => !isIncludeLine(line)).join("\n");
  return rest === "" ? `${SSH_CONFIG_INCLUDE_LINE}${newline}` : `${SSH_CONFIG_INCLUDE_LINE}${newline}${rest}`;
}

/** `~/.ssh/config` without {@link SSH_CONFIG_INCLUDE_LINE}; every other byte stays. */
export function withoutIncludeLine(content: string): string {
  if (!content.split("\n").some(isIncludeLine)) return content;
  return content
    .split("\n")
    .filter((line) => !isIncludeLine(line))
    .join("\n");
}
