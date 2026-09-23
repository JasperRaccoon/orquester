import React from "react";
import { createPortal } from "react-dom";
import { RotateCcw, X } from "lucide-react";
import type { AttachmentRef } from "@orquester/api/agent-chat";

import { imageOrdinal } from "./composer-images";
import { cn } from "../../../lib/cn";
import { FileTypeIcon } from "../../../icons/files";
import { ChatIconButton } from "../primitives";

/** One file staged in the draft, with the state of its own upload. */
export interface StagedAttachment {
  key: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  status: "uploading" | "ready" | "failed";
  /** 0–1 while uploading; the chip draws it as a fill, never as a number. */
  progress: number;
  ref?: AttachmentRef;
  error?: string;
  /**
   * An object URL of the local `File`, while the composer still holds it —
   * the chip's thumbnail and hover preview (§7.4). Never persisted: a reloaded
   * chip has none and resolves one lazily through `resolvePreview` on hover.
   */
  previewUrl?: string;
}

export interface ComposerAttachmentsProps {
  attachments: readonly StagedAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  disabled?: boolean;
  /**
   * Resolve a preview for an image chip that has no `previewUrl` (a reloaded
   * draft, a delivered ref): an object URL this component then owns and
   * revokes, or null when the bytes cannot be fetched.
   */
  resolvePreview?: (attachment: StagedAttachment) => Promise<string | null>;
}

interface HoverAnchor {
  key: string;
  /** Viewport x of the chip's centre. */
  left: number;
  /** Above the chip, unless the card would not fit between it and the viewport top. */
  placement: "above" | "below";
  /**
   * The card's `bottom` (above: viewport bottom to the chip's top edge) or
   * its `top` (below: the chip's bottom edge), plus the gap.
   */
  offset: number;
}

/** Half of the preview card's max width (`max-w-64` = 256px) plus its padding. */
const PREVIEW_HALF_WIDTH_PX = 136;
/** The card's max height (`max-h-48` = 192px) plus its padding (`p-1`, 2 × 4px) and border (2 × 1px). */
const PREVIEW_HEIGHT_PX = 202;
/** Between the chip's edge and the card. */
const PREVIEW_GAP_PX = 6;

/**
 * The attachment chips.
 *
 * **Upload progress is a fill behind the name, not a percentage.** A number
 * that ticks changes width and makes the whole row twitch; the fill says the
 * same thing and stays still. A failed upload keeps its chip and offers a
 * retry, because the alternative — dropping the file silently — leaves the
 * user sending a message that no longer references what they attached.
 *
 * Every chip carries the file-type icon of `icons/files`; an image chip shows
 * a thumbnail instead and a hover preview beside it, portaled because the
 * chip clips its overflow. The preview is gated to hover-capable pointers —
 * mobile browsers synthesise `mouseenter` on tap — and the chip is already
 * the file's name.
 *
 * *T3: `docs/user/composer.md:20-24` — "Uploads begin when you add an
 * attachment. All uploads must finish before the message can send. Retry or
 * remove a failed upload."*
 */
