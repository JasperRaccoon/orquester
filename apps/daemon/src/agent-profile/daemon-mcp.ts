/**
 * Daemon-pointing MCP servers (unified MCP design 2026-10-15 §12.1, D-12): every MCP server an
 * agent CLI would load that reaches THIS daemon's full-trust `/mcp`, so Orquester can deny it
 * inside the chats it launches (the manifest's `deny`, plan Task 6) and the agent-profile panel
 * can say "Disabled inside Orquester chats".
 *
 * ## What is scanned
 *
 * | Agent    | User config (per home)                                   | Project-level config                     |
 * |----------|----------------------------------------------------------|------------------------------------------|
 * | claude   | `<home>/.claude.json` `mcpServers`; `projects[<p>].mcpServers` (local scope, reported as `project`) | `<p>/.mcp.json` `mcpServers` |
 * | codex    | `<CODEX_HOME>/config.toml` `[mcp_servers.<n>]`           | `<p>/.codex/config.toml`                 |
 * | grok     | `<GROK_HOME>/config.toml` `[mcp_servers.<n>]`, plus the system `~/.claude.json` `mcpServers` Grok inherits | `<p>/.grok/config.toml` |
 * | opencode | `<dir>/{config.json,opencode.json,opencode.jsonc}` `mcp` | `<p>/opencode.json`, `<p>/opencode.jsonc` |
 *
 * A chat whose cwd is a subdirectory of its project loads the project-level configs of EVERY
 * directory from the project root down to its cwd (Codex 0.159.0 loads each `.codex/config.toml`
 * on that path — probed; Claude, OpenCode and Grok search upward from the cwd), and Claude's local
 * scope may be keyed by any of them: with `cwd`, each of those directories is scanned as a project
 * (`projectPath` = the directory that holds the config).
 *
 * Codex loads a project-level `.codex/config.toml` only where it TRUSTS the directory (probed on
 * 0.159.0): in a git repository, each directory from the repository root down to the cwd, a
 * directory trusted when its own `[projects."<dir>"] trust_level` in that home's `config.toml` is
 * `"trusted"`, else when the repository root's is (an explicit `"untrusted"` wins; keys match
 * exactly); outside a repository, the cwd's directory alone, by its own entry. That is reported
 * for display only (`loadedByHomes`): a chat denies every Codex server found whatever the trust,
 * because the Codex session sends a harmless disabled stub for one its config does not define
 * (`adapters/codex/session-tools.ts`). For the same reason every ancestor of a scanned project is
 * read for a `.codex/config.toml` too, up to the filesystem root (Codex starts at its project
 * root — the git root, or what `project_root_markers` names — which may lie above an Orquester
 * project).
 *
 * Homes: the daemon user's own (`home: "system"`) and **every managed account home** of the
 * agent's family (`home: <account id>`; spec S11). A file already read through another home (an
 * account's `config.toml` is a symlink to the system one) is read once, under the first home.
 * Project-level files carry `home: "system"`.
 *
 * ## When a server is flagged (most specific reason wins)
 *
 * 1. `bearer` — one of its header values, environment values or arguments (a stdio bridge such as
 *    `mcp-remote … --header "Authorization: Bearer …"`), or an environment variable it names for
 *    its bearer (`bearer_token_env_var`, `env_http_headers`, `${VAR}`), is a credential this
 *    daemon's auth verifier accepts. The comparison is the verifier's own constant-time digest
 *    check: a value is never logged, stored, returned or echoed.
 * 2. `url` — its URL (or an argument that is a URL) resolves to this daemon's `/mcp`: a loopback
 *    host (`localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`) on the daemon's HTTP port, or one of the
 *    configured public origins, with path `/mcp`.
 * 3. `name` — it is named exactly `orquester` (Orquester's own in-chat server is injected at
 *    launch, never written to a user or project config). Not for Codex: there Orquester's own
 *    server takes another name when the config has an `orquester`, so a user's that points
 *    nowhere near this daemon is left alone.
 *
 * Unreadable or unparsable files contribute nothing (logged by path, never by content).
 *
 * ## API (consumed by the chat manifest, plan Task 6)
 *
 * - `DaemonMcpDetector.detect({projectPath?, cwd?})` → `DaemonPointingServer[]`: user-scope servers
 *   of every home, plus project-level ones — of `projectPath` only when it is given (what a chat in
 *   that project loads; with `cwd`, a directory inside it, of every directory from `projectPath`
 *   down to `cwd`), else of every project under the workspaces root (the panel's view).
 * - `GET /api/agent-profile/daemon-mcp-servers[?projectPath=<abs>[&cwd=<abs>]]` (both transports;
 *   bearer on HTTP) answers `{servers}` from the same call.
 * - `DaemonMcpDetector.check(candidate)` → the reason a definition (an `edit_agent_profile`
 *   change, the current one merged in) would be flagged, or null. Socket-only route
 *   `POST /api/agent-profile/daemon-mcp-servers/check` for the tool's card preview.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE,
  isAgentProfileAgentId,
  type AgentProfileAgentId,
  type DaemonMcpServersResponse,
  type DaemonPointingReason,
  type DaemonPointingServer
} from "@orquester/api";
import type { AgentHomes } from "./adapters/types.ts";
import { parseToml, isTable, type TomlTable } from "./adapters/grok/toml-patch.ts";
import { parseJsoncObject } from "./adapters/opencode/jsonc.ts";
import { AgentProfileError } from "./errors.ts";
import { DAEMON_MCP_SERVERS_CHECK_ROUTE, type DaemonMcpCheckResponse } from "@orquester/api";

/** What the daemon knows about itself; injected by `index.ts`. Never exposes the bearer. */
export interface DaemonMcpIdentity {
  /** The HTTP transport's own credential check (constant time); `false` when HTTP has no credential. */
  verifyBearer(token: string): boolean;
  /** The HTTP transport's port (loopback URLs on it reach `/mcp`). */
  httpPort(): number | null;
  /** Other origins (`https://host[:port]`) that reach this daemon's HTTP transport. */
  publicOrigins(): readonly string[];
  /** The value of an environment variable a config names for its bearer (`bearer_token_env_var`, `${VAR}`). */
  env(name: string): string | undefined;
}

