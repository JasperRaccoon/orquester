/**
 * One agent-published page in a sandboxed frame, wearing the app's theme
 * (spec 2026-10-14 §2.4).
 *
 * Ported from T3 Code (MIT): `apps/web/src/components/files/BrowserDocumentFrame.tsx`
 * (`HtmlRenderDocument`: the frame, its bridge and its shortcut forwarding),
 * with Orquester's link handling and shortcut set.
 */

import React from "react";

import {
  htmlRenderResult,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  type HtmlRenderShortcut
} from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { isAllowedVisualKey, openVisualLink, visualRequestAllowed } from "../../../lib/agent-chat/visual-frame";
import { useVisualTheme } from "./use-visual-theme";

function userActive(): boolean | undefined {
  return (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
}

/**
 * The page reads its theme from the URL fragment before first paint, then
 * follows changes posted to its bootstrap. The first URL is kept for the
 * frame's whole life: a new `src` would reload the page and lose its state.
 *
 * Never `allow-same-origin`, never `srcdoc`: with only `allow-scripts
 * allow-forms` the page runs with an opaque origin, out of reach of the app's
 * session, storage and bridge — the daemon's CSP says the same.
 */
export function VisualDocument(props: {
  src: string;
  title: string;
  className?: string;
  /** The app chords a focused page passes on (`VISUAL_FRAME_SHORTCUTS`, …). */
  shortcuts: readonly HtmlRenderShortcut[];
  /** The page's content height whenever it changes, so an inline frame fits it. */
  onContentHeight?: (height: number) => void;
}): React.ReactElement {
  const theme = useVisualTheme();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [src] = React.useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = React.useState(false);

  const themeRef = React.useRef(theme);
  themeRef.current = theme;
  const shortcutsRef = React.useRef(props.shortcuts);
  shortcutsRef.current = props.shortcuts;

  const post = React.useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);
  // A live theme change: the page restyles itself, no reload.
  React.useEffect(() => post(htmlRenderThemeMessage(theme)), [post, theme]);
  React.useEffect(() => post(htmlRenderShortcutsMessage(props.shortcuts)), [post, props.shortcuts]);

  // The page asks the host to open a link (it cannot open windows itself),
  // and passes on the app chords it was told about. Both are honoured only
  // from this frame, while it has focus and the reader has just used the app:
  // a page can take focus by script, so this stops opens on load. A replayed
  // key is dispatched on the frame element, so it bubbles to the app's own
  // window and document listeners as if typed outside the frame.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) {
        return;
      }
      const link = readHtmlRenderLinkRequest(event.data);
      if (link !== undefined) {
        if (
          visualRequestAllowed({
            fromFrame: true,
            frameFocused: document.activeElement === frame,
            userActive: userActive()
          })
        ) {
          openVisualLink(link.url);
          frame.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
        }
        return;
      }
      const key = readHtmlRenderKeyDown(event.data);
      if (
        key !== undefined &&
        isAllowedVisualKey(key, shortcutsRef.current) &&
        visualRequestAllowed({
          fromFrame: true,
          frameFocused: document.activeElement === frame,
          userActive: userActive(),
          escape: key.key === "Escape"
        })
      ) {
        frame.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A page posts its height once per change, so listen from the commit that
  // inserts the frame: a passive effect could run after a fast page's first post.
  const { onContentHeight } = props;
  React.useLayoutEffect(() => {
    if (onContentHeight === undefined) return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) onContentHeight(height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onContentHeight]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change, and the shortcut list, that landed while the page loaded.
        post(htmlRenderThemeMessage(themeRef.current));
        post(htmlRenderShortcutsMessage(shortcutsRef.current));
      }}
      className={cn("border-0 bg-transparent", props.className)}
      // A frame whose colour scheme differs from its document's paints an
      // opaque canvas, so the blank document a frame starts with would flash
      // white in dark mode: it stays `light` (the blank document's) until the
      // page is in, whose own `color-scheme` the bootstrap set from the theme.
      style={{ colorScheme: loaded ? theme.appearance : "light" }}
    />
  );
}
