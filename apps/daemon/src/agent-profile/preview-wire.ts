/**
 * The reads an `edit_agent_profile` approval card needs (unified MCP design 2026-10-15 §7.1, §7.2):
 * an item's files in full, an import scan's picked items in full with the repository's commit,
 * and a marketplace plugin's contents, `provides` and commit — each with SHA-256 content hashes
 * the card pins and the write re-verifies (`PREVIEW_STALE`).
 *
 * Daemon-local contract (types and paths only, no imports): consumed by the catalog's
 * agent-profile tools (`mcp/tools/agent-profile-preview.ts`) over `DaemonApi`, served by
 * `routes.ts`. Both transports, bearer on HTTP. No secret value ever appears here: MCP servers a
 * plugin ships are listed with their env/header KEYS only.
 */

/** One file a preview shows. `text` is present for a UTF-8 text file (no NUL) within the read cap. */
export interface ProfilePreviewFile {
  /** Relative to the item's (plugin's, candidate's) directory, `/`-separated. */
  path: string;
  size: number;
  sha256: string;
  /** `executable`: exec bit, shebang, or ELF / Mach-O / PE magic; `binary`: not UTF-8 text; `symlink`: never followed. */
  flag?: "binary" | "executable" | "symlink";
  /** A symlink's target text. */
  target?: string;
  text?: string;
}

/** A directory's files, or `complete: false` when it holds more than the read caps allow. */
export interface ProfilePreviewTree {
  files: ProfilePreviewFile[];
  complete: boolean;
}

/** `GET agentProfilePreviewRoutes.itemFiles(agent, id)`: a skill's or command's files, read now. */
export interface ProfileItemFilesResponse extends ProfilePreviewTree {
  itemId: string;
  revision: string;
}

/** `GET agentProfilePreviewRoutes.importDetail(agent, importId)`: what a scan found, in full. */
export interface ProfileImportDetailResponse {
  importId: string;
  /** Git scans: the URL with any credentials replaced by `***`; uploads: the file name. */
  source: { type: "git"; url: string; ref?: string; commit: string | null } | { type: "upload"; name: string };
  candidates: (ProfilePreviewTree & { ref: string; kind: "skill" | "command"; name: string; exists: boolean })[];
}

/** One MCP server a plugin ships: its command line or URL, and its env / header KEYS. */
export interface ProfilePluginMcpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
}

export interface ProfilePluginHook {
  event: string;
  matcher?: string;
  command: string;
}

/** `GET agentProfilePreviewRoutes.pluginPreview(agent, marketplace, plugin)`. */
export interface ProfilePluginPreviewResponse {
  marketplace: string;
  plugin: string;
  version?: string;
  /** The commit the marketplace checkout is at; null when it is not a git checkout. */
  commit: string | null;
  /**
   * `local`: the plugin's files as they will be installed. `remote`: the marketplace names a
   * source outside its checkout (fetched by the CLI at install). `unavailable`: this agent's
   * marketplaces cannot be inspected before installing.
   */
  source:
    | ({ type: "local" } & ProfilePreviewTree)
    | { type: "remote"; description: string }
    | { type: "unavailable"; reason: string };
  provides: {
    skills: string[];
    commands: string[];
    agents: string[];
    hooks: ProfilePluginHook[];
    mcpServers: ProfilePluginMcpServer[];
  };
}

/**
 * `POST` (socket-only): would this MCP definition reach this daemon's `/mcp`? The values may hold
 * a credential: the daemon compares them with its verifier and answers the reason only.
 * `id`: the item's current values (read daemon-side) are checked too.
 */
export const DAEMON_MCP_SERVERS_CHECK_ROUTE = "/api/agent-profile/daemon-mcp-servers/check";

export interface DaemonMcpCheckRequest {
  agent: string;
  id?: string;
  name: string;
  url?: string;
  values?: string[];
}

export interface DaemonMcpCheckResponse {
  reason: "bearer" | "url" | "name" | null;
}

const agentPath = (agent: string): string => `/api/agent-profile/${encodeURIComponent(agent)}`;

export const agentProfilePreviewRoutes = {
  itemFiles: (agent: string, id: string): string => `${agentPath(agent)}/items/${encodeURIComponent(id)}/files`,
  importDetail: (agent: string, importId: string): string => `${agentPath(agent)}/imports/${encodeURIComponent(importId)}`,
  pluginPreview: (agent: string, marketplace: string, plugin: string): string =>
    `${agentPath(agent)}/marketplaces/${encodeURIComponent(marketplace)}/plugins/${encodeURIComponent(plugin)}`
} as const;
