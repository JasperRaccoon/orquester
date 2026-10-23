/**
 * Knowledge Graph plugin — which collections a calling chat can see (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, goal 2 and "Collections and
 * profiles"):
 *
 * - no session (the user in the Knowledge tab) → `all`;
 * - a chat without an Agent Profile (Global) → `all`, Unfiled included;
 * - a chat with a profile → exactly the collections ticked in it (`settings.knowledgeCollections`;
 *   none ticked, or never set, → no collection). Ids of collections deleted since are passed on:
 *   search ignores what does not exist;
 * - a chat whose profile was deleted → `all` (it runs Global from its next start on);
 * - one of the plugin's own worker sessions (`owner.kind === "knowledge-indexer"`) → no collection:
 *   it works through the two worker tools only;
 * - a session the daemon does not know, or a profile that cannot be read → no collection (fail closed).
 *
 * Fresh on every call: removing a collection from a profile takes effect on the chat's next tool
 * call, and nothing is cached in the chat (spec).
 */

import type { KnowledgeVisibility } from "@orquester/api";

import type { ManifestKnowledge } from "../session-tools/manifest.ts";
import type { KnowledgeVisibilityPort } from "./ports.ts";

/** `KnowledgeSessionOwner.kind`: a session the plugin started to answer myKG's inbox. */
export const KNOWLEDGE_WORKER_OWNER_KIND = "knowledge-indexer";

/** What the daemon's records say about one session, as visibility reads it. */
export interface KnowledgeSessionRecord {
  /** Its Agent Profile; absent or null = Global. */
  profileId?: string | null;
  /** Its owner's `kind` (`"workflow"`, `"knowledge-indexer"`, …), read as a plain string; absent = none. */
  ownerKind?: string;
}

export interface KnowledgeVisibilityDeps {
  /** The session now, or null when the daemon knows no such session. */
  session(sessionId: string): KnowledgeSessionRecord | null | Promise<KnowledgeSessionRecord | null>;
  /**
   * The collection ids the profile ticks now (`[]` for none), or `"missing"` when there is no such
   * profile. A throw (unreadable) counts as none ticked. The session-profiles helper
   * `profileKnowledgeCollections(store, id)` is this read.
   */
  profileCollections(profileId: string): Promise<readonly string[] | "missing">;
  logger?: { warn?(message: string, detail?: unknown): void };
}

/** An owner record's `kind`, whatever the owner union holds (`WorkflowSessionOwner`, `KnowledgeSessionOwner`, a newer one). */
export function ownerKindOf(owner: unknown): string | undefined {
  if (owner === null || typeof owner !== "object") return undefined;
  const kind = (owner as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

const NONE: KnowledgeVisibility = { kind: "collections", ids: [] };

export class KnowledgeSessionVisibility implements KnowledgeVisibilityPort {
  constructor(private readonly deps: KnowledgeVisibilityDeps) {}

  private async record(sessionId: string): Promise<KnowledgeSessionRecord | null> {
    try {
      return await this.deps.session(sessionId);
    } catch (error) {
      this.deps.logger?.warn?.("knowledge: a session could not be read; it sees no collection", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async forSession(sessionId: string | undefined): Promise<KnowledgeVisibility> {
    if (sessionId === undefined || sessionId === "") return { kind: "all" };
    const record = await this.record(sessionId);
    if (record === null) return NONE;
    if (record.ownerKind === KNOWLEDGE_WORKER_OWNER_KIND) return NONE;
    const profileId = record.profileId;
    if (profileId === undefined || profileId === null || profileId === "") return { kind: "all" };
    try {
      const ids = await this.deps.profileCollections(profileId);
      if (ids === "missing") return { kind: "all" };
      return { kind: "collections", ids: [...new Set(ids)] };
    } catch (error) {
      this.deps.logger?.warn?.("knowledge: an Agent Profile could not be read; its chat sees no collection", error instanceof Error ? error.message : String(error));
      return NONE;
    }
  }

  /** Whether the session is one of the plugin's worker sessions (`owner.kind === "knowledge-indexer"`). */
  async isWorker(sessionId: string): Promise<boolean> {
    return (await this.record(sessionId))?.ownerKind === KNOWLEDGE_WORKER_OWNER_KIND;
  }
}

export interface KnowledgeForSessionDeps {
  /** Whether the plugin is enabled on this server (`KnowledgeSettingsPort.enabled`). */
  enabled(): boolean;
  visibility: Pick<KnowledgeSessionVisibility, "forSession" | "isWorker">;
  /** Every collection, in the order chats are told about them. */
  collections(): readonly { id: string; name: string }[] | Promise<readonly { id: string; name: string }[]>;
}

/**
 * The session-tools manifest's knowledge input for one chat (`SessionToolsRefreshDeps.knowledgeForSession`):
 * whether the plugin is on, whether the chat is a worker, what it sees, and the NAMES of the
 * collections it sees that exist (deleted ids are dropped). A worker is a worker with the plugin
 * off too (it keeps only its two tools); otherwise, with the plugin off, nothing else is read.
 */
export function createKnowledgeForSession(deps: KnowledgeForSessionDeps): (sessionId: string) => Promise<ManifestKnowledge> {
  return async (sessionId) => {
    const enabled = deps.enabled();
    if (await deps.visibility.isWorker(sessionId)) return { enabled, worker: true, searchable: false, visibleCollectionNames: [] };
    if (!enabled) return { enabled: false, worker: false, searchable: false, visibleCollectionNames: [] };
    const [visibility, collections] = await Promise.all([deps.visibility.forSession(sessionId), deps.collections()]);
    if (visibility.kind === "all") return { enabled: true, worker: false, searchable: true, visibleCollectionNames: collections.map((collection) => collection.name) };
    const ticked = new Set(visibility.ids);
    const names = collections.filter((collection) => ticked.has(collection.id)).map((collection) => collection.name);
    return { enabled: true, worker: false, searchable: names.length > 0, visibleCollectionNames: names };
  };
}
