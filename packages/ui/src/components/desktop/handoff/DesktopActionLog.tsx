/**
 * The Activity popover's body (spec 2026-11-10 R2.4): the desktop's last 50 agent actions, newest
 * first, with time, actor and summary; failures in red; a screenshot row shows its thumbnail. It
 * mounts while the popover is open: it reloads the daemon's log and marks everything seen, and
 * live actions keep arriving through the store.
 */

import React from "react";
import { ImageOff, ListTree } from "lucide-react";

import type { DesktopActionEntry } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { loadDesktopActionLog, setDesktopActionsViewing } from "../../../lib/desktops/actions-store";
import { desktopActionLogRows, type DesktopActionLogRow } from "../../../lib/desktops/handoff.logic";
import { useAppStore } from "../../../store/app";

function Thumb({ desktopId, screenshotId }: { desktopId: string; screenshotId: string }) {
  const api = useAppStore((s) => s.api);
  const url = React.useMemo(() => api?.desktopScreenshotUrl(desktopId, screenshotId) ?? null, [api, desktopId, screenshotId]);
  const [failed, setFailed] = React.useState(false);
  if (!url) return null;
  if (failed) {
    return (
      <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-neutral-600">
        <ImageOff size={11} aria-hidden />
        Screenshot no longer kept
      </span>
    );
  }
  return (
    <img
      src={url}
      alt="Screenshot the agent took"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="mt-1 max-h-24 max-w-full rounded border border-neutral-800 bg-neutral-900 object-contain"
    />
  );
}

function Row({ row, desktopId }: { row: DesktopActionLogRow; desktopId: string }) {
  return (
    <li className="flex gap-2 px-3 py-1 text-[12px] leading-5" data-failed={row.failed || undefined}>
      <time dateTime={row.at} className="w-[52px] shrink-0 pt-px font-mono text-[10.5px] tabular-nums text-neutral-500">
        {row.time}
      </time>
      <span className="w-14 shrink-0 truncate text-[11px] text-warn" title={row.who}>
        {row.who}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", row.failed ? "text-danger" : "text-neutral-300")} title={row.text}>
          {row.text}
        </span>
        {row.failed ? (
          <span className="truncate text-[11px] text-danger/80" title={row.error ?? undefined}>
            {row.error}
          </span>
        ) : null}
        {row.screenshotId ? <Thumb desktopId={desktopId} screenshotId={row.screenshotId} /> : null}
      </span>
    </li>
  );
}

export function DesktopActionLogPanel({
  desktopId,
  entries,
  loaded
}: {
  desktopId: string;
  entries: readonly DesktopActionEntry[];
  loaded: boolean;
}): React.ReactElement {
  const api = useAppStore((s) => s.api);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDesktopActionsViewing(desktopId, true);
    if (api) {
      loadDesktopActionLog(api, desktopId, true).then(
        () => setError(null),
        () => setError("The desktop's activity could not be loaded.")
      );
    }
    return () => setDesktopActionsViewing(desktopId, false);
  }, [api, desktopId]);
  const rows = React.useMemo(() => desktopActionLogRows(entries), [entries]);
  return (
    <div className="flex flex-col" tabIndex={-1}>
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-1 text-[12px]">
        <ListTree size={13} aria-hidden className="text-neutral-500" />
        <span className="font-medium text-neutral-200">Agent activity</span>
        <span className="text-neutral-600">·</span>
        <span className="tabular-nums text-neutral-500">{rows.length === 1 ? "1 action" : `${rows.length} actions`}</span>
      </div>
      <div className="ac-scroll-thin max-h-[min(22rem,60vh)] overflow-y-auto border-t border-neutral-800/80 pb-1 pt-0.5">
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-neutral-500">
            {error ?? (loaded ? "Nothing yet. An agent's clicks, typing and screenshots on this desktop show here." : "Loading…")}
          </p>
        ) : (
          <ul aria-label="Agent actions, newest first">
            {rows.map((row) => (
              <Row key={row.id} row={row} desktopId={desktopId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
