/**
 * Ephemeral AI VMs — the box surfaces' (sidebar badges, "Opened agents" cards,
 * the chat banner, temporary-box and config-change cards) view of the boxes
 * store (`lib/boxes/store.ts`).
 *
 * That store is the one copy of the plugin's state: the app store loads it per
 * connection while the plugin is on, feeds it the `boxes` channel events and
 * resets it on a connection switch or when the plugin turns off. This module
 * only reads it, adds what the surfaces need on top (a project's box joined
 * with the project list's own `ProjectSummary.box`, which only refreshes with
 * the list), and forwards the surfaces' actions to the store's mutations.
 */

import { useMemo } from "react";

import {
  projectBoxInfo,
  type BoxConfigChangeSet,
  type BoxSummary,
  type DecideBoxConfigChangeRequest,
  type ProjectBoxInfo
} from "@orquester/api";

import {
  decideBoxConfigChange,
  destroyBox as destroyStoreBox,
  projectBoxIn,
  useBoxConfigChanges,
  useBoxes,
  type BoxesApi
} from "../../../lib/boxes/store";
import { readDestroyedReason } from "../../../lib/boxes/validate";
import { useAppStore, type AppState } from "../../../store/app";
import { boxShellRefId, boxTerminalTitle, currentSetupStep } from "./box-surfaces.logic";

export { useBoxConfigChanges, useBoxes };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

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
      // The project's live box at this path, else its newest destroyed one (its record outlives it).
      projectBoxIn(boxes, projectPath);
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
  api: BoxesApi,
  id: string,
  decision: DecideBoxConfigChangeRequest["decision"]
): Promise<BoxConfigChangeSet | null> {
  return decideBoxConfigChange(api, id, decision);
}

/** Destroy one of a chat's temporary boxes (`DELETE boxRoutes.box`); the answer lands in the store. */
export function destroyBox(api: BoxesApi, id: string): Promise<void> {
  return destroyStoreBox(api, id);
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
