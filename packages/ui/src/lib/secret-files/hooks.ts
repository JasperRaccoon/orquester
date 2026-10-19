/**
 * Secret files — the React side of `store.ts`.
 */

import { useSyncExternalStore } from "react";

import { SECRET_FILES_PLUGIN_ID, type SecretFilesClone, type SecretVaultDetail } from "@orquester/api";

import { isGlobalPluginEnabled } from "../plugins-state";
import { useAppStore } from "../../store/app";
import { secretFilesStore, vaultKey } from "./store";

const subscribe = (listener: () => void) => secretFilesStore.subscribe(listener);
const snapshot = () => secretFilesStore.getState().vaults;

/** Whether the "Secret files" plugin is on for this server (every entry point hides when it's off). */
export function useSecretFilesEnabled(): boolean {
  return useAppStore((s) => isGlobalPluginEnabled(s.plugins, SECRET_FILES_PLUGIN_ID));
}

/** Every known vault, vaultKey → detail. Stable between changes. */
export function useSecretVaults(): ReadonlyMap<string, SecretVaultDetail> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One repo's vault in one workspace; undefined when it has none. */
export function useSecretVault(workspace: string | undefined, repoKey: string | undefined): SecretVaultDetail | undefined {
  const vaults = useSecretVaults();
  return workspace && repoKey ? vaults.get(vaultKey(workspace, repoKey)) : undefined;
}

/** A project's place in a vault — the vault and its clone entry — or undefined when it's in none. */
export function useProjectSecretFiles(
  projectPath: string | undefined
): { vault: SecretVaultDetail; clone: SecretFilesClone } | undefined {
  const vaults = useSecretVaults();
  if (!projectPath) return undefined;
  for (const vault of vaults.values()) {
    const clone = vault.clones.find((entry) => entry.projectPath === projectPath);
    if (clone) return { vault, clone };
  }
  return undefined;
}
