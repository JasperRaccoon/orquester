/**
 * An agent-published page full screen, in the app's modal, with zoom
 * (spec 2026-10-14 §2.4).
 *
 * Ported from T3 Code (MIT): `apps/web/src/components/chat/HtmlRenderDialog.tsx`.
 */

import React from "react";
import { Minus, Plus } from "lucide-react";

import {
  VISUAL_VIEWER_SHORTCUTS,
  VISUAL_VIEWER_MAX_ZOOM,
  VISUAL_VIEWER_MIN_ZOOM,
  stepVisualZoom
} from "../../../lib/agent-chat/visual-frame";
import { Modal, ModalCloseButton } from "../../ui";
import { ChatIconButton } from "../primitives";
import { VisualDocument } from "./VisualDocument";

export function VisualViewer(props: { src: string; title: string; onClose: () => void }): React.ReactElement {
  const [zoom, setZoom] = React.useState(1);
  return (
    <Modal open onClose={props.onClose} className="h-[min(90vh,calc(100vh-48px))] max-w-[min(96vw,1400px)]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-3">
          <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{props.title}</span>
          <ChatIconButton
            label="Zoom out"
            size="sm"
            disabled={zoom <= VISUAL_VIEWER_MIN_ZOOM}
            onClick={() => setZoom((value) => stepVisualZoom(value, -1))}
          >
            <Minus size={14} aria-hidden />
          </ChatIconButton>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => setZoom(1)}
            className="ac-tabular h-7 min-w-12 rounded-md px-1.5 text-xs text-neutral-300 hover:bg-neutral-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            {Math.round(zoom * 100)}%
          </button>
          <ChatIconButton
            label="Zoom in"
            size="sm"
            disabled={zoom >= VISUAL_VIEWER_MAX_ZOOM}
            onClick={() => setZoom((value) => stepVisualZoom(value, 1))}
          >
            <Plus size={14} aria-hidden />
          </ChatIconButton>
          <ModalCloseButton onClose={props.onClose} />
        </div>
        {/* The page lays out at the box's own size and is scaled by `zoom`, so
            zooming in scrolls the box rather than reflowing the page. */}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-neutral-950 [container-type:size]">
          <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
            <VisualDocument
              src={props.src}
              title={props.title}
              shortcuts={VISUAL_VIEWER_SHORTCUTS}
              className="block size-full"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
