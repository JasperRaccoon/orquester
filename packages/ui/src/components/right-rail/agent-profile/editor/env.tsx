/**
 * What every agent-profile editor reads from the one that opened it: the
 * agent, the client, phone or desktop, and the verbs that close it — so the
 * nine editors never thread them through props. `AgentProfileEditor`
 * provides it.
 */

import React, { createContext, useContext, useEffect, useState } from "react";

import type { AgentProfileAgentId, ProfileItemKind, ProfileMutationResponse } from "@orquester/api";

import type { ApiClient } from "../../../../lib/api-client";
import { isWide, type EditorVariant } from "./layout.logic";

export interface EditorEnv {
  agent: AgentProfileAgentId;
  api: ApiClient;
  variant: EditorVariant;
  /** The daemon connection is up; Save waits for it otherwise. */
  connected: boolean;
  /** Cancel, Escape, the backdrop: asks before discarding unsaved changes. */
  requestClose(): void;
  /** A save landed: tell the panel what changed, then close. */
  finish(response: ProfileMutationResponse): void;
  /** The open editor reports whether it holds unsaved changes. */
  setDirty(dirty: boolean): void;
  /**
   * A save is in flight (`useProfileSubmit`). Closing then asks nothing: the
   * changes are on their way, and the save reports to the panel's notice
   * whether it lands or not.
   */
  setSaving(saving: boolean): void;
  /** Turn a create editor into another kind's ("Add a marketplace" from the plugin installer). */
  switchKind(kind: ProfileItemKind): void;
}

export const EditorEnvContext = createContext<EditorEnv | null>(null);

export function useEditorEnv(): EditorEnv {
  const env = useContext(EditorEnvContext);
  if (env === null) throw new Error("An agent-profile editor must render inside EditorEnvContext");
  return env;
}

/** Finger-sized controls: the phone variant. */
export function useTouch(): boolean {
  return useEditorEnv().variant === "phone";
}

/** Report unsaved changes while mounted; an unmounted editor holds none. */
export function useReportDirty(dirty: boolean): void {
  const { setDirty } = useEditorEnv();
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
}

/** The editor's own width (a ResizeObserver), for layouts keyed on it rather than on the viewport. */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>, initial: number): number {
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.round(element.getBoundingClientRect().width) || initial);
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (next <= 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(next));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref, initial]);
  return width;
}

/** Wide enough for key | value side by side (measured by the shell). */
export const EditorWideContext = createContext(true);

export function useEditorWide(): boolean {
  return useContext(EditorWideContext);
}

export { isWide };
