import React from "react";

import { cn } from "../../../lib/cn";
import { useChatImageUrl, type ChatImageItem } from "./chat-image";
import { ChatImageActions } from "./ChatImageActions";

/** The inline image row's height cap (design 2026-11-10 §9.1: "about 512px"). */
export const INLINE_IMAGE_MAX_HEIGHT = 512;

/**
 * One image, shown in the chat: click to enlarge, the actions on hover (a
 * device with no hover has them in the enlarged view). `single` fits the
 * chat column under the height cap, keeping the image's shape — reserved
 * from its known size before the bytes arrive, so nothing below it jumps;
 * `grid` fills a cell of a several-image row; `inline` is a Markdown image's
 * own size.
 */
export function ChatImageView(props: {
  item: ChatImageItem;
  layout: "single" | "grid" | "inline";
  onOpen: () => void;
}): React.ReactElement {
  const { item, layout } = props;
  const { url, loading, error } = useChatImageUrl(item);
  const known = item.width !== undefined && item.height !== undefined;
  const label = item.alt || item.caption || "image";

  if (error) {
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-md border border-dashed border-neutral-800 text-xs text-neutral-500",
          layout === "inline" ? "px-2 py-1" : "h-24 w-full max-w-sm px-3"
        )}
      >
        Image unavailable{layout === "inline" && label ? `: ${label}` : ""}
      </span>
    );
  }

  const frame: React.CSSProperties | undefined =
    layout === "single" && known
      ? {
          aspectRatio: `${item.width} / ${item.height}`,
          width: `min(100%, ${item.width}px, ${Math.round((INLINE_IMAGE_MAX_HEIGHT * item.width!) / item.height!)}px)`
        }
      : undefined;

  return (
    <span
      className={cn(
        "group/image relative block max-w-full overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/60",
        layout === "single" && !known && "inline-block",
        layout === "grid" && "aspect-[4/3] w-full",
        layout === "inline" && "my-[0.65rem] inline-block align-top first:mt-0"
      )}
      style={frame}
    >
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`Enlarge image: ${label}`}
        className="block size-full cursor-zoom-in focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        {url !== null ? (
          <img
            src={url}
            alt={item.alt}
            {...(known ? { width: item.width, height: item.height } : {})}
            className={cn(
              "block",
              layout === "grid" && "size-full object-contain",
              layout === "single" && (known ? "size-full object-contain" : "max-h-[512px] max-w-full"),
              layout === "inline" && "max-h-64 max-w-full"
            )}
          />
        ) : (
          <span
            className={cn(
              "flex items-center justify-center text-xs text-neutral-600",
              layout === "inline" ? "h-16 w-32" : known || layout === "grid" ? "size-full" : "h-48 w-72 max-w-full"
            )}
          >
            {loading ? "Loading image…" : null}
          </span>
        )}
      </button>
      <ChatImageActions
        item={item}
        url={url}
        className={cn(
          "absolute right-1.5 top-1.5 rounded-md bg-neutral-950/85 p-0.5 opacity-0 transition-opacity",
          "focus-within:opacity-100 group-hover/image:opacity-100 [@media(hover:none)]:hidden"
        )}
      />
    </span>
  );
}
