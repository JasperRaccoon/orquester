// The Excalidraw editor of a whiteboard tab. Loaded lazily by WhiteboardView:
// everything that imports @excalidraw/excalidraw lives in this module.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, hashElementsVersion, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { EXCALIDRAW_ASSETS_DIR, WhiteboardConflictError } from "../../lib/whiteboard";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// Fonts come from the app's own build (the Vite plugin copies them to
// `excalidraw/fonts/`), never from Excalidraw's CDN, which the CSP blocks and
// an offline host cannot reach. Absolute, because Excalidraw resolves a
// relative path against `location.origin`, which is "null" in the desktop
// app's file:// window. Set before the first render: the font registry reads it then.
window.EXCALIDRAW_ASSET_PATH = new URL(`${EXCALIDRAW_ASSETS_DIR}/`, document.baseURI).href;

const SAVE_DEBOUNCE_MS = 1000;

/** Shared with WhiteboardView: the file's text as last read or saved, and whether the board has edits not in it. */
export interface WhiteboardSync {
  text: string | null;
  dirty: boolean;
}

type ElementsArg = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>["onChange"]>>[0];

interface Scene {
  elements: ElementsArg;
  appState: AppState;
  files: BinaryFiles;
}

type SaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "failed"; message: string }
  /** The file changed elsewhere since this board read or wrote it: nothing is saved until the user picks. */
  | { state: "conflict" };

/** What a change must touch to be saved: the drawing, plus the canvas settings the file keeps. */
const sceneSignature = (elements: ElementsArg, appState: AppState): string =>
  `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${appState.gridModeEnabled}`;

const ExcalidrawBoard: React.FC<{
  initialText: string;
  name: string;
  theme: "light" | "dark";
  active: boolean;
  sync: React.MutableRefObject<WhiteboardSync>;
  /** Write `text`; unless `force`, refused with a `WhiteboardConflictError` when the file changed meanwhile. */
  onSave: (text: string, force: boolean) => Promise<void>;
  /** Drop this board's edits and load the file as it is now. */
  onReload: () => void;
  /** This board was closed and its last save failed. */
  onLostEdits: (message: string) => void;
}> = ({ initialText, name, theme, active, sync, onSave, onReload, onLostEdits }) => {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });
  const latest = useRef<Scene | null>(null);
  // The signature of the scene as loaded; the first onChange (Excalidraw's own,
  // on mount) sets it, so opening a file never rewrites it.
  const baseline = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  // While set, edits wait for the user's pick instead of re-checking the file every second.
  const conflicted = useRef(false);
  const mounted = useRef(true);

  const initialData = useMemo<Promise<ExcalidrawInitialDataState>>(
    () =>
      loadFromBlob(new Blob([initialText], { type: "application/json" }), null, null).then((scene) => ({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files,
        scrollToContent: true
      })),
    [initialText]
  );

  const flush = useCallback(async (force = false): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // One save at a time; a change made during it is saved after it.
    while (saving.current) await saving.current;
    const scene = latest.current;
    if (!sync.current.dirty || !scene || (conflicted.current && !force)) return;
    const text = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
    sync.current.dirty = false;
    if (text === sync.current.text) return;
    if (mounted.current) setStatus({ state: "saving" });
    const run = onSave(text, force).then(
      () => {
        sync.current.text = text;
        conflicted.current = false;
        if (mounted.current) setStatus({ state: "idle" });
      },
      (err: unknown) => {
        sync.current.dirty = true;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof WhiteboardConflictError) conflicted.current = true;
        if (!mounted.current) {
          onLostEdits(message);
        } else {
          setStatus(err instanceof WhiteboardConflictError ? { state: "conflict" } : { state: "failed", message });
        }
      }
    );
    saving.current = run;
    try {
      await run;
    } finally {
      saving.current = null;
    }
  }, [onLostEdits, onSave, sync]);

  const onChange = useCallback(
    (elements: ElementsArg, appState: AppState, files: BinaryFiles) => {
      // Still reading `initialData`: the scene on screen is not the file's yet.
      if (appState.isLoading) return;
      latest.current = { elements, appState, files };
      const signature = sceneSignature(elements, appState);
      if (baseline.current === null) {
        baseline.current = signature;
        return;
      }
      if (signature === baseline.current) return;
      baseline.current = signature;
      sync.current.dirty = true;
      if (conflicted.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush, sync]
  );

  // Leaving the tab saves at once; coming back re-measures the canvas, which
  // was laid out at 0×0 while the tab was hidden.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) void flush();
    if (!wasActive.current && active) api?.refresh();
    wasActive.current = active;
  }, [active, api, flush]);

  // Closing the tab (or a reload of the file replacing this board) saves what is pending.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flushRef.current();
    };
  }, []);

  const renderTopRightUI = useCallback(() => {
    if (status.state === "saving") {
      return <span className="orq-whiteboard-status">Saving…</span>;
    }
    if (status.state === "failed") {
      return (
        <button
          type="button"
          className="orq-whiteboard-status orq-whiteboard-status--failed"
          title={status.message}
          onClick={() => {
            sync.current.dirty = true;
            void flush();
          }}
        >
          Not saved — retry
        </button>
      );
    }
    if (status.state === "conflict") {
      return (
        <span className="orq-whiteboard-status orq-whiteboard-status--failed">
          Changed on disk:
          <button type="button" className="orq-whiteboard-status-action" onClick={onReload}>
            Reload
          </button>
          <button type="button" className="orq-whiteboard-status-action" onClick={() => void flush(true)}>
            Overwrite
          </button>
        </span>
      );
    }
    return null;
  }, [flush, onReload, status, sync]);

  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={initialData}
      onChange={onChange}
      name={name}
      theme={theme}
      aiEnabled={false}
      renderTopRightUI={renderTopRightUI}
      UIOptions={{
        canvasActions: {
          // The tab owns the file: no opening another scene over it, no
          // "save to file" beside the auto-save. Export and image export stay.
          loadScene: false,
          saveToActiveFile: false
        }
      }}
    />
  );
};

export default ExcalidrawBoard;
