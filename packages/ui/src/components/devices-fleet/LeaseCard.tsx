/**
 * One leased device in the fleet grid: its ~1 fps thumbnail (polled only while the card is on
 * screen), name and model glyph, platform, the chat that holds it (a link: the chat opens with
 * its Device panel on this lease), agent, who drives it, the last action, uptime and its share
 * of the host's cost. A row on a phone (thumbnail left), a tile in the desktop grid.
 */

import React from "react";
import { AlertTriangle, ArrowUpRight, Bot, Clock, Hand, ImageOff, Loader2, MessageSquare } from "lucide-react";

import type { DeviceActionEntry, DeviceHostSummary, DeviceLeaseSummary } from "@orquester/api";

import { formatHourlyRate, formatUsd } from "../../lib/boxes/format";
import { cn } from "../../lib/cn";
import { openLeaseInChat } from "./actions";
import {
  formatAgo,
  formatUptime,
  leaseCostShare,
  leaseFormFactor,
  leaseStateNote,
  msSince,
  thumbnailAspect,
  type ChatRef
} from "./fleet.logic";
import { DeviceGlyph, StatusPill, TONE_TEXT, platformText } from "./parts";
import { useDeviceThumbnail, type DeviceThumbnailRequest } from "./use-device-thumbnail";
import type { ThumbnailDeps } from "./thumbnail-poller";

export interface LeaseCardProps {
  lease: DeviceLeaseSummary;
  host: DeviceHostSummary | null;
  /** How many leases share the host's cost now. */
  sharers: number;
  chat: ChatRef;
  lastAction: DeviceActionEntry | null;
  /** The thumbnail's URL and auth headers, or null (nothing to show, or a transport without them). */
  thumbnail: DeviceThumbnailRequest | null;
  /** Why there is no thumbnail URL although the lease is live (a unix-socket connection). */
  thumbnailUnavailable?: string | null;
  now: number;
  /** The card came on screen: load its action log once. */
  onVisible?: (leaseId: string) => void;
  /** Tests and the dev harness: the poller's clock and fetch. */
  thumbnailDeps?: ThumbnailDeps;
}

const Thumbnail: React.FC<{
  lease: DeviceLeaseSummary;
  request: DeviceThumbnailRequest | null;
  unavailable: string | null;
  container: Element | null;
  onVisible?: (leaseId: string) => void;
  deps?: ThumbnailDeps;
}> = ({ lease, request, unavailable, container, onVisible, deps }) => {
  const thumb = useDeviceThumbnail(request, container, deps);
  const url = request?.url ?? null;
  const note = leaseStateNote(lease);
  const formFactor = leaseFormFactor(lease);
  const visibleRef = React.useRef(false);
  React.useEffect(() => {
    if (thumb.onScreen && !visibleRef.current) {
      visibleRef.current = true;
      onVisible?.(lease.id);
    }
  }, [thumb.onScreen, onVisible, lease.id]);

  const live = note === null;
  return (
    <div
      className="relative flex h-full max-w-full items-center justify-center overflow-hidden rounded-[10px] bg-neutral-900 ring-1 ring-inset ring-neutral-800"
      style={{ aspectRatio: String(thumbnailAspect(lease)) }}
      data-thumbnail-status={thumb.status}
    >
      {thumb.src ? (
        <img
          src={thumb.src}
          alt={`${lease.name || "Device"} screen`}
          draggable={false}
          className={cn("h-full w-full object-contain transition-opacity", (!live || thumb.status === "paused" || thumb.status === "error") && "opacity-50")}
        />
      ) : (
        <div className="flex flex-col items-center gap-1.5 px-2 text-center text-neutral-600">
          {live && (thumb.status === "loading" || thumb.status === "off") && url ? (
            <Loader2 size={16} aria-hidden className="animate-spin" />
          ) : live && (unavailable || thumb.status === "error") ? (
            <ImageOff size={16} aria-hidden />
          ) : (
            <DeviceGlyph platform={lease.platform} formFactor={formFactor} size={22} />
          )}
          {live && unavailable ? <span className="text-[10px] leading-tight">{unavailable}</span> : null}
        </div>
      )}
      {note ? (
        <div className="absolute inset-x-1.5 bottom-1.5 flex justify-center">
          <span className={cn("line-clamp-2 max-w-full rounded-md bg-neutral-950/85 px-1.5 py-0.5 text-center text-[10px] font-medium leading-tight", TONE_TEXT[note.tone])} title={note.label}>
            {lease.state === "starting" ? <Loader2 size={9} aria-hidden className="mr-1 inline animate-spin align-[-1px]" /> : null}
            {note.label}
          </span>
        </div>
      ) : thumb.status === "error" && thumb.error ? (
        <div className="absolute inset-x-1.5 bottom-1.5 flex justify-center">
          <span className="max-w-full truncate rounded-md bg-neutral-950/85 px-1.5 py-0.5 text-[10px] text-warn" title={thumb.error}>
            {thumb.error}
          </span>
        </div>
      ) : thumb.status === "live" ? (
        <span aria-label="Live thumbnail" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_0_2px_rgb(var(--n-950)/0.8)]" />
      ) : null}
    </div>
  );
};

