/**
 * Which panel the desktop sidebar shows, picked on its activity bar: the
 * projects tree, the workflows panel or the agent profile. A per-device
 * viewing preference, so it lives in localStorage under
 * `orquester:sidebar-view` as the bare id, validated on load: anything else
 * (a payload from another bundle, a storage error) is the projects tree.
 */

import React from "react";

export type SidebarView = "projects" | "workflows" | "profile";

const STORAGE_KEY = "orquester:sidebar-view";

export function parseSidebarView(raw: unknown): SidebarView {
  return raw === "workflows" || raw === "profile" ? raw : "projects";
}

function loadSidebarView(): SidebarView {
  try {
    return typeof localStorage === "undefined" ? "projects" : parseSidebarView(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "projects";
  }
}

function saveSidebarView(view: SidebarView): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, view);
  } catch {
    /* ignore quota/availability errors — the choice stays in memory only */
  }
}

let current: SidebarView | null = null;
const listeners = new Set<() => void>();

function sidebarView(): SidebarView {
  if (current === null) current = loadSidebarView();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSidebarView(view: SidebarView): void {
  if (sidebarView() === view) return;
  current = view;
  saveSidebarView(view);
  for (const listener of [...listeners]) listener();
}

export function useSidebarView(): SidebarView {
  return React.useSyncExternalStore(subscribe, sidebarView, sidebarView);
}
