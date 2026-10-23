// Agent Profiles — the persisted shapes of one profile's source directory
// (docs/superpowers/specs/2026-10-18-agent-profiles-design.md §4.4).
//
//   <appdir>/daemon/session-profiles/profiles/<profileId>/   (`sessionProfileDir`, index.ts)
//     profile.json   the manifest: fields, settings, revision, items (MCP servers, hooks, plugin
//                    records, and the metadata of skills and commands)
//     secrets.json   0600: MCP env / header VALUES, by item id — never in the manifest
//
// This module imports only zod: the path helpers live in index.ts, which re-exports this file.
// `@orquester/api` `session-profiles.ts` owns the wire shapes; these carry the validation.
//
// Tolerance (AGENTS.md): every object is `passthrough`, so a field a newer build added survives
// this build's rewrite. A known field whose value may come in a shape this build cannot read
// (the settings, a plugin's source) is kept RAW in the record and read only where it is used
// (`readSessionProfilePluginSource`, the daemon's `resolveSessionProfileSettings`): a rewrite
// never replaces it. An item that does not read — a hand edit, a kind a newer build added, an
// id an earlier item already has — is kept VERBATIM in its place and reported, never loaded and
// never dropped. Anything that is not a version-1 manifest THROWS: the profile is listed as
// unreadable and never rewritten.
//
// **Any change to an existing field's TYPE or MEANING must bump the manifest `version`.**

import { z } from "zod";

export const SESSION_PROFILE_MANIFEST_VERSION = 1;
export const SESSION_PROFILE_SECRETS_VERSION = 1;
export const SESSION_PROFILE_DELETED_VERSION = 1;

/** A profile or item id: safe as one path segment (it names directories). */
export const sessionProfileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => !value.includes(".."), "must not contain ..");

/** `"all"` or a non-empty list of agent ids. Unknown ids are kept (a newer build's agent) and ignored on use. */
export const sessionProfileScopeRecordSchema = z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]);
export type SessionProfileScopeRecord = z.infer<typeof sessionProfileScopeRecordSchema>;

const itemBase = {
  id: sessionProfileIdSchema,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  agents: sessionProfileScopeRecordSchema.default("all"),
  /** Cached from a skill's / command's frontmatter at write; a plugin's description. */
  description: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
};

/** A skill: `skills/<id>/SKILL.md` (+ files) holds its content. */
export const sessionProfileSkillRecordSchema = z.object({ ...itemBase, kind: z.literal("skill") }).passthrough();

/** A command: `commands/<id>.md` holds its content; `name` may be `folder/name`. */
export const sessionProfileCommandRecordSchema = z.object({ ...itemBase, kind: z.literal("command") }).passthrough();

/** An MCP server; `name` is the server name. Env and header KEYS only — values are in `secrets.json`. */
export const sessionProfileMcpRecordSchema = z
  .object({
    ...itemBase,
    kind: z.literal("mcp"),
    mcp: z
      .object({
        transport: z.enum(["stdio", "http", "sse"]),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        envKeys: z.array(z.string()).optional(),
        url: z.string().optional(),
        headerKeys: z.array(z.string()).optional(),
        advanced: z.record(z.unknown()).optional(),
        /**
         * boxes (spec 2026-10-19 §8.4): run this server INSIDE a box chat's box instead of on the
         * host behind `orq-agent mcp-bridge`. Its secrets then reach the box, in process env only.
         * Absent/false: the host runs it.
         */
        runInBox: z.boolean().optional()
      })
      .passthrough()
  })
  .passthrough();

/** A hook in its one agent's own format. */
export const sessionProfileHookRecordSchema = z
  .object({
    ...itemBase,
    kind: z.literal("hook"),
    hook: z
      .object({
        event: z.string().min(1),
        matcher: z.string().optional(),
        command: z.string().min(1),
        timeoutSec: z.number().positive().optional()
      })
      .passthrough()
  })
  .passthrough();

/**
 * Where a plugin's files were copied from (`SessionProfilePluginSource` in `@orquester/api`).
 * The record keeps the value raw (see {@link readSessionProfilePluginSource}).
 */
export const sessionProfilePluginSourceRecordSchema = z
  .object({
    type: z.enum(["marketplace", "global"]),
    marketplace: z.string().optional(),
    commit: z.string().optional(),
    url: z.string().optional(),
    ref: z.string().optional(),
    copiedAt: z.string()
  })
  .passthrough();

/**
 * A plugin of one agent; `name` is the plugin's name. Its files live in `plugins/<id>/` — the
 * plugin's ROOT directory as its agent lays it out (Claude / Codex: with `.claude-plugin/` or
 * `.codex-plugin/plugin.json`; Grok: its plugin directory; OpenCode: the plugin's `.js`/`.ts`
 * file(s) at the top level). See the session-profiles README, "Plugin cache".
 */
