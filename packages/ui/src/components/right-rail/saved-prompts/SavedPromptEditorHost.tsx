import React, { useEffect, useRef, useState } from "react";

import { subscribeSavedPromptEditor, type SavedPromptEditorRequest } from "./editor-bridge";
import { SavedPromptEditor } from "./SavedPromptEditor";

/**
 * The one saved-prompt editor, mounted once by the rail: it listens on
 * `editor-bridge.ts` and opens for whichever panel asked — the Saved prompts
 * panel's "New prompt", "Edit" and "Duplicate", History's "Save as prompt".
 *
 * A request while the editor is open replaces it; each opening is a fresh
 * editor (its own draft), keyed so a late close of the previous one cannot
 * close the next.
 */
export const SavedPromptEditorHost: React.FC = () => {
  const [open, setOpen] = useState<{ key: number; request: SavedPromptEditorRequest } | null>(null);
  const seq = useRef(0);

  useEffect(
    () =>
      subscribeSavedPromptEditor((request) => {
        seq.current += 1;
        setOpen({ key: seq.current, request });
      }),
    []
  );

  if (open === null) return null;
  const { key } = open;
  return (
    <SavedPromptEditor
      key={key}
      request={open.request}
      onClose={() => setOpen((current) => (current?.key === key ? null : current))}
    />
  );
};
