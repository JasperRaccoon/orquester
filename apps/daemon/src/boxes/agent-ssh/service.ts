/**
 * Direct SSH for agents (spec docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md
 * §4.3): `ssh orq-<name>` (and scp, rsync, git, `docker -H ssh://`) from an agent's bash reaches a
 * box its chat owns, or a Free-use machine, through the daemon's `BoxConnection` to `orq-agent`. No
 * public IP, no inbound port, and no SSH from the daemon to anything.
 *
 * - **Aliases follow the box records.** A chat gets `orq-<name>` for each temporary box it owns
 *   (a rented box, or the owner's machine lent to it) once that box is ready, until the box is
 *   destroyed or given back, its deadline passes, or the chat closes. The machines registry hands
 *   the machine-level aliases of Free-use machines to {@link AgentSsh.syncMachines}
 *   (`MachineSshAccessPort`). Every change of a box, its connection, a chat or that set reconciles
 *   the box's aliases (one box at a time, idempotently); nothing else issues or revokes one.
 * - **Keys.** One ed25519 key per alias (`ssh-keygen`, no passphrase): a chat's under its thread
 *   (`agentChatThreadSshKeyPath`), a machine-level one under `machineSshKeyPath`; dirs 0700, files
 *   0600. Each carries the `agentSshKeyComment` tag.
 * - **Two ways in, decided per connect.** With the `ssh-server` capability (Phase 2) the box's
 *   whole key set is pushed with `ssh.keys` (replace-all, again on every connect: orq-agent keeps
 *   them in memory only), `hello.sshHostKey` is pinned, and the ProxyCommand opens an `ssh`
 *   channel; nothing is written to the box, and Phase 1 lines left from an older orq-agent are
 *   removed. Without it (Phase 1) the work user's `~/.ssh/authorized_keys` gets one tagged line per
 *   alias with an `expiry-time` backstop, the sshd host keys are read over the connection and
 *   pinned, and the ProxyCommand opens `openTcp(22)`. Windows boxes have no Phase 1.
 * - **Host files.** `~/.ssh/orquester/<name>.conf` (marker, tag, `Host orq-<name>`, absolute paths,
 *   `StrictHostKeyChecking yes` against `~/.ssh/orquester/known_hosts` under `HostKeyAlias` — never
 *   trust-on-first-use) with a ProxyCommand running `ssh-proxy-helper.mjs` on the daemon's own node.
 *   An alias is offered (`aliasFor`) only once its box side is done and its host key pinned. The
 *   opt-in `Include` line in `~/.ssh/config` is {@link AgentSsh.setIncludeEnabled}.
 * - **Box-project chats** run their CLI in a project box: the chat's key, config and pins are also
 *   written to that box's `~/.ssh/orquester/` (the documented exception to "no secrets in box
 *   files", boxes README), and the config dials a listener on the project box's 127.0.0.1 that
 *   `ProjectBoxForwards` pipes over its `host-tcp` channel to the same checked upstream the proxy
 *   socket uses. That box's `~/.ssh/orquester/` holds nothing else (anything else there is removed).
 * - **Revocation.** Revoking deletes the config, the key and the pin, updates `ssh.keys`, removes
 *   the `authorized_keys` line (found by its tag; on a machine that is away, when it reconnects:
 *   every connect sweeps lines tagged for that box that are no longer live). A closed chat's
 *   thread `ssh/` dir goes whole. `expiry-time` is the backstop when the box never returns.
 * - **Restarts.** The managed configs are read back at start (their tag says whose they are), so a
 *   live alias keeps its name and key, and one that is no longer wanted is revoked. Every chat
 *   counts as open until {@link AgentSsh.chatsLoaded} says the chat list is loaded; then the
 *   aliases of chats that closed (or vanished) while the daemon was down go, like a chat close.
 *
 * Security (spec §7.3): agents run as the daemon's user and can read the appdir; the per-chat
 * scoping is bookkeeping and cleanup, not isolation. No key, config body or host key is logged.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Duplex, Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  agentSshAlias,
  agentSshAliasName,
  agentSshKeyComment,
  AGENT_SSH_ALIAS_PREFIX,
  type AgentSshKeyTag,
  type SshProxyRequest
} from "@orquester/api";
import {
  agentChatThreadSshDir,
  agentChatThreadSshKeyPath,
  machineSshDir,
  machineSshKeyPath,
  managedSshConfigDir,
  managedSshConfigPath,
  managedSshKnownHostsPath,
  sshProxySocketPath,
  type StoredBox
} from "@orquester/config";

import type { MachineSshAccessEntry, MachineSshAccessPort } from "../../machines/ports.ts";
import type { BoxConnection, BoxHub, BoxRegistry } from "../contracts.ts";
import type { ProjectBoxForward, ProjectBoxForwards } from "../temporary/project-forwards.ts";
import { authorizedKeyLine, rewriteAuthorizedKeys } from "./authorized-keys.ts";
import { SshProxyServer, type SshProxyOutcome } from "./proxy-server.ts";
import { normalizeHostKey, parseKnownHosts, parseManagedConfig, renderAliasConfig, renderKnownHosts, withIncludeLine, withoutIncludeLine } from "./ssh-files.ts";

/** The ProxyCommand helper shipped beside this module (plain Node, no tsx: it must start fast). */
export const SSH_PROXY_HELPER_PATH = fileURLToPath(new URL("./ssh-proxy-helper.mjs", import.meta.url));

