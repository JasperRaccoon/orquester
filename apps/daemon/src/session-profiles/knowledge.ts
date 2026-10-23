/**
 * Agent Profiles × Knowledge Graph plugin (spec
 * docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md, "Collections and profiles"):
 * the reads the plugin makes of `settings.knowledgeCollections`. Fresh on every call — a profile
 * edit takes effect on the next tool call, nothing is cached here.
 */

import { SessionProfileError } from "./errors.ts";
import { knowledgeCollectionsOf } from "./resolve.ts";
import type { SessionProfileStore } from "./store.ts";

/**
 * Per collection id, the profiles that tick it (`{id, name}`, by profile name): the list view's
 * "SEO · SaaS expert, Mobile expert". Unreadable profiles are left out; ids of deleted collections
 * appear as keys too (the caller looks up the collections it has).
 */
export async function profilesForCollection(store: Pick<SessionProfileStore, "list">): Promise<Map<string, { id: string; name: string }[]>> {
  const { profiles } = await store.list();
  const byCollection = new Map<string, { id: string; name: string }[]>();
  for (const profile of [...profiles].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    for (const collectionId of knowledgeCollectionsOf(profile.manifest.settings) ?? []) {
      const list = byCollection.get(collectionId) ?? [];
      list.push({ id: profile.manifest.id, name: profile.manifest.name });
      byCollection.set(collectionId, list);
    }
  }
  return byCollection;
}

/**
 * The collection ids one profile ticks (`[]` when none — absent, or a value this build cannot
 * read); `"missing"` when there is no such profile (deleted: its chats fall back to Global at
 * their next start). Throws when the profile exists but cannot be read.
 */
export async function profileKnowledgeCollections(store: Pick<SessionProfileStore, "read">, profileId: string): Promise<string[] | "missing"> {
  try {
    const profile = await store.read(profileId);
    return knowledgeCollectionsOf(profile.manifest.settings) ?? [];
  } catch (error) {
    if (error instanceof SessionProfileError && error.code === "PROFILE_NOT_FOUND") return "missing";
    throw error;
  }
}
