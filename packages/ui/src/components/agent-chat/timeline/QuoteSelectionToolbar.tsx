// Informed by T3 Code (MIT): apps/web/src/components/chat/AssistantSelectionToolbar.tsx
// and apps/web/src/lib/selectionActions.ts.
import React from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Quote } from "lucide-react";

import { cn } from "../../../lib/cn";
import { copyText } from "../../../lib/clipboard";
import { openLayer } from "../../../lib/open-layers";
import { MAX_COMPOSER_QUOTE_CHARS } from "../../../lib/agent-chat/composer.logic";
import { composerTakesQuotes, quoteIntoComposer } from "../composer/composer-bridge";
import { COPY_FEEDBACK_MS } from "../primitives";
import {
  isRectVisible,
  quoteToolbarPosition,
  resolveQuoteSelection,
  selectionMarkdown,
  type RectLike
} from "./quote-selection";

export interface QuoteSelectionToolbarProps {
  /** The timeline's scroller: selections inside it are watched, its scrolling dismisses. */
  viewport: HTMLElement | null;
  /** The thread whose composer a quote goes to. */
  sessionId: string;
  /** The bottom of the viewport the composer overlay covers; the toolbar never sits under it. */
  bottomInset: number;
}

type PointerKind = "mouse" | "touch" | "keyboard";

interface ToolbarState {
  first: RectLike;
  last: RectLike;
  pointer: PointerKind;
  /** The selection as markdown, what Quote adds. */
  markdown: string;
  /** The selection as the platform copies it, what Copy writes. */
  plain: string;
}

/** A keyboard selection (shift+arrows) settles quickly; a touch one is still being dragged by its handles. */
const SETTLE_MS: Record<PointerKind, number> = { mouse: 0, keyboard: 120, touch: 350 };
/** After a scroll or a resize, how long the view must be still before the toolbar comes back. */
const SCROLL_SETTLE_MS = 150;
/** How long a released press on the toolbar waits for its click. */
const PRESS_RELEASE_MS = 500;

