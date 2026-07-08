import React, { useCallback } from "react";
import { ArrowLeft, Download, File, Save } from "lucide-react";
import { Button, IconButton } from "../ui";
import { Editor } from "./Editor";
import { ImageViewer } from "./viewers/ImageViewer";
import { BinaryCard } from "./viewers/BinaryCard";
import { MediaViewer } from "./viewers/MediaViewer";
import { ArchiveViewer } from "./viewers/ArchiveViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { HtmlViewer } from "./viewers/HtmlViewer";
import { useApi } from "../../context/orquester-context";
import { useFileText } from "../../hooks";
import { detectFileKind, PREVIEW_CAP_BY_KIND, DOWNLOAD_MAX_BYTES } from "../../lib/file-kind";
import { downloadPath } from "../../lib/download";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * File viewer dispatcher: classifies the selected file and mounts the right
 * viewer. Text stays in CodeMirror (editable + saveable); binary kinds render
 * from raw bytes (or a download card when over their size cap).
 */
export const FilePreview: React.FC<{
  path: string | null;
  size: number;
  onBack: () => void;
  /** 1-based line to jump to (text files only), e.g. from a search-result click. */
  jumpToLine?: number;
  /** Bumped on every search-result open so re-clicking the same line re-jumps. */
  jumpNonce?: number;
}> = ({ path, size, onBack, jumpToLine, jumpNonce }) => {
  const api = useApi();
  const fetchBytes = useCallback((p: string, signal?: AbortSignal) => api.readFileBytes(p, signal), [api]);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a file to view its contents
      </div>
    );
  }

  const name = baseName(path);
  const { kind, mime } = detectFileKind(name);

  // Text keeps its own header (Save button + dirty dot) — delegate wholesale.
  if (kind === "text") {
    return <TextPreview path={path} mime={mime} size={size} onBack={onBack} jumpToLine={jumpToLine} jumpNonce={jumpNonce} />;
  }

  // HTML renders in a sandboxed iframe with a Preview | Source toggle (text route).
  if (kind === "html") {
    return <HtmlViewer path={path} onBack={onBack} />;
  }

  const overCeiling = size > DOWNLOAD_MAX_BYTES;
  const overPreview = size > PREVIEW_CAP_BY_KIND[kind];

  let body: React.ReactNode;
  if (overCeiling) {
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable={false} title="Too large to preview" fetchBytes={fetchBytes} />
    );
  } else if (overPreview) {
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Too large to preview" fetchBytes={fetchBytes} />
    );
  } else if (kind === "image") {
    body = <ImageViewer path={path} mime={mime} fetchBytes={fetchBytes} />;
  } else if (kind === "audio" || kind === "video") {
    body = <MediaViewer path={path} mime={mime} kind={kind} fetchBytes={fetchBytes} />;
  } else if (kind === "archive") {
    body = <ArchiveViewer path={path} name={name} size={size} mime={mime} fetchBytes={fetchBytes} />;
  } else if (kind === "pdf") {
    body = <PdfViewer path={path} fetchBytes={fetchBytes} />;
  } else {
    body = (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Preview" fetchBytes={fetchBytes} />
    );
  }

  return (
    <>
      <PreviewHeader path={path} name={name} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </>
  );
};

/** Shared header for non-text viewers (filename + mobile back + download). */
const PreviewHeader: React.FC<{ path: string; name: string; onBack: () => void }> = ({ path, name, onBack }) => {
  const api = useApi();
  return (
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
      <div className="flex-1" />
      <IconButton label="Download" onClick={() => void downloadPath(api, { path, name, kind: "file" })}>
        <Download size={14} />
      </IconButton>
    </div>
  );
};

/** Text files: CodeMirror editor with save — plus a null-byte -> binary card
 *  guard so an unknown-extension binary never renders as mojibake. */
const TextPreview: React.FC<{ path: string; mime: string; size: number; onBack: () => void; jumpToLine?: number; jumpNonce?: number }> = ({ path, mime, size, onBack, jumpToLine, jumpNonce }) => {
  const api = useApi();
  const fetchBytes = useCallback((p: string, signal?: AbortSignal) => api.readFileBytes(p, signal), [api]);
  const { content, setContent, original, truncated, state, saving, save } = useFileText(path);

  const name = baseName(path);
  // Same NUL-byte guard the original viewer used to force read-only;
  // written via fromCharCode to keep the source copy-paste-safe (no literal NUL).
  const isBinary = content.includes(String.fromCharCode(0));
  const readOnly = truncated || isBinary;
  const dirty = !readOnly && content !== original;

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
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" title="Unsaved changes" />}
        {truncated && <span className="text-[10px] text-neutral-600">(truncated · read-only)</span>}
        <div className="flex-1" />
        <IconButton label="Download" onClick={() => void downloadPath(api, { path, name, kind: "file" })}>
          <Download size={14} />
        </IconButton>
        {!readOnly && state === "idle" && (
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state === "loading" && <p className="p-3 text-xs text-neutral-600">Loading…</p>}
        {state === "error" && <p className="p-3 text-xs text-red-400">Could not read file.</p>}
        {state === "idle" && isBinary && (
          <BinaryCard path={path} name={name} size={size} mime={mime} downloadable title="Binary file" fetchBytes={fetchBytes} />
        )}
        {state === "idle" && !isBinary && (
          <Editor filename={name} value={content} readOnly={readOnly} jumpToLine={jumpToLine} jumpNonce={jumpNonce} onChange={setContent} onSave={() => void save()} />
        )}
      </div>
    </>
  );
};