export const sessionProfilePluginRecordSchema = z
  .object({
    ...itemBase,
    kind: z.literal("plugin"),
    plugin: z
      .object({
        marketplace: z.string().optional(),
        version: z.string().optional(),
        /** Raw: read it with {@link readSessionProfilePluginSource}; a value that does not read is kept as it is. */
        source: z.unknown().optional()
      })
      .passthrough()
      .default({})
  })
  .passthrough();

export type SessionProfilePluginSourceRecord = z.infer<typeof sessionProfilePluginSourceRecordSchema>;

/** A plugin record's `source`, or `undefined` when it is absent or does not read (a newer build's shape). */
export function readSessionProfilePluginSource(value: unknown): SessionProfilePluginSourceRecord | undefined {
  const parsed = sessionProfilePluginSourceRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const sessionProfileItemRecordSchema = z.discriminatedUnion("kind", [
  sessionProfileSkillRecordSchema,
  sessionProfileCommandRecordSchema,
  sessionProfileMcpRecordSchema,
  sessionProfileHookRecordSchema,
  sessionProfilePluginRecordSchema
]);
export type SessionProfileItemRecord = z.infer<typeof sessionProfileItemRecordSchema>;

/**
 * Spec §4.3. Values are kept RAW: absent — or a value this build cannot read, kept as it is for
 * the rewrite — means the default (`SESSION_PROFILE_DEFAULT_SETTINGS` in `@orquester/api`),
 * applied where the settings are used. `hideBuiltinSkills` is normally an object of agent →
 * boolean; `claudeWorkflowTool` a boolean. `claudeBuiltinTools` (daemon-internal, set only on
 * managed profiles, never on the wire): `false` launches Claude with no built-in tools.
 */
export const sessionProfileSettingsRecordSchema = z
  .object({
    hideBuiltinSkills: z.unknown().optional(),
    claudeWorkflowTool: z.unknown().optional(),
    claudeBuiltinTools: z.unknown().optional()
  })
  .passthrough();
export type SessionProfileSettingsRecord = z.infer<typeof sessionProfileSettingsRecordSchema>;

/** `profile.json` without its items (they are read one by one, see {@link parseSessionProfileManifest}). */
const sessionProfileManifestShape = z.object({
  version: z.literal(SESSION_PROFILE_MANIFEST_VERSION),
  id: sessionProfileIdSchema,
  name: z.string().min(1),
  icon: z.string().optional(),
  description: z.string().default(""),
  /** Bumped by every mutation of the profile; the wire's `revision` is its decimal string. */
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: sessionProfileSettingsRecordSchema.default({}),
  /**
   * Set on a profile Orquester itself owns (e.g. `"knowledge-indexer"`): it is kept out of every
   * user-facing list, refuses user edits and never takes part in the name-uniqueness check. One
   * that does not read is dropped (the profile is then an ordinary one).
   */
  managed: z.string().min(1).max(64).optional().catch(undefined),
  items: z.array(z.unknown()).default([])
});
export const sessionProfileManifestSchema = sessionProfileManifestShape.passthrough();
/** The manifest's fields (unknown ones included, kept for the rewrite) without its items. */
export type SessionProfileManifestRecord = Omit<z.infer<typeof sessionProfileManifestShape>, "items"> & Record<string, unknown>;

/** One `items` entry as read: a record, or the raw value kept verbatim with why it did not read. */
export type SessionProfileItemEntry =
  | { ok: true; record: SessionProfileItemRecord }
  | { ok: false; raw: unknown; error: string; id?: string };

export interface SessionProfileManifestFile {
  manifest: SessionProfileManifestRecord;
  /** Every `items` entry, in file order. */
  items: SessionProfileItemEntry[];
}

function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function rawId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && sessionProfileIdSchema.safeParse(id).success ? id : undefined;
}

/**
 * Reads a `profile.json` value. Throws (with the reason) when it is not a version-1 manifest;
 * otherwise every item is read on its own (see the module header).
 */