export const LeaseCard: React.FC<LeaseCardProps> = ({ lease, host, sharers, chat, lastAction, thumbnail, thumbnailUnavailable = null, now, onVisible, thumbnailDeps }) => {
  const [element, setElement] = React.useState<HTMLLIElement | null>(null);
  const cost = leaseCostShare(lease, host, sharers, now);
  const name = lease.name || lease.profile || "Device";
  const open = chat.known ? () => openLeaseInChat(lease) : undefined;
  const userDrives = lease.controller === "user";

  return (
    <li
      ref={setElement}
      data-lease-id={lease.id}
      className={cn(
        "group flex min-w-0 flex-row overflow-hidden rounded-xl border bg-neutral-900/40 transition-colors md:flex-col",
        lease.state === "lost" ? "border-danger/30" : "border-neutral-800 hover:border-neutral-700"
      )}
    >
      <button
        type="button"
        onClick={open}
        disabled={!open}
        aria-label={open ? `Show ${name} in “${chat.title}”` : `${name} (its chat is not open)`}
        className={cn(
          "flex h-40 w-28 shrink-0 items-center justify-center bg-neutral-950/60 p-2 md:h-56 md:w-full md:p-3",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
          open ? "cursor-pointer" : "cursor-default"
        )}
      >
        <Thumbnail lease={lease} request={thumbnail} unavailable={thumbnailUnavailable} container={element} onVisible={onVisible} deps={thumbnailDeps} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 border-l border-neutral-800/70 p-3 md:border-l-0 md:border-t">
        <div className="flex min-w-0 items-center gap-1.5">
          <DeviceGlyph platform={lease.platform} formFactor={leaseFormFactor(lease)} className="text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-100" title={name}>
            {name}
          </span>
          <span className="shrink-0 text-[11px] text-neutral-500">{platformText(lease.platform, lease.osVersion)}</span>
        </div>

        <button
          type="button"
          onClick={open}
          disabled={!open}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded text-left text-xs",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            open ? "text-neutral-300 hover:text-neutral-50" : "text-neutral-500"
          )}
          title={open ? "Open the chat with this device in its Device panel" : "This chat is not open on this server"}
        >
          <MessageSquare size={12} aria-hidden className="shrink-0 text-neutral-500" />
          <span className={cn("min-w-0 truncate", open && "underline-offset-2 group-hover:underline")}>{chat.title}</span>
          {open ? <ArrowUpRight size={11} aria-hidden className="shrink-0 text-neutral-500" /> : null}
        </button>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-neutral-400">
          {chat.agentName ? <span className="min-w-0 truncate">{chat.agentName}</span> : null}
          <StatusPill
            tone={userDrives ? "info" : "muted"}
            label={userDrives ? "You drive" : "Agent drives"}
            className="py-0"
          />
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-[11px]" title={lastAction ? `${lastAction.summary} — ${new Date(lastAction.at).toLocaleString()}` : undefined}>
          {lastAction ? (
            <>
              {lastAction.ok ? (
                lastAction.actor === "user" ? (
                  <Hand size={11} aria-label="You" className="shrink-0 text-info" />
                ) : (
                  <Bot size={11} aria-label="Agent" className="shrink-0 text-neutral-500" />
                )
              ) : (
                <AlertTriangle size={11} aria-label="Failed" className="shrink-0 text-danger" />
              )}
              <span className={cn("min-w-0 truncate", lastAction.ok ? "text-neutral-300" : "text-danger")}>{lastAction.summary}</span>
              <span className="shrink-0 text-neutral-500">{formatAgo(lastAction.at, now)}</span>
            </>
          ) : (
            <span className="text-neutral-600">No actions yet</span>
          )}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[11px] tabular-nums text-neutral-500">
          <span className="flex items-center gap-1" title="Leased for">
            <Clock size={11} aria-hidden />
            {formatUptime(msSince(lease.createdAt, now))}
          </span>
          {cost ? (
            <span title={`Its share of the host: ${formatHourlyRate(cost.hourlyUsd)}`}>
              <span className="text-neutral-300">{formatUsd(cost.spentUsd)}</span> · {formatHourlyRate(cost.hourlyUsd)}
            </span>
          ) : host?.kind === "local" ? (
            <span>On this host</span>
          ) : host?.kind === "byo" ? (
            <span>Your machine</span>
          ) : null}
        </div>
      </div>
    </li>
  );
};