export interface DaemonMcpSources {
  /** The daemon user's own agent homes. */
  homes: AgentHomes;
  /** Every managed account home of an agent family (`[]` for OpenCode). */
  accountHomes(agent: AgentProfileAgentId): Promise<{ id: string; home: string }[]>;
  /** Every project directory (`<workspaces>/<ws>/<project>`), for the panel's all-projects view. */
  projects(): Promise<string[]>;
  /** The workspaces root: a `projectPath` filter must realpath inside it. */
  workspacesRoot(): string;
  logger?: { warn(message: string): void };
}

/** One server definition, normalised across the CLIs' shapes. Holds real values: never serialised. */
export interface McpCandidate {
  name: string;
  url?: string;
  /** Every string a credential may hide in: header values, env values, arguments, the command. */
  values: string[];
  /** Environment variable names whose value the CLI sends as (part of) a header. */
  envRefs: string[];
}

/** The name Orquester's own in-chat server uses (`SESSION_TOOLS_SERVER_NAME`). */
const ORQUESTER_NAME = "orquester";
const MCP_PATH = "/mcp";
const CLAUDE_JSON = ".claude.json";
const OPENCODE_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const;
const OPENCODE_PROJECT_FILES = ["opencode.json", "opencode.jsonc"] as const;
/** A config file larger than this is not read (no CLI config is close). */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (isRecord(value)) return Object.values(value).filter((entry): entry is string => typeof entry === "string");
  return [];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "::1", "[::1]", "::", "[::]"]);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // WHATWG URL writes an IPv4-mapped loopback (`[::ffff:127.0.0.1]`) as `[::ffff:7f00:1]`.
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith(".localhost") || /^\[?::ffff:(127\.|7f[0-9a-f]{2}:)/.test(host);
}

function defaultPort(protocol: string): number | null {
  return protocol === "http:" || protocol === "ws:" ? 80 : protocol === "https:" || protocol === "wss:" ? 443 : null;
}

/** Whether `text` is a URL that reaches this daemon's `/mcp`. */
export function urlReachesDaemon(text: string, port: number | null, origins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== MCP_PATH) return false;
  const urlPort = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  if (port !== null && urlPort === port && isLoopbackHost(url.hostname)) return true;
  for (const origin of origins) {
    try {
      const allowed = new URL(origin);
      const allowedPort = allowed.port === "" ? defaultPort(allowed.protocol) : Number(allowed.port);
      if (allowed.protocol === url.protocol && allowed.hostname.toLowerCase() === url.hostname.toLowerCase() && allowedPort === urlPort) return true;
    } catch {
      // A bad configured origin matches nothing.
    }
  }
  return false;
}

