import React, { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApi } from "../../context/orquester-context";
import { useAppStore, useTerminalFontSize } from "../../store/app";
import { uploadFilesToSession, type UploadStatus } from "../../lib/session-upload";
import type { SessionSummary } from "../../types";
import type { ViewMode } from "../../lib/view-mode";

const FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

// Delay (ms) between the two halves of the post-replay "repaint nudge" (see the
// terminal effect). Long enough that a running agent processes the first SIGWINCH
// (and caches the off-by-one size) before the restore, so the two size changes
// can't coalesce into a single no-op — short enough to stay barely perceptible.
const REPAINT_NUDGE_MS = 50;

// Pixels a touch must travel before we claim it as a scroll gesture. Below this,
// touches pass through to xterm so tap-to-focus, mouse-report clicks, and
// long-press selection still work.
const SCROLL_SLOP_PX = 6;

// Standard 16-colour ANSI palette tuned for a dark, neutral background so
// CLIs/TUIs render with the colours they expect (not washed-out grays).
const THEME: ITheme = {
  background: "#0a0a0a",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3f3f46",
  black: "#1c1c1c",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa"
};

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard API unavailable (insecure context or permission denied) */
  }
}

/**
 * Wrap pasted text in the bracketed-paste escapes (`\x1b[200~`…`\x1b[201~`) a
 * native terminal sends, normalizing every newline to CR exactly as xterm's own
 * `prepareTextForTerminal` does. We send this explicitly for agent sessions
 * because xterm only brackets a paste once it has SEEN the app enable
 * bracketed-paste mode (`\x1b[?2004h`) — but the daemon replays scrollback via
 * `tmux capture-pane`, which omits DEC private modes, so a reattached / reloaded
 * / reconnected client never learns the agent turned it on. Without the wrapper
 * xterm sends a bare CR between lines and the agent submits at the first one.
 */
function bracketPaste(text: string): string {
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  return `\x1b[200~${normalized}\x1b[201~`;
}

/**
 * True when the element currently has a layout box — i.e. it and all its
 * ancestors are rendered, not `display:none`. A hidden element reports
 * `offsetWidth`/`offsetHeight` of 0.
 *
 * Every fit/resize is gated on this. An inactive tab is kept mounted but
 * `display:none` (see MainView), and xterm's FitAddon sizes from
 * `getComputedStyle(container).height/width`. For a hidden element those resolve
 * to the *computed* value — the literal "100%" from Tailwind's `h-full`/`w-full`
 * (`parseInt("100%")` → 100px) — so FitAddon proposes a tiny ~11×6 grid and we'd
 * shrink the daemon PTY to it. That stray SIGWINCH reflows a running agent into a
 * "tiny square" and emits redraw output that churns its working/idle light. So we
 * fit only when shown; the ResizeObserver fires again on reveal (the box goes
 * 0→real) and fits to the correct size then.
 */
