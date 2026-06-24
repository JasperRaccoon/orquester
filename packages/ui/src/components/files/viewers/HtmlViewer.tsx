import React, { useMemo, useState } from "react";
import { ArrowLeft, Code2, Eye, File, Save } from "lucide-react";
import { Button } from "../../ui";
import { Editor } from "../Editor";
import { useFileText } from "../../../hooks";
import { buildHtmlSrcdoc } from "../../../lib/html-preview";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * HTML viewer with a Preview | Source toggle. Preview renders the file in a
 * fully-sandboxed iframe (empty `sandbox` => no scripts/forms/popups/plugins/
 * same-origin => static markup + CSS only, zero JS execution). Source is the
 * CodeMirror editor (editable + saveable). Content loads as text via
 * /api/fs/read (1 MB cap); a truncated file previews partially and is read-only.
 */
export const HtmlViewer: React.FC<{ path: string; onBack: () => void }> = ({ path, onBack }) => {
  const name = baseName(path);
  const [view, setView] = useState<"preview" | "source">("preview");
  const { content, setContent, original, truncated, state, saving, save } = useFileText(path);
  const readOnly = truncated;
  const dirty = !readOnly && content !== original;
  // Rewrite self-anchors + inject <base> so in-page links scroll instead of
  // navigating the iframe to the app origin (which frame-ancestors blocks).
  const previewHtml = useMemo(() => buildHtmlSrcdoc(content, name), [content, name]);

  return (
    <>
      <div className="flex h-9 items-center gap-2 border-b border-neutral-800 px-2">
        <button
          type="button"
          aria-label="Back to files"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 md:hidden"
        >
          <ArrowLeft size={15} />
        </button>
        <File size={13} className="text-neutral-500" />
        <span className="truncate text-xs text-neutral-300">{name}</span>
        {view === "source" && dirty && (
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" title="Unsaved changes" />
        )}
        {truncated && <span className="text-[10px] text-neutral-600">(truncated)</span>}
        <div className="flex-1" />
        {view === "source" && state === "idle" && !readOnly && (
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        <div className="flex items-center overflow-hidden rounded-md border border-neutral-700">
          <ToggleButton active={view === "preview"} label="Preview" onClick={() => setView("preview")}>
            <Eye size={13} />
          </ToggleButton>
          <ToggleButton active={view === "source"} label="Source" onClick={() => setView("source")}>
            <Code2 size={13} />
          </ToggleButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state === "loading" && <p className="p-3 text-xs text-neutral-600">Loading…</p>}
        {state === "error" && <p className="p-3 text-xs text-red-400">Could not read file.</p>}
        {state === "idle" && view === "preview" && (
          <iframe
            // Empty sandbox: no scripts, forms, popups, plugins, or same-origin
            // access — the HTML renders as static markup/CSS only.
            sandbox=""
            srcDoc={previewHtml}
            title={`Preview of ${name}`}
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
          />
        )}
        {state === "idle" && view === "source" && (
          <Editor filename={name} value={content} readOnly={readOnly} onChange={setContent} onSave={() => void save()} />
        )}
      </div>
    </>
  );
};

const ToggleButton: React.FC<{
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, label, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className={
      "flex h-7 items-center gap-1 px-2 text-[11px] transition-colors " +
      (active ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900")
    }
  >
    {children}
    {label}
  </button>
);
