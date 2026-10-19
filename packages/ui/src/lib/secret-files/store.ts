/**
 * Secret files — this client's copy of the daemon's vaults (`/api/secret-files`),
 * keyed by {@link vaultKey}(workspace, repoKey). Only states and names: the
 * daemon never sends secret content.
 *
 * One module-level store read by the repo-group menu/dialog, the project-row
 * badges, the repo-header counts and the project bar. Converges on the daemon
 * by a load per connection, the vault each mutation answers, and
 * `SECRET_FILES_CHANNEL` events routed here by the app store's `applyEvent`.
 * No React import (see `hooks.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  SECRET_FILES_CHANGED,
  type EventMessage,
  type SecretFilesCloneRequest,
  type SecretVaultDetail,
  type SecretVaultResponse,
  type SecretVaultsResponse
} from "@orquester/api";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface SecretFilesApi {
  readonly connection?: { readonly id: string };
  listSecretVaults(signal?: AbortSignal): Promise<SecretVaultsResponse>;
  getSecretVault(workspace: string, repoKey: string, signal?: AbortSignal): Promise<SecretVaultResponse>;
  pushSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse>;
  resetSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse>;
}

export interface SecretFilesState {
  /** vaultKey → detail. Repos without a vault are absent. */
  vaults: ReadonlyMap<string, SecretVaultDetail>;
}

export const secretFilesStore = createStore<SecretFilesState>(() => ({ vaults: new Map() }));

export function vaultKey(workspace: string, repoKey: string): string {
  return `${workspace}\u0000${repoKey}`;
}

export function getSecretVault(workspace: string, repoKey: string): SecretVaultDetail | undefined {
  return secretFilesStore.getState().vaults.get(vaultKey(workspace, repoKey));
}

/** Every vault's detail, replacing the map. */
export async function loadSecretVaults(api: SecretFilesApi, signal?: AbortSignal): Promise<void> {
  const { vaults } = await api.listSecretVaults(signal);
  const details = await Promise.all(
    vaults.map((summary) => api.getSecretVault(summary.workspace, summary.repoKey, signal).then((r) => r.vault))
  );
  secretFilesStore.setState({ vaults: new Map(details.map((vault) => [vaultKey(vault.workspace, vault.repoKey), vault])) });
}

/** Apply a vault a mutation answered or an event carried (`null`: deleted). */
export function applySecretVault(workspace: string, repoKey: string, vault: SecretVaultDetail | null): void {
  const next = new Map(secretFilesStore.getState().vaults);
  if (vault) next.set(vaultKey(workspace, repoKey), vault);
  else next.delete(vaultKey(workspace, repoKey));
  secretFilesStore.setState({ vaults: next });
}

/** One `SECRET_FILES_CHANNEL` event; a malformed payload is ignored. */
export function applySecretFilesEvent(event: EventMessage): void {
  if (event.type !== SECRET_FILES_CHANGED) return;
  const payload = event.payload as
    | { vault?: SecretVaultDetail; workspace?: unknown; repoKey?: unknown; deleted?: unknown }
    | null;
  if (payload?.vault && typeof payload.vault.workspace === "string" && typeof payload.vault.repoKey === "string") {
    applySecretVault(payload.vault.workspace, payload.vault.repoKey, payload.vault);
  } else if (payload && typeof payload.workspace === "string" && typeof payload.repoKey === "string" && payload.deleted === true) {
    applySecretVault(payload.workspace, payload.repoKey, null);
  }
}

/** A connection switch. */
export function resetSecretFiles(): void {
  secretFilesStore.setState({ vaults: new Map() });
}

export async function pushSecretFiles(api: SecretFilesApi, req: SecretFilesCloneRequest): Promise<SecretVaultDetail> {
  const { vault } = await api.pushSecretFiles(req);
  applySecretVault(req.workspace, req.repoKey, vault);
  return vault;
}

export async function resetCloneSecretFiles(api: SecretFilesApi, req: SecretFilesCloneRequest): Promise<SecretVaultDetail> {
  const { vault } = await api.resetSecretFiles(req);
  applySecretVault(req.workspace, req.repoKey, vault);
  return vault;
}
