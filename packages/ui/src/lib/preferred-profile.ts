/**
 * Client-local memory of the Agent Profile last picked per agent (agent
 * profiles spec §5.3), exactly like the account and model preferences: a new
 * chat and a resumed conversation launch with it. Keyed by the agent's
 * registry id (the tab's `refId`); an agent with no entry is Global.
 *
 * Loaded field-wise (persisted-shape rule): a blob from another bundle or a
 * hand edit must never reach typed code raw — anything that is not a short
 * non-empty string id is dropped.
 */

const STORAGE_KEY = "orquester:preferred-profile-by-agent";

/** Longest profile id kept (the daemon mints UUIDs; the persisted schemas cap ids at 128). */
const PROFILE_ID_MAX = 128;

/** The map, validated: only non-empty agent keys mapped to non-empty string ids survive. */
export function parsePreferredProfiles(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [agent, id] of Object.entries(raw as Record<string, unknown>)) {
    if (agent.length === 0) continue;
    if (typeof id !== "string" || id.trim().length === 0 || id.length > PROFILE_ID_MAX) continue;
    result[agent] = id;
  }
  return result;
}

/** Load the persisted per-agent profile map (empty — every agent Global — on any failure). */
export function loadPreferredProfiles(): Record<string, string> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return parsePreferredProfiles(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Persist the per-agent profile map; a storage failure is non-fatal. */
export function savePreferredProfiles(map: Record<string, string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — the selection stays in-memory only */
  }
}

/** `map` with `agent` set to `profileId`, or removed (Global) for `null`. */
export function withPreferredProfile(
  map: Record<string, string>,
  agent: string,
  profileId: string | null
): Record<string, string> {
  if (profileId === null) {
    if (!(agent in map)) return map;
    const { [agent]: _removed, ...rest } = map;
    return rest;
  }
  return map[agent] === profileId ? map : { ...map, [agent]: profileId };
}

/** `map` without every agent that remembered `profileId` (it was deleted): those agents are Global again. */
export function withoutPreferredProfile(map: Record<string, string>, profileId: string): Record<string, string> {
  if (!Object.values(map).includes(profileId)) return map;
  const next: Record<string, string> = {};
  for (const [agent, id] of Object.entries(map)) if (id !== profileId) next[agent] = id;
  return next;
}