function toRect(rect: DOMRect): RectLike {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

/**
 * The floating toolbar over a selection in an agent's reply: **Quote** adds
 * the selected passage to the composer (as markdown — a code block stays a
 * code block) and focuses the textarea for the user's comment; **Copy** copies
 * it as the platform would.
 *
 * Shown only for a selection wholly inside one agent message (or proposed
 * plan) body (`resolveQuoteSelection`), and only once it has settled: on a
 * mouse release, a beat after a keyboard extension, longer after a touch
 * selection whose handles may still be moving. It goes on a collapse, a
 * click or tap elsewhere, Escape, a scroll (coming back once the view is
 * still, if the selection is still in sight) and a resize.
 *
 * While it shows it is an open layer (`openLayer`), so the chat's own Escape
 * — interrupt, rewind — stands down and the Escape closes the toolbar
 * instead. Tab moves into it from the page; the arrow keys move between its
 * buttons.
 */
export function QuoteSelectionToolbar({
  viewport,
  sessionId,
  bottomInset
}: QuoteSelectionToolbarProps): React.ReactElement | null {
  const [state, setState] = React.useState<ToolbarState | null>(null);
  const [copied, setCopied] = React.useState(false);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const bottomInsetRef = React.useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  /**
   * A press on the toolbar is in progress, from its pointerdown to its click.
   * A tap may collapse the native selection on a phone before the click
   * lands; that change is the press's own and must not take the toolbar away
   * from under the finger. A ref, because the buttons end the press too.
   */
  const pressingRef = React.useRef(false);
  const pressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const endPress = React.useCallback(() => {
    pressingRef.current = false;
    if (pressTimerRef.current !== null) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  }, []);
  React.useEffect(() => endPress, [endPress]);
  const shown = state !== null;

  React.useEffect(() => {
    if (!viewport) return;
    const document = viewport.ownerDocument;
    const view = document.defaultView;
    if (!view) return;

    let pointer: PointerKind = "mouse";
    /** A primary mouse or pen button is held: a drag-select in progress. */
    let mouseDown = false;
    /** Escape closed it: it stays closed until the selection changes. */
    let dismissed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;

    const cancelPending = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) view.cancelAnimationFrame(frame);
      timer = null;
      frame = null;
    };
    const hide = (): void => {
      setState((current) => (current === null ? current : null));
    };
    const insideToolbar = (target: EventTarget | null): boolean =>
      target instanceof Node && (toolbarRef.current?.contains(target) ?? false);

    const evaluate = (): void => {
      if (dismissed || mouseDown) return;
      const resolved = resolveQuoteSelection(view.getSelection(), viewport);
      if (resolved === null || !composerTakesQuotes(sessionId)) {
        hide();
        return;
      }
      const box = viewport.getBoundingClientRect();
      const bounds: RectLike = {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom - bottomInsetRef.current
      };
      // Only the lines the reader can see anchor it: a selection scrolled out
      // of sight (or under the composer) has nothing to point at.
      const lines = Array.from(resolved.range.getClientRects())
        .filter((rect) => rect.width > 0 || rect.height > 0)
        .map(toRect)
        .filter((rect) => isRectVisible(rect, [bounds]));
      if (lines.length === 0) {
        hide();
        return;
      }
      const markdown = selectionMarkdown(resolved.range, resolved.source);
      if (markdown.trim().length === 0) {
        hide();
        return;
      }
      setCopied(false);
      setState({
        first: lines[0]!,
        last: lines[lines.length - 1]!,
        pointer,
        markdown,
        plain: view.getSelection()?.toString() ?? resolved.range.toString()
      });
    };
    const schedule = (delay: number): void => {
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        frame = view.requestAnimationFrame(() => {
          frame = null;
          evaluate();
        });
      }, delay);
    };

    const onSelectionChange = (): void => {
      if (pressingRef.current || insideToolbar(document.activeElement)) return;
      dismissed = false;
      const selection = view.getSelection();
      if (mouseDown || selection === null || selection.isCollapsed) {
        // A drag still moving, or nothing selected any more: gone now, back on release.
        cancelPending();
        hide();
        return;
      }
      schedule(SETTLE_MS[pointer]);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.isPrimary) return;
      if (insideToolbar(event.target)) {
        endPress();
        pressingRef.current = true;
        return;
      }
      endPress();
      cancelPending();
      hide();
      pointer = event.pointerType === "touch" ? "touch" : "mouse";
      mouseDown = event.pointerType !== "touch" && event.button === 0;
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (!event.isPrimary) return;
      if (pressingRef.current) {
        // Released: the button's click ends the press. One that never comes (a
        // release off the button) must not leave the toolbar deaf for good.
        if (pressTimerRef.current !== null) clearTimeout(pressTimerRef.current);
        pressTimerRef.current = setTimeout(endPress, PRESS_RELEASE_MS);
        return;
      }
      if (!mouseDown) return;
      mouseDown = false;
      // After this frame: a double or triple click finishes its selection
      // on the release, and the rects must be the final ones.
      schedule(SETTLE_MS.mouse);
    };
    const onPointerCancel = (): void => {
      // A long press that turned into a native selection cancels the pointer;
      // the selection's own changes take it from there.
      mouseDown = false;
      endPress();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const toolbar = toolbarRef.current;
      if (event.key === "Escape" && toolbar !== null) {
        dismissed = true;
        cancelPending();
        hide();
        return;
      }
      if (
        event.key === "Tab" &&
        toolbar !== null &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.defaultPrevented &&
        !insideToolbar(event.target) &&
        !isEditable(event.target)
      ) {
        // From the page into the toolbar, as from the selection to its actions.
        event.preventDefault();
        toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
        return;
      }
      if (!insideToolbar(event.target)) pointer = "keyboard";
    };
    const onScroll = (): void => {
      cancelPending();
      hide();
      // Drag-autoscroll ends at the release, which evaluates anyway.
      if (!mouseDown && !dismissed) schedule(SCROLL_SETTLE_MS);
    };
    const onResize = (): void => {
      cancelPending();
      hide();
      if (!dismissed) schedule(SCROLL_SETTLE_MS);
    };
    const onBlur = (): void => {
      cancelPending();
      mouseDown = false;
      endPress();
      hide();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    view.addEventListener("pointerup", onPointerUp, true);
    view.addEventListener("pointercancel", onPointerCancel, true);
    viewport.addEventListener("scroll", onScroll, true);
    view.addEventListener("resize", onResize);
    view.addEventListener("blur", onBlur);
    return () => {
      cancelPending();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      view.removeEventListener("pointerup", onPointerUp, true);
      view.removeEventListener("pointercancel", onPointerCancel, true);
      viewport.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("resize", onResize);
      view.removeEventListener("blur", onBlur);
      setState(null);
    };
  }, [viewport, sessionId, endPress]);

  // An open layer while it shows: the chat's Escape (interrupt, rewind) stands down for it.
  React.useEffect(() => (shown ? openLayer() : undefined), [shown]);

  // Placed once its size is known, before paint.
  React.useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || state === null || !viewport) return;
    const box = viewport.getBoundingClientRect();
    const view = viewport.ownerDocument.defaultView;
    const position = quoteToolbarPosition({
      first: state.first,
      last: state.last,
      toolbar: { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
      bounds: {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom - bottomInsetRef.current
      },
      window: { width: view?.innerWidth ?? box.right, height: view?.innerHeight ?? box.bottom },
      pointer: state.pointer
    });
    toolbar.style.left = `${position.left}px`;
    toolbar.style.top = `${position.top}px`;
    toolbar.style.visibility = "visible";
    toolbar.dataset.placement = position.placement;
  }, [state, viewport]);

  // The tick goes after a moment; the toolbar stays for a Quote after a Copy.
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (state === null || typeof document === "undefined") return null;

  const tooLong = state.markdown.length > MAX_COMPOSER_QUOTE_CHARS;
  const close = (): void => setState(null);
  const quote = (): void => {
    endPress();
    close();
    // Let go of the selection first: the composer then focuses its textarea,
    // and a document selection cleared after that could take the caret along.
    window.getSelection()?.removeAllRanges();
    // A refusal (the draft holds all the quotes it may) is said on the
    // composer's status line, where the quotes are.
    quoteIntoComposer(sessionId, state.markdown);
  };
  const copy = (): void => {
    endPress();
    void copyText(state.plain).then((ok) => {
      if (ok) setCopied(true);
    });
  };
  const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const BUTTON = cn(
    "ac-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-neutral-300",
    "hover:bg-neutral-800 hover:text-neutral-100",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
    "disabled:pointer-events-none disabled:opacity-50"
  );

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selected text"
      data-quote-selection-toolbar="true"
      // Pressing a button must not take the selection away from under it.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={onToolbarKeyDown}
      style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
      className={cn(
        "z-[110] flex select-none items-center gap-0.5 rounded-lg border border-neutral-700",
        "bg-neutral-900 p-0.5 shadow-lg"
      )}
    >
      <button
        type="button"
        className={BUTTON}
        disabled={tooLong}
        title={tooLong ? "The selection is too long to quote" : "Quote in the message you are writing"}
        onClick={quote}
      >
        <Quote size={12} strokeWidth={1.8} aria-hidden />
        {tooLong ? "Too long to quote" : "Quote"}
      </button>
      <button type="button" className={BUTTON} title="Copy the selected text" onClick={copy}>
        {copied ? (
          <Check size={12} className="text-ok" aria-hidden />
        ) : (
          <Copy size={12} strokeWidth={1.8} aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>,
    document.body
  );
}