/** The bearer candidates one string may hold: as it is, without `Authorization:` / `Bearer `, and each `Bearer x` inside it. */
function bearerCandidates(text: string, identity: DaemonMcpIdentity): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length <= 4096) out.add(trimmed);
  };
  const resolved = resolveEnvRef(text, identity);
  for (const value of resolved === undefined ? [text] : [text, resolved]) {
    add(value);
    add(value.replace(/^\s*authorization\s*[:=]\s*/i, "").replace(/^\s*bearer\s+/i, ""));
    for (const match of value.matchAll(/bearer\s+([A-Za-z0-9._~+/=-]+)/gi)) add(match[1]);
  }
  return [...out];
}

/** `${VAR}`, `$VAR`, `${env:VAR}`, `{env:VAR}` (OpenCode) → the variable's value. */
function resolveEnvRef(text: string, identity: DaemonMcpIdentity): string | undefined {
  const match = /^\s*(?:Bearer\s+)?(?:\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})\s*$/i.exec(text);
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  return name ? identity.env(name) : undefined;
}

/** Why `candidate` points at this daemon, or null. Never throws, never logs a value. */
export function pointingReason(candidate: McpCandidate, identity: DaemonMcpIdentity): DaemonPointingReason | null {
  const values = [...candidate.values];
  for (const name of candidate.envRefs) {
    const value = identity.env(name);
    if (value !== undefined) values.push(value);
  }
  for (const value of values) {
    for (const token of bearerCandidates(value, identity)) {
      if (identity.verifyBearer(token)) return "bearer";
    }
  }
  const port = identity.httpPort();
  const origins = identity.publicOrigins();
  for (const text of [candidate.url, ...candidate.values]) {
    if (text !== undefined && /^\s*(?:https?|wss?):\/\//i.test(text) && urlReachesDaemon(text, port, origins)) return "url";
  }
  return candidate.name === ORQUESTER_NAME ? "name" : null;
}

// ---------------------------------------------------------------------------
// Config shapes → candidates
// ---------------------------------------------------------------------------

/** Claude / Grok-inherited / `.mcp.json`: `{command, args, env, url, headers, headersHelper?}`. */
function claudeCandidates(servers: unknown): McpCandidate[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, def]) => {
    if (!isRecord(def)) return [];
    return [{
      name,
      ...(typeof def.url === "string" ? { url: def.url } : {}),
      values: [...strings(def.headers), ...strings(def.env), ...strings(def.args), ...strings(def.command)],
      envRefs: []
    }];
  });
}

/** Codex / Grok `[mcp_servers.<n>]`: `url`, `http_headers`, `headers`, `env_http_headers`, `bearer_token_env_var`, `command`, `args`, `env`. */
function tomlCandidates(doc: TomlTable): McpCandidate[] {
  const servers = doc.mcp_servers;
  if (!isTable(servers)) return [];
  return Object.entries(servers).flatMap(([name, def]) => {
    if (!isTable(def)) return [];
    return [{
      name,
      ...(typeof def.url === "string" ? { url: def.url } : {}),
      values: [...strings(def.http_headers), ...strings(def.headers), ...strings(def.env), ...strings(def.args), ...strings(def.command)],
      envRefs: [...strings(def.bearer_token_env_var), ...strings(def.env_http_headers), ...strings(def.env_vars)]
    }];
  });
}

/** OpenCode `mcp.<n>`: `{type: "local", command: [...], environment}` | `{type: "remote", url, headers}`. */
function opencodeCandidates(doc: Record<string, unknown>): McpCandidate[] {
  const servers = doc.mcp;
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, def]) => {
    if (!isRecord(def)) return [];
    return [{
      name,
      ...(typeof def.url === "string" ? { url: def.url } : {}),
      values: [...strings(def.headers), ...strings(def.environment), ...strings(def.command)],
      envRefs: []
    }];
  });
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

type FileShape = "claude-json" | "mcp-json" | "toml" | "opencode";

interface ScanTarget {
  agent: AgentProfileAgentId;
  home: string;
  scope: "user" | "project";
  projectPath?: string;
  path: string;
  shape: FileShape;
  /** `claude-json` user files: also read `projects[<p>].mcpServers` (local scope) — of the `only` directories (realpaths), or of every project. */
  local?: { only?: ReadonlySet<string> };
  /** Every home of `agent` loads this file (`DaemonPointingServer.allHomes`). */
  allHomes?: true;
  /** A Codex project-level file: the cwd of the chat it is read for (its trust decides who loads it). */
  codexCwd?: string;
}

