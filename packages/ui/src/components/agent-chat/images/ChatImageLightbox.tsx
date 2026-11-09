import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Modal, ModalCloseButton } from "../../ui";
import { ChatIconButton } from "../primitives";
import { useChatImageUrl, type ChatImageItem } from "./chat-image";
import { ChatImageActions } from "./ChatImageActions";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * An image of the chat enlarged (design 2026-11-10 §9.1): the app's modal
 * (a portal over a dimmed backdrop; Escape, a click outside and Back close
 * it), the image as large as the window allows, its caption, the same
 * actions as on hover, and ←/→ through the other images of its row. Focus
 * stays inside while it is open and goes back to the image that opened it.
 */
export function ChatImageLightbox(props: {
  items: readonly ChatImageItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}): React.ReactElement | null {
  const { items, onIndexChange, onClose } = props;
  const index = Math.min(Math.max(props.index, 0), items.length - 1);
  const item = items[index];
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const many = items.length > 1;

  React.useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>("[data-lightbox-close] button")?.focus({ preventScroll: true });
  }, []);

  if (item === undefined) return null;
  const step = (delta: number) => onIndexChange((index + delta + items.length) % items.length);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    // A dialog opened from here (Save to project…) is portaled elsewhere, but
    // its keys still bubble through this tree: they are its own.
    if (container === null || !container.contains(event.target as Node)) return;
    if (many && event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (many && event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "Tab") {
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const label = item.caption ?? (item.alt || "Image");
  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={many ? `Image ${index + 1} of ${items.length}: ${label}` : label}
      className="h-[min(92vh,calc(100vh-32px))] max-w-[min(96vw,1600px)] bg-neutral-950"
    >
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        {/* Not keyed by the image: ←/→ keep the focused control (and with it
            the keys and the focus trap) where it is. */}
        <LightboxContent
          item={item}
          position={many ? `${index + 1} / ${items.length}` : null}
          onStep={many ? step : null}
          onClose={onClose}
        />
      </div>
    </Modal>
  );
}

/** One image's view: its own read of the bytes (the row's belongs to the row), revoked when the image changes. */
function LightboxContent(props: {
  item: ChatImageItem;
  position: string | null;
  onStep: ((delta: number) => void) | null;
  onClose: () => void;
}): React.ReactElement {
  const { item, onStep, onClose } = props;
  const { url, loading, error } = useChatImageUrl(item);
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-3">
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
          {item.title ?? item.caption ?? item.alt}
        </span>
        {props.position !== null ? (
          <span className="ac-tabular shrink-0 text-xs text-neutral-500">{props.position}</span>
        ) : null}
        <ChatImageActions item={item} url={error ? null : url} onLeave={onClose} />
        <div data-lightbox-close>
          <ModalCloseButton onClose={onClose} />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <p className="text-sm text-neutral-500">Image unavailable</p>
        ) : loading || url === null ? (
          <p className="text-sm text-neutral-600">Loading image…</p>
        ) : (
          <img src={url} alt={item.alt} className="max-h-full max-w-full object-contain" />
        )}
        {onStep !== null ? (
          <>
            <ChatIconButton
              label="Previous image"
              size="sm"
              variant="outline"
              className="absolute left-3 top-1/2 -translate-y-1/2 bg-neutral-900/80"
              onClick={() => onStep(-1)}
            >
              <ChevronLeft size={16} aria-hidden />
            </ChatIconButton>
            <ChatIconButton
              label="Next image"
              size="sm"
              variant="outline"
              className="absolute right-3 top-1/2 -translate-y-1/2 bg-neutral-900/80"
              onClick={() => onStep(1)}
            >
              <ChevronRight size={16} aria-hidden />
            </ChatIconButton>
          </>
        ) : null}
      </div>
      {item.caption !== undefined && item.caption !== item.title ? (
        <p className="shrink-0 border-t border-neutral-800 px-4 py-2 text-xs text-neutral-400">{item.caption}</p>
      ) : null}
    </>
  );
}
