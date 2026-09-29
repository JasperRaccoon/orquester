// Automated workflows — the schedule and git triggers (spec §6.1, §6.2). Both talk to the engine
// only through `TriggerHost` (contracts.ts) and keep their runtime state in `WorkflowStateStore`.

export { createScheduler } from "./scheduler.ts";
export type { Scheduler, SchedulerDeps, ScheduleTriggerState } from "./scheduler.ts";
export { createGitPoller } from "./git-poller.ts";
export type { GitPoller, GitPollerDeps, GitRemoteReader, GitTriggerState } from "./git-poller.ts";
export { createRepoResolver } from "./repo-resolve.ts";
export type { RepoResolverDeps, ResolvedRepo, ResolveRepo } from "./repo-resolve.ts";
export { matchesAnyGlob, matchesGlob } from "./glob.ts";
export { systemTriggerClock } from "./clock.ts";
