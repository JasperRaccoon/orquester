import { useEffect, useRef, useState } from "react";
import { useApi } from "../context/orquester-context";

// A successful tree rename records oldPath → newPath here so an open editor
// "follows" its file instead of re-reading it — the bytes on disk are unchanged
// by a rename, and a reload would silently discard unsaved edits. Consumed (and
// cleared) by the hook instance that observes the matching path change.
const renameCarry = new Map<string, string>(); // newPath -> oldPath

export function noteFileRenamed(oldPath: string, newPath: string): void {
  renameCarry.set(newPath, oldPath);
}

export interface FileTextState {
  content: string;
  setContent: (value: string) => void;
  /** Last-saved content (for the dirty comparison). */
  original: string;
  /** True when the file exceeded the read cap and `content` is partial. */
  truncated: boolean;
  state: "idle" | "loading" | "error";
  saving: boolean;
  /** Persist the current content; no-op when unchanged. Updates `original` on success. */
  save: () => Promise<void>;
}

/**
 * Load a file's text via `/api/fs/read` (1 MB cap) and expose edit/save state.
 * Shared by the text editor and the HTML viewer's Source mode so the read/save
 * plumbing lives in one place.
 */
export function useFileText(path: string): FileTextState {
  const api = useApi();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);

  // Path whose content the buffer currently holds, for the rename carry-over.
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    // A pure rename of the loaded file: keep the buffer (and its dirty state)
    // instead of re-reading — the content on disk is identical.
    if (renameCarry.get(path) === loadedPathRef.current && loadedPathRef.current !== null) {
      renameCarry.delete(path);
      loadedPathRef.current = path;
      return;
    }
    let active = true;
    setState("loading");
    api
      .readFile(path)
      .then((res) => {
        if (!active) return;
        loadedPathRef.current = path;
        setContent(res.content);
        setOriginal(res.content);
        setTruncated(res.truncated);
        setState("idle");
      })
      .catch(() => active && setState("error"));
    return () => {
      active = false;
    };
  }, [api, path]);

  const save = async () => {
    if (saving || content === original) return;
    setSaving(true);
    try {
      await api.saveFile(path, content);
      setOriginal(content);
    } catch {
      /* surfaced as still-dirty */
    } finally {
      setSaving(false);
    }
  };

  return { content, setContent, original, truncated, state, saving, save };
}
