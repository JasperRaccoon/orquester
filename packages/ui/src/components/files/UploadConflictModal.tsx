import React, { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";
import { Button, Modal } from "../ui";
import type { ConflictChoice, ConflictPrompt } from "./use-file-upload";

/**
 * Per-conflict upload prompt: shows the existing target's relative path and
 * offers Replace / Skip / Keep both. "Apply to all remaining" reuses the choice
 * for the rest of this upload. When a DIRECTORY already occupies the path,
 * Replace is hidden — replacing a subtree with a file would delete it.
 */
export const UploadConflictModal: React.FC<{ prompt: ConflictPrompt | null }> = ({ prompt }) => {
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (prompt) {
      setAll(false);
    }
  }, [prompt]);

  if (!prompt) {
    return null;
  }
  const isDir = prompt.kind === "dir";
  const choose = (choice: ConflictChoice) => prompt.resolve(choice, all);

  // Dismiss (Esc / backdrop) skips ONLY the current conflict — never the whole
  // batch — by ignoring the "apply to all" checkbox, so an incidental dismiss
  // gesture can't silently skip every remaining conflict.
  return (
    <Modal open onClose={() => prompt.resolve("skip", false)} className="max-w-md">
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
            <FileWarning size={16} />
          </span>
          <p className="text-sm font-medium text-neutral-100">
            {isDir ? "A folder already exists here" : "This file already exists"}
          </p>
        </div>

        <p className="break-all text-sm text-neutral-400">
          <code className="text-neutral-300">{prompt.relativePath}</code>
          {isDir && " is a folder in the project — it can't be replaced by a file."}
        </p>

        {prompt.remaining > 0 && (
          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Apply to all {prompt.remaining} remaining conflict(s)
          </label>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button variant="outline" size="sm" onClick={() => choose("keepBoth")}>
            Keep both
          </Button>
          {!isDir && (
            <Button
              size="sm"
              onClick={() => choose("replace")}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              Replace
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
