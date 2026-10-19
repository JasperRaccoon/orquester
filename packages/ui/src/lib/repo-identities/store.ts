/**
 * Repo identities — this client's copy of the daemon's per-repo icon + label
 * (`/api/repo-identities`), keyed by `ProjectSummary.repoKey`.
 *
 * One module-level store: every repo group header, agent card and dialog reads
 * the same map. It converges on the daemon by a full load per connection, the
 * record each mutation answers, and `REPO_IDENTITIES_CHANNEL` events routed
 * here by the app store's `applyEvent`. No React import (see `hooks.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  REPO_IDENTITY_CHANGED,
  type EventMessage,
  type FetchRepoFaviconRequest,
  type RepoIconUploadType,
  type RepoIdentitiesResponse,
  type RepoIdentity,
  type RepoIdentityResponse,
  type SetRepoEmojiRequest,
  type SetRepoLabelRequest
} from "@orquester/api";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface RepoIdentitiesApi {
  readonly connection?: { readonly id: string };
  listRepoIdentities(signal?: AbortSignal): Promise<RepoIdentitiesResponse>;
  setRepoLabel(req: SetRepoLabelRequest): Promise<RepoIdentityResponse>;
  setRepoEmoji(req: SetRepoEmojiRequest): Promise<RepoIdentityResponse>;
  uploadRepoIcon(repoKey: string, contentType: RepoIconUploadType, data: Blob): Promise<RepoIdentityResponse>;
  clearRepoIcon(repoKey: string): Promise<RepoIdentityResponse>;
  fetchRepoFavicon(req: FetchRepoFaviconRequest): Promise<RepoIdentityResponse>;
  readRepoIcon(repoKey: string, version: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

export interface RepoIdentitiesState {
  /** repoKey → identity. Repos with no identity are absent. */
  identities: ReadonlyMap<string, RepoIdentity>;
}

export const repoIdentitiesStore = createStore<RepoIdentitiesState>(() => ({ identities: new Map() }));

export function getRepoIdentity(repoKey: string | undefined): RepoIdentity | undefined {
  return repoKey ? repoIdentitiesStore.getState().identities.get(repoKey) : undefined;
}

/** The label a repo shows: its custom label, else `fallback` (the remote's `owner/repo`). */
export function repoLabelOf(
  identities: ReadonlyMap<string, RepoIdentity>,
  repoKey: string,
  fallback: string
): string {
  return identities.get(repoKey)?.label ?? fallback;
}

/** Replace the whole map with the daemon's list. */
export async function loadRepoIdentities(api: RepoIdentitiesApi, signal?: AbortSignal): Promise<void> {
  const { identities } = await api.listRepoIdentities(signal);
  repoIdentitiesStore.setState({ identities: new Map(identities.map((identity) => [identity.repoKey, identity])) });
}

/** Apply the identity a mutation answered (`null`: the repo has none left). */
export function applyRepoIdentity(repoKey: string, identity: RepoIdentity | null): void {
  const next = new Map(repoIdentitiesStore.getState().identities);
  if (identity) next.set(repoKey, identity);
  else next.delete(repoKey);
  repoIdentitiesStore.setState({ identities: next });
}

/** One `REPO_IDENTITIES_CHANNEL` event; a malformed payload is ignored. */
export function applyRepoIdentityEvent(event: EventMessage): void {
  if (event.type !== REPO_IDENTITY_CHANGED) return;
  const payload = event.payload as { identity?: RepoIdentity; repoKey?: unknown; deleted?: unknown } | null;
  if (payload?.identity && typeof payload.identity.repoKey === "string") {
    applyRepoIdentity(payload.identity.repoKey, payload.identity);
  } else if (payload && typeof payload.repoKey === "string" && payload.deleted === true) {
    applyRepoIdentity(payload.repoKey, null);
  }
}

/** A connection switch or sign-out. */
export function resetRepoIdentities(): void {
  repoIdentitiesStore.setState({ identities: new Map() });
}

export async function setRepoLabel(api: RepoIdentitiesApi, repoKey: string, label: string | null): Promise<void> {
  const { identity } = await api.setRepoLabel({ repoKey, label });
  applyRepoIdentity(repoKey, identity);
}