/** Each Codex home's project trust table (`[projects."<dir>"] trust_level`). */
type CodexTrust = { home: string; levels: ReadonlyMap<string, string> }[];

export class DaemonMcpDetector {
  constructor(
    private readonly identity: DaemonMcpIdentity,
    private readonly sources: DaemonMcpSources
  ) {}

  /** The reason `candidate` would be flagged, or null (a card preview's check). */
  check(candidate: McpCandidate): DaemonPointingReason | null {
    return pointingReason(candidate, this.identity);
  }

  /**
   * Every flagged server: user configs of every home, and project-level configs — of
   * `projectPath` only when given (the chat manifest; with `cwd`, of every directory from it down
   * to `cwd`), else of every project (the panel).
   */
  async detect(options: { projectPath?: string; cwd?: string } = {}): Promise<DaemonPointingServer[]> {
    if (options.cwd !== undefined && !options.projectPath) throw new AgentProfileError(400, "INVALID_REQUEST", "cwd needs projectPath.");
    const projectFilter = options.projectPath ? await this.containedProject(options.projectPath) : undefined;
    const dirs = projectFilter !== undefined ? await this.configDirs(projectFilter, options.cwd) : undefined;
    // A project reached through a symlink: Codex may resolve its layers from the LINK's path, so
    // that path's ancestors are read too.
    const lexical = options.projectPath !== undefined && projectFilter !== undefined && resolve(options.projectPath) !== projectFilter ? [resolve(options.projectPath)] : [];
    const targets = await this.targets(dirs, options.cwd !== undefined ? dirs?.at(-1) : undefined, lexical);
    const codexTrust = targets.some((target) => target.codexCwd !== undefined) ? await this.codexTrust() : [];
    const gitRoots = new Map<string, Promise<string | undefined>>();
    const seenFiles = new Set<string>();
    const out: DaemonPointingServer[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const real = await realpathOr(target.path);
      const fileKey = `${target.agent}\0${target.shape}\0${real}`;
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      const text = await this.read(real);
      if (text === null) continue;
      let found: { candidate: McpCandidate; scope: "user" | "project"; projectPath?: string }[];
      try {
        found = await this.candidatesOf(target, text);
      } catch (error) {
        this.sources.logger?.warn(`daemon-pointing MCP scan: ${target.path} could not be parsed (${error instanceof Error ? error.name : "error"}); skipped.`);
        continue;
      }
      for (const { candidate, scope, projectPath } of found) {
        const reason = pointingReason(candidate, this.identity);
        // Codex registers Orquester's own server under another name where the config has an
        // `orquester` (`adapters/codex/session-tools.ts`): a user's `orquester` that does not point
        // at this daemon is left alone there.
        if (reason === null || (target.agent === "codex" && reason === "name")) continue;
        const key = [target.agent, target.home, scope, projectPath ?? "", candidate.name].join("\0");
        if (seen.has(key)) {
          // The same name in the system Grok config and in ~/.claude.json: every Grok home loads it.
          if (target.allHomes) {
            const entry = out.find((server) => [server.agent, server.home, server.scope, server.projectPath ?? "", server.name].join("\0") === key);
            if (entry) entry.allHomes = true;
          }
          continue;
        }
        seen.add(key);
        let loadedByHomes: string[] | undefined;
        if (target.codexCwd !== undefined && target.projectPath !== undefined) {
          // Codex matches its trust keys against real paths.
          const cwd = await realpathOr(target.codexCwd);
          let gitRoot = gitRoots.get(cwd);
          if (gitRoot === undefined) {
            gitRoot = this.gitRoot(cwd);
            gitRoots.set(cwd, gitRoot);
          }
          loadedByHomes = codexLoadingHomes(await realpathOr(target.projectPath), cwd, await gitRoot, codexTrust);
        }
        out.push({
          agent: target.agent,
          home: target.home,
          scope,
          ...(projectPath ? { projectPath } : {}),
          name: candidate.name,
          reason,
          ...(target.allHomes ? { allHomes: true as const } : {}),
          ...(loadedByHomes !== undefined ? { loadedByHomes } : {})
        });
      }
    }
    return out;
  }

