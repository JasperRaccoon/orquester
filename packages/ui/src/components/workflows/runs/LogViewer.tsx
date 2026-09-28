/**
 * A code or shell block's log (spec §7.3): stdout / stderr, followed live
 * while the block runs (`GET …/nodes/:nodeId/log?stream=&offset=&follow=1`,
 * chunked, open only while on screen), ANSI stripped, the DOM capped at
 * `LOG_MAX_LINES` lines with the whole log one "Download full log" away.
 *
 * Auto-scroll sticks to the bottom until the user scrolls up; then a
 * "Jump to latest" pill brings them back. A stream that ends while the block
 * still runs (a dropped connection) resumes from the bytes already shown.
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
import { errorText, FOCUS_RING, type RunsVariant, type WorkflowRunsApi } from "./shared";

export type LogStream = "stdout" | "stderr";

/** A layout effect in the browser, a plain one in the static render checks (which run neither). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface LogViewerViewProps {
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
export const LogViewerView: React.FC<LogViewerViewProps> = ({
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
  /** Follow while the block runs; the stream ends by itself when it stops. */
  live: boolean;
  sizes?: { stdoutBytes: number; stderrBytes: number };
  /** Start on stderr (a failed block's first look), else stdout. */
  initialStream?: LogStream;
  variant?: RunsVariant;
  className?: string;
}

const RESUME_DELAY_MS = 1_000;

/** The viewer, streaming: `LogViewerView` fed by `openWorkflowNodeLog`. */
export const LogViewer: React.FC<LogViewerProps> = ({
  api,
  runId,
  nodeId,
  blockName,
  live,
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
  const bytesRef = useRef(0);

  useEffect(() => {
    let closed = false;
    let handle: { close(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    bytesRef.current = 0;
    setBuffer(EMPTY_LOG);
    setLoading(true);
    setError(null);

    const open = (): void => {
      const follow = liveRef.current;
      setFollowing(follow);
      handle = api.openWorkflowNodeLog(
        runId,
        nodeId,
        { stream, offset: bytesRef.current, follow },
        {
          onData: (chunk) => {
            if (closed) return;
            setLoading(false);
            setBuffer((current) => {
              const next = appendLog(current, chunk);
              bytesRef.current = next.bytes;
              return next;
            });
          },
          onEnd: () => {
            if (closed) return;
            setLoading(false);
            handle = null;
            // A stream that ends while the block still runs dropped: resume where it stopped.
            if (follow && liveRef.current) {
              timer = setTimeout(() => {
                if (!closed) open();
              }, RESUME_DELAY_MS);
            } else {
              setFollowing(false);
            }
          },
          onError: (reason) => {
            if (closed) return;
            setLoading(false);
            handle = null;
            if (follow && liveRef.current) {
              timer = setTimeout(() => {
                if (!closed) open();
              }, RESUME_DELAY_MS * 3);
            } else {
              setFollowing(false);
              setError(errorText(reason, "The log could not be read."));
            }
          }
        }
      );
    };
    open();
    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      handle?.close();
    };
  }, [api, runId, nodeId, stream]);

  // The block stopped while its stream was open: the server ends the stream; nothing to do but reflect it.
  useEffect(() => {
    if (!live) setFollowing(false);
  }, [live]);

  const download = useCallback(() => {
    if (downloading) return;
    setDownloading(true);
    const parts: string[] = [];
    const finish = (failure?: unknown) => {
      setDownloading(false);
      if (failure !== undefined) {
        setError(errorText(failure, "The log could not be downloaded."));
        return;
      }
      downloadBlob(logFileName(blockName, stream), new Blob(parts, { type: "text/plain;charset=utf-8" }));
    };
    api.openWorkflowNodeLog(
      runId,
      nodeId,
      { stream, offset: 0, follow: false },
      {
        onData: (chunk) => parts.push(chunk),
        onEnd: () => finish(),
        onError: (reason) => finish(reason ?? new Error())
      }
    );
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
