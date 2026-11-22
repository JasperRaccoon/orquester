/**
 * Direct SSH for agents (spec docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md
 * §4.3): `ssh orq-<name>` from an agent's bash reaches a box or machine through the daemon's
 * connection to `orq-agent` — Phase 1 tunnels to the machine's own sshd (`openTcp(22)`), Phase 2 to
 * `orq-agent`'s built-in server (the `ssh` channel, `box-protocol.ts`).
 *
 * The alias scheme, the `authorized_keys` tag and the ProxyCommand helper's socket protocol are
 * shared here. Paths (per-chat keys, `~/.ssh/orquester/<name>.conf`, the proxy socket) are
 * `@orquester/config` helpers: `agentChatThreadSshDir`, `managedSshConfigPath`, `sshProxySocketPath`.
 */

/** Every Orquester alias starts with this (`orq-jasper`). */
export const AGENT_SSH_ALIAS_PREFIX = "orq-";
/** Longest `<name>` part of an alias. */
export const AGENT_SSH_ALIAS_NAME_MAX = 40;

/**
 * The alias name (`<name>` of `orq-<name>`) for a box or machine label: lowercase ASCII letters,
 * digits and single dashes, at most {@link AGENT_SSH_ALIAS_NAME_MAX} characters; null when nothing
 * usable is left. Callers make it unique (`-2`, `-3`, …) among the aliases they hold.
 */
export function agentSshAliasName(label: string): string | null {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AGENT_SSH_ALIAS_NAME_MAX)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : null;
}

/** `orq-<name>` for an alias name from {@link agentSshAliasName}. */
export function agentSshAlias(name: string): string {
  return `${AGENT_SSH_ALIAS_PREFIX}${name}`;
}

/** Who an Orquester key was added for: a chat's key (`threadId`), or a machine-level Free-use key (null). */
export interface AgentSshKeyTag {
  threadId: string | null;
  boxId: string;
}

const TAG_PREFIX = "orquester";
const TAG_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The comment on every public key Orquester authorizes (Phase 1 `authorized_keys` lines, Phase 2
 * `ssh.keys`): `orquester chat=<threadId> box=<boxId>`, or `orquester box=<boxId>` for a
 * machine-level key. Cleanup removes exactly the lines whose comment parses to its tag.
 */
export function agentSshKeyComment(tag: AgentSshKeyTag): string {
  if (!TAG_VALUE.test(tag.boxId) || (tag.threadId !== null && !TAG_VALUE.test(tag.threadId))) {
    throw new Error("A key tag holds only ids of letters, digits, '.', '_' and '-'.");
  }
  return tag.threadId === null ? `${TAG_PREFIX} box=${tag.boxId}` : `${TAG_PREFIX} chat=${tag.threadId} box=${tag.boxId}`;
}

/** The tag of an Orquester key comment; null for any other comment (a key Orquester did not add). */
export function parseAgentSshKeyComment(comment: string): AgentSshKeyTag | null {
  const match = /^orquester(?: chat=([^\s]+))? box=([^\s]+)$/.exec(comment.trim());
  if (!match) return null;
  const [, threadId, boxId] = match;
  if (!boxId || !TAG_VALUE.test(boxId) || (threadId !== undefined && !TAG_VALUE.test(threadId))) return null;
  return { threadId: threadId ?? null, boxId };
}

// ---------------------------------------------------------------------------
// The ProxyCommand helper ↔ daemon socket (`sshProxySocketPath`)
// ---------------------------------------------------------------------------

export const SSH_PROXY_PROTOCOL_VERSION = 1;

/**
 * The helper's first write: this JSON and `\n`. The alias's config file passes `threadId` for a
 * per-chat alias (absent for a machine-level one); the daemon checks the alias is live for it.
 */
export interface SshProxyRequest {
  v: typeof SSH_PROXY_PROTOCOL_VERSION;
  alias: string;
  threadId?: string;
}

/**
 * The daemon's one-line JSON answer. After `ok: true` the socket carries raw SSH bytes both ways
 * until either side closes; `via` says which server answers (`ssh-server`: Phase 2's built-in one,
 * `sshd`: Phase 1's tunnel to port 22). On `ok: false` the daemon closes and the helper prints
 * `message` (and `fix`) to stderr and exits 255, as ssh does for connection failures.
 */
export type SshProxyResponse =
  | { ok: true; via: "ssh-server" | "sshd" }
  | { ok: false; code: SshProxyErrorCode; message: string; fix?: string };

/**
 * - `ALIAS_UNKNOWN` — no live alias of that name (revoked, box destroyed, lease ended);
 * - `NOT_ALLOWED` — the alias exists but not for this chat, or the machine is no longer Free use
 *   with Commands and SSH on;
 * - `MACHINE_OFFLINE` — `orq-agent` is not connected;
 * - `SSH_UNAVAILABLE` — neither the built-in server nor a reachable sshd;
 * - `BAD_REQUEST` — the first line was not a valid {@link SshProxyRequest}.
 */
export type SshProxyErrorCode = "ALIAS_UNKNOWN" | "NOT_ALLOWED" | "MACHINE_OFFLINE" | "SSH_UNAVAILABLE" | "BAD_REQUEST";
