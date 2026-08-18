import { useMemo } from "react";
import type { SessionActivity } from "@orquester/api";
import type { ProjectIndex } from "../../lib/project-index";
import { isProjectRefVisible, jumpToProject, resolveProjectRef } from "../../lib/session-nav";
import { useAppStore } from "../../store/app";
import type { ProjectSummary, SessionSummary, WorkspaceSummary } from "../../types";

export { resolveProjectRef } from "../../lib/session-nav";

/** Which Opened Agents group a session lands in. */
export type AttentionBucket = "attention" | "finished" | "active" | "idle";

/** Group order in the panel — loudest first. */
const BUCKET_RANK: Record<AttentionBucket, number> = {
  attention: 0,
  finished: 1,
  active: 2,
  idle: 3
};

export interface AgentSessionEntry {
  session: SessionSummary;
  /** The project the tab belongs to — resolved from `session.projectPath`. */
  project: ProjectSummary;
  activity: SessionActivity | undefined;
  bucket: AttentionBucket;
  /**
   * Sort key for the flagged groups. The daemon's `needsAttentionAt` where it
   * has one, else the session's own creation time (older daemons,
   * `waiting`-without-attention sessions, and — after a reload — exited ones,
   * whose activity the daemon stops reporting).
   */
  flaggedAt: string;
}

/** Groups that call for the user: they drive the trigger badge together. */
export function isFlaggedBucket(bucket: AttentionBucket): boolean {
  return bucket === "attention" || bucket === "finished";
}

/**
 * Bucket a session:
 * an exited process is **finished** — the daemon stamps `attention: "finished"`
 * on exit, and deriving the group from `status` instead keeps it there across a
 * reload (the daemon drops activity for non-running sessions). Any raised
 * `attention` or the structural `waiting` state (permission prompt / question)
 * blocks on the user, `working` is busy, everything else is idle.
 */
export function bucketOf(
  session: SessionSummary,
  activity: SessionActivity | undefined
): AttentionBucket {
  if (session.status === "exited") {
    return "finished";
  }
  if (activity?.attention || activity?.state === "waiting") {
    return "attention";
  }
  return activity?.state === "working" ? "active" : "idle";
}

/**
 * Every agent-kind session across every *visible* workspace/project, bucketed —
 * the Opened Agents section's data source. Pure so the global shortcut can derive
 * the same list from `useAppStore.getState()` outside of React.
 *
 * Sessions with no `projectPath` are dropped: there is nowhere to navigate to,
 * and the daemon only ever creates agent sessions as project tabs. Archived
 * projects/workspaces are dropped too — the panel must not be a hole in the
 * "Protect archived data" curtain.
 */
export function deriveAgentSessions(
  sessions: SessionSummary[],
  workspaces: WorkspaceSummary[],
  activityById: Record<string, SessionActivity>,
  projects: ProjectSummary[] = []
): AgentSessionEntry[] {
  const entries: AgentSessionEntry[] = [];
  for (const session of sessions) {
    if (session.kind !== "agent" || session.projectPath === "") {
      continue;
    }
    const project = resolveProjectRef(session.projectPath, workspaces, projects);
    if (!isProjectRefVisible(project, workspaces)) {
      continue;
    }
    const activity = activityById[session.id];
    entries.push({
      session,
      project,
      activity,
      bucket: bucketOf(session, activity),
      flaggedAt: activity?.needsAttentionAt ?? session.createdAt
    });
  }
  return entries.sort((a, b) => {
    if (a.bucket !== b.bucket) {
      return BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    }
    // The flagged groups are ordered "what just called for me" first; the calmer
    // groups keep the stable project/tab order the tab strip uses.
    if (isFlaggedBucket(a.bucket)) {
      return b.flaggedAt.localeCompare(a.flaggedAt);
    }
    return (
      a.project.workspace.localeCompare(b.project.workspace) ||
      a.project.name.localeCompare(b.project.name) ||
      a.session.order - b.session.order ||
      a.session.createdAt.localeCompare(b.session.createdAt)
    );
  });
}

