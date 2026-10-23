import type { AgentHostRestartBlocker, AgentHostStatusResponse } from "@orquester/api/agent-chat";

/** One thread and everything of it a pending agent-host restart waits on. */
export interface RestartBlockerGroup {
  threadId: string;
  /** The tab's title, else the thread id. */
  label: string;
  blockers: AgentHostRestartBlocker[];
}

/** The blockers by thread, in the order the daemon listed them. */
export function groupRestartBlockers(blockers: readonly AgentHostRestartBlocker[]): RestartBlockerGroup[] {
  const groups = new Map<string, RestartBlockerGroup>();
  for (const blocker of blockers) {
    let group = groups.get(blocker.threadId);
    if (group === undefined) {
      group = { threadId: blocker.threadId, label: blocker.threadId, blockers: [] };
      groups.set(blocker.threadId, group);
    }
    if (blocker.threadTitle !== undefined && blocker.threadTitle.trim() !== "") group.label = blocker.threadTitle;
    group.blockers.push(blocker);
  }
  return [...groups.values()];
}

/** What a blocker is, in a few words. */
export function blockerKindLabel(blocker: AgentHostRestartBlocker): string {
  switch (blocker.kind) {
    case "turn":
      return "Turn running";
    case "background":
      return "Background shell";
    case "agent":
      return "Subagent";
    case "wake":
      return "About to continue with a finished background task";
    case "work":
      return "Background work";
  }
}

/** A blocker's own name: its title, else its command, else its task id. */
export function blockerName(blocker: AgentHostRestartBlocker): string | null {
  return blocker.title?.trim() || blocker.command?.trim() || blocker.taskId || null;
}

/** Seconds since `since` at `nowMs`, or null when unknown. */
export function blockerAgeSeconds(blocker: AgentHostRestartBlocker, nowMs: number): number | null {
  if (blocker.since === undefined) return null;
  const since = Date.parse(blocker.since);
  return Number.isFinite(since) ? Math.max(0, (nowMs - since) / 1000) : null;
}

/** The stop a blocker offers: one task alone, the chat's whole session, or none (a turn, a wake). */
export function blockerStopAction(blocker: AgentHostRestartBlocker): "task" | "session" | null {
  if (blocker.kind === "turn" || blocker.kind === "wake") return null;
  return blocker.stoppable === true && blocker.taskId !== undefined ? "task" : "session";
}

/** A code stamp for display: its first 12 characters. */
export function shortCodeStamp(stamp: string | null): string {
  return stamp === null || stamp === "" ? "unknown" : stamp.slice(0, 12);
}

/**
 * The lines a "Restart agent host now" confirmation lists: everything the restart stops, one
 * line per blocker, or a single line saying nothing is running.
 */
export function restartNowConsequences(status: AgentHostStatusResponse | null): string[] {
  const blockers = status?.pendingRestart?.blockers ?? [];
  if (blockers.length === 0) return ["Nothing is running in any chat right now."];
  return groupRestartBlockers(blockers).flatMap((group) =>
    group.blockers.map((blocker) => {
      const name = blockerName(blocker);
      return `${group.label}: ${blockerKindLabel(blocker)}${name !== null && blocker.kind !== "turn" ? ` — ${name}` : ""}`;
    })
  );
}
