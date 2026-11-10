/**
 * Desktops — this client's recent agent actions per desktop (spec 2026-11-10 §3.2–§3.3): a ring of
 * the last 50 entries for the agent overlay and the Activity popover, with the badge's unseen count.
 *
 * Fed by `desktop.action` events (the app store's `applyEvent` routes them here) and by the daemon's
 * log, loaded once per desktop and connection (`loadDesktopActionLog`). Everything is validated
 * first; a malformed payload is ignored. `resetDesktopActions()` runs on a connection switch.
 */

import { createStore } from "zustand/vanilla";

import type { DesktopActionLogResponse } from "@orquester/api";

import {
  appendDesktopAction,
  EMPTY_DESKTOP_RING,
  mergeDesktopActionLog,
  parseDesktopActionEvent,
  parseDesktopActionLog,
  type DesktopActionRing
} from "./handoff.logic";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface DesktopActionsApi {
  desktopActionLog(id: string, signal?: AbortSignal): Promise<DesktopActionLogResponse>;
}

export interface DesktopActionsState {
  rings: Readonly<Record<string, DesktopActionRing>>;
}

export const desktopActionsStore = createStore<DesktopActionsState>(() => ({ rings: {} }));

/** Desktops whose Activity popover is open: what arrives then is seen. */
const viewing = new Map<string, number>();
const loading = new Map<string, Promise<void>>();
let generation = 0;

function ringOf(desktopId: string): DesktopActionRing {
  return desktopActionsStore.getState().rings[desktopId] ?? EMPTY_DESKTOP_RING;
}

function writeRing(desktopId: string, ring: DesktopActionRing): void {
  const { rings } = desktopActionsStore.getState();
  if (rings[desktopId] === ring) return;
  desktopActionsStore.setState({ rings: { ...rings, [desktopId]: ring } });
}

/** A `desktop.action` event's payload (ignored unless it is one). */
export function applyDesktopActionEvent(payload: unknown): void {
  const event = parseDesktopActionEvent(payload);
  if (!event) return;
  writeRing(event.desktopId, appendDesktopAction(ringOf(event.desktopId), event.entry, (viewing.get(event.desktopId) ?? 0) > 0));
}

/**
 * Load the daemon's log into the ring. Once per desktop and connection unless `force` (the popover
 * opening asks again); a daemon without the route (404) reads as an empty log.
 */
export function loadDesktopActionLog(api: DesktopActionsApi, desktopId: string, force = false): Promise<void> {
  if (!force && ringOf(desktopId).loaded) return Promise.resolve();
  const pending = loading.get(desktopId);
  if (pending) return pending;
  const taken = generation;
  const run = api
    .desktopActionLog(desktopId)
    .then(
      (response) => {
        if (taken === generation) writeRing(desktopId, mergeDesktopActionLog(ringOf(desktopId), parseDesktopActionLog(response)));
      },
      (err: unknown) => {
        if (taken !== generation) return;
        // Remembered as loaded so an older daemon is not asked again on every mount.
        writeRing(desktopId, mergeDesktopActionLog(ringOf(desktopId), []));
        throw err;
      }
    )
    .finally(() => {
      if (loading.get(desktopId) === run) loading.delete(desktopId);
    });
  loading.set(desktopId, run);
  return run;
}

/** The Activity popover opened (`true`) or closed: either way everything so far is seen. */
export function setDesktopActionsViewing(desktopId: string, open: boolean): void {
  viewing.set(desktopId, Math.max(0, (viewing.get(desktopId) ?? 0) + (open ? 1 : -1)));
  if (viewing.get(desktopId) === 0) viewing.delete(desktopId);
  const ring = ringOf(desktopId);
  if (ring.unseen !== 0) writeRing(desktopId, { ...ring, unseen: 0 });
}

/** A closed desktop's ring goes with it. */
export function dropDesktopActions(desktopId: string): void {
  const { rings } = desktopActionsStore.getState();
  if (!(desktopId in rings)) return;
  const { [desktopId]: _gone, ...rest } = rings;
  desktopActionsStore.setState({ rings: rest });
}

/** A connection switch: another daemon's desktops mean nothing here. */
export function resetDesktopActions(): void {
  generation += 1;
  viewing.clear();
  loading.clear();
  desktopActionsStore.setState({ rings: {} }, true);
}
