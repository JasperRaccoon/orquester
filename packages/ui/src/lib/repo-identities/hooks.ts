/**
 * Repo identities — the React side of `store.ts`.
 */

import { useSyncExternalStore } from "react";

import type { RepoIdentity } from "@orquester/api";

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
