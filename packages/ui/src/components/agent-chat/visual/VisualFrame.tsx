/**
 * An agent's published page inline in the thread (spec 2026-10-14 §2.4,
 * §2.5): the page itself on the thread's own background, at its measured
 * height for this width until it reports its own, with a full-screen viewer.
 *
 * Ported from T3 Code (MIT): `apps/web/src/components/chat/HtmlRenderFrame.tsx`,
 * minting its URL through Orquester's API client.
 */

import React from "react";
import { Maximize2 } from "lucide-react";

import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderReference
} from "@orquester/api/agent-chat";

import { useApi } from "../../../context/orquester-context";
import type { ApiClient } from "../../../lib/api-client";
import { VISUAL_FRAME_SHORTCUTS, VisualUrlCache, type VisualFrameUrl } from "../../../lib/agent-chat/visual-frame";
import { ChatIconButton } from "../primitives";
import { VisualDocument } from "./VisualDocument";
import { VisualViewer } from "./VisualViewer";

/** One cache per API client: a URL is only good on the connection that minted it. */
const caches = new WeakMap<ApiClient, VisualUrlCache>();

function cacheFor(api: ApiClient): VisualUrlCache {
  let cache = caches.get(api);
  if (cache === undefined) {
    cache = new VisualUrlCache();
    caches.set(api, cache);
  }
  return cache;
}

/**
 * A usable URL for a thread's framed document (an agent page, an MCP App's
 * snapshot): a cached one with life left, else a fresh mint.
 */
export async function visualPageUrl(api: ApiClient, sessionId: string, attachmentId: string): Promise<VisualFrameUrl> {
  const cache = cacheFor(api);
  const key = `${sessionId}\n${attachmentId}`;
  const cached = cache.usable(key, Date.now());
  if (cached !== null) return cached;
  const minted = await api.agentVisualUrl(sessionId, attachmentId);
  cache.remember(key, minted);
  return minted;
}

export function VisualFrame(props: { sessionId: string; htmlRender: HtmlRenderReference }): React.ReactElement {
  const { sessionId, htmlRender } = props;
  const { attachmentId, title } = htmlRender;
  const api = useApi();

  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(HTML_RENDER_COLUMN_WIDTH);
  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    setWidth(box.clientWidth || HTML_RENDER_COLUMN_WIDTH);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Client fonts can wrap a page taller than it was measured; a frame left
  // short would scroll inside the thread and take the reader's scroll, so the
  // page's own report wins.
  const [contentHeight, setContentHeight] = React.useState<number>();
  const height = htmlRenderFrameHeight(htmlRender, width, contentHeight);

  // At most one mint per mount, kept for the frame's life.
  const [src, setSrc] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    visualPageUrl(api, sessionId, attachmentId).then(
      (url) => {
        if (!cancelled) setSrc(url.src);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, attachmentId]);

  const [expandedSrc, setExpandedSrc] = React.useState<string | null>(null);
  const [expandFailed, setExpandFailed] = React.useState(false);
  const expand = React.useCallback(() => {
    setExpandFailed(false);
    visualPageUrl(api, sessionId, attachmentId).then(
      (url) => setExpandedSrc(url.src),
      () => setExpandFailed(true)
    );
  }, [api, sessionId, attachmentId]);
  const closeViewer = React.useCallback(() => setExpandedSrc(null), []);

  return (
    <div ref={boxRef} className="group/visual relative w-full" style={{ height }} data-visual-attachment={attachmentId}>
      {src !== null ? (
        <>
          <VisualDocument
            src={src}
            title={title}
            shortcuts={VISUAL_FRAME_SHORTCUTS}
            className="block size-full"
            onContentHeight={setContentHeight}
          />
          <div className="absolute end-1 top-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/visual:opacity-100 [@media(pointer:coarse)]:opacity-100">
            {expandFailed ? <span className="rounded bg-neutral-900/90 px-1.5 py-0.5 text-[11px] text-danger">Page unavailable</span> : null}
            <ChatIconButton
              label="Open full screen"
              className="bg-neutral-900/80 backdrop-blur"
              onClick={expand}
            >
              <Maximize2 size={13} aria-hidden />
            </ChatIconButton>
          </div>
          {expandedSrc !== null ? <VisualViewer src={expandedSrc} title={title} onClose={closeViewer} /> : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-xs text-neutral-500">Unable to load {title}</p>
      ) : null}
    </div>
  );
}