  /**
   * A `projectPath` filter's realpath, which must lie strictly inside the workspaces root (the
   * sandbox rule): anything else is refused (400, the same answer whether or not it exists) and never read.
   */
  private async containedProject(projectPath: string): Promise<string> {
    let real: string;
    let root: string;
    try {
      [real, root] = await Promise.all([realpath(projectPath), realpath(this.sources.workspacesRoot())]);
    } catch {
      throw new AgentProfileError(400, "PATH_NOT_CONTAINED", "projectPath is not a project under the workspaces root.");
    }
    if (!real.startsWith(`${root}${sep}`)) throw new AgentProfileError(400, "PATH_NOT_CONTAINED", "projectPath is not a project under the workspaces root.");
    return real;
  }

  /**
   * The directories a chat in `project` (a contained realpath) with `cwd` loads project-level
   * configs from: `project`, then each directory down to `cwd`'s realpath, which must be `project`
   * or inside it (else refused, 400, never read). Without `cwd`, `project` alone.
   */
  private async configDirs(project: string, cwd: string | undefined): Promise<string[]> {
    if (cwd === undefined) return [project];
    let real: string;
    try {
      real = await realpath(cwd);
    } catch {
      throw new AgentProfileError(400, "PATH_NOT_CONTAINED", "cwd is not a directory inside projectPath.");
    }
    if (real === project) return [project];
    if (!real.startsWith(`${project}${sep}`)) throw new AgentProfileError(400, "PATH_NOT_CONTAINED", "cwd is not a directory inside projectPath.");
    const dirs = [project];
    let dir = project;
    for (const part of real.slice(project.length + 1).split(sep)) {
      dir = join(dir, part);
      dirs.push(dir);
    }
    return dirs;
  }

  /** The trust table of every Codex home (system and managed accounts); an unreadable one trusts nothing. */
  private async codexTrust(): Promise<CodexTrust> {
    let accounts: { id: string; home: string }[] = [];
    try {
      accounts = await this.sources.accountHomes("codex");
    } catch {
      accounts = [];
    }
    const homes = [{ id: "system", home: this.sources.homes.codexHome }, ...accounts];
    const out: { home: string; levels: Map<string, string> }[] = [];
    for (const { id, home } of homes) {
      const levels = new Map<string, string>();
      const text = await this.read(await realpathOr(join(home, "config.toml")));
      let projects: unknown;
      try {
        projects = text === null ? undefined : parseToml(text).projects;
      } catch {
        projects = undefined;
      }
      if (isTable(projects)) {
        for (const [dir, entry] of Object.entries(projects)) {
          if (!isTable(entry) || typeof entry.trust_level !== "string") continue;
          // As written, and as its real path: a key spelled through a symlink still counts (at worst
          // a server is denied that Codex would not load — the thread fails closed, never open).
          levels.set(dir, entry.trust_level);
          const real = await realpathOr(dir);
          if (!levels.has(real)) levels.set(real, entry.trust_level);
        }
      }
      out.push({ home: id, levels });
    }
    return out;
  }

  /** The git repository `cwd` is in, as Codex finds it (display only: `loadedByHomes`). */
  private async gitRoot(cwd: string): Promise<string | undefined> {
    for (let dir = cwd; ; dir = dirname(dir)) {
      try {
        await lstat(join(dir, ".git"));
        return dir;
      } catch {
        // Not here: one level up.
      }
      if (dirname(dir) === dir) return undefined;
    }
  }

