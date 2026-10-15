import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { ApiError } from "../../lib/api-client";
import { WhiteboardConflictError, isWhiteboardScene, whiteboardText } from "../../lib/whiteboard";
import type { WhiteboardSync } from "./ExcalidrawBoard";

// The editor (~330 KB gzip plus its CSS) loads with the first whiteboard tab,
// never with the app.
const ExcalidrawBoard = React.lazy(() => import("./ExcalidrawBoard"));

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; generation: number };

const errorText = (err: unknown): string => {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : String(err);
};

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

// Saves in flight and saves started, per file, across tabs and remounts. A read
// waits for the save in flight (a GET served before its rename would show the
// old scene), and a reload is dropped when a save started while it read.
const inflightSaves = new Map<string, Promise<void>>();
const savesStarted = new Map<string, number>();

/**
 * A whiteboard tab (the Excalidraw plugin): the `.excalidraw` file at `path`,
 * edited in Excalidraw in Orquester's light/dark mode and saved back to the
 * file. The file is the only copy: an empty file opens as an empty board, a
 * file that is not a scene is refused (saving would replace it). When the tab
 * comes back with nothing unsaved, a file changed meanwhile (an agent, git, the
 * file browser) is reloaded; a save over a file changed meanwhile is refused
 * until the user reloads or overwrites it.
 */
export const WhiteboardView: React.FC<{ path: string; title: string; active: boolean }> = ({ path, title, active }) => {
  const api = useApi();
  // Through a ref: a reconnect swaps the client, which must not reload the board.
  const apiRef = useRef(api);
  apiRef.current = api;
  const theme = useAppStore((s) => s.resolvedMode);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  // What the file holds as far as this tab knows, and whether the board has edits not in it.
  const sync = useRef<WhiteboardSync>({ text: null, dirty: false });
  const generation = useRef(0);

  /** Read the file; `reloadOnly` keeps the board as is when the file did not change. */
  const read = useCallback(
    async (reloadOnly: boolean, signal?: AbortSignal) => {
      try {
        await inflightSaves.get(path);
        const started = savesStarted.get(path) ?? 0;
        const text = whiteboardText(decode(await apiRef.current.readFileBytes(path, signal)));
        if (signal?.aborted) return;
        if (
          reloadOnly &&
          (sync.current.dirty || text === sync.current.text || (savesStarted.get(path) ?? 0) !== started)
        ) {
          return;
        }
        if (!isWhiteboardScene(text)) {
          if (!reloadOnly) setLoad({ status: "error", message: "This file is not an Excalidraw drawing." });
          return;
        }
        sync.current = { text, dirty: false };
        generation.current += 1;
        setLoad({ status: "ready", text, generation: generation.current });
      } catch (err) {
        if (signal?.aborted || reloadOnly) return;
        setLoad({ status: "error", message: errorText(err) });
      }
    },
    [path]
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    void read(false, controller.signal);
    return () => controller.abort();
  }, [read]);

  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && load.status === "ready") void read(true);
    wasActive.current = active;
  }, [active, load.status, read]);

  // Overwrite in place: the upload route writes a temp file and renames it over the
  // target. Unless `force`, only over the file this board last read or wrote.
  const save = useCallback(
    (text: string, force: boolean): Promise<void> => {
      const client = apiRef.current;
      const run = (async () => {
        if (!force && sync.current.text !== null) {
          const current = await client.readFileBytes(path).then(
            (bytes) => whiteboardText(decode(bytes)),
            (err: unknown) => {
              // Deleted meanwhile: the save puts it back.
              if (err instanceof ApiError && err.status === 404) return null;
              throw err;
            }
          );
          if (current !== null && current !== sync.current.text) throw new WhiteboardConflictError();
        }
        await client.uploadFsEntry(
          { destDir: dirOf(path), relativePath: nameOf(path), onConflict: "overwrite" },
          new Blob([text], { type: "application/json" })
        );
      })();
      savesStarted.set(path, (savesStarted.get(path) ?? 0) + 1);
      const settled = run.catch(() => undefined);
      inflightSaves.set(path, settled);
      void settled.then(() => {
        if (inflightSaves.get(path) === settled) inflightSaves.delete(path);
      });
      return run;
    },
    [path]
  );

  // Discard the board's edits for the file as it is now (the "changed on disk" choice).
  const reload = useCallback(() => {
    sync.current.dirty = false;
    void read(false);
  }, [read]);

  // A board closed with edits it could not save: the tab is gone, so say so here.
  const lostEdits = useCallback(
    (message: string) =>
      useAppStore.getState().setNotice({
        title: "Whiteboard",
        message: `Closed ${nameOf(path)} with changes that were not saved: ${message}`
      }),
    [path]
  );

  if (load.status === "loading") {
    return <Centered><Loader2 size={16} className="animate-spin" /> Opening whiteboard…</Centered>;
  }
  if (load.status === "error") {
    return (
      <Centered>
        <AlertTriangle size={16} className="text-warn" />
        <span className="max-w-md text-center">Could not open {nameOf(path)}: {load.message}</span>
        <Button size="sm" variant="outline" onClick={() => void read(false)}>
          <RefreshCw size={13} /> Retry
        </Button>
      </Centered>
    );
  }
  return (
    <div className="orq-whiteboard relative h-full w-full">
      <Suspense fallback={<Centered><Loader2 size={16} className="animate-spin" /> Loading Excalidraw…</Centered>}>
        <ExcalidrawBoard
          key={load.generation}
          initialText={load.text}
          name={title}
          theme={theme}
          active={active}
          sync={sync}
          onSave={save}
          onReload={reload}
          onLostEdits={lostEdits}
        />
      </Suspense>
    </div>
  );
};

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-sm text-neutral-400">
    {children}
  </div>
);
