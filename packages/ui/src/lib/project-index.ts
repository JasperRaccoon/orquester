import { useSyncExternalStore } from "react";
import { workspaceService } from "../services";
import type { ApiClient } from "./api-client";
import type { ProjectSummary, WorkspaceSummary } from "../types";

/**
 * A positively verified answer to "which project paths may this client show and
 * navigate to right now".
 *
 * The store only ever holds the project list of the *open* workspace, so
 * anything derived from it alone (an agent session's `projectPath`, a recent
 * project) cannot tell an archived project of another workspace from a live
 * one — a hole in the "Protect archived data" curtain. This index closes it the
 * only way a client can: by listing every unarchived workspace and keeping the
 * paths the daemon actually reported as unarchived projects.
 *
 * Membership is therefore the whole contract: a path in `visible` is safe to
 * show and to jump to; a path that is absent is either archived, gone, or in a
 * workspace whose listing failed — indistinguishable, and all three fail closed.
 */
export interface ProjectIndex {
  /** Path → project, for unarchived projects of unarchived workspaces only. */
  visible: Map<string, ProjectSummary>;
  /** At least one workspace listing failed, so `visible` may be missing real projects. */
  incomplete: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let cache: ProjectIndex | null = null;
let inFlight: Promise<ProjectIndex> | null = null;
/**
 * Bumped by every invalidation so a fetch that was already in flight when the
 * user archived something cannot publish its pre-mutation answer afterwards.
 */
let generation = 0;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeProjectIndex(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last published index, or null when none has resolved since the last invalidation. */
export function cachedProjectIndex(): ProjectIndex | null {
  return cache;
}

/**
 * Drop the cached answer — call after anything that can change what is
 * archived (archive/restore of a project or a workspace, a disconnect).
 * Consumers fall back to "nothing verified" until the next fetch resolves.
 */
export function invalidateProjectIndex(): void {
  generation += 1;
  inFlight = null;
  if (cache !== null) {
    cache = null;
    notify();
  }
}

/**
 * Re-list every unarchived workspace and publish the result to every consumer.
 * `signal` aborts the in-flight requests; an aborted (or superseded) run never
 * publishes, so a closing popover can't overwrite a fresher answer.
 */
export async function refreshProjectIndex(
  api: ApiClient,
  workspaces: readonly WorkspaceSummary[],
  signal?: AbortSignal
): Promise<ProjectIndex> {
  const started = generation;
  const lists = await Promise.all(
    workspaces
      .filter((workspace) => !workspace.isArchived)
      .map((workspace) =>
        workspaceService.listProjects(api, workspace.name, signal).catch(() => null)
      )
  );
  const visible = new Map<string, ProjectSummary>();
  for (const list of lists) {
    for (const project of list ?? []) {
      if (!project.isArchived) {
        visible.set(project.path, project);
      }
    }
  }
  const index: ProjectIndex = { visible, incomplete: lists.some((list) => list === null) };
  if (signal?.aborted || started !== generation) {
    return index;
  }
  cache = index;
  notify();
  return index;
}

/**
 * The cached index, fetching one first if there is none. Deduped, so the
 * keyboard shortcut can await it on every press without a request storm.
 */
export function ensureProjectIndex(
  api: ApiClient,
  workspaces: readonly WorkspaceSummary[]
): Promise<ProjectIndex> {
  if (cache !== null) {
    return Promise.resolve(cache);
  }
  if (inFlight === null) {
    inFlight = refreshProjectIndex(api, workspaces).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Subscribe to the published index (null until one resolves). Does not fetch. */
export function useProjectIndex(): ProjectIndex | null {
  return useSyncExternalStore(subscribeProjectIndex, cachedProjectIndex, cachedProjectIndex);
}
