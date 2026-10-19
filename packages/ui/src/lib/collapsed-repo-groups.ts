/**
 * Which repo groups of the sidebar are collapsed (spec 2026-10-18 §1): a
 * per-device viewing preference, global across workspaces, kept in
 * localStorage under `orquester:collapsed-repo-groups` as a JSON list of repo
 * keys. Validated on load — anything that is not a list of repo keys (a
 * payload from another bundle, a storage error) is dropped, so every group
 * starts expanded.
 */

import React from "react";

import { repoKeyProblem } from "@orquester/api";

const STORAGE_KEY = "orquester:collapsed-repo-groups";

/** A runaway list (keys of long-gone repos) stays bounded. */
const MAX_KEYS = 500;

const EMPTY: ReadonlySet<string> = new Set();

/** The stored value (the raw localStorage string) → the collapsed keys. */
export function parseCollapsedRepoGroups(raw: unknown): ReadonlySet<string> {
  if (typeof raw !== "string") return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(parsed)) return EMPTY;
  const keys = new Set<string>();
  for (const value of parsed) {
    if (keys.size >= MAX_KEYS) break;
    if (typeof value === "string" && repoKeyProblem(value) === null) keys.add(value);
  }
  return keys;
}

function load(): ReadonlySet<string> {
  try {
    return typeof localStorage === "undefined" ? EMPTY : parseCollapsedRepoGroups(localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

function save(keys: ReadonlySet<string>): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore quota/availability errors — the choice stays in memory only */
  }
}

let current: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function collapsedRepoGroups(): ReadonlySet<string> {
  if (current === null) current = load();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setRepoGroupCollapsed(repoKey: string, collapsed: boolean): void {
  const keys = collapsedRepoGroups();
  if (keys.has(repoKey) === collapsed) return;
  const next = new Set(keys);
  if (collapsed) next.add(repoKey);
  else next.delete(repoKey);
  current = next;
  save(next);
  for (const listener of [...listeners]) listener();
}

export function useCollapsedRepoGroups(): ReadonlySet<string> {
  return React.useSyncExternalStore(subscribe, collapsedRepoGroups, collapsedRepoGroups);
}
