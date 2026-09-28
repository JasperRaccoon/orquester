/**
 * A markdown body or instruction file in the file editor's CodeMirror
 * (`files/Editor.tsx`: markdown highlighting, soft wrap, oneDark on dark and
 * the light chrome on light). It fills the height its parent gives it, with a
 * floor, and Ctrl/Cmd+S saves.
 *
 * CodeMirror needs a DOM: before the first effect (a static render, the first
 * frame) a plain box of the same size stands in.
 */

import React, { useEffect, useState } from "react";

import { cn } from "../../../../lib/cn";
import { Editor } from "../../../files/Editor";
import { useTouch } from "./env";

export const CodeArea: React.FC<{
  id: string;
  /** The editor's accessible name ("SKILL.md body"). */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  /** A floor in px; the editor otherwise takes the height left. */
  minHeight?: number;
  invalid?: boolean;
  describedBy?: string;
  /** Shown in the stand-in while the text is empty. */
  placeholder?: string;
}> = ({ id, label, value, onChange, onSave, minHeight = 220, invalid = false, describedBy, placeholder }) => {
  const touch = useTouch();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      data-code-area=""
      className={cn(
        "relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border bg-neutral-900",
        "focus-within:ring-2 focus-within:ring-neutral-500",
        invalid ? "border-danger-500/70" : "border-neutral-700",
        // 16 px on a phone: iOS zooms into anything smaller when it takes focus.
        touch && "[&_.cm-editor]:text-base [&_.cm-line]:leading-6"
      )}
      style={{ minHeight }}
    >
      {mounted ? (
        <div className="absolute inset-0">
          <Editor filename="SKILL.md" value={value} onChange={onChange} onSave={onSave} />
        </div>
      ) : (
        <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[13px] text-neutral-400">
          {value || placeholder || ""}
        </pre>
      )}
    </div>
  );
};
