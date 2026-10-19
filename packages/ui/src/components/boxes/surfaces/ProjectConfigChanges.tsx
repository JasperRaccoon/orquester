/**
 * Ephemeral AI VMs — a project row's line for its box's pending config changes
 * that no chat turn made (spec 2026-10-19 §8.3): "2 config changes need
 * approval", opening the same cards a chat shows in a dialog.
 */

import React from "react";
import { FileCog } from "lucide-react";
import type { BoxConfigChangeSet } from "@orquester/api";

import { useBoxConfigChanges, type ProjectBoxView } from "./box-data";
import { configChangesIndicator, projectPendingConfigChanges } from "./box-surfaces.logic";
import { ConfigChangesDialog, useShownConfigChanges } from "./ConfigChangeCard";

export const ProjectConfigChanges: React.FC<{ view: ProjectBoxView; projectName: string }> = ({ view, projectName }) => {
  const all = useBoxConfigChanges();
  const boxId = view.info.boxId;
  const [open, setOpen] = React.useState(false);
  const isMine = React.useCallback(
    (change: BoxConfigChangeSet) => change.threadId === null && change.boxId === boxId,
    [boxId]
  );
  const { shown, dismiss } = useShownConfigChanges(all, isMine);
  const label = configChangesIndicator(projectPendingConfigChanges(all, boxId).length);
  // Closing the dialog clears what was decided in it; what is still pending stays.
  const close = () => {
    for (const change of shown) if (change.state !== "pending") dismiss(change.id);
    setOpen(false);
  };
  return (
    <>
      {label ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-[1.875rem] flex max-w-[calc(100%-2.25rem)] items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-warn hover:bg-neutral-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          title="Changes the VM made to agent configuration outside a chat turn"
        >
          <FileCog size={11} aria-hidden className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ) : null}
      {open ? (
        <ConfigChangesDialog open projectName={projectName} changes={shown} onClose={close} />
      ) : null}
    </>
  );
};