export function parseSessionProfileManifest(value: unknown): SessionProfileManifestFile {
  const parsed = sessionProfileManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Not a version-${SESSION_PROFILE_MANIFEST_VERSION} profile manifest (${issueText(parsed.error)}).`);
  }
  const { items: rawItems, ...manifest } = parsed.data;
  const seen = new Set<string>();
  const items = rawItems.map((raw): SessionProfileItemEntry => {
    const item = sessionProfileItemRecordSchema.safeParse(raw);
    const id = rawId(raw);
    if (!item.success) {
      return { ok: false, raw, error: issueText(item.error), ...(id ? { id } : {}) };
    }
    if (seen.has(item.data.id)) {
      return { ok: false, raw, error: `An earlier item already has the id "${item.data.id}".`, id: item.data.id };
    }
    seen.add(item.data.id);
    return { ok: true, record: item.data };
  });
  return { manifest, items };
}

/** The manifest's file text: records as they are now, unreadable entries exactly as they were read. */
export function serializeSessionProfileManifest(file: SessionProfileManifestFile): string {
  const value = { ...file.manifest, items: file.items.map((entry) => (entry.ok ? entry.record : entry.raw)) };
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// secrets.json
// ---------------------------------------------------------------------------

/** One MCP item's secret values. */
export const sessionProfileItemSecretsSchema = z
  .object({
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional()
  })
  .passthrough();
export type SessionProfileItemSecrets = z.infer<typeof sessionProfileItemSecretsSchema>;

const sessionProfileSecretsFileSchema = z
  .object({
    version: z.literal(SESSION_PROFILE_SECRETS_VERSION),
    items: z.record(z.unknown()).default({})
  })
  .passthrough();

export interface SessionProfileSecretsFile {
  /** Every top-level key but `items`, as read (`version` included). */
  extra: Record<string, unknown>;
  /** Readable entries by item id. */
  items: Record<string, SessionProfileItemSecrets>;
  /** Entries that do not read, kept verbatim by item id. */
  unreadable: Record<string, unknown>;
}

/** Reads a `secrets.json` value. Throws when it is not a version-1 file. Error messages never quote a value. */
export function parseSessionProfileSecrets(value: unknown): SessionProfileSecretsFile {
  const parsed = sessionProfileSecretsFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Not a version-${SESSION_PROFILE_SECRETS_VERSION} profile secrets file.`);
  }
  const { items: rawItems, ...extra } = parsed.data;
  const items: Record<string, SessionProfileItemSecrets> = {};
  const unreadable: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(rawItems)) {
    const entry = sessionProfileItemSecretsSchema.safeParse(raw);
    if (entry.success) items[id] = entry.data;
    else unreadable[id] = raw;
  }
  return { extra, items, unreadable };
}

export function emptySessionProfileSecrets(): SessionProfileSecretsFile {
  return { extra: { version: SESSION_PROFILE_SECRETS_VERSION }, items: {}, unreadable: {} };
}

export function serializeSessionProfileSecrets(file: SessionProfileSecretsFile): string {
  const value = { ...file.extra, version: SESSION_PROFILE_SECRETS_VERSION, items: { ...file.unreadable, ...file.items } };
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// deleted.json — the names of deleted profiles (a chat's fallback notice names its profile)
// ---------------------------------------------------------------------------

/** One deleted profile: its name when it was deleted. */
export const sessionProfileDeletedEntrySchema = z
  .object({
    name: z.string().min(1),
    deletedAt: z.string().optional()
  })
  .passthrough();
export type SessionProfileDeletedEntry = z.infer<typeof sessionProfileDeletedEntrySchema>;

const sessionProfileDeletedFileSchema = z
  .object({
    version: z.literal(SESSION_PROFILE_DELETED_VERSION),
    profiles: z.record(z.unknown()).default({})
  })
  .passthrough();

export interface SessionProfileDeletedFile {
  /** Every top-level key but `profiles`, as read (`version` included). */
  extra: Record<string, unknown>;
  /** Readable entries by profile id. */
  profiles: Record<string, SessionProfileDeletedEntry>;
  /** Entries that do not read, kept verbatim by profile id. */
  unreadable: Record<string, unknown>;
}

/** Reads a `deleted.json` value. Throws when it is not a version-1 file. */
export function parseSessionProfileDeleted(value: unknown): SessionProfileDeletedFile {
  const parsed = sessionProfileDeletedFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Not a version-${SESSION_PROFILE_DELETED_VERSION} deleted-profiles file.`);
  const { profiles: rawProfiles, ...extra } = parsed.data;
  const profiles: Record<string, SessionProfileDeletedEntry> = {};
  const unreadable: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(rawProfiles)) {
    const entry = sessionProfileDeletedEntrySchema.safeParse(raw);
    if (entry.success) profiles[id] = entry.data;
    else unreadable[id] = raw;
  }
  return { extra, profiles, unreadable };
}

export function emptySessionProfileDeleted(): SessionProfileDeletedFile {
  return { extra: { version: SESSION_PROFILE_DELETED_VERSION }, profiles: {}, unreadable: {} };
}

export function serializeSessionProfileDeleted(file: SessionProfileDeletedFile): string {
  const value = { ...file.extra, version: SESSION_PROFILE_DELETED_VERSION, profiles: { ...file.unreadable, ...file.profiles } };
  return `${JSON.stringify(value, null, 2)}\n`;
}
