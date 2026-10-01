/**
 * The seam between the agent profile service and each agent's adapter
 * (spec §4.1). An adapter holds ALL of one agent's format knowledge: nothing
 * else reads or writes that agent's files. The service owns the per-agent
 * mutation queue, revisions, installed/version detection, change detection and
 * events; it calls an adapter only from inside that agent's queue, so an
 * adapter never sees two of its own mutations at once.
 *
 * Every mutation re-reads what it needs from disk first, checks the item's
 * `revision` (a stale one throws `profileErrors.conflict()`), writes through
 * the realpath of the daemon user's own home (never through a managed account
 * home's symlink), and returns what it created/changed plus notes for the owner.
 */

import type {
  AgentProfileAgentId,
  MarketplacePluginEntry,
  McpTransport,
  ProfileConflictPolicy,
  ProfileFileError,
  ProfileInstructionsInfo,
  ProfileItem,
  ProfileItemDetail,
  ProfileItemDraft
} from "@orquester/api";

/** The daemon user's own agent homes, resolved once at boot (spec §3: global only). */
export interface AgentHomes {
  /** `$HOME` of the daemon user. */
  home: string;
  /** `~/.claude` (or `$CLAUDE_CONFIG_DIR` of the daemon itself). */
  claudeDir: string;
  /** `~/.claude.json` — beside `claudeDir`'s parent unless `CLAUDE_CONFIG_DIR` moved it. */
  claudeJson: string;
  /** `~/.codex` (or `$CODEX_HOME`). */
  codexHome: string;
  /** `~/.grok` (or `$GROK_HOME`). */
  grokHome: string;
  /** `~/.config/opencode` (or `$OPENCODE_CONFIG_DIR`). */
  opencodeDir: string;
  /** `~/.agents/skills` — the shared skills root Codex, Grok and OpenCode read. */
  agentsSkillsDir: string;
}

/** What every adapter is constructed with. */
export interface ProfileAdapterContext {
  homes: AgentHomes;
  /** `<appdir>` — the agent profile's own state lives under `agentProfileDir(appdir)`. */
  appdir: string;
  /** The agent's CLI binary as the registry resolved it; `null` when not installed. */
  bin: string | null;
  /**
   * The managed account homes of this agent's family
   * (`<appdir>/daemon/agent-accounts/<family>/<id>/home`): Codex needs them to
   * write `hooks.state` for every path a hook is seen from (spec §4.6).
   */
  accountHomes: () => Promise<string[]>;
  logger: { info(message: string): void; warn(message: string): void };
  now: () => Date;
}

/** What `snapshot()` answers; the service adds `agent`, `installed`, `version`, `revision`, `readAt`. */
export interface AdapterSnapshot {
  instructions: ProfileInstructionsInfo;
  items: ProfileItem[];
  fileErrors: ProfileFileError[];
}

export interface AdapterMutationResult {
  /** Ids created or changed (a rename changes the id). */
  itemIds: string[];
  notes: string[];
}

/**
 * An item lifted out of one agent for another (spec §6): the daemon-internal
 * form a copy or an import travels in. It carries real secret values — it is
 * NEVER serialized to a client, a log or an event.
 */
export type PortableItem =
  | {
      kind: "skill";
      name: string;
      /** A directory holding `SKILL.md` and the skill's other files; owned by the caller. */
      dir: string;
    }
  | {
      kind: "command";
      /** `git/pr` style. */
      name: string;
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | { kind: "mcp"; server: PortableMcpServer };

export interface PortableMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** Real values. */
  env?: Record<string, string>;
  url?: string;
  /** Real values. */
  headers?: Record<string, string>;
  /** The source agent's own non-secret extras (`MCP_ADVANCED_FIELDS` keys); the converter maps them. */
  advanced?: Record<string, unknown>;
}

export interface ProfileAdapter {
  readonly agent: AgentProfileAgentId;

  /** Every item and the instructions info, read from disk now. Never throws for one bad file: it lands in `fileErrors`. */
  snapshot(): Promise<AdapterSnapshot>;

  /** The editable detail of one item (secrets masked). */
  readItem(id: string): Promise<ProfileItemDetail>;

  create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult>;

  update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult>;

  setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult>;

  remove(id: string, revision: string): Promise<AdapterMutationResult>;

  /** Codex hooks only (spec §4.6); other adapters leave it undefined. */
  trust?(id: string, revision: string): Promise<AdapterMutationResult>;

  readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }>;

  /** `revision` is the info's; `""` means "the file must not exist yet". */
  writeInstructions(text: string, revision: string): Promise<AdapterMutationResult>;

  /** Grok only: fold the dead `GROK.md` into `AGENTS.md` and remove it. */
  migrateLegacyInstructions?(revision: string): Promise<AdapterMutationResult>;

  /** The plugins a marketplace offers (Claude, Codex, Grok). */
  listMarketplacePlugins?(marketplace: string): Promise<MarketplacePluginEntry[]>;

  /** Lift a copyable item (`PROFILE_COPYABLE_KINDS`) out, real secret values included. Caller owns any temp dir. */
  exportItem(id: string): Promise<PortableItem>;

  /** Write a portable item already converted for this agent (names valid, frontmatter mapped). */
  importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult>;

  /**
   * Files and directories whose change means the snapshot may have moved
   * (spec §4.7). The service resolves and watches their realpaths.
   */
  watchPaths(): string[];

  /** Release anything long-lived (a codex app-server). */
  close?(): Promise<void>;
}
