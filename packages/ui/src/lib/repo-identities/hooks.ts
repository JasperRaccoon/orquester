/**
 * Repo identities — the React side of `store.ts` and `icon-images.ts`.
 */

import { useEffect, useSyncExternalStore } from "react";

import type { RepoIcon, RepoIdentity } from "@orquester/api";

import { useAppStore } from "../../store/app";
import { ensureRepoIconImage, repoIconImagesStore, type RepoIconImage } from "./icon-images";
import { repoIdentitiesStore } from "./store";

const subscribe = (listener: () => void) => repoIdentitiesStore.subscribe(listener);
const snapshot = () => repoIdentitiesStore.getState().identities;

/** Every known identity, repoKey → identity. Stable between changes. */
export function useRepoIdentities(): ReadonlyMap<string, RepoIdentity> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRepoIdentity(repoKey: string | undefined): RepoIdentity | undefined {
  const identities = useRepoIdentities();
  return repoKey ? identities.get(repoKey) : undefined;
}

const subscribeImages = (listener: () => void) => repoIconImagesStore.subscribe(listener);
const imagesSnapshot = () => repoIconImagesStore.getState().images;

/**
 * The shared image of `repoKey`'s image icon (fetched once per version, through
 * the authenticated client): `undefined` until a fetch starts, or when the icon
 * is not an image. Only ever show its `url` through `<img src>`.
 */
export function useRepoIconImage(repoKey: string | undefined, icon: RepoIcon | undefined): RepoIconImage | undefined {
  // The active connection's client (the one the identities were loaded through);
  // null before one exists, when nothing is fetched — so an icon renders anywhere.
  const api = useAppStore((state) => state.api);
  const images = useSyncExternalStore(subscribeImages, imagesSnapshot, imagesSnapshot);
  const version = icon?.kind === "image" ? icon.version : null;
  const held = repoKey ? images.get(repoKey) : undefined;
  const image = held !== undefined && held.version === version ? held : undefined;
  // Re-run when the entry goes away too: a reconnect's load clears failed ones to retry.
  const present = image !== undefined;
  useEffect(() => {
    if (api && repoKey && !present) void ensureRepoIconImage(api, repoKey, icon);
    // `icon` is read through `version` (its identity changes on every identity update).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, repoKey, version, present]);
  return image;
}
