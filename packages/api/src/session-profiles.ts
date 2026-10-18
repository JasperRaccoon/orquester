/**
 * Agent Profiles — Orquester-owned, per-session kits of instructions, skills, MCP servers,
 * plugins, hooks and commands (docs/superpowers/specs/2026-10-18-agent-profiles-design.md).
 *
 * Code name `SessionProfile…` so nothing here can be confused with the per-agent GLOBAL config
 * editor in `agent-profile.ts` (user-facing "Agent config"). A chat with no `profileId` is
 * "Global": the agent's own setup, exactly as before.
 *
 * Concurrency: every profile has ONE opaque `revision`. Every mutation of a profile — its
 * fields, settings, instructions, or any of its items — carries the revision the client holds;
 * a stale one is refused with 409 `PROFILE_CONFLICT` (`{error: {code, message}}`, the
 * agent-profile shape) and the client refetches. Every successful mutation answers the fresh
 * {@link SessionProfileDetail}.
 *
 * Secrets: an MCP server's `env` and `headers` VALUES never cross the wire. A view carries
 * `{key, set: true}`; a draft sends `{key, value}` (set or replace), `{key, keep: true}`
 * (unchanged) or leaves the key out (removed) — the agent-profile convention
 * ({@link SecretEntryView}, {@link SecretEntryDraft}).
 */

import {
  AGENT_PROFILE_AGENTS,
  type AgentProfileAgentId,
  type HookDraft,
  type HookView,
  type MarkdownDocumentDraft,
  type MarkdownDocumentView,
  type McpServerDraft,
  type McpServerView
} from "./agent-profile.ts";

// ---------------------------------------------------------------------------
// Agents, kinds, scope
// ---------------------------------------------------------------------------

/** The four agents a profile can target (the same ids as the agent-config editor's). */
export const SESSION_PROFILE_AGENTS = AGENT_PROFILE_AGENTS;
export type SessionProfileAgentId = AgentProfileAgentId;

export function isSessionProfileAgentId(value: unknown): value is SessionProfileAgentId {
  return typeof value === "string" && (SESSION_PROFILE_AGENTS as readonly string[]).includes(value);
}

/** Every item kind but the instructions, which are one document per profile (spec §4.1). */
export const SESSION_PROFILE_ITEM_KINDS = ["mcp", "skill", "plugin", "hook", "command"] as const;
export type SessionProfileItemKind = (typeof SESSION_PROFILE_ITEM_KINDS)[number];

