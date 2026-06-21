import React, { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApi } from "../../context/orquester-context";
import type { SessionSummary } from "../../types";
import type { ViewMode } from "../../lib/view-mode";

const FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: FONT_STACK,
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 8000,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      theme: THEME
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // NB: we intentionally use xterm's default DOM renderer rather than the
    // WebGL addon. The WebGL renderer leaves terminals blank/garbled after a
    // resize (e.g. toggling the grid/tab layout) or when revealed from a hidden
    // tab; the DOM renderer repaints reliably across those transitions.

    const applyFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
      void api.resizeSession(session.id, term.cols, term.rows);
    };
    applyFit();
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
      return true;
    });

    // Right-click copies the current selection (keeping it highlighted); with
    // no selection the browser's native context menu is left untouched.
    const onContextMenu = (event: MouseEvent) => {
      const selection = term.getSelection();
      if (selection) {
        event.preventDefault();
        void writeClipboard(selection);
      }
    };
    container.addEventListener("contextmenu", onContextMenu);

    const inputSub = term.onData((data) => {
      void api.sendSessionInput(session.id, data);
    });

    const resizeObserver = new ResizeObserver(() => applyFit());
    resizeObserver.observe(container);

    const stream = api.openSessionOutput(session.id, {
      onData: (chunk) => term.write(chunk),
      onEnd: () => term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n"),
      // Multiplexed socket reconnected → clear before the buffer replay so the
      // existing content isn't duplicated.
      onReset: () => term.reset()
    });

    return () => {
      container.removeEventListener("contextmenu", onContextMenu);
      stream.close();
      inputSub.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [api, session.id]);

  // Focus the active terminal when it becomes active OR when the view mode
  // toggles (clicking the tab/grid toggle moves focus to that button; switching
  // tabs blurs the previous terminal). Mount-time focus only runs once, so
  // without this typing silently goes nowhere after those interactions.
  useEffect(() => {
    if (active) {
      termRef.current?.focus();
    }
  }, [active, viewMode]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#0a0a0a] p-2" />;
};
