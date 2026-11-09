import React from "react";

import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { cn } from "../../../../lib/cn";
import type { ChatImageItem } from "../../images/chat-image";
import { ChatImageLightbox } from "../../images/ChatImageLightbox";
import { ChatImageView } from "../../images/ChatImageView";
import { ShimmerText } from "../../primitives";
import { useTimelineRowContext } from "../context";

/**
 * Images an agent put in the chat (design 2026-11-10 §9), in place of the
 * `show_image` / `generate_image` call or Codex `image_generation` item that
 * produced them, left-aligned with the reply text and always visible: the
 * title above, one image sized to the chat column (or several in a grid),
 * each with its caption, and a generated image's revised prompt. Keyed by
 * its first image, so the loaded bytes survive re-derivation.
 */
export function ImageRow({
  row
}: {
  row: Extract<AgentChatTimelineRow, { kind: "image" }>;
}): React.ReactElement | null {
  const { sessionId } = useTimelineRowContext();
  const [open, setOpen] = React.useState<number | null>(null);
  const items = React.useMemo<ChatImageItem[]>(
    () =>
      sessionId === undefined
        ? []
        : row.image.images.map((image) => ({
            key: image.attachmentId,
            source: { kind: "attachment", sessionId, attachmentId: image.attachmentId },
            alt: image.caption ?? row.image.title ?? "Image",
            ...(image.caption !== undefined ? { caption: image.caption } : {}),
            ...(row.image.title !== undefined ? { title: row.image.title } : {}),
            ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
            ...(image.width !== undefined && image.height !== undefined
              ? { width: image.width, height: image.height }
              : {}),
            ...(image.path !== undefined ? { path: image.path } : {})
          })),
    [row.image, sessionId]
  );
  if (items.length === 0) return null;
  const single = items.length === 1;
  const revisedPrompt =
    row.image.revisedPrompt !== undefined && row.image.revisedPrompt !== items[0]?.caption
      ? row.image.revisedPrompt
      : undefined;

  return (
    // `px-1`: the assistant text's own inset, so the images line up with the reply.
    <figure className="m-0 px-1">
      {row.image.title !== undefined ? (
        <figcaption className="mb-1.5 text-sm text-neutral-300">{row.image.title}</figcaption>
      ) : null}
      <div
        className={cn(
          single ? "flex flex-col items-start" : "grid gap-2",
          !single && (items.length === 2 || items.length === 4 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")
        )}
      >
        {items.map((item, index) => (
          <div key={item.key} className={cn("min-w-0", single && "max-w-full")}>
            <ChatImageView item={item} layout={single ? "single" : "grid"} onOpen={() => setOpen(index)} />
            {item.caption !== undefined ? (
              <p className={cn("mt-1 text-xs text-neutral-400", !single && "line-clamp-2")} title={item.caption}>
                {item.caption}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {revisedPrompt !== undefined ? (
        <p className="mt-1 text-xs text-neutral-500" title="The prompt the image was made from">
          Revised prompt: {revisedPrompt}
        </p>
      ) : null}
      {open !== null ? (
        <ChatImageLightbox items={items} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </figure>
  );
}

/**
 * The place an image is coming in (design 2026-11-10 §9.1): a running
 * `generate_image` call or Codex `image_generation` item, as a quiet,
 * square placeholder where the image will be.
 */
export function ImagePendingRow(): React.ReactElement {
  return (
    <div className="px-1">
      <div
        role="status"
        className="flex aspect-square w-full max-w-64 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900/60 motion-safe:animate-pulse"
      >
        <ShimmerText live className="text-xs">
          Generating image…
        </ShimmerText>
      </div>
    </div>
  );
}
