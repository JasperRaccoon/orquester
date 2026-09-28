/**
 * A code or shell block's log (spec §7.3): stdout / stderr, read window by
 * window (`GET …/nodes/:nodeId/log?stream=&offset=`) to its end and polled
 * while the block runs (only while on screen), ANSI stripped, the DOM capped
 * at `LOG_MAX_LINES` lines (the dropped count is said above the log) with the
 * whole log one "Download full log" away — which reads every window too.
 *
 * Auto-scroll sticks to the bottom until the user scrolls up; then a
 * "Jump to latest" pill brings them back. Every read resumes at the daemon's
 * own raw-file offset (`X-Log-Next-Offset`), so a dropped connection never
 * doubles or skips output; a non-2xx answer is an error, never log text.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Download, Loader2 } from "lucide-react";

import { cn } from "../../../lib/cn";
import { downloadBlob } from "../../../lib/files";
import {
  appendLog,
  droppedLinesText,
  EMPTY_LOG,
  formatBytes,
  logFileName,
  visibleLogLines,
  type LogBufferState
} from "./log-buffer";
import { readWholeLog, startLogFollower, type LogFollower } from "./log-follower";
import { errorText, FOCUS_RING, type RunsVariant, type WorkflowRunsApi } from "./shared";

/** Bytes per window when downloading the whole log (the daemon's maximum). */
const LOG_DOWNLOAD_WINDOW_BYTES = 4 * 1024 * 1024;

export type LogStream = "stdout" | "stderr";

/** A layout effect in the browser, a plain one in the static render checks (which run neither). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface LogViewerViewProps {
  lines: readonly string[];
  stream: LogStream;
  onStreamChange: (stream: LogStream) => void;
  /** Sizes per stream from the block's run state, when known. */
  sizes?: { stdoutBytes: number; stderrBytes: number };
  /** Following a running block. */
  following: boolean;
  /** The first bytes have not arrived yet. */
  loading: boolean;
  error: string | null;
  dropped: number;
  onDownload?: () => void;
  downloading?: boolean;
  variant?: RunsVariant;
  className?: string;
}

/** The viewer as a picture of its props (no stream) — what the container and the render checks draw. */
const LogViewerView: React.FC<LogViewerViewProps> = ({
  lines,
  stream,
  onStreamChange,
  sizes,
  following,
  loading,
  error,
  dropped,
  onDownload,
  downloading,
  variant = "docked",
  className
}) => {
  const sheet = variant === "sheet";
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Stick to the bottom while pinned; a new stream starts pinned.
  useIsomorphicLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned) element.scrollTop = element.scrollHeight;
  }, [lines, pinned]);
  useEffect(() => setPinned(true), [stream]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setPinned(atBottom);
  };

  const droppedText = droppedLinesText(dropped);
  const size = sizes ? (stream === "stdout" ? sizes.stdoutBytes : sizes.stderrBytes) : null;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/70",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        <div
          role="group"
          aria-label="Log stream"
          className="flex items-center gap-0.5 rounded-md bg-neutral-900/80 p-0.5 ring-1 ring-neutral-800"
        >
          {(["stdout", "stderr"] as const).map((option) => {
            const bytes = sizes ? (option === "stdout" ? sizes.stdoutBytes : sizes.stderrBytes) : null;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={stream === option}
                onClick={() => onStreamChange(option)}
                className={cn(
                  "rounded px-2.5 font-mono text-[11px] transition-colors",
                  FOCUS_RING,
                  sheet ? "h-10" : "h-6",
                  stream === option ? "bg-neutral-700/70 text-neutral-50" : "text-neutral-400 hover:text-neutral-200"
                )}
              >
                {option}
                {bytes !== null && bytes > 0 ? (
                  <span className="ml-1 text-neutral-500">{formatBytes(bytes)}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {following ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-info">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 rounded-full bg-info opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-info" />
            </span>
            Live
          </span>
        ) : null}
        <span className="flex-1" />
        {onDownload ? (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            title={
              size !== null && size > 0
                ? `Download the whole ${stream} (${formatBytes(size)})`
                : `Download the whole ${stream}`
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-60",
              FOCUS_RING,
              sheet ? "h-10" : "h-6"
            )}
          >
            {downloading ? (
              <Loader2 size={13} aria-hidden className="animate-spin" />
            ) : (
              <Download size={13} aria-hidden />
            )}
            Download full log
          </button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          role="log"
          aria-live={following ? "polite" : "off"}
          aria-label={`${stream} log`}
          className={cn("h-full overflow-auto px-3 py-2", sheet ? "min-h-[40vh]" : "min-h-40")}
        >
          {droppedText ? (
            <p className="mb-1.5 text-[11px] italic text-neutral-500">
              {droppedText}
              {onDownload ? " Download the full log to read them." : ""}
            </p>
          ) : null}
          {lines.length > 0 ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-neutral-200">
              {lines.join("\n")}
            </pre>
          ) : loading ? (
            <p className="flex items-center gap-1.5 text-xs text-neutral-500">
              <Loader2 size={12} aria-hidden className="animate-spin" />
              Reading the log…
            </p>
          ) : error ? null : (
            <p className="text-xs text-neutral-500">
              {following ? `Nothing on ${stream} yet.` : `Nothing was written to ${stream}.`}
            </p>
          )}
          {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : null}
        </div>
        {!pinned && lines.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              const element = scroller.current;
              if (element) element.scrollTop = element.scrollHeight;
              setPinned(true);
            }}
            className={cn(
              "absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900/95 px-3 text-xs text-neutral-200 shadow-lg shadow-black/30 backdrop-blur hover:bg-neutral-800",
              FOCUS_RING,
              sheet ? "h-10" : "h-7"
            )}
          >
            <ArrowDown size={13} aria-hidden />
            Jump to latest
          </button>
        ) : null}
      </div>
    </div>
  );
};