  private async targets(dirs: readonly string[] | undefined, cwd: string | undefined, lexical: readonly string[] = []): Promise<ScanTarget[]> {
    const { homes } = this.sources;
    const targets: ScanTarget[] = [];
    const local = dirs ? { only: new Set(dirs) } : {};
    // System homes.
    targets.push({ agent: "claude", home: "system", scope: "user", path: homes.claudeJson, shape: "claude-json", local });
    targets.push({ agent: "codex", home: "system", scope: "user", path: join(homes.codexHome, "config.toml"), shape: "toml" });
    targets.push({ agent: "grok", home: "system", scope: "user", path: join(homes.grokHome, "config.toml"), shape: "toml" });
    // Grok loads the user's Claude servers too (`grok inspect`: source `claudeJson`).
    // A managed Grok account sets only GROK_HOME (HOME stays the user's): every Grok home loads them.
    targets.push({ agent: "grok", home: "system", scope: "user", path: homes.claudeJson, shape: "claude-json", allHomes: true });
    for (const name of OPENCODE_FILES) {
      targets.push({ agent: "opencode", home: "system", scope: "user", path: join(homes.opencodeDir, name), shape: "opencode" });
    }
    // Every managed account home (CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME = the home).
    for (const agent of ["claude", "codex", "grok"] as const) {
      let accounts: { id: string; home: string }[] = [];
      try {
        accounts = await this.sources.accountHomes(agent);
      } catch {
        accounts = [];
      }
      for (const account of accounts) {
        targets.push(
          agent === "claude"
            ? { agent, home: account.id, scope: "user", path: join(account.home, CLAUDE_JSON), shape: "claude-json", local }
            : { agent, home: account.id, scope: "user", path: join(account.home, "config.toml"), shape: "toml" }
        );
      }
    }
    // Project-level configs.
    let projects: readonly string[];
    if (dirs) projects = dirs;
    else {
      try {
        projects = await this.sources.projects();
      } catch {
        projects = [];
      }
    }
    // Codex reads a `.codex/config.toml` in every directory from its project root (the git root,
    // or what `project_root_markers` names) down to the cwd — which may lie ABOVE an Orquester
    // project. Denying a server Codex does not load is harmless (the session sends a stub for it),
    // so every ancestor of a scanned project is read for Codex too, up to the filesystem root.
    const ancestors = new Set<string>();
    for (const project of [...projects, ...lexical]) {
      for (let dir = dirname(project); ; dir = dirname(dir)) {
        if (!projects.includes(dir)) ancestors.add(dir);
        if (dirname(dir) === dir) break;
      }
    }
    for (const dir of ancestors) {
      targets.push({ home: "system", scope: "project", projectPath: dir, agent: "codex", path: join(dir, ".codex", "config.toml"), shape: "toml", codexCwd: cwd ?? dir });
    }
    for (const project of projects) {
      const base = { home: "system", scope: "project" as const, projectPath: project };
      targets.push({ ...base, agent: "claude", path: join(project, ".mcp.json"), shape: "mcp-json" });
      // A project root read on its own (no chat cwd) is its own cwd.
      targets.push({ ...base, agent: "codex", path: join(project, ".codex", "config.toml"), shape: "toml", codexCwd: cwd ?? project });
      targets.push({ ...base, agent: "grok", path: join(project, ".grok", "config.toml"), shape: "toml" });
      for (const name of OPENCODE_PROJECT_FILES) targets.push({ ...base, agent: "opencode", path: join(project, name), shape: "opencode" });
    }
    return targets;
  }

  private async candidatesOf(
    target: ScanTarget,
    text: string
  ): Promise<{ candidate: McpCandidate; scope: "user" | "project"; projectPath?: string }[]> {
    const own = (candidates: McpCandidate[]) =>
      candidates.map((candidate) => ({ candidate, scope: target.scope, ...(target.projectPath ? { projectPath: target.projectPath } : {}) }));
    switch (target.shape) {
      case "toml":
        return own(tomlCandidates(parseToml(text)));
      case "opencode": {
        const parsed = parseJsoncObject(text);
        if (!parsed.ok) throw new SyntaxError("not JSONC");
        return own(opencodeCandidates(parsed.value));
      }
      case "mcp-json": {
        const doc: unknown = JSON.parse(text);
        return own(claudeCandidates(isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : doc));
      }
      case "claude-json": {
        const doc: unknown = JSON.parse(text);
        if (!isRecord(doc)) return [];
        const out = own(claudeCandidates(doc.mcpServers));
        if (target.local && isRecord(doc.projects)) {
          for (const [projectPath, entry] of Object.entries(doc.projects)) {
            if (!isRecord(entry)) continue;
            if (target.local.only !== undefined && !target.local.only.has(await realpathOr(projectPath))) continue;
            for (const candidate of claudeCandidates(entry.mcpServers)) out.push({ candidate, scope: "project", projectPath });
          }
        }
        return out;
      }
    }
  }

  private async read(path: string): Promise<string | null> {
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }
}

/**
 * The Codex homes that load the project-level `.codex/config.toml` in `dir` for a chat in `cwd`
 * (see the module header): `dir` is one of the layers Codex reads there, and that home trusts it.
 */
