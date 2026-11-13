/**
 * A desktop tool's chat row extras (spec 2026-11-10 R2.6): **Show desktop**, which opens the
 * desktop's tab, and the thumbnail of a screenshot the daemon kept (from the authenticated
 * screenshot route with a query token, as a device screenshot's). Mirrors `DeviceRowLink.tsx`.
 * The app's chat host hands them to the timeline's tool rows (`ChatHost.desktopRows`).
 */

import React from "react";
import { ImageOff, Monitor } from "lucide-react";

import { Modal, ModalCloseButton } from "../ui/modal";

import { cn } from "../../lib/cn";
import type { DesktopRowLink } from "../../lib/desktops/chat-rows.logic";
import { jumpToProject, resolveProjectRef } from "../../lib/session-nav";
import { useAppStore } from "../../store/app";

/** The desktop's title as the store knows it (a primitive, so a row re-renders only when it changes). */
export function useDesktopLinkTitle(link: DesktopRowLink | undefined): string | undefined {
  return useAppStore((state) => (link ? state.desktops.find((desktop) => desktop.id === link.desktopId)?.title || undefined : undefined));
}

/** "Show desktop": that desktop's tab; disabled once the desktop closed. */
export function DesktopShowButton({ link }: { link: DesktopRowLink }): React.ReactElement {
  const projectPath = useAppStore((state) => state.desktops.find((desktop) => desktop.id === link.desktopId)?.projectPath);
  const title = useDesktopLinkTitle(link);
  const live = projectPath !== undefined;
  return (
    <button
      type="button"
      data-desktop-link={link.desktopId}
      disabled={!live}
      onClick={(event) => {
        event.stopPropagation();
        if (!projectPath) return;
        const state = useAppStore.getState();
        jumpToProject({ project: resolveProjectRef(projectPath, state.workspaces, state.projects), sessionId: link.desktopId });
      }}
      onKeyDown={(event) => event.stopPropagation()}
      title={live ? `Show ${title ?? "the desktop"}` : "That desktop was closed"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 text-[11px] text-neutral-400 transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        live ? "hover:bg-neutral-800/60 hover:text-neutral-100" : "cursor-default text-neutral-600"
      )}
    >
      <Monitor size={11} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <span>Show desktop</span>
    </button>
  );
}

/** A kept screenshot's thumbnail under the row; nothing off HTTP. */
export function DesktopScreenshotThumb({ link, title }: { link: DesktopRowLink; title: string | undefined }): React.ReactElement | null {
  const api = useAppStore((state) => state.api);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const { desktopId, screenshotId } = link;
  const url = React.useMemo(() => (api && screenshotId ? api.desktopScreenshotUrl(desktopId, screenshotId) : null), [api, desktopId, screenshotId]);
  React.useEffect(() => setFailed(false), [url]);
  if (!url) return null;
  const label = `Screenshot of ${title ?? "the desktop"}`;
  if (failed) {
    return (
      <div className="ms-7 mt-1 inline-flex items-center gap-1 text-[11px] text-neutral-600" data-desktop-screenshot="unavailable">
        <ImageOff size={11} aria-hidden />
        Screenshot unavailable
      </div>
    );
  }
  // The full image opens in the app (a modal), never in a tab: the URL carries the bearer.
  return (
    <>
      <button
        type="button"
        title={`${label} — view full size`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="ms-7 mt-1 block w-fit rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        data-desktop-screenshot={screenshotId}
      >
        <img
          src={url}
          alt={label}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="max-h-40 max-w-[min(100%,20rem)] rounded-md border border-neutral-800 bg-neutral-900 object-contain"
        />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} className="w-auto max-w-[min(92vw,64rem)] p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="truncate text-sm text-neutral-300">{label}</p>
          <ModalCloseButton onClose={() => setOpen(false)} />
        </div>
        <img src={url} alt={label} className="max-h-[80vh] max-w-full rounded-md object-contain" />
      </Modal>
    </>
  );
}