/**
 * Narrow a derived list to the sessions whose project the daemon has positively
 * confirmed is an unarchived project of an unarchived workspace.
 *
 * {@link deriveAgentSessions} can only consult the *open* workspace's project
 * list, so on its own it leaks sessions living in archived projects of every
 * other workspace (and of any workspace while none is open) into the panel, the
 * count, the cycle shortcut and navigation. The index is the only thing that can
 * tell those apart, so nothing is shown or navigated to until it says so:
 * `index === null` (not fetched, or invalidated) means *nothing* is verified,
 * and a workspace whose listing failed (`index.incomplete`) drops out too.
 *
 * This is stricter than the "Protect archived data" toggle strictly requires —
 * it curtains the panel even with protection off — but it is one rule for both
 * display and navigation, and the alternative (a visible row that refuses to
 * open) is worse than an absent one.
 */
export function verifiedAgentSessions(
  entries: AgentSessionEntry[],
  index: ProjectIndex | null
): AgentSessionEntry[] {
  if (index === null) {
    return [];
  }
  return entries.filter((entry) => index.visible.has(entry.session.projectPath));
}

/** React binding for {@link deriveAgentSessions}; re-derives on `session.activity` events. */
export function useAgentSessions(): AgentSessionEntry[] {
  const sessions = useAppStore((s) => s.sessions);
  const workspaces = useAppStore((s) => s.workspaces);
  const activityById = useAppStore((s) => s.activityById);
  const projects = useAppStore((s) => s.projects);
  return useMemo(
    () => deriveAgentSessions(sessions, workspaces, activityById, projects),
    [sessions, workspaces, activityById, projects]
  );
}

/** Snapshot of the same list from outside React (the global shortcut). */
export function agentSessionsSnapshot(): AgentSessionEntry[] {
  const { sessions, workspaces, activityById, projects } = useAppStore.getState();
  return deriveAgentSessions(sessions, workspaces, activityById, projects);
}

/** Navigate to a session's tab (shared with the command palette's rows). */
export function focusAgentSession(entry: AgentSessionEntry): boolean {
  return jumpToProject({ project: entry.project, sessionId: entry.session.id });
}

/**
 * Identity of one "the agent is calling for you" episode. Includes the flag
 * timestamp so a session that goes quiet and calls again counts as unseen.
 */
export function attentionKey(entry: AgentSessionEntry): string {
  return `${entry.session.id}@${entry.flaggedAt}`;
}

/**
 * An episode counts as *unseen* only while the daemon's `attention` is still
 * raised. Focusing the tab nulls it (`clearSessionAttention`), which is exactly
 * the acknowledgement the badge should respect — bucket membership alone would
 * keep badging a session parked at a permission prompt the user is looking at.
 */
function isUnseeable(entry: AgentSessionEntry): boolean {
  return entry.activity?.attention != null;
}

export interface AttentionSummary {
  /** Live agent sessions — exited ones live in Finished and don't count. */
  total: number;
  /** Needs-Attention + Finished: always shown on the header, seen or not. */
  flaggedCount: number;
  /** Flagged sessions still calling and not yet looked at — drives the amber. */
  unseenCount: number;
  label: string;
}

/** Everything the section header needs, as a pure function of the two inputs. */
export function summarizeAgentSessions(
  entries: AgentSessionEntry[],
  seenKeys: ReadonlySet<string>
): AttentionSummary {
  const flagged = entries.filter((entry) => isFlaggedBucket(entry.bucket));
  const total = entries.filter((entry) => entry.bucket !== "finished").length;
  const flaggedCount = flagged.length;
  return {
    total,
    flaggedCount,
    unseenCount: flagged.filter(
      (entry) => isUnseeable(entry) && !seenKeys.has(attentionKey(entry))
    ).length,
    label:
      `${total} agent session${total === 1 ? "" : "s"}` +
      (flaggedCount > 0
        ? `, ${flaggedCount} need${flaggedCount === 1 ? "s" : ""} attention`
        : "")
  };
}

/**
 * Replace the seen set with exactly the episodes currently on screen, keeping
 * the previous object when nothing changed (a new Set every render would loop
 * the effect that calls this).
 */
export function nextSeenKeys(prev: ReadonlySet<string>, keys: string[]): ReadonlySet<string> {
  return keys.length === prev.size && keys.every((key) => prev.has(key)) ? prev : new Set(keys);
}