/** Where a POSIX sshd keeps its host public keys (Linux and macOS alike). */
const SSHD_HOST_KEY_FILES = ["/etc/ssh/ssh_host_ed25519_key.pub", "/etc/ssh/ssh_host_ecdsa_key.pub", "/etc/ssh/ssh_host_rsa_key.pub"];
/** Largest file read back from a box (a host key, `authorized_keys`). */
const MAX_BOX_FILE_BYTES = 1024 * 1024;
/** How long a box request of this module may take. */
const BOX_REQUEST_TIMEOUT_MS = 20_000;
/** How long `settled` waits for a box's alias work in flight. */
const SETTLE_TIMEOUT_MS = 60_000;
/** The project box's port for an alias's forward is drawn above the privileged ones (22 is never free there). */
const FORWARD_PREFERRED_PORT = 22;
/** Box states in which a chat keeps an alias it already has (a ready box that dropped its link). */
const KEEP_STATES = new Set(["ready", "unreachable", "offline"]);
const GONE_STATES = new Set(["destroying", "destroy-failed", "destroyed"]);

/** The alias of a box for one caller: the name and the exact command that opens a shell with it. */
export interface AgentSshAliasInfo {
  alias: string;
  command: string;
}

export interface AgentSshChats {
  /** Whether the chat is open (a closed one keeps no alias). Asked only after {@link AgentSsh.chatsLoaded}. */
  isOpen(threadId: string): boolean;
  /** The chat's project path (to tell a box project's chat), or null. */
  projectPath(threadId: string): string | null;
}

export interface AgentSshLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentSshDeps {
  baseDir: string;
  /** The daemon user's home: `~/.ssh/orquester/` and the opt-in `~/.ssh/config` line are here. */
  home: string;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  registry: Pick<BoxRegistry, "get" | "list" | "onChange" | "locate">;
  chats: AgentSshChats;
  /** Listeners in a box project's own box (`ProjectBoxForwards`); without it a box project's chat gets no alias. */
  projectForwards?: Pick<ProjectBoxForwards, "open">;
  /** The `agentPrefs.sshConfigInclude` setting, read at start. */
  includeSetting(): Promise<boolean>;
  /** The node that runs the helper. Default: this process's. */
  nodePath?: string;
  /** Default {@link SSH_PROXY_HELPER_PATH}. */
  helperPath?: string;
  /** Default `ssh-keygen` (from PATH). */
  sshKeygen?: string;
  /** Tests: where Phase 1 reads the sshd host keys in the box. */
  sshdHostKeyFiles?: readonly string[];
  now?: () => number;
  logger?: AgentSshLogger;
}

interface Alias {
  /** `<boxId>/<threadId or "*">`: one per chat and box, one machine-level per box. */
  readonly key: string;
  name: string;
  alias: string;
  readonly boxId: string;
  readonly threadId: string | null;
  keyPath: string;
  publicKey: string | null;
  user: string | null;
  /** Pinned host keys (`<type> <base64>`). */
  hostKeys: string[];
  via: "ssh-server" | "sshd" | null;
  expiresAt: number | null;
  /** Box side done and host key pinned: offered to agents and served by the proxy. */
  ready: boolean;
}

interface Wanted {
  threadId: string | null;
  /** A machine-level alias's name is the registry's; a chat's is chosen here. */
  fixedName: string | null;
  label: string;
  expiresAt: number | null;
}

/** An alias's copy in a box project's own box. */
interface Placement {
  readonly threadId: string;
  readonly name: string;
  readonly alias: string;
  readonly forward: ProjectBoxForward;
  readonly home: string;
  /** What was written, to skip a rewrite that changes nothing. */
  readonly written: string;
}

