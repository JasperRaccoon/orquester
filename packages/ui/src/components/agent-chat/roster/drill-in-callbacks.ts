/**
 * The drill-in's timeline callbacks (§7.6).
 *
 * "The child view dispatches no commands": no rewind, no approval, no queue
 * inside a child — each of those callbacks is inert here. Navigation and
 * reads are no commands, though: opening a file a child's words link to, and
 * reading a call's whole output in the parent's viewer, pass the host's own
 * handlers through, as the thread's timeline has them. One table, pure, so
 * the rule is tested rather than spread over a component's props.
 */

import type { ChatTimelineProps } from "../contracts";

/** What the drill-in's host offers its timeline: navigation and reads only. */
export interface DrillInTimelineHost {
  /** Open a file in the project's Files tab (a link in a child's words, a changed file). */
  onOpenFile?: ChatTimelineProps["onOpenFile"] | undefined;
  /** The parent's full-output viewer: a read, not a command. */
  onLoadFullOutput?: ChatTimelineProps["onLoadFullOutput"] | undefined;
}

/** The callbacks a drill-in's `ChatTimeline` takes. */
export type DrillInTimelineCallbacks = Pick<
  ChatTimelineProps,
  | "canRevert"
  | "onRevert"
  | "onOpenTurnDiff"
  | "onOpenFile"
  | "onLoadFullOutput"
  | "onOpenAgent"
  | "onSendQueuedNow"
  | "onReturnQueuedToComposer"
>;

const inert = (): void => {};

/**
 * The drill-in's callback table: the host's navigation, every command inert.
 * A turn diff is a read, but a child shows no changed-files card (it has no
 * checkpoints of its own), so nothing here could open one.
 */
export function drillInTimelineCallbacks(host: DrillInTimelineHost): DrillInTimelineCallbacks {
  return {
    canRevert: false,
    onRevert: inert,
    onOpenTurnDiff: inert,
    onOpenFile: host.onOpenFile ?? inert,
    onLoadFullOutput: host.onLoadFullOutput ?? inert,
    onOpenAgent: inert,
    onSendQueuedNow: inert,
    onReturnQueuedToComposer: inert
  };
}
