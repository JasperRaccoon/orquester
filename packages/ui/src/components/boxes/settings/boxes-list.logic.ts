/**
 * The plugin page's Boxes list (spec §8.10, §13.3): every box that is not
 * destroyed, plus the ones destroyed recently, with their state, price, cost
 * so far, countdown and setup progress.
 */

import {
  BOX_KIND_LABELS,
  type BoxDestroyedReason,
  type BoxSetupStep,
  type BoxState,
  type BoxSummary
} from "@orquester/api";

import { formatCountdown, formatHourlyRate, formatUsd } from "../../../lib/boxes/format";
import type { Tone } from "../../settings/primitives";

/** How long a destroyed box stays listed. */
export const RECENTLY_DESTROYED_MS = 24 * 60 * 60_000;

const timeOf = (value: string | null): number => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
};

/**
 * Live boxes (newest first), then — unless `liveOnly` — those destroyed within
 * {@link RECENTLY_DESTROYED_MS} (latest first).
 */
export function listedBoxes(boxes: readonly BoxSummary[], now: number, liveOnly = false): BoxSummary[] {
  const live = boxes.filter((box) => box.state !== "destroyed").sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  if (liveOnly) return live;
  const gone = boxes
    .filter((box) => box.state === "destroyed" && now - timeOf(box.destroyedAt ?? box.createdAt) <= RECENTLY_DESTROYED_MS)
    .sort((a, b) => timeOf(b.destroyedAt) - timeOf(a.destroyedAt));
  return [...live, ...gone];
}

const STATE_VIEW: Record<BoxState, { tone: Tone; label: string }> = {
  provisioning: { tone: "info", label: "Setting up…" },
  ready: { tone: "ok", label: "Running" },
  unreachable: { tone: "warn", label: "Reconnecting…" },
  destroying: { tone: "neutral", label: "Destroying…" },
  "destroy-failed": { tone: "danger", label: "Destroy failed" },
  destroyed: { tone: "neutral", label: "Destroyed" }
};

const DESTROYED_REASON: Record<BoxDestroyedReason, string> = {
  deleted: "its project was deleted",
  agent: "the agent destroyed it",
  "time-limit": "its time limit ran out",
  "chat-closed": "its chat was closed",
  "provider-gone": "it is gone at the provider",
  "provider-error": "the provider reported an error",
  "provisioning-failed": "setup failed",
  orphan: "cleaned up as an orphan"
};

export function destroyedReasonText(reason: BoxDestroyedReason | null): string | null {
  return reason ? DESTROYED_REASON[reason] : null;
}

/** The state pill, with the daemon's one-line reason as its tooltip. */
export function boxStateView(box: BoxSummary): { tone: Tone; label: string; title: string | null } {
  const view = STATE_VIEW[box.state];
  const reason = box.state === "destroyed" ? destroyedReasonText(box.destroyedReason) : null;
  return { ...view, title: box.stateReason ?? (reason ? `Destroyed: ${reason}` : null) };
}

/** "Linux VM · Hetzner · CX22 · Falkenstein". */
export function boxTitle(box: BoxSummary): string {
  return [BOX_KIND_LABELS[box.kind], box.providerLabel, box.sizeLabel, box.regionLabel].filter(Boolean).join(" · ");
}

/** Whose box it is: "ws / project", or the agent's purpose for a temporary box. */
export function boxOwner(box: BoxSummary): string {
  if (box.project) return box.project.workspace ? `${box.project.workspace} / ${box.project.name}` : box.project.name;
  if (box.purpose === "temporary") return box.purposeNote ? `Agent chat: ${box.purposeNote}` : "Agent chat";
  return "Project";
}

/** "$0.0119/h · $0.42 so far" (estimates); the price part left out when the provider gave none. */
export function boxCostLine(box: BoxSummary): string {
  const parts = [box.hourlyUsd === null ? null : formatHourlyRate(box.hourlyUsd), `${formatUsd(box.estimatedCostUsd)} so far`];
  return parts.filter((part) => part !== null).join(" · ");
}

/** The countdown to the box's automatic end, while it is live. */
export function boxCountdown(box: BoxSummary, now: number): string | null {
  if (box.state === "destroyed" || box.state === "destroying") return null;
  return formatCountdown(box.deadlineAt, now);
}

export interface SetupProgress {
  done: number;
  total: number;
  /** The step that failed, or the one running. */
  current: BoxSetupStep | null;
  failed: boolean;
  /** Every step done or skipped. */
  complete: boolean;
}

export function setupProgress(box: BoxSummary): SetupProgress {
  const steps = box.setup;
  const failed = steps.find((step) => step.state === "failed") ?? null;
  const running = steps.find((step) => step.state === "running") ?? null;
  const done = steps.filter((step) => step.state === "done" || step.state === "skipped").length;
  return {
    done,
    total: steps.length,
    current: failed ?? running,
    failed: failed !== null,
    complete: steps.length > 0 && done === steps.length
  };
}

/**
 * "Destroy" is offered for temporary boxes that still exist; a project box goes
 * with its project (Delete in the project menu).
 */
export function canDestroyBox(box: BoxSummary): boolean {
  return box.purpose === "temporary" && box.state !== "destroyed" && box.state !== "destroying";
}