export function ComposerAttachments({
  attachments,
  onRemove,
  onRetry,
  disabled,
  resolvePreview
}: ComposerAttachmentsProps): React.ReactElement | null {
  const [hover, setHover] = React.useState<HoverAnchor | null>(null);
  // Lazily resolved previews by chip key. Owned here — revoked when the chip
  // leaves (the sweep below) and on unmount; `previewUrl`s are the composer's
  // to revoke. The map is a REF, written synchronously the moment a resolve
  // lands, so the sweep and the unmount cleanup see every URL that exists: a
  // `setState` store still queued in the same batch as a removal, or resolved
  // one render before an unmount, was invisible to both and leaked its Blob.
  // `lazyVersion` is only the render trigger — bumped after every store, which
  // is what makes reading the ref during render safe.
  const lazyUrlsRef = React.useRef(new Map<string, string>());
  const [, setLazyVersion] = React.useState(0);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // Every key with a resolve in flight or a URL in the map: a chip is
  // requested at most once while it lives, so a hover in the gap between a
  // resolve and its re-render cannot fetch twice. A failed resolve leaves the
  // set — the host drain-restarts on deploys, and the next hover asks again —
  // and a departed chip's key is forgotten together with its URL.
  const requestedRef = React.useRef(new Set<string>());
  const unmountedRef = React.useRef(false);

  React.useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      for (const url of lazyUrlsRef.current.values()) URL.revokeObjectURL(url);
      lazyUrlsRef.current.clear();
    };
  }, []);

  // A lazily resolved URL follows its CHIP, not the mount: this component
  // stays mounted across sends and tab switches within a project, so an entry
  // kept until unmount pinned its Blob for the whole project session. The
  // accidental cache an A→B→A re-stage would enjoy is traded for one re-fetch
  // — the right price; "a URL that outlives its chip pins the whole file in
  // memory" is the rule `revokeImagePreviews` already states. A resolve that
  // lands after its chip left is revoked on arrival (below); one that landed
  // just before is swept here, on the render that dropped the chip. No
  // re-render is owed: a departed chip draws nothing.
  const keyList = attachments.map((attachment) => attachment.key).join("\u0000");
  React.useEffect(() => {
    const live = new Set(attachments.map((attachment) => attachment.key));
    for (const [key, url] of lazyUrlsRef.current) {
      if (live.has(key)) continue;
      URL.revokeObjectURL(url);
      lazyUrlsRef.current.delete(key);
      requestedRef.current.delete(key);
    }
    // `keyList` stands in for `attachments`: which chips exist, not their upload state.
  }, [keyList]);

  const previewFor = (attachment: StagedAttachment): string | null =>
    attachment.previewUrl ?? lazyUrlsRef.current.get(attachment.key) ?? null;

  const requestPreview = (attachment: StagedAttachment): void => {
    if (attachment.previewUrl || !resolvePreview) return;
    if (requestedRef.current.has(attachment.key)) return;
    requestedRef.current.add(attachment.key);
    void resolvePreview(attachment)
      .catch(() => null)
      .then((url) => {
        if (url === null) {
          // Nothing stored and the key forgotten: the next hover asks again.
          requestedRef.current.delete(attachment.key);
          return;
        }
        const live = attachmentsRef.current.some((entry) => entry.key === attachment.key);
        if (!live || unmountedRef.current) {
          // The chip left (or the tray unmounted) while the bytes were in
          // flight: nothing owns the URL, so it dies here.
          URL.revokeObjectURL(url);
          requestedRef.current.delete(attachment.key);
          return;
        }
        // Stored BEFORE the re-render is asked for, so a sweep or an unmount
        // that runs first still finds it.
        lazyUrlsRef.current.set(attachment.key, url);
        setLazyVersion((version) => version + 1);
      });
  };

  if (attachments.length === 0) return null;
  const hovered = hover ? attachments.find((attachment) => attachment.key === hover.key) : undefined;
  const hoveredUrl = hovered ? previewFor(hovered) : null;

  return (
    <div
      data-chat-composer-attachments="true"
      className="flex flex-wrap items-center gap-1.5 pb-2"
    >
      {attachments.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/");
        const ordinal = isImage ? imageOrdinal(attachments, attachment.key) : null;
        const failed = attachment.status === "failed";
        const thumbnail = isImage ? previewFor(attachment) : null;
        return (
          <span
            key={attachment.key}
            title={attachment.error ?? attachment.name}
            data-attachment-chip={isImage ? "image" : "file"}
            className={cn(
              "relative inline-flex h-7 max-w-56 items-center gap-1.5 overflow-hidden rounded-md",
              "border px-2 text-[11px]",
              failed
                ? "border-danger-900/50 bg-danger-soft/40 text-danger-300"
                : "border-neutral-800 bg-neutral-900/60 text-neutral-300"
            )}
            onMouseEnter={
              isImage
                ? (event) => {
                    // Hover-capable pointers only: a tap on mobile synthesises
                    // `mouseenter`, and a preview nothing can dismiss would stick.
                    if (
                      typeof window.matchMedia === "function" &&
                      !window.matchMedia("(hover: hover)").matches
                    ) {
                      return;
                    }
                    requestPreview(attachment);
                    const rect = event.currentTarget.getBoundingClientRect();
                    // Above the chip, unless that would run the card off the viewport top.
                    const placement =
                      rect.top < PREVIEW_HEIGHT_PX + PREVIEW_GAP_PX ? "below" : "above";
                    setHover({
                      key: attachment.key,
                      left: rect.left + rect.width / 2,
                      placement,
                      offset:
                        placement === "above"
                          ? window.innerHeight - rect.top + PREVIEW_GAP_PX
                          : rect.bottom + PREVIEW_GAP_PX
                    });
                  }
                : undefined
            }
            onMouseLeave={
              isImage
                ? () => setHover((state) => (state?.key === attachment.key ? null : state))
                : undefined
            }
          >
            {attachment.status === "uploading" ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-neutral-800/70 transition-[width] duration-200"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, attachment.progress)) * 100)}%` }}
              />
            ) : null}
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              {thumbnail ? (
                <img src={thumbnail} alt="" className="h-4 w-4 rounded-[3px] object-cover" />
              ) : (
                <FileTypeIcon name={attachment.name} mimeType={attachment.mimeType} size={16} />
              )}
            </span>
            {ordinal !== null ? (
              <span className="relative shrink-0 font-mono text-[10px] text-neutral-500">#{ordinal}</span>
            ) : null}
            <span className="relative truncate">{attachment.name}</span>
            {failed ? (
              <ChatIconButton
                label={`Retry ${attachment.name}`}
                size="micro"
                disabled={disabled}
                className="relative"
                onClick={() => onRetry(attachment.key)}
              >
                <RotateCcw size={10} aria-hidden />
              </ChatIconButton>
            ) : null}
            <ChatIconButton
              label={`Remove ${attachment.name}`}
              size="micro"
              disabled={disabled}
              className="relative"
              onClick={() => onRemove(attachment.key)}
            >
              <X size={10} aria-hidden />
            </ChatIconButton>
          </span>
        );
      })}
      {hover && hoveredUrl
        ? createPortal(
            <div
              role="img"
              aria-label={`Preview of ${hovered?.name ?? "image"}`}
              style={{
                position: "fixed",
                left: Math.min(
                  Math.max(hover.left, PREVIEW_HALF_WIDTH_PX),
                  window.innerWidth - PREVIEW_HALF_WIDTH_PX
                ),
                ...(hover.placement === "above" ? { bottom: hover.offset } : { top: hover.offset }),
                transform: "translateX(-50%)"
              }}
              className="pointer-events-none z-[120] rounded-lg border border-neutral-800 bg-neutral-900 p-1 shadow-lg"
            >
              <img src={hoveredUrl} alt="" className="block max-h-48 max-w-64 rounded-md object-contain" />
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
