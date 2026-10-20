/**
 * Ephemeral AI VMs — the small badges a box project carries in the sidebar
 * (spec 2026-10-19 §8.10): on its project row, on its archived row, and on
 * each of its chats' "Opened agents" cards, plus the destroyed banner inside
 * such a card (§9.3). The wording is `box-surfaces.logic.ts`'s; the clock is
 * the shared minute tick.
 */

import React from "react";
import { Server, TriangleAlert } from "lucide-react";
import type { ProjectBoxInfo } from "@orquester/api";

import { useUsageNow } from "../../../hooks/use-usage-display";
import { cn } from "../../../lib/cn";
import { useProjectBox, type ProjectBoxView } from "./box-data";
import {
  agentCardBoxBadge,
  archivedBoxNote,
  boxDestroyedMessage,
  projectBoxBadge,
  type BoxBadgeModel,
  type BoxTone
} from "./box-surfaces.logic";

/** Pill colours per tone — the sidebar's `CountPill` palette. */
export const BOX_PILL_TONE: Record<BoxTone, string> = {
  neutral: "bg-neutral-800 text-neutral-400",
  info: "bg-info-soft/60 text-info",
  warn: "bg-warn-soft/60 text-warn",
  danger: "bg-danger-soft/60 text-danger"
};

/** Text colours per tone, for the quieter places a pill would be too loud. */
export const BOX_TEXT_TONE: Record<BoxTone, string> = {
  neutral: "text-neutral-500",
  info: "text-info",
  warn: "text-warn",
  danger: "text-danger"
};

/** One badge as a pill; its tooltip says what the box is and why it is in its state. */
export const BoxBadge: React.FC<{ model: BoxBadgeModel; className?: string }> = ({ model, className }) => (
  <span
    title={model.title}
    data-box-badge={model.tone}
    className={cn(
      "inline-flex h-[18px] min-w-0 max-w-[60%] shrink items-center gap-1 overflow-hidden rounded-full px-1.5 text-[10px] font-medium tabular-nums",
      BOX_PILL_TONE[model.tone],
      className
    )}
  >
    <span className="shrink-0">{model.text}</span>
    {model.detail ? <span className="min-w-0 truncate font-normal opacity-80">· {model.detail}</span> : null}
  </span>
);

/** A project row's badge. */
export const ProjectRowBoxBadge: React.FC<{ view: ProjectBoxView }> = ({ view }) => {
  const now = useUsageNow();
  return <BoxBadge model={projectBoxBadge(view.info, now, view.setupStep)} />;
};

/** An archived box project's "still billing" note (§8.11); nothing for a project on this host. */
export const ArchivedBoxNote: React.FC<{ projectPath: string; listed?: ProjectBoxInfo }> = ({ projectPath, listed }) => {
  const view = useProjectBox(projectPath, listed);
  const note = archivedBoxNote(view?.info);
  if (!note) return null;
  return (
    <span className="ml-1.5 shrink-0 text-[11px] text-warn" title="Archiving leaves the VM running. Delete the project to destroy it.">
      {note}
    </span>
  );
};

/** The badge an "Opened agents" card carries beside `workspace / project`. */
export const AgentCardBoxBadge: React.FC<{ view: ProjectBoxView }> = ({ view }) => {
  const now = useUsageNow();
  const model = agentCardBoxBadge(view.info, now);
  return (
    <span
      title={model.title}
      data-box-badge={model.tone}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-medium tabular-nums",
        BOX_PILL_TONE[model.tone]
      )}
    >
      <Server size={9} aria-hidden />
      {model.text}
    </span>
  );
};

/**
 * The destroyed banner inside an "Opened agents" card (§9.3). Text only: the card is a button.
 * Two lines at most — a box with several chats would otherwise fill the sidebar with the same
 * paragraph; the whole message is the tooltip, and the chat itself shows it in full.
 */
export const AgentCardBoxBanner: React.FC<{ view: ProjectBoxView }> = ({ view }) => {
  if (view.info.state !== "destroyed") return null;
  const message = boxDestroyedMessage(view.info);
  return (
    <span
      role="note"
      title={message}
      className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-danger-900/50 bg-danger-soft/40 px-2 py-1.5 text-[11px] leading-snug text-danger-300"
    >
      <TriangleAlert size={12} aria-hidden className="mt-px shrink-0" />
      <span className="line-clamp-2 min-w-0">{message}</span>
    </span>
  );
};
