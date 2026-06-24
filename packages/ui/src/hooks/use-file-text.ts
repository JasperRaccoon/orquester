import { useEffect, useState } from "react";
import { useApi } from "../context/orquester-context";

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

  useEffect(() => {
    let active = true;
    setState("loading");
    api
      .readFile(path)
      .then((res) => {
        if (!active) return;
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
