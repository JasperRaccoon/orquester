import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Code2, Eye, File, Save } from "lucide-react";
import { Button } from "../../ui";
import { Editor } from "../Editor";
import { useFileText } from "../../../hooks";
import { useAppStore } from "../../../store/app";
import { renderMarkdownDocument } from "../../../lib/markdown-preview";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Markdown viewer with a Preview | Source toggle — the HtmlViewer pattern.
 * Preview renders the markdown (GFM) into a themed HTML document shown in a
 * fully-sandboxed iframe (empty `sandbox` => static markup + CSS only, zero JS,
 * so raw HTML embedded in the markdown is inert). Source is the CodeMirror
 * editor (editable + saveable). A search-result jump lands in Source, where
 * lines exist.
 */
export const MarkdownViewer: React.FC<{
  path: string;
  onBack: () => void;
  jumpToLine?: number;
  jumpToColumn?: number;
  jumpLength?: number;
  jumpNonce?: number;
}> = ({ path, onBack, jumpToLine, jumpToColumn, jumpLength, jumpNonce }) => {
  const name = baseName(path);
  const [view, setView] = useState<"preview" | "source">(jumpToLine != null ? "source" : "preview");
  const { content, setContent, original, truncated, state, saving, save } = useFileText(path);
  const readOnly = truncated;
  const dirty = !readOnly && content !== original;
  // The preview document carries its own colours, so it follows the resolved
  // mode (like the editor pane), not the scheme.
  const resolvedMode = useAppStore((s) => s.resolvedMode);

  // A fresh search-result click while sitting in Preview must land on the line.
  const lastJump = useRef(jumpNonce);
  useEffect(() => {
    if (jumpNonce !== lastJump.current) {
      lastJump.current = jumpNonce;
      if (jumpToLine != null) setView("source");
    }
  }, [jumpNonce, jumpToLine]);

  // blob: URL (not srcDoc) so the document has a real URL: TOC `#anchor` links
  // scroll in place instead of navigating the app origin (same as HtmlViewer).
  const previewHtml = useMemo(
    () => renderMarkdownDocument(content, name, resolvedMode),
    [content, name, resolvedMode]
  );
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (state !== "idle") {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([previewHtml], { type: "text/html" }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewHtml, state]);

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
        {state === "error" && <p className="p-3 text-xs text-danger">Could not read file.</p>}
        {state === "idle" && view === "preview" && blobUrl && (
          <iframe
            // Empty sandbox: no scripts, forms, popups, plugins, or same-origin
            // access — static markup/CSS only. src is a blob: URL (frame-src
            // 'self' blob: in the CSP) so links can't navigate to the app origin.
            sandbox=""
            src={blobUrl}
            title={`Preview of ${name}`}
            referrerPolicy="no-referrer"
            className={"h-full w-full border-0 " + (resolvedMode === "light" ? "bg-white" : "bg-neutral-900")}
          />
        )}
        {state === "idle" && view === "source" && (
          <Editor
            filename={name}
            value={content}
            readOnly={readOnly}
            jumpToLine={jumpToLine}
            jumpToColumn={jumpToColumn}
            jumpLength={jumpLength}
            jumpNonce={jumpNonce}
            onChange={setContent}
            onSave={() => void save()}
          />
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