const keyOf = (boxId: string, threadId: string | null) => `${boxId}/${threadId ?? "*"}`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One POSIX shell word, for the commands shown to agents. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readBoxText(connection: BoxConnection, path: string): Promise<string | null> {
  const info = await connection.request("fs.stat", { path }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
  if (!info || info.kind !== "file") return null;
  const stream: Readable = await connection.readFile(path, { length: MAX_BOX_FILE_BYTES });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureBoxDir(connection: BoxConnection, path: string): Promise<void> {
  const info = await connection.request("fs.stat", { path }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
  if (info?.kind === "dir") return;
  await connection.request("fs.mkdir", { path, recursive: true, mode: 0o700 }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}

/** Write `content` atomically with `mode`, creating the parent dir (0700) when missing. */
async function writePrivateFile(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** `~/.ssh/config` with the Include line added (`enabled`) or removed; mode and every other byte kept. */
async function applySshConfigInclude(home: string, enabled: boolean): Promise<void> {
  const path = join(home, ".ssh", "config");
  let target = path;
  let content: string | null = null;
  let mode = 0o600;
  try {
    target = await realpath(path);
    content = await readFile(target, "utf8");
    mode = (await stat(target)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content === null) {
    if (!enabled) return;
    await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    await writeFile(path, withIncludeLine(""), { mode: 0o600, flag: "wx" });
    return;
  }
  const next = enabled ? withIncludeLine(content) : withoutIncludeLine(content);
  if (next === content) return;
  const tmp = `${target}.orquester-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, next, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export class AgentSsh {
  private readonly aliases = new Map<string, Alias>();
  private readonly machineEntries = new Map<string, MachineSshAccessEntry>();
  /** Project box → alias name → its copy there. */
  private readonly placements = new Map<string, Map<string, Placement>>();
  private readonly closedThreads = new Set<string>();
  /** Machines being removed: nothing is issued for them again. */
  private readonly removed = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  /** Boxes (re)connected since their last reconcile: their box side is applied again whatever it was. */
  private readonly fresh = new Set<string>();
  /** Per connected box: what its box side was last brought to (skips box requests that would change nothing). */
  private readonly applied = new Map<string, string>();
  /** Until the registry's first `syncMachines`, the machine-level aliases read back at start are kept. */
  private machinesSynced = false;
  /** The chat list is loaded: `chats.isOpen` is believed (before, every chat counts as open). */
  private chatsKnown = false;
  private readonly unsubscribers: (() => void)[] = [];
  private files: Promise<void> = Promise.resolve();
  /** The Include line is in `~/.ssh/config` (the setting is on and writing it worked). */
  private includeActive = false;
  private proxy: SshProxyServer | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly now: () => number;
  private readonly configDir: string;
  private readonly knownHostsPath: string;

  constructor(private readonly deps: AgentSshDeps) {
    this.now = deps.now ?? Date.now;
    this.configDir = managedSshConfigDir(deps.home);
    this.knownHostsPath = managedSshKnownHostsPath(deps.home);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Read the managed configs back, open the proxy socket, follow boxes and connections, reconcile every box. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let include: boolean | null = null;
    try {
      include = await this.deps.includeSetting();
    } catch (error) {
      this.warn("agent SSH: the Include setting could not be read; leaving ~/.ssh/config alone", error);
    }
    // Both ways: a line left by a run whose removal failed goes too (a file without it is not written).
    if (include !== null) await this.applyInclude(include);
    await this.recover();
    const proxy = new SshProxyServer({
      socketPath: sshProxySocketPath(this.deps.baseDir),
      open: (request) => this.openProxy(request),
      ...(this.deps.logger ? { logger: this.deps.logger } : {})
    });
    try {
      await proxy.start();
      this.proxy = proxy;
    } catch (error) {
      this.warn("agent SSH: the proxy socket could not start; orq-<name> aliases will not connect", error);
    }
    this.unsubscribers.push(
      this.deps.registry.onChange((boxId) => void this.schedule(boxId)),
      // Registered after `ProjectBoxForwards`' own listener (built first in the wiring): its re-listen
      // of a project box's forwards is queued before an alias's `alive()` check asks about them.
      this.deps.hub.onConnectionChange((boxId, connected) => {
        if (!connected) return;
        this.fresh.add(boxId);
        void this.schedule(boxId);
      })
    );
    const boxIds = new Set([...this.deps.registry.list().map((record) => record.id), ...[...this.aliases.values()].map((alias) => alias.boxId)]);
    await Promise.all([...boxIds].map((boxId) => this.schedule(boxId)));
  }

  /** Daemon stop: the socket closes; configs and keys stay for the next start (the helper says Orquester is not running meanwhile). */
  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    await Promise.allSettled([...this.queues.values()]);
    await this.proxy?.close();
    this.proxy = null;
    await this.files;
  }

  // -------------------------------------------------------------------------
  // Callers
  // -------------------------------------------------------------------------

  /** The chat's live alias for a box, as the chat must type it; null when it has none (yet). */
  aliasFor(threadId: string, boxId: string): AgentSshAliasInfo | null {
    const alias = this.aliases.get(keyOf(boxId, threadId));
    if (!alias?.ready) return null;
    const placed = this.placementOf(threadId, alias.name);
    if (placed) return { alias: alias.alias, command: `ssh -F ${shellWord(`${placed.home}/.ssh/orquester/${alias.name}.conf`)} ${alias.alias}` };
    // A box project's chat runs ssh in its box, where the host's config is out of reach.
    if (this.chatInBox(threadId)) return null;
    return { alias: alias.alias, command: this.hostCommand(alias) };
  }

  /** A machine-level alias of a box (for `list_machines`), as any chat on the host types it. */
  machineAlias(boxId: string): AgentSshAliasInfo | null {
    const alias = this.aliases.get(keyOf(boxId, null));
    return alias?.ready ? { alias: alias.alias, command: this.hostCommand(alias) } : null;
  }

  /** {@link aliasFor} once the box's alias work in flight is done (bounded): `create_box` answers with it. */
  async settled(threadId: string, boxId: string): Promise<AgentSshAliasInfo | null> {
    const chatBox = this.chatProjectBox(threadId);
    const work = this.schedule(boxId).then(() => (chatBox ? this.schedule(chatBox) : undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    return this.aliasFor(threadId, boxId);
  }

  /** A chat closed: every alias of it is revoked and its thread `ssh/` dir deleted. */
  async chatClosed(threadId: string): Promise<void> {
    this.closedThreads.add(threadId);
    const boxIds = new Set<string>();
    for (const alias of this.aliases.values()) if (alias.threadId === threadId) boxIds.add(alias.boxId);
    const projectBoxIds = new Set<string>();
    for (const [projectBoxId, placed] of this.placements) if ([...placed.values()].some((placement) => placement.threadId === threadId)) projectBoxIds.add(projectBoxId);
    // The aliases first, then their copies in a box project's box (which follow the aliases).
    await Promise.all([...boxIds].map((boxId) => this.schedule(boxId)));
    await Promise.all([...projectBoxIds].map((boxId) => this.schedule(boxId)));
    await rm(agentChatThreadSshDir(this.deps.baseDir, threadId), { recursive: true, force: true }).catch((error) =>
      this.warn("agent SSH: a closed chat's ssh dir could not be deleted", error, { threadId })
    );
  }

  /**
   * The chat list is loaded (the daemon's session reattach finished): every chat that owns an
   * alias but is no longer open loses them all, with its keys, pins, `ssh.keys` entries and
   * thread `ssh/` dir, as if it had just closed.
   */
  async chatsLoaded(): Promise<void> {
    this.chatsKnown = true;
    const gone = new Set<string>();
    for (const alias of this.aliases.values()) if (alias.threadId !== null && !this.chatOpen(alias.threadId)) gone.add(alias.threadId);
    for (const placed of this.placements.values()) for (const placement of placed.values()) if (!this.chatOpen(placement.threadId)) gone.add(placement.threadId);
    await Promise.all([...gone].map((threadId) => this.chatClosed(threadId)));
  }

  /**
   * A machine is about to be removed (while orq-agent is still connected): every alias of it is
   * revoked and every line Orquester added to its `authorized_keys` removed.
   */
  async machineRemoving(boxId: string): Promise<void> {
    this.removed.add(boxId);
    await this.schedule(boxId);
  }

  /** `MachineSshAccessPort.sync`: the complete set of machine-level aliases. */
  async syncMachines(entries: readonly MachineSshAccessEntry[]): Promise<void> {
    const next = new Map<string, MachineSshAccessEntry>();
    for (const entry of entries) {
      if (agentSshAliasName(entry.alias) !== entry.alias) {
        this.deps.logger?.warn("agent SSH: a machine alias name is not usable; skipped", { machineId: entry.machineId });
        continue;
      }
      // One alias per machine, and one machine per name.
      if (!next.has(entry.boxId) && ![...next.values()].some((taken) => taken.alias === entry.alias)) next.set(entry.boxId, entry);
    }
    const boxIds = new Set([...this.machineEntries.keys(), ...next.keys()]);
    this.machinesSynced = true;
    this.machineEntries.clear();
    for (const [boxId, entry] of next) this.machineEntries.set(boxId, entry);
    // Before `start` the set is only kept: start reconciles every box with it.
    if (!this.started) return;
    await Promise.all([...boxIds].map((boxId) => this.schedule(boxId)));
  }

  /** The `agentPrefs.sshConfigInclude` setting changed: the line goes in or out at once. */
  async setIncludeEnabled(enabled: boolean): Promise<void> {
    await this.applyInclude(enabled);
  }

  // -------------------------------------------------------------------------
  // The proxy (socket and project-box forwards)
  // -------------------------------------------------------------------------

  /** Authorize `request` and open its upstream: a chat's own alias, or a live machine-level one. */
  async openProxy(request: SshProxyRequest): Promise<SshProxyOutcome> {
    const alias = [...this.aliases.values()].find((candidate) => candidate.alias === request.alias);
    if (!alias || !alias.ready || !this.stillWanted(alias)) {
      return { ok: false, code: "ALIAS_UNKNOWN", message: `${request.alias} is not a live Orquester alias: its box was destroyed or given back, its time ran out, or it was revoked.` };
    }
    if (alias.threadId !== null && request.threadId !== alias.threadId) {
      return { ok: false, code: "NOT_ALLOWED", message: `${request.alias} belongs to another chat.` };
    }
    const connection = this.deps.hub.get(alias.boxId);
    if (!connection?.connected) {
      return { ok: false, code: "MACHINE_OFFLINE", message: `${request.alias} is offline: orq-agent on it is not connected to Orquester.`, fix: "Wait for it to reconnect, or check that the machine is on." };
    }
    const builtIn = connection.capabilities?.includes("ssh-server") === true;
    const via = alias.via ?? (builtIn ? "ssh-server" : "sshd");
    // The pins were taken for the other server: re-pin now (this connection still uses the pinned one).
    if ((via === "ssh-server") !== builtIn) void this.schedule(alias.boxId);
    try {
      const stream: Duplex = via === "ssh-server" ? await connection.openChannel({ kind: "ssh" }) : await connection.openTcp(22);
      return { ok: true, via, stream };
    } catch {
      return via === "ssh-server"
        ? { ok: false, code: "SSH_UNAVAILABLE", message: `orq-agent on ${request.alias} did not open its SSH server.` }
        : { ok: false, code: "SSH_UNAVAILABLE", message: `Nothing answered on port 22 of ${request.alias}.`, fix: "Start sshd there, or update orq-agent to a build with its own SSH server." };
    }
  }

  // -------------------------------------------------------------------------
  // Reconciling one box
  // -------------------------------------------------------------------------

  /** Run (or join the queued run of) the box's reconcile. Never rejects. */
  private schedule(boxId: string): Promise<void> {
    const tail = this.queues.get(boxId);
    if (tail && this.queued.has(boxId)) return tail;
    this.queued.add(boxId);
    const run = (tail ?? Promise.resolve()).then(async () => {
      this.queued.delete(boxId);
      try {
        await this.reconcile(boxId);
      } catch (error) {
        this.warn("agent SSH: reconciling a box failed", error, { boxId });
      }
    });
    this.queues.set(boxId, run);
    void run.then(() => {
      if (this.queues.get(boxId) === run) this.queues.delete(boxId);
    });
    return run;
  }

  private async reconcile(boxId: string): Promise<void> {
    const fresh = this.fresh.delete(boxId);
    const wanted = this.wanted(boxId);
    const before = [...this.aliases.values()].filter((alias) => alias.boxId === boxId);
    const revoked: Alias[] = [];
    for (const alias of before) {
      const want = wanted.find((candidate) => candidate.threadId === alias.threadId);
      if (!want || (want.fixedName !== null && want.fixedName !== alias.name)) revoked.push(alias);
    }
    for (const alias of revoked) await this.revokeOnHost(alias);
    for (const want of wanted) {
      const existing = this.aliases.get(keyOf(boxId, want.threadId));
      if (existing) {
        existing.expiresAt = want.expiresAt;
        continue;
      }
      await this.issueOnHost(boxId, want).catch((error) => this.warn("agent SSH: an alias could not be issued", error, { boxId }));
    }
    await this.syncBox(boxId, fresh);
    await this.writeKnownHosts();
    // Chats in box projects: their copies follow (in the project box's own queue).
    const projectBoxes = new Set<string>();
    for (const alias of [...revoked, ...this.aliases.values()]) {
      if (alias.boxId !== boxId || alias.threadId === null) continue;
      const chatBox = this.chatProjectBox(alias.threadId);
      if (chatBox && chatBox !== boxId) projectBoxes.add(chatBox);
      for (const [projectBoxId, placed] of this.placements) if (placed.has(alias.name)) projectBoxes.add(projectBoxId);
    }
    for (const projectBoxId of projectBoxes) void this.schedule(projectBoxId);
    await this.reconcilePlacements(boxId, fresh);
    this.armDeadline();
  }

  /** The aliases this box should have now. */
  private wanted(boxId: string): Wanted[] {
    const record = this.deps.registry.get(boxId);
    if (!record || GONE_STATES.has(record.state) || this.removed.has(boxId)) return [];
    const out: Wanted[] = [];
    const threadId = record.purpose === "temporary" ? (record.threadId ?? null) : null;
    if (threadId !== null && this.chatOpen(threadId)) {
      const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : NaN;
      const expiresAt = Number.isFinite(deadline) ? deadline : null;
      const has = this.aliases.has(keyOf(boxId, threadId));
      const live = expiresAt === null || expiresAt > this.now();
      if (live && (record.state === "ready" || (has && KEEP_STATES.has(record.state)))) {
        out.push({ threadId, fixedName: null, label: labelOf(record), expiresAt });
      }
    }
    const entry = this.machineEntries.get(boxId);
    if (entry) out.push({ threadId: null, fixedName: entry.alias, label: entry.alias, expiresAt: null });
    return out;
  }

  private stillWanted(alias: Alias): boolean {
    return this.wanted(alias.boxId).some((want) => want.threadId === alias.threadId && (want.fixedName === null || want.fixedName === alias.name));
  }

  private chatOpen(threadId: string): boolean {
    return !this.closedThreads.has(threadId) && (!this.chatsKnown || this.deps.chats.isOpen(threadId));
  }

  /** The project box a chat's CLI runs in, or null for a host project. */
  private chatProjectBox(threadId: string): string | null {
    const projectPath = this.deps.chats.projectPath(threadId);
    if (!projectPath) return null;
    const location = this.deps.registry.locate(projectPath);
    return location.kind === "box" ? location.boxId : null;
  }

  private chatInBox(threadId: string): boolean {
    return this.chatProjectBox(threadId) !== null;
  }

  /** A name no live alias holds (a machine-level name moves a chat's alias that held it aside). */
  private async claimName(want: Wanted): Promise<string> {
    const taken = (name: string) => [...this.aliases.values()].some((alias) => alias.name === name);
    if (want.fixedName !== null) {
      const holder = [...this.aliases.values()].find((alias) => alias.name === want.fixedName);
      if (holder) {
        await this.revokeOnHost(holder);
        void this.schedule(holder.boxId);
      }
      return want.fixedName;
    }
    const base = agentSshAliasName(want.label) ?? "box";
    const reserved = new Set([...this.machineEntries.values()].map((entry) => entry.alias));
    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? "" : `-${index}`;
      const name = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!taken(name) && !reserved.has(name)) return name;
    }
  }

  private async issueOnHost(boxId: string, want: Wanted): Promise<void> {
    const name = await this.claimName(want);
    const alias = agentSshAlias(name);
    const tag: AgentSshKeyTag = { threadId: want.threadId, boxId };
    const keyPath = want.threadId === null ? machineSshKeyPath(this.deps.baseDir, alias) : agentChatThreadSshKeyPath(this.deps.baseDir, want.threadId, alias);
    if (!(await isFile(keyPath)) || !(await isFile(`${keyPath}.pub`))) await this.generateKey(keyPath, agentSshKeyComment(tag));
    const record: Alias = {
      key: keyOf(boxId, want.threadId),
      name,
      alias,
      boxId,
      threadId: want.threadId,
      keyPath,
      publicKey: normalizeHostKey(await readFile(`${keyPath}.pub`, "utf8")),
      user: null,
      hostKeys: [],
      via: null,
      expiresAt: want.expiresAt,
      ready: false
    };
    this.aliases.set(record.key, record);
    this.deps.logger?.info?.("agent SSH: alias issued", { alias, boxId, threadId: want.threadId });
  }

  /** Forget an alias on this host: its config, key and pin. The box side follows in {@link syncBox}. */
  private async revokeOnHost(alias: Alias): Promise<void> {
    this.aliases.delete(alias.key);
    await this.serialFiles(async () => {
      await rm(managedSshConfigPath(this.deps.home, alias.name), { force: true });
      await rm(alias.keyPath, { force: true });
      await rm(`${alias.keyPath}.pub`, { force: true });
    });
    this.deps.logger?.info?.("agent SSH: alias revoked", { alias: alias.alias, boxId: alias.boxId, threadId: alias.threadId });
  }

  /**
   * The box side of every alias of a connected box: Phase 2 pushes the key set and pins the
   * built-in server's host key; Phase 1 writes the tagged `authorized_keys` lines and pins sshd's
   * host keys. Either way, tagged lines of this box that are no longer live are removed.
   */
  private async syncBox(boxId: string, fresh: boolean): Promise<void> {
    const connection = this.deps.hub.get(boxId);
    const aliases = [...this.aliases.values()].filter((alias) => alias.boxId === boxId);
    if (!connection?.connected) {
      // Away: what it had stays offered (connecting says it is offline); configs stay as written.
      // Its next connect applies the box side again (a revoked key's line goes then).
      this.applied.delete(boxId);
      return;
    }
    const posix = connection.sys.os !== "win32";
    const builtIn = connection.capabilities?.includes("ssh-server") === true;
    const signature = JSON.stringify({
      builtIn,
      hostKey: connection.sshHostKey ?? null,
      user: connection.sys.user,
      keys: aliases.map((alias) => [alias.key, alias.name, alias.publicKey, alias.expiresAt])
    });
    if (!fresh && this.applied.get(boxId) === signature) return;
    this.applied.delete(boxId);
    let hostKeys: string[] = [];
    let via: Alias["via"] = null;
    try {
      if (builtIn) {
        const keys = aliases
          .filter((alias) => alias.publicKey !== null)
          .map((alias) => ({ publicKey: alias.publicKey!, comment: agentSshKeyComment({ threadId: alias.threadId, boxId }), expiresAt: alias.expiresAt }));
        await connection.request("ssh.keys", { keys }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
        const pinned = connection.sshHostKey ? normalizeHostKey(connection.sshHostKey) : null;
        hostKeys = pinned ? [pinned] : [];
        via = "ssh-server";
        if (!pinned && aliases.length > 0) this.deps.logger?.warn("agent SSH: orq-agent reported no SSH host key; its aliases are not offered", { boxId });
      } else if (posix && aliases.length > 0) {
        hostKeys = await this.readSshdHostKeys(connection);
        via = "sshd";
        if (hostKeys.length === 0) this.deps.logger?.warn("agent SSH: no sshd host key on the box and no built-in SSH server; its aliases are not offered", { boxId });
      }
      if (posix) await this.writeAuthorizedKeys(connection, boxId, !builtIn && hostKeys.length > 0 ? aliases : []);
      this.applied.set(boxId, signature);
    } catch (error) {
      this.warn("agent SSH: the box side could not be set up; its aliases are not offered until it reconnects", error, { boxId });
      hostKeys = [];
    }
    for (const alias of aliases) {
      alias.user = connection.sys.user;
      alias.hostKeys = hostKeys;
      alias.via = via;
      alias.ready = hostKeys.length > 0 && alias.publicKey !== null;
      await this.writeConfig(alias).catch((error) => {
        alias.ready = false;
        this.warn("agent SSH: an alias config could not be written", error, { boxId });
      });
    }
  }

  /** Phase 1: `~/.ssh/authorized_keys` of the work user holds exactly `aliases`' lines among this box's tagged ones. */
  private async writeAuthorizedKeys(connection: BoxConnection, boxId: string, aliases: readonly Alias[]): Promise<void> {
    const sshDir = `${connection.sys.home.replace(/\/+$/, "")}/.ssh`;
    let path = `${sshDir}/authorized_keys`;
    const exists = (await connection.request("fs.stat", { path }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS })) !== null;
    if (!exists && aliases.length === 0) return;
    if (exists) path = await connection.request("fs.realpath", { path }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
    const content = exists ? ((await readBoxText(connection, path)) ?? "") : "";
    const lines = aliases
      .filter((alias) => alias.publicKey !== null)
      .map((alias) => authorizedKeyLine(alias.publicKey!, agentSshKeyComment({ threadId: alias.threadId, boxId }), alias.expiresAt));
    const live = new Set(aliases.map((alias) => alias.threadId ?? "*"));
    const next = rewriteAuthorizedKeys(content, (tag) => tag.boxId === boxId && !live.has(tag.threadId ?? "*"), lines);
    if (next === content) return;
    if (!exists) await ensureBoxDir(connection, sshDir);
    await connection.writeFile(path, next, { mode: 0o600 });
  }

  private async readSshdHostKeys(connection: BoxConnection): Promise<string[]> {
    const keys: string[] = [];
    for (const path of this.deps.sshdHostKeyFiles ?? SSHD_HOST_KEY_FILES) {
      const text = await readBoxText(connection, path).catch(() => null);
      const key = text ? normalizeHostKey(text) : null;
      if (key) keys.push(key);
    }
    return keys;
  }

  // -------------------------------------------------------------------------
  // Box-project chats: the copies in their project box
  // -------------------------------------------------------------------------

  private placementOf(threadId: string, name: string): Placement | null {
    for (const placed of this.placements.values()) {
      const placement = placed.get(name);
      if (placement && placement.threadId === threadId) return placement;
    }
    return null;
  }

  /** If `projectBoxId` is a box project's box: its `~/.ssh/orquester/` holds the live aliases of its chats, and nothing else. */
  private async reconcilePlacements(projectBoxId: string, fresh: boolean): Promise<void> {
    const record = this.deps.registry.get(projectBoxId);
    const current = this.placements.get(projectBoxId) ?? new Map<string, Placement>();
    const connection = this.deps.hub.get(projectBoxId);
    const isProjectBox = record?.purpose === "project" && !GONE_STATES.has(record.state);
    const wanted = isProjectBox
      ? [...this.aliases.values()].filter((alias) => alias.ready && alias.threadId !== null && alias.boxId !== projectBoxId && this.chatProjectBox(alias.threadId) === projectBoxId)
      : [];
    // Nothing placed or wanted: only a project box that just connected is checked for leftovers.
    if (current.size === 0 && wanted.length === 0 && !(fresh && isProjectBox)) return;
    const forwards = this.deps.projectForwards;
    // Gone (or not this project's box any more): the forwards stop; the files go with the box or are swept on its next connect.
    let changed = fresh;
    for (const [name, placement] of current) {
      if (wanted.some((alias) => alias.name === name && alias.threadId === placement.threadId)) continue;
      current.delete(name);
      changed = true;
      await placement.forward.close().catch(() => undefined);
    }
    if (!connection?.connected || connection.sys.os === "win32" || !forwards) {
      this.storePlacements(projectBoxId, current);
      return;
    }
    const home = connection.sys.home.replace(/\/+$/, "");
    const dir = `${home}/.ssh/orquester`;
    try {
      if (wanted.length === 0 && (await connection.request("fs.stat", { path: dir }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS })) === null) {
        this.storePlacements(projectBoxId, current);
        return;
      }
      await ensureBoxDir(connection, `${home}/.ssh`);
      await ensureBoxDir(connection, `${dir}/keys`);
      for (const alias of wanted) {
        const existing = current.get(alias.name);
        let forward = existing?.forward ?? null;
        if (forward && !(await forward.alive())) forward = null;
        if (!forward) {
          const threadId = alias.threadId!;
          forward = await forwards.open(projectBoxId, FORWARD_PREFERRED_PORT, async () => {
            const outcome = await this.openProxy({ v: 1, alias: alias.alias, threadId });
            if (!outcome.ok) throw new Error(outcome.message);
            return outcome.stream;
          });
        }
        const keyFile = `${dir}/keys/${alias.alias}`;
        const conf = renderAliasConfig({
          alias: alias.alias,
          tag: { threadId: alias.threadId, boxId: alias.boxId },
          user: alias.user ?? connection.sys.user,
          identityFile: keyFile,
          knownHostsFile: `${dir}/known_hosts`,
          transport: { kind: "forward", port: forward.boxPort }
        });
        // Its pins too: the box's known_hosts is rewritten when the target's host key changed.
        const written = `${conf}\0${alias.keyPath}\0${alias.hostKeys.join(",")}`;
        if (fresh || existing?.written !== written || existing.forward !== forward) {
          await connection.writeFile(keyFile, await readFile(alias.keyPath), { mode: 0o600 });
          await connection.writeFile(`${dir}/${alias.name}.conf`, conf, { mode: 0o600 });
          changed = true;
        }
        current.set(alias.name, { threadId: alias.threadId!, name: alias.name, alias: alias.alias, forward, home, written });
      }
      if (changed) {
        const pins = new Map<string, readonly string[]>();
        for (const alias of wanted) if (current.has(alias.name)) pins.set(alias.alias, alias.hostKeys);
        await connection.writeFile(`${dir}/known_hosts`, renderKnownHosts(pins), { mode: 0o600 });
        await this.sweepBoxDir(connection, dir, current);
      }
    } catch (error) {
      this.warn("agent SSH: a box project's ssh files could not be written", error, { boxId: projectBoxId });
    }
    this.storePlacements(projectBoxId, current);
  }

  /** Remove what `~/.ssh/orquester/` of a project box holds beyond its live placements. */
  private async sweepBoxDir(connection: BoxConnection, dir: string, live: ReadonlyMap<string, Placement>): Promise<void> {
    const confs = new Set([...live.keys()].map((name) => `${name}.conf`));
    const keys = new Set([...live.values()].map((placement) => placement.alias));
    for (const entry of await connection.request("fs.readdir", { path: dir }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS })) {
      if (entry.name === "keys" || entry.name === "known_hosts" || confs.has(entry.name)) continue;
      await connection.request("fs.rm", { path: `${dir}/${entry.name}`, recursive: true, force: true }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
    }
    for (const entry of await connection.request("fs.readdir", { path: `${dir}/keys` }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS })) {
      if (keys.has(entry.name)) continue;
      await connection.request("fs.rm", { path: `${dir}/keys/${entry.name}`, recursive: true, force: true }, { timeoutMs: BOX_REQUEST_TIMEOUT_MS });
    }
  }

  private storePlacements(projectBoxId: string, placed: Map<string, Placement>): void {
    if (placed.size === 0) this.placements.delete(projectBoxId);
    else this.placements.set(projectBoxId, placed);
  }

  // -------------------------------------------------------------------------
  // Host files
  // -------------------------------------------------------------------------

  private hostCommand(alias: Alias): string {
    return this.includeActive ? `ssh ${alias.alias}` : `ssh -F ${shellWord(managedSshConfigPath(this.deps.home, alias.name))} ${alias.alias}`;
  }

  private async writeConfig(alias: Alias): Promise<void> {
    if (!this.aliases.has(alias.key)) return;
    const path = managedSshConfigPath(this.deps.home, alias.name);
    if (!alias.ready || alias.user === null) {
      await this.serialFiles(() => rm(path, { force: true }));
      return;
    }
    const proxy = [this.deps.nodePath ?? process.execPath, this.deps.helperPath ?? SSH_PROXY_HELPER_PATH, sshProxySocketPath(this.deps.baseDir), alias.alias];
    if (alias.threadId !== null) proxy.push(alias.threadId);
    const content = renderAliasConfig({
      alias: alias.alias,
      tag: { threadId: alias.threadId, boxId: alias.boxId },
      user: alias.user,
      identityFile: alias.keyPath,
      knownHostsFile: this.knownHostsPath,
      transport: { kind: "proxy", command: proxy }
    });
    await this.serialFiles(async () => {
      const before = await readFile(path, "utf8").catch(() => null);
      if (before !== content) await writePrivateFile(path, content);
    });
  }

  /** The pins of every alias that has one, as one file. */
  private async writeKnownHosts(): Promise<void> {
    const pins = new Map<string, readonly string[]>();
    for (const alias of this.aliases.values()) if (alias.hostKeys.length > 0) pins.set(alias.alias, alias.hostKeys);
    const content = renderKnownHosts(pins);
    await this.serialFiles(async () => {
      const before = await readFile(this.knownHostsPath, "utf8").catch(() => null);
      if (before === content || (before === null && content === "")) return;
      await writePrivateFile(this.knownHostsPath, content);
    }).catch((error) => this.warn("agent SSH: the pinned host keys could not be written", error));
  }

  private async generateKey(keyPath: string, comment: string): Promise<void> {
    const dir = dirname(keyPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${keyPath}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(this.deps.sshKeygen ?? "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", tmp], { timeout: 30_000 }, (error) =>
          error ? reject(new Error(`ssh-keygen failed (${(error as NodeJS.ErrnoException).code ?? "error"})`)) : resolve()
        );
        child.stdin?.end();
      });
      await chmod(tmp, 0o600);
      await chmod(`${tmp}.pub`, 0o600);
      await rename(`${tmp}.pub`, `${keyPath}.pub`);
      await rename(tmp, keyPath);
    } finally {
      await rm(tmp, { force: true });
      await rm(`${tmp}.pub`, { force: true });
    }
  }

  /** Read back the managed configs of a previous run: each one ours keeps its name, key and pins. */
  private async recover(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.configDir);
    } catch {
      return;
    }
    const pins = parseKnownHosts(await readFile(this.knownHostsPath, "utf8").catch(() => ""));
    for (const file of names) {
      if (!file.endsWith(".conf")) continue;
      const name = file.slice(0, -".conf".length);
      const parsed = parseManagedConfig(await readFile(join(this.configDir, file), "utf8").catch(() => ""));
      if (!parsed || parsed.alias !== agentSshAlias(name) || !parsed.alias.startsWith(AGENT_SSH_ALIAS_PREFIX)) continue;
      const { tag } = parsed;
      const keyPath = tag.threadId === null ? machineSshKeyPath(this.deps.baseDir, parsed.alias) : agentChatThreadSshKeyPath(this.deps.baseDir, tag.threadId, parsed.alias);
      const publicKey = normalizeHostKey(await readFile(`${keyPath}.pub`, "utf8").catch(() => ""));
      const hostKeys = pins.get(parsed.alias) ?? [];
      const key = keyOf(tag.boxId, tag.threadId);
      if (this.aliases.has(key) || !publicKey || !(await isFile(keyPath))) {
        // A config without its key (or a second one for the same chat and box) is of no use.
        await rm(join(this.configDir, file), { force: true });
        continue;
      }
      this.aliases.set(key, {
        key,
        name,
        alias: parsed.alias,
        boxId: tag.boxId,
        threadId: tag.threadId,
        keyPath,
        publicKey,
        user: parsed.user,
        hostKeys,
        via: null,
        expiresAt: null,
        ready: hostKeys.length > 0 && parsed.user !== null
      });
    }
    // The machine-level entries come from the registry's first sync; until then theirs stay as read.
    for (const alias of this.aliases.values()) {
      if (alias.threadId !== null || this.machinesSynced || this.machineEntries.has(alias.boxId)) continue;
      this.machineEntries.set(alias.boxId, { machineId: "", boxId: alias.boxId, alias: alias.name });
    }
  }

  private async applyInclude(enabled: boolean): Promise<void> {
    // Off at once: until the line is surely in, agents are shown the `-F` form, which always works.
    this.includeActive = false;
    try {
      await this.serialFiles(() => applySshConfigInclude(this.deps.home, enabled));
      this.includeActive = enabled;
    } catch (error) {
      this.warn(`agent SSH: the Include line could not be ${enabled ? "added to" : "removed from"} ~/.ssh/config`, error);
    }
  }

  private serialFiles<T>(run: () => Promise<T>): Promise<T> {
    const result = this.files.then(run);
    this.files = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** One timer for the next alias deadline: its box is reconciled then (the box's own destroy usually comes first). */
  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (!this.started || this.unsubscribers.length === 0) return;
    const now = this.now();
    const next = Math.min(...[...this.aliases.values()].map((alias) => alias.expiresAt ?? Infinity).filter((at) => at > now));
    if (!Number.isFinite(next)) return;
    this.deadlineTimer = setTimeout(
      () => {
        this.deadlineTimer = null;
        const due = this.now();
        for (const alias of [...this.aliases.values()]) if (alias.expiresAt !== null && alias.expiresAt <= due) void this.schedule(alias.boxId);
        this.armDeadline();
      },
      Math.min(next - now + 1, 2 ** 31 - 1)
    );
    this.deadlineTimer.unref?.();
  }

  private warn(message: string, error?: unknown, meta: Record<string, unknown> = {}): void {
    this.deps.logger?.warn(message, error === undefined ? meta : { ...meta, error: errorText(error) });
  }
}

/** What an alias of a box is named after: the owner's name for their machine, else the box id (`orq-<id>` like the instance). */
function labelOf(record: StoredBox): string {
  return record.provider === "byo" && record.machineName ? record.machineName : record.id;
}

/** The machines registry's port onto the agent SSH service (`machines/ports.ts`). */
export function createMachineSshAccess(agentSsh: Pick<AgentSsh, "syncMachines">): MachineSshAccessPort {
  return { sync: (entries) => agentSsh.syncMachines(entries) };
}