export function isSessionProfileItemKind(value: unknown): value is SessionProfileItemKind {
  return typeof value === "string" && (SESSION_PROFILE_ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds that always apply to exactly ONE agent (spec §4.2): a plugin is one agent's plugin,
 * a hook is written in one agent's own event vocabulary. Their scope must be a one-element list.
 */
export const SESSION_PROFILE_SINGLE_AGENT_KINDS: readonly SessionProfileItemKind[] = ["plugin", "hook"];

/**
 * The agents a hook item may target: those with a hook kind of their own. OpenCode has none —
 * its hooks are JS plugins (spec §4.2).
 */
export const SESSION_PROFILE_HOOK_AGENTS: readonly SessionProfileAgentId[] = ["claude", "codex", "grok"];

/**
 * Which agents an item applies to (spec §4.2): every agent, or a NON-EMPTY list. Plugins and
 * hooks are always a one-element list.
 */
export type SessionProfileAgentScope = "all" | SessionProfileAgentId[];

/** Whether `scope` includes `agent`. */
export function sessionProfileScopeIncludes(scope: SessionProfileAgentScope, agent: SessionProfileAgentId): boolean {
  return scope === "all" || scope.includes(agent);
}

/**
 * Why a scope is not valid for `kind`, or `null` when it is: a list must be non-empty, name only
 * known agents, no agent twice; a plugin or hook names exactly one agent (a hook one of
 * {@link SESSION_PROFILE_HOOK_AGENTS}).
 */
export function sessionProfileScopeProblem(kind: SessionProfileItemKind, scope: unknown): string | null {
  if (scope === "all") {
    return SESSION_PROFILE_SINGLE_AGENT_KINDS.includes(kind) ? `A ${kind} applies to exactly one agent.` : null;
  }
  if (!Array.isArray(scope) || scope.length === 0) return 'The agent scope must be "all" or a non-empty list of agents.';
  if (!scope.every(isSessionProfileAgentId)) return `The agent scope names an unknown agent; use ${SESSION_PROFILE_AGENTS.join(", ")}.`;
  if (new Set(scope).size !== scope.length) return "The agent scope names an agent twice.";
  if (SESSION_PROFILE_SINGLE_AGENT_KINDS.includes(kind) && scope.length !== 1) return `A ${kind} applies to exactly one agent.`;
  if (kind === "hook" && !SESSION_PROFILE_HOOK_AGENTS.includes(scope[0] as SessionProfileAgentId)) {
    return `${scope[0]} has no hooks of its own; add an OpenCode plugin instead.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings (spec §4.3)
// ---------------------------------------------------------------------------

export interface SessionProfileSettings {
  /** Per agent: hide the CLI's own built-in skills in this profile's chats. Default `true` for every agent. */
  hideBuiltinSkills: Record<SessionProfileAgentId, boolean>;
  /** Claude: keep the Workflow tool (and its `workflow-authoring` skill). Default `true`. */
  claudeWorkflowTool: boolean;
}

/** A settings change: only the fields (and agents) named are changed. */
export interface SessionProfileSettingsDraft {
  hideBuiltinSkills?: Partial<Record<SessionProfileAgentId, boolean>>;
  claudeWorkflowTool?: boolean;
}

export const SESSION_PROFILE_DEFAULT_SETTINGS: SessionProfileSettings = {
  hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true },
  claudeWorkflowTool: true
};

// ---------------------------------------------------------------------------
// Items (spec §4.1)
// ---------------------------------------------------------------------------

interface SessionProfileItemBase {
  /** Stable, minted by the daemon at create; never changes (a rename keeps it). */
  id: string;
  kind: SessionProfileItemKind;
  /** Skill / command / MCP server name as the agent will see it; a plugin's name; a hook's label. */
  name: string;
  enabled: boolean;
  agents: SessionProfileAgentScope;
  /** A skill's or command's frontmatter `description`; a plugin's description. */
  description?: string;
  /**
   * Agents in scope that cannot load this item, and why (e.g. an MCP transport the agent lacks,
   * spec §4.2). The item is skipped for them; it never blocks the others.
   */
  unsupported?: { agent: SessionProfileAgentId; reason: string }[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Where a plugin item's files were copied from (provenance; spec §4.5). Recorded when the files
 * land in the profile's plugin cache; never a secret.
 */
export interface SessionProfilePluginSource {
  /** `marketplace`: one of the agent's known marketplaces; `global`: the agent's own installed plugin (or OpenCode plugin file). */
  type: "marketplace" | "global";
  marketplace?: string;
  /** The commit of the marketplace checkout or of the repository fetched for it, when known. */
  commit?: string;
  /** A remote source that was cloned (credential-free URL) and its branch or tag. */
  url?: string;
  ref?: string;
  /** ISO time the files were copied. */
  copiedAt: string;
}

/** What a plugin item records. Its files live in the profile's own plugin cache (spec §4.5). */
export interface SessionProfilePluginView {
  /** The plugin's name as its agent knows it. */
  name: string;
  marketplace?: string;
  version?: string;
  /** Whether the profile's plugin cache holds the plugin's files yet. */
  cached: boolean;
  /** Where the files came from (absent on records made before it was recorded). */
  source?: SessionProfilePluginSource;
}

/** A plugin's record. Creating one with files is the marketplace flow's job (a later route). */
export interface SessionProfilePluginDraft {
  name: string;
  marketplace?: string;
  version?: string;
  description?: string;
}

/** A hook item: one agent's own hook format (spec §4.2). `name` defaults to the event. */
export type SessionProfileHookView = HookView;

/** One row of a profile's item list. */
export type SessionProfileItem =
  | (SessionProfileItemBase & { kind: "skill" })
  | (SessionProfileItemBase & { kind: "command" })
  | (SessionProfileItemBase & { kind: "mcp"; mcp: McpServerView })
  | (SessionProfileItemBase & { kind: "hook"; hook: SessionProfileHookView })
  | (SessionProfileItemBase & { kind: "plugin"; plugin: SessionProfilePluginView });

/** `GET sessionProfileRoutes.item(id, itemId)`: a row plus its content. */
export type SessionProfileItemDetail =
  | {
      kind: "skill" | "command";
      item: SessionProfileItem;
      document: MarkdownDocumentView;
      /** A skill's other files, relative to its directory (read-only here). */
      files?: string[];
    }
  | { kind: "mcp"; item: SessionProfileItem; mcp: McpServerView }
  | { kind: "hook"; item: SessionProfileItem; hook: SessionProfileHookView }
  | { kind: "plugin"; item: SessionProfileItem; plugin: SessionProfilePluginView };

interface SessionProfileItemDraftBase {
  /** Absent: `"all"` on create (plugins and hooks have no default and must name their agent), unchanged on update. */
  agents?: SessionProfileAgentScope;
  /** Absent: on at create, unchanged on update. */
  enabled?: boolean;
}

/**
 * An item as the client sends it. A skill's or command's `document.name` is the item's name; on
 * update the frontmatter is MERGED into the stored one (keys the draft leaves out are kept, a
 * `null` removes one) and a skill's `name` frontmatter always equals the item's name. An MCP
 * server's secrets follow {@link SecretEntryDraft}. A hook's `name` is optional (defaults to the
 * event).
 */
export type SessionProfileItemDraft =
  | (SessionProfileItemDraftBase & { kind: "skill"; document: MarkdownDocumentDraft })
  | (SessionProfileItemDraftBase & { kind: "command"; document: MarkdownDocumentDraft })
  | (SessionProfileItemDraftBase & { kind: "mcp"; mcp: McpServerDraft })
  | (SessionProfileItemDraftBase & { kind: "hook"; name?: string; hook: HookDraft })
  | (SessionProfileItemDraftBase & { kind: "plugin"; plugin: SessionProfilePluginDraft });

/** A stored item this build cannot read (a hand edit, a newer build's kind): kept on disk untouched. */
export interface SessionProfileItemError {
  /** The item's id when the record has a readable one. */
  itemId?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Preparation status (spec §6.5)
// ---------------------------------------------------------------------------

/**
 * One agent's preparation of a profile's current revision. `not-prepared`: nothing has been
 * built yet (or no preparer exists for the agent). Codex prepares per account; its state here is
 * the profile-level summary (any failure → `failed`).
 */
export type SessionProfilePrepareState = "preparing" | "ready" | "failed" | "not-prepared";

export interface SessionProfilePrepareStatus {
  agent: SessionProfileAgentId;
  state: SessionProfilePrepareState;
  /** Why it failed (or what it is waiting on). Never quotes a secret. */
  reason?: string;
  updatedAt: string;
}

/** `GET sessionProfileRoutes.prepareStatus(id)`. */
export interface SessionProfilePrepareStatusResponse {
  profileId: string;
  revision: string;
  agents: SessionProfilePrepareStatus[];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface SessionProfileItemCount {
  total: number;
  enabled: number;
}

/** A library card (spec §5.1). */
export interface SessionProfileSummary {
  /** Stable, minted at create (a UUID); the name is editable. */
  id: string;
  name: string;
  /** An emoji or an icon key the UI understands; absent = the UI's default icon. */
  icon?: string;
  description: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  counts: Record<SessionProfileItemKind, SessionProfileItemCount>;
  hasInstructions: boolean;
  /** One entry per agent, in {@link SESSION_PROFILE_AGENTS} order. */
  preparation: SessionProfilePrepareStatus[];
}

/** The profile editor (spec §5.2). */
export interface SessionProfileDetail extends SessionProfileSummary {
  settings: SessionProfileSettings;
  items: SessionProfileItem[];
  /** Stored items that could not be read; they stay on disk and are never loaded. */
  itemErrors: SessionProfileItemError[];
}

/** A profile directory that could not be read at all; it is never loaded and never rewritten. */
export interface SessionProfileListError {
  profileId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/** Longest profile name, description and icon the daemon accepts. */
export const SESSION_PROFILE_NAME_MAX = 80;
export const SESSION_PROFILE_DESCRIPTION_MAX = 2000;
export const SESSION_PROFILE_ICON_MAX = 64;

/** `GET sessionProfileRoutes.list` */
export interface SessionProfileListResponse {
  profiles: SessionProfileSummary[];
  errors: SessionProfileListError[];
}

/** `POST sessionProfileRoutes.list` → 201 {@link SessionProfileDetail}. Names are unique (case-insensitive). */
export interface CreateSessionProfileRequest {
  name: string;
  icon?: string;
  description?: string;
  settings?: SessionProfileSettingsDraft;
}

/** `PUT sessionProfileRoutes.profile(id)` → {@link SessionProfileDetail}. Absent fields are unchanged; `icon: null` clears it. */
export interface UpdateSessionProfileRequest {
  revision: string;
  name?: string;
  icon?: string | null;
  description?: string;
  settings?: SessionProfileSettingsDraft;
}

/** `DELETE sessionProfileRoutes.profile(id)?revision=` → {@link DeleteSessionProfileResponse}. */
export interface DeleteSessionProfileQuery {
  revision: string;
}

export interface DeleteSessionProfileResponse {
  profileId: string;
  deleted: true;
}

/**
 * `POST sessionProfileRoutes.duplicate(id)` → 201 {@link SessionProfileDetail}: a full copy
 * (items, secrets, plugin cache) under a new id. `name` absent: "<name> copy" (made unique).
 */
export interface DuplicateSessionProfileRequest {
  name?: string;
}

/** `POST sessionProfileRoutes.items(id)` → 201 {@link SessionProfileMutationResponse}. */
export interface CreateSessionProfileItemRequest {
  revision: string;
  draft: SessionProfileItemDraft;
}

/** `PUT sessionProfileRoutes.item(id, itemId)`; the draft's kind must be the item's. */
export interface UpdateSessionProfileItemRequest {
  revision: string;
  draft: SessionProfileItemDraft;
}

/** `POST sessionProfileRoutes.itemEnabled(id, itemId)` */
export interface SetSessionProfileItemEnabledRequest {
  revision: string;
  enabled: boolean;
}

/** `DELETE sessionProfileRoutes.item(id, itemId)?revision=` */
export interface DeleteSessionProfileItemQuery {
  revision: string;
}

/** Every item mutation's answer: the fresh profile, and the item it created or changed. */
export interface SessionProfileMutationResponse {
  profile: SessionProfileDetail;
  /** Absent for a delete. */
  itemId?: string;
}

/** `GET sessionProfileRoutes.instructions(id)`: `text` is `""` when the profile has none. */
export interface SessionProfileInstructionsResponse {
  text: string;
  /** The PROFILE's revision (instructions have no revision of their own). */
  revision: string;
}

/** `PUT sessionProfileRoutes.instructions(id)` → {@link SessionProfileDetail}. `""` removes them. */
export interface WriteSessionProfileInstructionsRequest {
  revision: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Filling a profile (spec §4.5): Import from Global, Git / .zip / .md, copy from another
// profile, marketplace plugins, export and import of a whole profile
// ---------------------------------------------------------------------------

/**
 * What an import does with an item whose kind and name the profile already has (for an
 * overlapping agent scope): refuse the whole import (409 `ITEM_EXISTS`), replace the profile's
 * item, keep both (the new one gets a `-2` style suffix; a plugin or an identical hook cannot be kept twice and is
 * skipped instead), or skip the new one. Every outcome other than a plain add is listed in the
 * response's `notes`.
 */
export type SessionProfileImportConflictPolicy = "fail" | "replace" | "keep-both" | "skip";

/** What instructions brought into a profile do to the profile's own. */
export type SessionProfileInstructionsMode = "replace" | "append";

/**
 * Every import, copy and plugin add answers the fresh profile, the ids of the items it created,
 * and what the owner should know (renamed, replaced, skipped, frontmatter keys dropped, an MCP
 * server whose secret values must be entered again).
 */
export interface SessionProfileImportResponse {
  profile: SessionProfileDetail;
  itemIds: string[];
  notes: string[];
}

/** One item of an agent's Global setup, as Import from Global offers it. */
export interface SessionProfileGlobalItem {
  /** The Agent config item id (`skill:review`, `hook:Stop:…`): what the import request names. */
  id: string;
  kind: SessionProfileItemKind;
  name: string;
  description?: string;
  /** The profile already has an item of this kind and name (the import's conflict policy applies). */
  exists: boolean;
  /** Why it cannot be imported (it comes from a plugin, another agent owns it, an npm plugin…); absent when it can. */
  unavailable?: string;
}

/** `GET sessionProfileRoutes.importGlobal(id)?agent=` */
export interface SessionProfileGlobalSourceResponse {
  agent: SessionProfileAgentId;
  installed: boolean;
  instructions: { exists: boolean; bytes: number };
  items: SessionProfileGlobalItem[];
}

/**
 * `POST sessionProfileRoutes.importGlobal(id)` → {@link SessionProfileImportResponse}. Items are
 * COPIED (Global is never changed). Skills, commands and MCP servers get `agents` (default
 * `"all"`); when that names one agent other than the source, frontmatter and MCP settings are
 * converted for it (the Agent config copy rules). Hooks and plugins keep their agent. MCP secret
 * values are copied into the profile's secrets file (never returned). `instructions` copies the
 * agent's global instruction file too.
 */
export interface ImportSessionProfileFromGlobalRequest {
  revision: string;
  agent: SessionProfileAgentId;
  itemIds: string[];
  agents?: SessionProfileAgentScope;
  instructions?: SessionProfileInstructionsMode;
  onConflict?: SessionProfileImportConflictPolicy;
}

/**
 * `POST sessionProfileRoutes.importGit(id) {url}` and `POST sessionProfileRoutes.importUpload(id)?name=`
 * (a `.zip` or `.md` as an `application/octet-stream` body) scan into candidates — the Agent
 * config scan's shape (`ProfileImportScanResponse`), whose `kind` and `name` are what the profile
 * will get (commands stay commands) and whose `exists` is checked against the profile.
 */
export interface SessionProfileImportGitRequest {
  url: string;
}

/** `POST sessionProfileRoutes.importScan(id, importId)` → {@link SessionProfileImportResponse}: takes the picks of a scan. */
export interface TakeSessionProfileImportRequest {
  revision: string;
  picks: string[];
  agents?: SessionProfileAgentScope;
  onConflict?: SessionProfileImportConflictPolicy;
}

/**
 * `POST sessionProfileRoutes.copyFrom(id)` → {@link SessionProfileImportResponse}: copies items
 * of another profile — their files, plugin caches and secret values — keeping their scope.
 */
export interface CopySessionProfileItemsRequest {
  revision: string;
  fromProfileId: string;
  itemIds: string[];
  instructions?: SessionProfileInstructionsMode;
  onConflict?: SessionProfileImportConflictPolicy;
}

/**
 * Where a plugin added to a profile comes from: a plugin of one of the agent's known
 * marketplaces (browsed with the Agent config routes `marketplacePlugins` / `pluginPreview`), or
 * one of the agent's installed Global plugins — for OpenCode, a plugin file — by Agent config id.
 */
export type SessionProfilePluginSourceRequest =
  | { type: "marketplace"; marketplace: string; plugin: string }
  | { type: "global"; itemId: string };

/**
 * `POST sessionProfileRoutes.plugins(id)` → {@link SessionProfileImportResponse}: copies the
 * plugin's files into the profile's own plugin cache (never into an agent's plugin dirs). A
 * remote marketplace source is cloned first. The item applies to `agent` only.
 */
export interface AddSessionProfilePluginRequest {
  revision: string;
  agent: SessionProfileAgentId;
  source: SessionProfilePluginSourceRequest;
  /** `keep-both` is refused for a plugin. */
  onConflict?: Exclude<SessionProfileImportConflictPolicy, "keep-both">;
}

/**
 * `GET sessionProfileRoutes.exportProfile(id)` → `application/zip`: a portable copy of the
 * profile — `orquester-export.json` (format marker), `profile.json` (the manifest: items, scopes,
 * settings; MCP env/header KEYS only — secret VALUES are never exported), `instructions.md`,
 * `skills/<itemId>/…`, `commands/<itemId>.md`, `plugins/<itemId>/…`. Items the daemon cannot
 * read are left out.
 */
export const SESSION_PROFILE_EXPORT_FORMAT = "orquester-agent-profile";
export const SESSION_PROFILE_EXPORT_VERSION = 1;

/**
 * `POST sessionProfileRoutes.importProfile?name=` (an export `.zip` as an
 * `application/octet-stream` body) → 201: a NEW profile built from it (its name made unique).
 * Validated strictly: anything unexpected refuses the whole file. MCP servers that need secret
 * values are listed in `notes`: enter them again (until then they are skipped at launch).
 */
export interface ImportSessionProfileResponse {
  profile: SessionProfileDetail;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Routes, events, errors
// ---------------------------------------------------------------------------

const SESSION_PROFILES_BASE = "/api/session-profiles";
const profilePath = (profileId: string): string => `${SESSION_PROFILES_BASE}/${encodeURIComponent(profileId)}`;

/**
 * Every Agent Profiles route. Both transports (the unix socket and the bearer-gated HTTP app).
 *
 * Reserved for later tasks (do not reuse this path for anything else): `…/:id/prepare` (re-run
 * preparation).
 */
export const sessionProfileRoutes = {
  /** `GET` → {@link SessionProfileListResponse}; `POST` {@link CreateSessionProfileRequest} → 201 detail. */
  list: SESSION_PROFILES_BASE,
  /** `GET` → detail; `PUT` {@link UpdateSessionProfileRequest}; `DELETE ?revision=`. */
  profile: profilePath,
  /** `POST` {@link DuplicateSessionProfileRequest} → 201 detail. */
  duplicate: (profileId: string): string => `${profilePath(profileId)}/duplicate`,
  /** `POST` {@link CreateSessionProfileItemRequest} → 201 {@link SessionProfileMutationResponse}. */
  items: (profileId: string): string => `${profilePath(profileId)}/items`,
  /** `GET` → {@link SessionProfileItemDetail}; `PUT` {@link UpdateSessionProfileItemRequest}; `DELETE ?revision=`. */
  item: (profileId: string, itemId: string): string => `${profilePath(profileId)}/items/${encodeURIComponent(itemId)}`,
  /** `POST` {@link SetSessionProfileItemEnabledRequest} → {@link SessionProfileMutationResponse}. */
  itemEnabled: (profileId: string, itemId: string): string =>
    `${profilePath(profileId)}/items/${encodeURIComponent(itemId)}/enabled`,
  /** `GET` → {@link SessionProfileInstructionsResponse}; `PUT` {@link WriteSessionProfileInstructionsRequest} → detail. */
  instructions: (profileId: string): string => `${profilePath(profileId)}/instructions`,
  /** `GET` → {@link SessionProfilePrepareStatusResponse}. */
  prepareStatus: (profileId: string): string => `${profilePath(profileId)}/prepare-status`,
  /** `GET ?agent=` → {@link SessionProfileGlobalSourceResponse}; `POST` {@link ImportSessionProfileFromGlobalRequest} → {@link SessionProfileImportResponse}. */
  importGlobal: (profileId: string): string => `${profilePath(profileId)}/imports/global`,
  /** `POST` {@link SessionProfileImportGitRequest} → `ProfileImportScanResponse`. */
  importGit: (profileId: string): string => `${profilePath(profileId)}/imports/git`,
  /** `POST ?name=` (`application/octet-stream`: a `.zip` or `.md`) → `ProfileImportScanResponse`. */
  importUpload: (profileId: string): string => `${profilePath(profileId)}/imports/upload`,
  /** `POST` {@link TakeSessionProfileImportRequest} → {@link SessionProfileImportResponse}. */
  importScan: (profileId: string, importId: string): string => `${profilePath(profileId)}/imports/${encodeURIComponent(importId)}`,
  /** `POST` {@link CopySessionProfileItemsRequest} → {@link SessionProfileImportResponse}. */
  copyFrom: (profileId: string): string => `${profilePath(profileId)}/copy-from`,
  /** `POST` {@link AddSessionProfilePluginRequest} → {@link SessionProfileImportResponse}. */
  plugins: (profileId: string): string => `${profilePath(profileId)}/plugins`,
  /** `GET` → `application/zip` (see {@link SESSION_PROFILE_EXPORT_FORMAT}). */
  exportProfile: (profileId: string): string => `${profilePath(profileId)}/export`,
  /** `POST ?name=` (`application/octet-stream`: an export `.zip`) → 201 {@link ImportSessionProfileResponse}. */
  importProfile: `${SESSION_PROFILES_BASE}/import`
} as const;

/** The `/events` channel every Agent Profiles change is broadcast on. */
export const SESSION_PROFILES_CHANNEL = "session-profiles";

/**
 * - `sessionProfile.changed` {@link SessionProfileChangedPayload}: created or changed; refetch when
 *   the revision differs from the one held.
 * - `sessionProfile.deleted` {@link SessionProfileDeletedPayload}.
 * - `sessionProfile.prepareStatus` {@link SessionProfilePrepareStatusResponse}: an agent's
 *   preparation state moved (published by the preparation lifecycle).
 */
export type SessionProfileEventType = "sessionProfile.changed" | "sessionProfile.deleted" | "sessionProfile.prepareStatus";

export interface SessionProfileChangedPayload {
  profileId: string;
  revision: string;
}

export interface SessionProfileDeletedPayload {
  profileId: string;
}

export type SessionProfileErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_NAME"
  | "INVALID_ITEM"
  | "UNKNOWN_AGENT"
  | "KIND_NOT_SUPPORTED"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_NAME_TAKEN"
  | "PROFILE_UNREADABLE"
  | "ITEM_NOT_FOUND"
  | "ITEM_EXISTS"
  | "PROFILE_CONFLICT"
  | "PROFILE_NOT_READY"
  | "PROFILE_UNSUPPORTED_AGENT"
  | "CONFIG_UNREADABLE"
  | "WRITE_VERIFY_FAILED"
  /** An import's source could not be fetched or read (a refused URL or zip, no candidates). */
  | "IMPORT_FAILED"
  /** The scan is gone (taken, expired) or belongs to another profile. */
  | "IMPORT_NOT_FOUND"
  | "UPLOAD_TOO_LARGE"
  /** Agent config cannot read that agent (its CLI is not installed). */
  | "AGENT_NOT_INSTALLED"
  /** Imports are not wired in this daemon. */
  | "IMPORTS_UNAVAILABLE"
  | "SESSION_PROFILE_ERROR";

/** Every refusal: `{error: {code, message}}` (the agent-profile and workflow routes' shape). */
export interface SessionProfileErrorBody {
  error: { code: SessionProfileErrorCode; message: string };
}