export interface LogViewerProps {
  api: WorkflowRunsApi;
  runId: string;
  nodeId: string;
  /** The block's name (the downloaded file is named after it). */
  blockName: string;
  /** Follow while the block runs; reading stops at the log's end once it does not. */
  live: boolean;
  /** The block's attempt: a retry writes a new log, read from its start. */
  attempt?: number;
  sizes?: { stdoutBytes: number; stderrBytes: number };
  /** Start on stderr (a failed block's first look), else stdout. */
  initialStream?: LogStream;
  variant?: RunsVariant;
  className?: string;
}

/** The viewer, reading: `LogViewerView` fed window by window (`startLogFollower`). */
export const LogViewer: React.FC<LogViewerProps> = ({
  api,
  runId,
  nodeId,
  blockName,
  live,
  attempt = 0,
  sizes,
  initialStream = "stdout",
  variant,
  className
}) => {
  const [stream, setStream] = useState<LogStream>(initialStream);
  const [buffer, setBuffer] = useState<LogBufferState>(EMPTY_LOG);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(live);
  const [downloading, setDownloading] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;
  const follower = useRef<LogFollower | null>(null);

  // One follower per (run, block, attempt, stream): a retry's new attempt is a new file.
  useEffect(() => {
    setBuffer(EMPTY_LOG);
    setLoading(true);
    setError(null);
    setFollowing(liveRef.current);
    const current = startLogFollower({
      read: (offset, signal) => api.readWorkflowNodeLogWindow(runId, nodeId, { stream, offset }, signal),
      live: () => liveRef.current,
      onText: (text) => {
        setLoading(false);
        setBuffer((previous) => appendLog(previous, text));
      },
      onState: (state) => {
        setLoading(state.loading);
        setFollowing(state.following);
        setError(state.error);
      },
      errorText: (reason) => errorText(reason, "The log could not be read.")
    });
    follower.current = current;
    return () => {
      current.stop();
      if (follower.current === current) follower.current = null;
    };
  }, [api, runId, nodeId, stream, attempt]);

  // The block (re)started while its reader had finished: read on from where it stopped.
  useEffect(() => {
    if (live) {
      setFollowing(true);
      follower.current?.wake();
    }
  }, [live]);

  const download = useCallback(() => {
    if (downloading) return;
    setDownloading(true);
    readWholeLog((offset) =>
      api.readWorkflowNodeLogWindow(runId, nodeId, { stream, offset, maxBytes: LOG_DOWNLOAD_WINDOW_BYTES })
    )
      .then((parts) => downloadBlob(logFileName(blockName, stream), new Blob(parts, { type: "text/plain;charset=utf-8" })))
      .catch((failure: unknown) => setError(errorText(failure, "The log could not be downloaded.")))
      .finally(() => setDownloading(false));
  }, [api, blockName, downloading, nodeId, runId, stream]);

  return (
    <LogViewerView
      lines={visibleLogLines(buffer)}
      stream={stream}
      onStreamChange={setStream}
      sizes={sizes}
      following={following}
      loading={loading}
      error={error}
      dropped={buffer.dropped}
      onDownload={download}
      downloading={downloading}
      variant={variant}
      className={className}
    />
  );
};