export function codexLoadingHomes(dir: string, cwd: string, gitRoot: string | undefined, trust: CodexTrust): string[] {
  const layer = gitRoot !== undefined ? (dir === gitRoot || dir.startsWith(`${gitRoot}${sep}`)) && (cwd === dir || cwd.startsWith(`${dir}${sep}`)) : dir === cwd;
  if (!layer) return [];
  return trust
    .filter(({ levels }) => (levels.get(dir) ?? (gitRoot !== undefined ? levels.get(gitRoot) : undefined)) === "trusted")
    .map(({ home }) => home);
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Every `<root>/<workspace>/<project>` directory (hidden names skipped). A PROJECT that is a symlink
 * to a directory is listed too — one level, the project's own link, never a workspace's — by the
 * path of its link: its chats load its configs through it. A deliberate exception to realpath
 * containment, for this detection read only (`session-tools/README.md`).
 */
export async function listProjectDirs(workspacesRoot: string): Promise<string[]> {
  const out: string[] = [];
  const entries = async (path: string): Promise<Dirent[]> => {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const workspace of await entries(workspacesRoot)) {
    if (workspace.name.startsWith(".") || !workspace.isDirectory()) continue;
    const dir = join(workspacesRoot, workspace.name);
    for (const project of await entries(dir)) {
      if (project.name.startsWith(".")) continue;
      if (project.isDirectory()) out.push(join(dir, project.name));
      else if (project.isSymbolicLink()) {
        try {
          if ((await stat(join(dir, project.name))).isDirectory()) out.push(join(dir, project.name));
        } catch {
          // A dangling link is no project.
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The current definition of an MCP item, as a candidate (real values, daemon-side only). */
export type CurrentMcpCandidate = (agent: AgentProfileAgentId, id: string) => Promise<McpCandidate | null>;

const CHECK_VALUES_MAX = 2_000;
const CHECK_VALUE_MAX_CHARS = 64 * 1024;

export function registerDaemonMcpServersRoutes(
  app: FastifyInstance,
  deps: { detector: DaemonMcpDetector; mode: "local" | "remote"; current?: CurrentMcpCandidate }
): void {
  app.get<{ Querystring: { projectPath?: unknown; cwd?: unknown } }>(AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, async (request, reply) => {
    const projectPath = request.query?.projectPath;
    const cwd = request.query?.cwd;
    const absolute = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !value.includes("\0");
    if (projectPath !== undefined && !absolute(projectPath)) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "projectPath must be an absolute path." } });
    }
    if (cwd !== undefined && (!absolute(cwd) || projectPath === undefined)) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "cwd must be an absolute path, with projectPath." } });
    }
    let servers: DaemonPointingServer[];
    try {
      servers = await deps.detector.detect(projectPath ? { projectPath, ...(cwd !== undefined ? { cwd } : {}) } : {});
    } catch (error) {
      if (error instanceof AgentProfileError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
    const body: DaemonMcpServersResponse = { servers };
    return body;
  });
  // The check takes candidate values (possibly a credential): trusted local control only.
  if (deps.mode !== "local") return;
  app.post<{ Body: unknown }>(DAEMON_MCP_SERVERS_CHECK_ROUTE, async (request, reply) => {
    const body = request.body;
    const bad = (message: string) => reply.code(400).send({ error: { code: "INVALID_REQUEST", message } });
    if (!isRecord(body) || !isAgentProfileAgentId(body.agent) || typeof body.name !== "string") return bad("Expected {agent, name, url?, values?, id?}.");
    if (body.url !== undefined && typeof body.url !== "string") return bad("url must be a string.");
    if (body.id !== undefined && typeof body.id !== "string") return bad("id must be a string.");
    const values = body.values ?? [];
    if (!Array.isArray(values) || values.length > CHECK_VALUES_MAX || !values.every((v) => typeof v === "string" && v.length <= CHECK_VALUE_MAX_CHARS)) {
      return bad("values must be a list of strings.");
    }
    const candidate: McpCandidate = { name: body.name, ...(body.url ? { url: body.url } : {}), values: values as string[], envRefs: [] };
    if (body.id && deps.current) {
      try {
        const current = await deps.current(body.agent, body.id);
        if (current) {
          candidate.values.push(...current.values);
          candidate.envRefs.push(...current.envRefs);
          if (candidate.url === undefined && current.url !== undefined) candidate.url = current.url;
        }
      } catch (error) {
        if (!(error instanceof AgentProfileError)) throw error;
        // An item that cannot be read adds nothing.
      }
    }
    const response: DaemonMcpCheckResponse = { reason: deps.detector.check(candidate) };
    return response;
  });
}
