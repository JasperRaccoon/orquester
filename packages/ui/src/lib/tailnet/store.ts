/**
 * Tailnet — this client's copy of the daemon's tailnet HTTPS status and shared previews (Settings →
 * Server; tailnet machines spec 2026-11-22 §4.7). It converges on the daemon three ways: a load when
 * Server settings open (per connection), each mutation's answer, and `TAILNET_CHANGED_EVENT`
 * snapshots routed here by the app store's `applyEvent`. Every write is a full snapshot, validated
 * first (`validate.ts`). No React import.
 */

import { createStore } from "zustand/vanilla";

import { TAILNET_CHANGED_EVENT, type TailnetHttpsStatus, type TailnetPreviewShare } from "@orquester/api";

import { parseTailnetChanged } from "./validate";

export interface TailnetState {
  https: TailnetHttpsStatus | null;
  previews: readonly TailnetPreviewShare[];
}

const INITIAL: TailnetState = { https: null, previews: [] };

export const tailnetStore = createStore<TailnetState>(() => INITIAL);

/** The routes this store reads — `ApiClient` satisfies it. */
export interface TailnetApi {
  getTailnetHttps(signal?: AbortSignal): Promise<TailnetHttpsStatus>;
  listTailnetPreviews(signal?: AbortSignal): Promise<TailnetPreviewShare[]>;
}

/** A new connection starts from nothing. */
export function resetTailnet(): void {
  tailnetStore.setState(INITIAL, true);
}

export function setTailnetHttps(https: TailnetHttpsStatus): void {
  tailnetStore.setState({ https });
}

export function setTailnetPreviews(previews: readonly TailnetPreviewShare[]): void {
  tailnetStore.setState({ previews });
}

/** Read both from the daemon (the HTTPS status is a fresh `tailscale` read). */
export async function loadTailnet(api: TailnetApi, signal?: AbortSignal): Promise<void> {
  const [https, previews] = await Promise.all([api.getTailnetHttps(signal), api.listTailnetPreviews(signal)]);
  if (signal?.aborted) return;
  tailnetStore.setState({ https, previews });
}

/** One `TAILNET_CHANNEL` event. A malformed payload or an unknown type is ignored. */
export function applyTailnetEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== TAILNET_CHANGED_EVENT) return;
  const payload = parseTailnetChanged(event.payload);
  if (payload) tailnetStore.setState({ https: payload.https, previews: payload.previews });
}