function hasLayoutBox(el: HTMLElement): boolean {
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

/**
 * xterm.js view bound to a daemon session. Keystrokes (including control codes
 * like Ctrl-C `\x03`) are forwarded as input; the session's output stream is
 * replayed (current buffer) then streamed live. The PTY lives in the daemon,
 * so unmounting this view does not kill the session.
 */
export const TerminalView: React.FC<{
  session: SessionSummary;
  active?: boolean;
  viewMode?: ViewMode;
}> = ({ session, active, viewMode }) => {
  const api = useApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fontSize = useTerminalFontSize();
  // Initial size is read through a ref so the terminal-creation effect (keyed on
  // [api, session.id]) does NOT re-run when the size changes — that would tear
  // down the session stream. Live changes are handled by a separate effect below.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fitRef = useRef<FitAddon | null>(null);
  // Drag-over highlight + a short-lived inline status line (uploading / errors).
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<UploadStatus | null>(null);

  // Upload dropped/pasted files, then inject all returned paths in one input.
  // Stored in a ref so the (effect-mounted) DOM listeners always see the latest
  // closure without re-running the terminal effect. The upload + path injection
  // lives in a shared helper so the mobile attach button runs the exact same flow.
  const handleFilesRef = useRef<(files: File[]) => Promise<void>>(async () => {});
  handleFilesRef.current = (files: File[]) =>
    uploadFilesToSession(api, session.id, files, { onStatus: setStatus });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: FONT_STACK,
      fontSize: fontSizeRef.current,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 8000,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      // When an app (e.g. an agent TUI) enables mouse reporting, a normal drag is
      // sent to the app instead of selecting text. Allowing Option/Alt+drag to
      // force a local selection on macOS gives a way to select+copy regardless
      // (Windows/Linux already allow Shift+drag). Without this, macOS users have
      // NO way to select inside a mouse-reporting agent.
      macOptionClickForcesSelection: true,
      // Default is true on macOS, where right-clicking reselects the word under
      // the cursor and wipes an existing selection before we can copy it.
      rightClickSelectsWord: false,
      theme: THEME
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    term.open(container);

    // Normalize the "force a local selection over an app's mouse reporting"
    // modifier. xterm hardcodes Shift on Windows/Linux but Option/Alt on macOS
    // (shouldForceSelection: isMac ? altKey : shiftKey) with no public option,
    // so on macOS there's no Shift way to select inside a mouse-reporting agent.
    // Override the internal predicate so Shift (or Alt) works on every platform.
    // Guarded: if a future xterm changes this internal, it falls back to the
    // native modifier (Alt on macOS via macOptionClickForcesSelection, Shift
    // elsewhere).
    const selectionService = (
      term as unknown as {
        _core?: { _selectionService?: { shouldForceSelection?: (e: MouseEvent) => boolean } };
      }
    )._core?._selectionService;
    if (selectionService && typeof selectionService.shouldForceSelection === "function") {
      selectionService.shouldForceSelection = (e: MouseEvent) => e.shiftKey || e.altKey;
    }

    // Force xterm to measure its character cell NOW. It normally defers this to the
    // first render, but the daemon's scrollback replay — an alt-screen agent's grid
    // captured at the pane's REAL width — can arrive before that first render. Writing
    // that wide content into the still-80-col default terminal wraps it (and the alt
    // screen doesn't reflow on the later resize), so it lands garbled and only a
    // redraw heals it — unreliably for an idle agent. Measuring now lets applyFit()
    // below size to the real width immediately, so our resize reaches the daemon
    // BEFORE it captures + replays and the grid arrives un-wrapped. Same `_core`
    // internal as the selection override above; a no-op (lazy fallback) if it moves.
    try {
      (
        term as unknown as { _core?: { _charSizeService?: { measure?: () => void } } }
      )._core?._charSizeService?.measure?.();
    } catch {
      /* internal moved — fall back to lazy render-time measurement */
    }

    // NB: we intentionally use xterm's default DOM renderer rather than the
    // WebGL addon. The WebGL renderer leaves terminals blank/garbled after a
    // resize (e.g. toggling the grid/tab layout) or when revealed from a hidden
    // tab; the DOM renderer repaints reliably across those transitions.

    const applyFit = () => {
      // Skip while hidden (display:none) — see hasLayoutBox. The PTY keeps its
      // real size until the tab is shown again, when the ResizeObserver re-fires
      // with a measurable box and we fit for real.
      if (!hasLayoutBox(container)) {
        return;
      }
      // Bail until xterm has measured its character cell — it does so lazily on
      // the first render, and fitting before then leaves xterm at its default
      // 80×24, which we'd push to the PTY as a ≈half-size SIGWINCH (the "half size
      // on a fresh mount / project switch" bug). proposeDimensions() returns
      // undefined while the cell width is still 0; the first-render handler and the
      // ResizeObserver both re-fit once it's measured.
      const dims = fit.proposeDimensions();
      if (!dims || Number.isNaN(dims.cols) || Number.isNaN(dims.rows)) {
        return;
      }
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
      void api.resizeSession(session.id, term.cols, term.rows);
    };
    applyFit();
    // xterm measures its character cell lazily on its first render, so the fit()
    // above can bail (0-width cell → FitAddon proposes nothing) and leave the
    // terminal at xterm's default 80×24. On a full-size container that's ≈ half
    // the real cols/rows, so a freshly-mounted terminal — e.g. after a project
    // switch, which remounts every tab — shows up at ~half size until something
    // resizes it. Re-fit on the first render, by which point the cell IS measured,
    // so the correct size lands within a frame instead of on a later stray resize.
    const firstRenderFit = term.onRender(() => {
      firstRenderFit.dispose();
      applyFit();
    });
    term.focus();

    // Clipboard: xterm forwards Ctrl-C to the PTY as SIGINT and has no built-in
    // copy, so selecting text then pressing Ctrl-C / right-clicking would just
    // clear the selection instead of copying. Wire copy from xterm's own
    // selection model (works regardless of the app-wide `select-none`).
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const mod = event.ctrlKey || event.metaKey;
      // Copy on Ctrl/Cmd+Shift+C, or Ctrl/Cmd+C when text is selected. With no
      // selection, Ctrl+C falls through to the PTY so it still interrupts.
      if (mod && event.code === "KeyC" && (event.shiftKey || term.hasSelection())) {
        const selection = term.getSelection();
        if (selection) {
          event.preventDefault();
          void writeClipboard(selection);
          return false;
        }
      }
      // Shift+Enter inserts a newline in an agent's prompt instead of submitting.
      // xterm has no distinct encoding for Shift+Enter — it sends a bare CR,
      // identical to Enter — so the agent can't tell them apart and submits.
      // Send the sequence agents recognize as "insert newline": ESC + CR
      // (`\x1b\r`, i.e. Meta+Enter) — exactly what Claude Code's `/terminal-setup`
      // binds Shift+Enter to. Scoped to agents so a shell's Shift+Enter still
      // behaves as a normal Enter. (Plain Shift only — Ctrl/Cmd/Alt fall through.)
      if (
        session.kind === "agent" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        void api.sendSessionInput(session.id, "\x1b\r");
        return false;
      }
      return true;
    });

    // Right-click copies the current selection. Both handlers are CAPTURE-phase
    // + stopPropagation so they run before xterm sees the event. The mousedown
    // handler is the important one: when an app has mouse reporting enabled, the
    // right-press is otherwise consumed by xterm (clearing the selection or
    // forwarding it to the app) before the contextmenu fires — so we copy on the
    // press itself. The contextmenu handler then suppresses the native menu.
    // With no selection we leave the event alone (native menu / app gets it).
    const onRightMouseDown = (event: MouseEvent) => {
      if (event.button === 2 && term.hasSelection()) {
        event.preventDefault();
        event.stopPropagation();
        void writeClipboard(term.getSelection());
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      if (term.hasSelection()) {
        event.preventDefault();
        event.stopPropagation();
        void writeClipboard(term.getSelection());
      }
    };
    container.addEventListener("mousedown", onRightMouseDown, true);
    container.addEventListener("contextmenu", onContextMenu, true);

    // --- Touch drag-to-scroll (mobile) -------------------------------------
    // The scrollable .xterm-viewport sits UNDER .xterm-screen, and xterm's
    // touch→mouse shim turns a drag into a selection/mouse-report event — so a
    // drag never scrolls natively. Translate a one-finger vertical drag into
    // term.scrollLines(). Direction is content-follows-finger (finger down →
    // older history). Touch events only fire on touch input, so desktop
    // mouse/trackpad (xterm's own wheel handler) is unaffected.
    let touchY: number | null = null; // last clientY of the active 1-finger drag
    let touchAccum = 0; // unconsumed vertical px delta
    let touchRowHeight = 0; // px per row, measured at touchstart
    let touchDragging = false; // crossed the slop threshold → we own the gesture
    const onTouchStart = (event: TouchEvent) => {
      // Ignore multi-touch (pinch) and full-screen TUIs (alt-screen has no
      // scrollback — leave those touches to xterm).
      if (event.touches.length !== 1 || term.buffer.active.type === "alternate") {
        touchY = null;
        return;
      }
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      touchRowHeight =
        screen && term.rows > 0
          ? screen.clientHeight / term.rows
          : (term.options.fontSize ?? 13) * 1.2;
      touchY = event.touches[0].clientY;
      touchAccum = 0;
      touchDragging = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY === null || event.touches.length !== 1) {
        return;
      }
      const y = event.touches[0].clientY;
      touchAccum += touchY - y; // finger up → positive → scroll toward newer
      touchY = y;
      if (!touchDragging && Math.abs(touchAccum) < SCROLL_SLOP_PX) {
        return; // small move: let xterm have tap / long-press
      }
      touchDragging = true;
      event.preventDefault(); // stop native scroll + xterm's touch→mouse select
      event.stopPropagation(); // stop the document-level shim (bubble phase)
      if (touchRowHeight > 0 && Math.abs(touchAccum) >= touchRowHeight) {
        const lines = Math.trunc(touchAccum / touchRowHeight);
        term.scrollLines(lines);
        touchAccum -= lines * touchRowHeight;
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (touchDragging) {
        event.preventDefault(); // swallow the synthetic tap/click after a drag
        event.stopPropagation();
      }
      touchY = null;
      touchDragging = false;
    };
    // passive:false so preventDefault() works inside the move handler.
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);

    // --- File drop & paste → upload + path injection -----------------------
    // dragenter/dragover must preventDefault so the browser allows a drop here;
    // we also track a `dragging` state for the highlight. A dragleave that
    // crosses into a child still bubbles, so only clear when actually leaving
    // the container (relatedTarget outside it).
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !container.contains(next)) {
        setDragging(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (files.length > 0) {
        void handleFilesRef.current(files);
      }
    };
    // Paste handling, registered in the CAPTURE phase so it runs before xterm's
    // own textarea paste handler (a descendant) and can take over cleanly:
    //   • files/images  → upload + inject paths, and stop the event so xterm
    //                      doesn't also paste.
    //   • agent text     → bracket it ourselves (see bracketPaste) and stop the
    //                      event; xterm's bracketed-paste mode is unreliable
    //                      after a capture-pane replay, so a multi-line paste
    //                      would otherwise submit at the first line.
    //   • other text     → fall through untouched so xterm pastes natively.
    // Raw clipboard images arrive as `items` of kind "file" with no filename →
    // synthesize pasted-<id>.<ext> from the MIME subtype.
    const onPaste = (event: ClipboardEvent) => {
      const clip = event.clipboardData;
      if (!clip) {
        return;
      }
      const files: File[] = Array.from(clip.files);
      // The same file can appear in both `clip.files` and `clip.items` as
      // distinct File instances, so dedup by identity (name+size+type+mtime)
      // rather than reference — otherwise it would upload twice.
      const fileKey = (file: File) => `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
      const seen = new Set(files.map(fileKey));
      for (const item of Array.from(clip.items)) {
        if (item.kind !== "file") {
          continue;
        }
        const file = item.getAsFile();
        if (!file) {
          continue;
        }
        if (seen.has(fileKey(file))) {
          continue;
        }
        seen.add(fileKey(file));
        // Clipboard images often have no usable name (e.g. "image.png" or "").
        if (file.name) {
          files.push(file);
        } else {
          // Strip any MIME parameters (e.g. "text/plain; charset=utf-8") before
          // taking the subtype, mirroring the daemon's split(";") handling.
          const subtype = (item.type.split(";")[0] || "").split("/")[1] || "bin";
          const ext = subtype.replace(/[^a-z0-9]/gi, "") || "bin";
          // Crypto-based id (mirrors the daemon's randomUUID().slice(0, 8)) so
          // the synthesized name isn't predictable. This is only a hint — the
          // daemon re-sanitizes and re-prefixes the final on-disk name.
          const id = crypto.randomUUID().slice(0, 8);
          files.push(new File([file], `pasted-${id}.${ext}`, { type: item.type }));
        }
      }
      if (files.length > 0) {
        // Capture phase: stop here so xterm's own paste handler doesn't fire too.
        event.preventDefault();
        event.stopImmediatePropagation();
        void handleFilesRef.current(files);
        return;
      }
      // Plain text. Agents get an explicitly-bracketed paste (robust against the
      // mode desync above); every other session kind falls through to xterm.
      if (session.kind === "agent") {
        const text = clip.getData("text/plain");
        if (!text) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        void api.sendSessionInput(session.id, bracketPaste(text));
      }
    };
    container.addEventListener("dragenter", onDragEnter);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("dragleave", onDragLeave);
    container.addEventListener("drop", onDrop);
    // Capture phase (true): see onPaste — must run before xterm's textarea handler.
    container.addEventListener("paste", onPaste, true);

    const inputSub = term.onData((data) => {
      // The user is responding → clear any bell-driven attention pulse.
      useAppStore.getState().clearSessionAttention(session.id);
      void api.sendSessionInput(session.id, data);
    });

    // Agents ring the terminal bell (BEL) when they finish / want attention.
    // Treat it as an explicit "your turn": go idle now (skip the quiescence wait)
    // and pulse the status dot. Scoped to agents so a shell's completion beep
    // doesn't masquerade as "waiting for you".
    const bellSub =
      session.kind === "agent"
        ? term.onBell(() => useAppStore.getState().noteSessionBell(session.id))
        : null;

    const resizeObserver = new ResizeObserver(() => applyFit());
    resizeObserver.observe(container);

    // After the daemon replays a session's scrollback, force a running agent TUI
    // (claude/codex) to repaint itself. The replay is a `tmux capture-pane`
    // snapshot — a static, imperfect reproduction of a live full-screen TUI. On a
    // fresh mount (e.g. switching projects in the sidebar) the new terminal re-fits
    // to the size the daemon pane ALREADY has, so the follow-up resize is a no-op:
    // no SIGWINCH reaches the agent, it never redraws over the snapshot, and the
    // terminal looks mangled until the next genuine resize (which is why toggling
    // grid/tab view "fixes" it). The replay's arrival (first output chunk — the
    // daemon installs the live subscriber immediately after sending it) is our cue
    // to nudge the pane size by one row and back: two real size changes →
    // SIGWINCHes → a clean self-repaint. Only the daemon pane is resized, never
    // xterm, so xterm's own grid never reflows. Re-armed on every replay (onReset)
    // so a socket reconnect heals the same way.
    let repaintArmed = true;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    let repaintRaf: number | undefined;
    const forceAgentRepaint = (tries = 0) => {
      if (!repaintArmed) {
        return;
      }
      // The nudge MUST use the real on-screen size. Our trigger is the scrollback
      // replay, and on a fresh mount (a project switch remounts every tab) that
      // replay can arrive BEFORE xterm has measured its character cell, so
      // term.{cols,rows} is still xterm's 80×24 default — nudging it would resize
      // the PTY down to 80×24 (the "shrinks on project switch" bug). applyFit()
      // fits to the real size once measurable.
      applyFit();
      if (!hasLayoutBox(container) || !fit.proposeDimensions()) {
        // Not a real on-screen size yet. If we're VISIBLE but the cell just isn't
        // measured (the replay paints on the next frame), retry on a frame instead
        // of waiting for the next output chunk — an idle agent paused at a prompt
        // sends nothing else, so the mangled capture-pane snapshot would stay
        // garbled until the user types. If hidden, stay armed; the next chunk (or
        // showing the tab) re-triggers us.
        if (hasLayoutBox(container) && tries < 120) {
          cancelAnimationFrame(repaintRaf ?? 0);
          repaintRaf = requestAnimationFrame(() => forceAgentRepaint(tries + 1));
        }
        return;
      }
      repaintArmed = false;
      if (term.rows <= 1) {
        return;
      }
      // Shrink the daemon pane by a row (a genuine change → SIGWINCH)…
      void api.resizeSession(session.id, term.cols, term.rows - 1);
      // …then restore to xterm's CURRENT size (re-read, in case a real resize
      // landed meanwhile) so the agent ends matched to xterm. The gap keeps the
      // two changes from coalescing into one no-op SIGWINCH.
      nudgeTimer = setTimeout(() => {
        void api.resizeSession(session.id, term.cols, term.rows);
      }, REPAINT_NUDGE_MS);
    };

    const stream = api.openSessionOutput(session.id, {
      onData: (chunk) => {
        term.write(chunk);
        forceAgentRepaint();
        // Output flowing → working; re-arms the quiescence timer (guarded so a
        // streaming burst doesn't churn the store).
        useAppStore.getState().noteSessionActivity(session.id);
      },
      onEnd: () => term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n"),
      // Multiplexed socket reconnected → clear before the buffer replay so the
      // existing content isn't duplicated.
      onReset: () => {
        term.reset();
        repaintArmed = true;
      }
    });

    return () => {
      container.removeEventListener("mousedown", onRightMouseDown, true);
      container.removeEventListener("contextmenu", onContextMenu, true);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
      container.removeEventListener("dragenter", onDragEnter);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("dragleave", onDragLeave);
      container.removeEventListener("drop", onDrop);
      container.removeEventListener("paste", onPaste, true);
      stream.close();
      if (nudgeTimer) {
        clearTimeout(nudgeTimer);
      }
      if (repaintRaf) {
        cancelAnimationFrame(repaintRaf);
      }
      inputSub.dispose();
      bellSub?.dispose();
      firstRenderFit.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [api, session.id]);

  // Apply a live font-size change (from the mobile A−/A+ buttons) without
  // recreating the terminal: mutate the option, refit (recomputes cols/rows),
  // and push the new size to the daemon PTY — the same path applyFit() uses.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.fontSize = fontSize;
    // Skip the fit+resize while hidden (same trap as applyFit); setting the
    // option is enough — the reveal-time ResizeObserver fits to the new metrics.
    const container = containerRef.current;
    if (!container || !hasLayoutBox(container)) {
      return;
    }
    try {
      fitRef.current?.fit();
    } catch {
      /* container not measurable yet */
    }
    void api.resizeSession(session.id, term.cols, term.rows);
  }, [fontSize, api, session.id]);

  // Auto-clear a transient status line so it doesn't linger.
  useEffect(() => {
    if (!status) {
      return;
    }
    const timer = window.setTimeout(() => setStatus(null), status.kind === "uploading" ? 2000 : 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Focus the active terminal when it becomes active OR when the view mode
  // toggles (clicking the tab/grid toggle moves focus to that button; switching
  // tabs blurs the previous terminal). Mount-time focus only runs once, so
  // without this typing silently goes nowhere after those interactions.
  useEffect(() => {
    if (active) {
      termRef.current?.focus();
      // Looking at the session acknowledges any bell-driven attention pulse.
      useAppStore.getState().clearSessionAttention(session.id);
    }
  }, [active, viewMode, session.id]);

  // Outer wrapper is the positioning context for the drag overlay + status
  // line; the inner div is the dedicated xterm host the ResizeObserver watches,
  // so the overlays never perturb xterm's fit/layout.
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#0a0a0a] p-2" />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded ring-2 ring-inset ring-blue-400/70 bg-blue-400/10">
          <span className="rounded bg-zinc-900/80 px-3 py-1 text-xs text-zinc-100">
            Drop to attach to this session
          </span>
        </div>
      )}
      {status && (
        <div
          className={`pointer-events-none absolute bottom-2 left-2 rounded px-2 py-1 text-xs ${
            status.kind === "uploading" ? "bg-zinc-800/90 text-zinc-100" : "bg-red-500/90 text-white"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
};
