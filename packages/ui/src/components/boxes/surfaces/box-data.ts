/**
 * Ephemeral AI VMs — the ONE module the box surfaces (sidebar badges, "Opened
 * agents" cards, the chat banner, temporary-box and config-change cards) read
 * box data through.
 *
 * Today it reads `ProjectSummary.box` (the project list's own copy) and this
 * folder's stand-in store (`box-store.ts`: `GET boxRoutes.list` /
 * `boxRoutes.configChanges` plus the `boxes` channel events), and prefers the
 * live box over the project list's copy, which only refreshes with the list.
 *
 * MERGE NOTE: when the boxes store slice (`lib/boxes/store.ts`: `useBoxes`,
 * `useBox`, `useProjectBox`, `useBoxConfigChanges`) lands, re-point the hooks
 * below at it, delete `box-store.ts` and the app store's `// boxes:` event
 * branch that feeds it. Nothing else imports `box-store.ts`.
 */

import { useMemo, useSyncExternalStore } from "react";

import {
  EPHEMERAL_VMS_PLUGIN_ID,
  projectBoxInfo,
  type BoxConfigChangeSet,
  type BoxSummary,
  type DecideBoxConfigChangeRequest,
  type ProjectBoxInfo
} from "@orquester/api";

import { isGlobalPluginEnabled } from "../../../lib/plugins-state";
import { useAppStore, type AppState } from "../../../store/app";
import {
  boxSurfacesStore,
  decideBoxConfigChange,
  destroyTemporaryBox,
  loadBoxSurfaces,
  readDestroyedReason,
  resetBoxSurfaces,
  type BoxSurfacesApi,
  type BoxSurfacesState
} from "./box-store";
import { boxShellRefId, boxTerminalTitle, currentSetupStep } from "./box-surfaces.logic";

// ---------------------------------------------------------------------------
// Loading: once per connected episode, while the plugin is on
// ---------------------------------------------------------------------------

let wired = false;
/** The client the held copy came from: another one (a connection switch) resets it. */
let heldApi: AppState["api"] = null;
/** The client a load ran for in this connected episode; cleared when the connection drops. */
let loadedFor: AppState["api"] = null;

function sync(state: Pick<AppState, "api" | "connectionStatus" | "plugins">): void {
  const api = state.api;
  if (api !== heldApi) {
    heldApi = api;
    loadedFor = null;
    resetBoxSurfaces();
  }
  if (!api || state.connectionStatus !== "connected") {
    // The event stream has no replay: the next connected episode reloads.
    loadedFor = null;
    return;
  }
  if (!isGlobalPluginEnabled(state.plugins, EPHEMERAL_VMS_PLUGIN_ID)) {
    if (loadedFor !== null || boxSurfacesStore.getState().boxes !== null) resetBoxSurfaces();
    loadedFor = null;
    return;
  }
  if (loadedFor === api) return;
  loadedFor = api;
  void loadBoxSurfaces(api).catch(() => undefined);
}

/** Starts following the app store the first time any box surface renders. */
function ensureWired(): void {
  if (wired) return;
  wired = true;
  useAppStore.subscribe((state, previous) => {
    if (state.api === previous.api && state.connectionStatus === previous.connectionStatus && state.plugins === previous.plugins) return;
    sync(state);
  });
  sync(useAppStore.getState());
}

const subscribe = (listener: () => void) => boxSurfacesStore.subscribe(listener);
const snapshot = (): BoxSurfacesState => boxSurfacesStore.getState();

function useSurfacesState(): BoxSurfacesState {
  ensureWired();
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const NO_BOXES: readonly BoxSummary[] = [];
const NO_CHANGES: readonly BoxConfigChangeSet[] = [];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every box this client knows (empty until loaded, or with the plugin off). */
export function useBoxes(): readonly BoxSummary[] {
  return useSurfacesState().boxes ?? NO_BOXES;
}

/** Every box → host config change set held, pending first as the daemon sends them. */
export function useBoxConfigChanges(): readonly BoxConfigChangeSet[] {
  return useSurfacesState().configChanges ?? NO_CHANGES;
}

/** A project's box as its surfaces show it, with the live summary when one is held. */
export interface ProjectBoxView {
  info: ProjectBoxInfo;
  /** The live box, when the boxes list has it (setup steps, connection). */
  box: BoxSummary | null;
  /** The label of the setup step in progress, while provisioning. */
  setupStep: string | null;
}

/** The project list's copy of a project's box: the open project, the open workspace's list. */
function listedProjectBox(state: Pick<AppState, "currentProject" | "projects">, projectPath: string): ProjectBoxInfo | undefined {
  if (state.currentProject?.path === projectPath && state.currentProject.box) return state.currentProject.box;
  return state.projects.find((project) => project.path === projectPath)?.box;
}

/** A project box's info as surfaces show it — the destroyed reason narrowed to the ones this build knows. */
function normalizedInfo(info: ProjectBoxInfo): ProjectBoxInfo {
  return { ...info, destroyedReason: readDestroyedReason(info.destroyedReason) };
}

/**
 * A box project's box, or null for a project on this host. `listed` is the
 * caller's own `ProjectSummary.box` when it has one (an "Opened agents" card
 * reads its project from the project index, not the open workspace's list).
 */
export function useProjectBox(projectPath: string | null | undefined, listed?: ProjectBoxInfo): ProjectBoxView | null {
  const boxes = useBoxes();
  const fromList = useAppStore((state) => (projectPath ? listedProjectBox(state, projectPath) : undefined));
  const summary = listed ?? fromList;
  return useMemo(() => {
    if (!projectPath) return null;
    const live =
      (summary ? boxes.find((box) => box.id === summary.boxId) : undefined) ??
      // The newest project box at this path — a destroyed box's record outlives it.
      [...boxes]
        .filter((box) => box.purpose === "project" && box.project?.path === projectPath)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (live) {
      return {
        info: normalizedInfo(projectBoxInfo(live)),
        box: live,
        setupStep: live.state === "provisioning" ? (currentSetupStep(live.setup)?.label ?? null) : null
      };
    }
    return summary ? { info: normalizedInfo(summary), box: null, setupStep: null } : null;
  }, [boxes, projectPath, summary]);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Approve or deny a config change set; resolves with the decided set (null if the answer did not read). */
export function decideConfigChange(
  api: BoxSurfacesApi,
  id: string,
  decision: DecideBoxConfigChangeRequest["decision"]
): Promise<BoxConfigChangeSet | null> {
  return decideBoxConfigChange(api, id, decision);
}

/** Destroy one of a chat's temporary boxes (`DELETE boxRoutes.box`). */
export function destroyBox(api: BoxSurfacesApi, id: string): Promise<void> {
  return destroyTemporaryBox(api, id);
}

/**
 * "Watch": a terminal tab in the open project attached to the box — a shell
 * session created with `boxId`, which the daemon starts in the box instead of
 * on this host.
 */
export function watchBox(box: BoxSummary) {
  return useAppStore.getState().openTab({
    kind: "shell",
    refId: boxShellRefId(box),
    title: boxTerminalTitle(box),
    boxId: box.id
  });
}
