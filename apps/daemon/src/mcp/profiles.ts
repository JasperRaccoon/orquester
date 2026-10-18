// Agent Profiles as the catalog tools see them (spec 2026-10-18 §5.5): `create_session` and
// `fork_session` name one by id or name, `list_agents` lists them, and the session views report a
// chat's. Everything through the daemon's own `sessionProfileRoutes.list` (DaemonApi), field-wise:
// an older daemon without the route, or a body that does not read, is "no profiles known".
import { sessionProfileRoutes, type SessionProfilePrepareState } from "@orquester/api";
import type { DaemonApi } from "./daemon-api.ts";
import { daemonError, ToolError } from "./errors.ts";
import { clipText, MAX_ECHO_CHARS } from "./result.ts";

/** One profile as the tools read it off the list route. */
export interface ProfileRow {
  id: string;
  name: string;
  description: string;
  /** Per agent (adapter id): its preparation state and, when it is not ready, why. */
  preparation: { agent: string; state: SessionProfilePrepareState; reason?: string }[];
}

/** A chat's profile as the views report it: `null` = Global. `name` is absent when the profile is gone. */
export type ProfileRef = { id: string; name?: string } | null;

const PREPARE_STATES: ReadonlySet<string> = new Set(["preparing", "ready", "failed", "not-prepared"]);
/** The longest description `list_agents` lists (the editor's own limit is 2 000). */
const DESCRIPTION_CHARS = 200;
/** The longest preparation reason `list_agents` lists. */
const REASON_CHARS = 300;

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => v !== null && typeof v === "object" && !Array.isArray(v);

/** The rows of a list body, each re-built from checked fields; a row that does not read is left out. */
function profileRows(body: unknown): ProfileRow[] {
  const profiles = isRecord(body) && Array.isArray(body.profiles) ? body.profiles : [];
  return profiles.flatMap((p): ProfileRow[] => {
    if (!isRecord(p) || typeof p.id !== "string" || p.id === "" || typeof p.name !== "string") return [];
    const preparation = (Array.isArray(p.preparation) ? p.preparation : []).flatMap((s): ProfileRow["preparation"] =>
      isRecord(s) && typeof s.agent === "string" && typeof s.state === "string" && PREPARE_STATES.has(s.state)
        ? [{ agent: s.agent, state: s.state as SessionProfilePrepareState, ...(typeof s.reason === "string" && s.reason ? { reason: s.reason } : {}) }]
        : []
    );
    return [{ id: p.id, name: p.name, description: typeof p.description === "string" ? p.description : "", preparation }];
  });
}

/** Every profile, or null when the daemon cannot list them (no such route, a failed read). */
export async function loadProfiles(api: DaemonApi): Promise<ProfileRow[] | null> {
  const res = await api.request("GET", sessionProfileRoutes.list);
  return res.status < 400 ? profileRows(res.body) : null;
}

/** The profiles, or a refusal written for the agent when they cannot be read — a launch naming one must not guess. */
async function requireProfiles(api: DaemonApi): Promise<ProfileRow[]> {
  const res = await api.request("GET", sessionProfileRoutes.list);
  if (res.status >= 400) {
    const failure = daemonError(res);
    throw new ToolError(failure.code === "NOT_FOUND" ? "UNAVAILABLE" : failure.code, `Agent Profiles cannot be read on this host (${failure.message}); leave \`profile\` out to use Global.`);
  }
  return profileRows(res.body);
}

/**
 * The profile a launch names: by id, else by name (case-insensitive — names are unique), else, for
 * `"global"`, Global (`null`). Unknown: PROFILE_NOT_FOUND naming the ones that exist — a launch
 * never falls back to Global (§5.5).
 */
export async function resolveProfileArg(api: DaemonApi, ref: string): Promise<{ id: string; name: string } | null> {
  const profiles = await requireProfiles(api);
  const wanted = ref.trim();
  const found = profiles.find((p) => p.id === wanted) ?? profiles.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (found) return { id: found.id, name: found.name };
  if (wanted.toLowerCase() === "global") return null;
  const known = profiles.map((p) => `"${p.name}"`).join(", ");
  throw new ToolError("PROFILE_NOT_FOUND", `No Agent Profile "${clipText(wanted, MAX_ECHO_CHARS)}". ${known ? `Profiles: ${known} (list_agents).` : "There are no Agent Profiles."} Leave \`profile\` out for Global.`);
}

/** The profile names by id, for the views (empty when they cannot be read). */
export async function profileNames(api: DaemonApi): Promise<ReadonlyMap<string, string>> {
  return new Map((await loadProfiles(api).catch(() => null))?.map((p) => [p.id, p.name]) ?? []);
}

/** A chat's profile as the views report it, from its summary's `profileId` (absent or null = Global). */
export function profileRef(profileId: string | null | undefined, names: ReadonlyMap<string, string>): ProfileRef {
  if (typeof profileId !== "string" || profileId === "") return null;
  const name = names.get(profileId);
  return name !== undefined ? { id: profileId, name } : { id: profileId };
}

/**
 * The profiles as `list_agents` lists them: id, name, description (cut), and per agent its readiness
 * — `ready`, `preparing`, `failed` (with `reasons`), or `not-prepared` (prepared at the first launch;
 * with a reason when the agent has no profile support). `agents` narrows it to those adapters.
 */
export function profileListing(rows: readonly ProfileRow[], agents?: ReadonlySet<string>): Record<string, unknown>[] {
  return rows.map((row) => {
    const states = row.preparation.filter((s) => agents === undefined || agents.has(s.agent));
    const reasons = Object.fromEntries(states.filter((s) => s.state !== "ready" && s.reason).map((s) => [s.agent, clipText(s.reason!, REASON_CHARS)]));
    return {
      id: row.id,
      name: row.name,
      ...(row.description ? { description: clipText(row.description, DESCRIPTION_CHARS) } : {}),
      agents: Object.fromEntries(states.map((s) => [s.agent, s.state])),
      ...(Object.keys(reasons).length > 0 ? { reasons } : {})
    };
  });
}
