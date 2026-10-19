/**
 * Repo icon images — one shared blob URL per `(repoKey, version)`.
 *
 * An image icon's bytes come through the authenticated API client
 * (`readRepoIcon`), never a bare URL, and are shown from an object URL. Every
 * mounted `RepoIcon` of a repo shares the one fetch and the one URL; the URL is
 * revoked when the repo's icon version changes, when its identity goes away,
 * and on a connection reset (the identity map empties). A failed fetch is
 * remembered for its version and not retried in a loop — only the next applied
 * identity load (a reconnect) clears it.
 *
 * The blob is typed with the identity's own `contentType`. Callers must show
 * the URL only through `<img src>` — an SVG there cannot run script.
 */

import { createStore } from "zustand/vanilla";

import type { RepoIcon } from "@orquester/api";

import { repoIdentitiesStore, type RepoIdentitiesApi } from "./store";

export interface RepoIconImage {
  repoKey: string;
  version: string;
  status: "loading" | "ready" | "failed";
  /** The object URL, while `status === "ready"`. */
  url: string | null;
}

interface Entry extends RepoIconImage {
  controller: AbortController | null;
}

export interface RepoIconImagesState {
  /** repoKey → the image of its current icon version. */
  images: ReadonlyMap<string, RepoIconImage>;
}

export const repoIconImagesStore = createStore<RepoIconImagesState>(() => ({ images: new Map() }));

function entries(): ReadonlyMap<string, Entry> {
  return repoIconImagesStore.getState().images as ReadonlyMap<string, Entry>;
}

function release(entry: Entry): void {
  entry.controller?.abort();
  if (entry.url !== null) URL.revokeObjectURL(entry.url);
}

function put(entry: Entry): void {
  const next = new Map(entries());
  next.set(entry.repoKey, entry);
  repoIconImagesStore.setState({ images: next });
}

/** The image a mounted icon of `repoKey` should show, if any. */
export function getRepoIconImage(repoKey: string): RepoIconImage | undefined {
  return entries().get(repoKey);
}

/**
 * Make sure the bytes of `repoKey`'s image icon are fetched (once). A no-op
 * for an emoji, for a version already loading, shown or failed, and for an icon
 * that is no longer the repo's current one. Resolves once the fetch it started
 * (if any) has settled; never rejects.
 */
export function ensureRepoIconImage(
  api: Pick<RepoIdentitiesApi, "readRepoIcon">,
  repoKey: string,
  icon: RepoIcon | undefined
): Promise<void> {
  if (icon?.kind !== "image") return Promise.resolve();
  const current = repoIdentitiesStore.getState().identities.get(repoKey)?.icon;
  if (current?.kind !== "image" || current.version !== icon.version) return Promise.resolve();
  const held = entries().get(repoKey);
  if (held?.version === icon.version) return Promise.resolve();
  if (held) release(held);
  const controller = new AbortController();
  const entry: Entry = { repoKey, version: icon.version, status: "loading", url: null, controller };
  put(entry);
  const contentType = current.contentType;
  const settle = (patch: Pick<Entry, "status" | "url">): void => {
    put({ ...entry, ...patch, controller: null });
  };
  return api.readRepoIcon(repoKey, icon.version, controller.signal).then(
    (bytes) => {
      if (entries().get(repoKey) !== entry) return;
      settle({ status: "ready", url: URL.createObjectURL(new Blob([bytes], { type: contentType })) });
    },
    () => {
      if (entries().get(repoKey) !== entry) return;
      settle({ status: "failed", url: null });
    }
  );
}

/**
 * Drop every image whose repo no longer has that icon version (replaced, reset
 * to an emoji or the default, identity gone, connection reset), and — after a
 * fresh identity load — every failed one, so mounted icons try once more.
 */
function prune(retryFailed: boolean): void {
  const identities = repoIdentitiesStore.getState().identities;
  let next: Map<string, Entry> | null = null;
  for (const entry of entries().values()) {
    const icon = identities.get(entry.repoKey)?.icon;
    const stale = icon?.kind !== "image" || icon.version !== entry.version;
    if (stale || (retryFailed && entry.status === "failed")) {
      release(entry);
      next ??= new Map(entries());
      next.delete(entry.repoKey);
    }
  }
  if (next !== null) repoIconImagesStore.setState({ images: next });
}

repoIdentitiesStore.subscribe((state, previous) => {
  if (state.identities === previous.identities && state.loads === previous.loads) return;
  prune(state.loads !== previous.loads);
});
