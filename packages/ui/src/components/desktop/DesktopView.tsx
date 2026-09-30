/// <reference path="../../types/novnc.d.ts" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Power, RotateCw } from "lucide-react";
import type RFB from "@novnc/novnc";
import { desktopRoutes, type DesktopSummary, type DesktopWindow, type DesktopWindowAction } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { useMediaQuery } from "../../hooks/use-media-query";
import { useDesktopAudio } from "../../lib/desktop-audio";
import { readDesktopPrefs, writeDesktopPrefs, type DesktopPrefs } from "../../lib/desktop-prefs";
import {
  DESKTOP_COMPRESSION_LEVEL,
  DESKTOP_QUALITY_INITIAL,
  initialDesktopQuality,
  nextDesktopQuality
} from "../../lib/desktop-quality";
import { openDesktopVncChannel, type DesktopVncChannel } from "../../lib/desktop-vnc-socket";
import { DesktopToolbar } from "./DesktopToolbar";
import { DesktopAppsDialog, DesktopInfoDialog } from "./DesktopDialogs";
import { DesktopKeyStrip, useDesktopHiddenInput } from "./DesktopKeyboard";
import { MODIFIER_KEYSYM, XK, keysymsForText, type LatchModifier } from "./desktop-keys";

export interface DesktopViewProps {
  desktop: DesktopSummary;
  /** This tab is the active tab of the visible project view. */
  active: boolean;
  /** Open the launch dialog targeting this desktop (toolbar "+"). */
  onLaunchApp: () => void;
  /** Close the tab through the normal close flow (confirmation if apps run). */
  onCloseTab: () => void;
}

type RfbCtor = typeof RFB;
type ConnState = "idle" | "connecting" | "connected" | "reconnecting";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** RTT samples (one per 2 s) to spend getting a fixed size applied before giving up. */
const FIXED_SIZE_ATTEMPTS = 5;
const DISPLAY_BACKGROUND = "rgb(10, 10, 10)";

// noVNC is loaded on first use: it is only needed once a desktop tab is shown,
// and its `core/util/browser.js` has a top-level await that is better kept out
// of the app's entry chunk.
let rfbModule: Promise<RfbCtor> | null = null;
function loadRfb(): Promise<RfbCtor> {
  rfbModule ??= import("@novnc/novnc").then((m) => m.default).catch((err: unknown) => {
    rfbModule = null; // a failed chunk load may succeed on the next attempt
    throw err;
  });
  return rfbModule;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Apply a view mode to a live RFB.
 *
 * - **Fit:** `scaleViewport`, and `resizeSession` only while this viewer
 *   `drives` (it has focus or just got local input) — so with several viewers
 *   the one last used sets the display size and the others scale it.
 * - **Fixed, scale:** the shared display at whatever size it is, scaled to fit.
 * - **Fixed, pan:** 1:1, clipped to the tab, drag to pan (`clipViewport` +
 *   `dragViewport`).
 */
function applyView(rfb: RFB, prefs: DesktopPrefs, driving: boolean): void {
  if (prefs.view === "fit") {
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.scaleViewport = true;
    rfb.resizeSession = driving;
  } else if (prefs.fixedMode === "pan") {
    rfb.resizeSession = false;
    rfb.scaleViewport = false;
    rfb.clipViewport = true;
    rfb.dragViewport = true;
  } else {
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.scaleViewport = true;
  }
}

/**
 * Ask the server for exactly `size`, using noVNC's public API only.
 *
 * noVNC 1.7 has no "request W×H" call. With `resizeSession` on, it requests
 * the size of its screen element (the `width/height: 100%` div it appends to
 * the target), measured with `getBoundingClientRect()` synchronously inside the
 * `resizeSession` setter. So for one synchronous moment the target is laid out
 * at W×H CSS px, `resizeSession` goes on (noVNC measures and sends
 * SetDesktopSize) and straight back off, and the inline size is restored. No
 * frame is painted in between, and noVNC's ResizeObserver sees no change.
 *
 * A CSS-transform wrapper (lay the target out at W×H and scale it visually)
 * does not work: noVNC maps pointer coordinates through getBoundingClientRect
 * divided by its own display scale, so a transformed ancestor skews every
 * click.
 *
 * noVNC silently drops the request before the server has announced
 * ExtendedDesktopSize (the first framebuffer update), while an earlier resize
 * is pending, or within 100 ms of the last one; the caller retries on the next
 * RTT sample until `desktop.size` reports the new size.
 */
function requestRemoteSize(rfb: RFB, target: HTMLElement, size: { width: number; height: number }): void {
  const { style } = target;
  const saved = { right: style.right, bottom: style.bottom, width: style.width, height: style.height };
  style.right = "auto";
  style.bottom = "auto";
  style.width = `${size.width}px`;
  style.height = `${size.height}px`;
  try {
    rfb.resizeSession = true;
    rfb.resizeSession = false;
  } finally {
    style.right = saved.right;
    style.bottom = saved.bottom;
    style.width = saved.width;
    style.height = saved.height;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function DesktopView({ desktop, active, onLaunchApp, onCloseTab }: DesktopViewProps) {
  const api = useAppStore((s) => s.api);
  const visible = useDocumentVisible();
  const narrow = !useMediaQuery("(min-width: 640px)");
  const touch = useMediaQuery("(pointer: coarse)");

  const rootRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const rfbRef = useRef<RFB | null>(null);

  const [prefs, setPrefs] = useState<DesktopPrefs>(() => readDesktopPrefs(desktop.id));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;

  const [conn, setConn] = useState<ConnState>("idle");
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [qualityLevel, setQualityLevel] = useState(DESKTOP_QUALITY_INITIAL);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [desktopName, setDesktopName] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restart" | "stop" | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [latched, setLatched] = useState<ReadonlySet<LatchModifier>>(() => new Set());
  const latchedRef = useRef(latched);
  latchedRef.current = latched;
  const [installHint, setInstallHint] = useState<string | null>(null);

  const vncAvailable = useMemo(() => api?.desktopSocketUrl(desktopRoutes.vncSocket(desktop.id)) != null, [api, desktop.id]);
  const audioUrl = useMemo(() => api?.desktopSocketUrl(desktopRoutes.audioSocket(desktop.id)) ?? null, [api, desktop.id]);
  const audio = useDesktopAudio({
    url: audioUrl,
    active: active && visible && desktop.status === "running",
    muted: prefs.muted,
    volume: prefs.volume
  });

  // Prefs follow the desktop id (a remount normally, but be safe).
  useEffect(() => {
    setPrefs(readDesktopPrefs(desktop.id));
  }, [desktop.id]);

  // ---- Size handover -------------------------------------------------------

  // Fit mode: this viewer drives the display size while it has focus or just
  // received local input, and stops on blur / input elsewhere.
  const drivingRef = useRef(false);
  const setDriving = useCallback((on: boolean) => {
    drivingRef.current = on;
    const rfb = rfbRef.current;
    if (rfb && prefsRef.current.view === "fit") rfb.resizeSession = on;
  }, []);

  // Fixed mode: the size is requested once per connection and per choice, and
  // retried (on RTT samples) until the daemon reports it or attempts run out.
  const fixedRequestRef = useRef<{ key: string; attempts: number } | null>(null);
  const tryFixedRequest = useCallback(() => {
    const request = fixedRequestRef.current;
    const rfb = rfbRef.current;
    const target = targetRef.current;
    const { view, fixedSize } = prefsRef.current;
    if (!request || !rfb || !target || view !== "fixed" || !fixedSize) return;
    if (request.key !== `${fixedSize.width}x${fixedSize.height}`) return;
    const current = desktopRef.current.size;
    if (current.width === fixedSize.width && current.height === fixedSize.height) {
      fixedRequestRef.current = null;
      return;
    }
    if (request.attempts >= FIXED_SIZE_ATTEMPTS) {
      fixedRequestRef.current = null;
      return;
    }
    request.attempts += 1;
    requestRemoteSize(rfb, target, fixedSize);
  }, []);
  const armFixedRequest = useCallback(() => {
    const { view, fixedSize } = prefsRef.current;
    fixedRequestRef.current =
      view === "fixed" && fixedSize ? { key: `${fixedSize.width}x${fixedSize.height}`, attempts: 0 } : null;
    tryFixedRequest();
  }, [tryFixedRequest]);

  // The daemon reporting the size we asked for settles the request.
  useEffect(() => {
    tryFixedRequest();
  }, [desktop.size.width, desktop.size.height, tryFixedRequest]);

  // ---- Connection ----------------------------------------------------------

  const shouldConnect = active && visible && desktop.status === "running" && vncAvailable;

  useEffect(() => {
    const target = targetRef.current;
    if (!shouldConnect || !api || !target) return;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let rfb: RFB | null = null;
    let channel: DesktopVncChannel | null = null;

    const scheduleRetry = () => {
      if (disposed) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      setConn("reconnecting");
      retryTimer = setTimeout(() => void start(), delay);
    };

    const start = async () => {
      retryTimer = null;
      let Rfb: RfbCtor;
      try {
        Rfb = await loadRfb();
      } catch (err) {
        if (disposed) return;
        setConnError(`Could not load the viewer: ${errorText(err)}`);
        scheduleRetry();
        return;
      }
      if (disposed) return;
      const url = api.desktopSocketUrl(desktopRoutes.vncSocket(desktop.id));
      if (!url) return;

      let quality = initialDesktopQuality();
      setQualityLevel(quality.level);
      const ownChannel = openDesktopVncChannel(url, {
        onRtt: (ms) => {
          if (disposed) return;
          setRttMs(ms);
          quality = nextDesktopQuality(quality, ms);
          if (rfb && rfb.qualityLevel !== quality.level) {
            rfb.qualityLevel = quality.level;
            setQualityLevel(quality.level);
          }
          tryFixedRequest();
        }
      });
      channel = ownChannel;
      let r: RFB;
      try {
        r = new Rfb(target, ownChannel, { shared: true });
      } catch (err) {
        ownChannel.close();
        channel = null;
        setConnError(errorText(err));
        scheduleRetry();
        return;
      }
      rfb = r;
      rfbRef.current = r;
      r.background = DISPLAY_BACKGROUND;
      r.focusOnClick = true;
      r.qualityLevel = DESKTOP_QUALITY_INITIAL;
      r.compressionLevel = DESKTOP_COMPRESSION_LEVEL;
      applyView(r, prefsRef.current, drivingRef.current);

      r.addEventListener("connect", () => {
        if (disposed || rfb !== r) return;
        attempt = 0;
        setConn("connected");
        setConnError(null);
        // Opening/activating the tab in a focused window counts as local
        // input: a lone viewer should fit the tab without an extra click.
        if (document.hasFocus()) {
          const focused = document.activeElement;
          if (!focused || focused === document.body) r.focus({ preventScroll: true });
          setDriving(true);
        }
        // The view effect re-applies the mode and arms the fixed-size request
        // once `conn` flips to "connected".
        applyView(r, prefsRef.current, drivingRef.current);
      });
      r.addEventListener("disconnect", () => {
        if (rfbRef.current === r) rfbRef.current = null;
        if (disposed || rfb !== r) return;
        rfb = null;
        channel = null;
        scheduleRetry();
      });
      r.addEventListener("securityfailure", (e) => {
        if (!disposed) setConnError(e.detail.reason ?? `Security failure (${e.detail.status})`);
      });
      r.addEventListener("clipboard", (e) => {
        const text = e.detail.text;
        setRemoteClipboard(text);
        if (document.hasFocus()) {
          navigator.clipboard?.writeText(text).catch(() => undefined);
        }
      });
      r.addEventListener("desktopname", (e) => setDesktopName(e.detail.name));
    };

    setConn("connecting");
    void start();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (rfb) {
        try {
          rfb.disconnect();
        } catch {
          channel?.close();
        }
      } else {
        channel?.close();
      }
      setConn("idle");
    };
  }, [shouldConnect, api, desktop.id, setDriving, tryFixedRequest]);

  // Re-apply the view whenever it changes; choosing a fixed size requests it.
  const viewKey = `${prefs.view}:${prefs.fixedMode ?? ""}:${prefs.fixedSize?.width ?? 0}x${prefs.fixedSize?.height ?? 0}`;
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb || conn !== "connected") return;
    applyView(rfb, prefsRef.current, drivingRef.current);
    armFixedRequest();
    // armFixedRequest is stable; viewKey captures every view field.
  }, [viewKey, conn, armFixedRequest]);

  // Focus / input tracking for the Fit-mode handover.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inside = (node: EventTarget | null) => node instanceof Node && root.contains(node);
    const onLocalInput = () => setDriving(true);
    const onFocusIn = () => {
      if (document.hasFocus()) setDriving(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget !== null && !inside(e.relatedTarget)) setDriving(false);
    };
    const onDocPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) setDriving(false);
    };
    const onWindowBlur = () => setDriving(false);
    const onWindowFocus = () => {
      if (inside(document.activeElement)) setDriving(true);
    };
    // Paste chord on the display: keep it away from noVNC (which would send a
    // bare Ctrl+V, pasting the desktop's stale clipboard) and let the browser
    // fire a real `paste` event, handled below. Capture phase on the root runs
    // before noVNC's listener on its canvas.
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && targetRef.current?.contains(e.target as Node)) {
        e.stopPropagation();
      }
    };
    root.addEventListener("pointerdown", onLocalInput, true);
    root.addEventListener("keydown", onLocalInput, true);
    root.addEventListener("keydown", onKeyDownCapture, true);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      root.removeEventListener("pointerdown", onLocalInput, true);
      root.removeEventListener("keydown", onLocalInput, true);
      root.removeEventListener("keydown", onKeyDownCapture, true);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [setDriving]);

  // With the touch keyboard up, a tap on the display (noVNC focuses its canvas
  // on touchstart) must not dismiss it: hand focus back to the hidden input.
  const keyboardOpenRef = useRef(keyboardOpen);
  keyboardOpenRef.current = keyboardOpen;
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const onTouchEnd = () => {
      if (keyboardOpenRef.current) hiddenInputRef.current?.focus({ preventScroll: true });
    };
    target.addEventListener("touchend", onTouchEnd);
    return () => target.removeEventListener("touchend", onTouchEnd);
  }, []);

  // An error'd desktop may be a host problem: show the install hint if any.
  useEffect(() => {
    if (desktop.status !== "error" || !api) {
      setInstallHint(null);
      return;
    }
    const ctrl = new AbortController();
    api.desktopHostStatus(ctrl.signal).then(
      (host) => setInstallHint(host.available ? null : host.installHint),
      () => undefined
    );
    return () => ctrl.abort();
  }, [desktop.status, api]);

  // ---- Keys & clipboard ----------------------------------------------------

  /** Press and release `keysym` with the latched (and any extra) modifiers held. */
  const pressKeysym = useCallback((keysym: number, extra: LatchModifier[] = []) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    const mods = [...new Set<LatchModifier>([...latchedRef.current, ...extra])];
    for (const m of mods) rfb.sendKey(MODIFIER_KEYSYM[m], "", true);
    rfb.sendKey(keysym, "");
    for (const m of [...mods].reverse()) rfb.sendKey(MODIFIER_KEYSYM[m], "", false);
    if (latchedRef.current.size > 0) {
      latchedRef.current = new Set();
      setLatched(latchedRef.current);
    }
  }, []);

  const typeText = useCallback(
    (text: string) => {
      for (const keysym of keysymsForText(text)) pressKeysym(keysym);
    },
    [pressKeysym]
  );

  useDesktopHiddenInput(hiddenInputRef, typeText, pressKeysym);

  const toggleModifier = useCallback((m: LatchModifier) => {
    const next = new Set(latchedRef.current);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    latchedRef.current = next;
    setLatched(next);
  }, []);

  const sendClipboard = useCallback((text: string) => {
    rfbRef.current?.clipboardPasteFrom(text);
  }, []);

  // Local paste inside the view (the chord on the display, or the soft
  // keyboard's paste): hand the text to the desktop's clipboard, then Ctrl+V.
  const onPaste = (e: React.ClipboardEvent) => {
    // React bubbles synthetic events out of portals: a paste into the clipboard
    // popover's textarea must stay a normal paste.
    const where = e.target as Node;
    if (!rootRef.current?.contains(where)) return;
    if (where instanceof HTMLElement && where.isContentEditable) return;
    if ((where instanceof HTMLTextAreaElement || where instanceof HTMLInputElement) && where !== hiddenInputRef.current) return;
    const rfb = rfbRef.current;
    const text = e.clipboardData.getData("text/plain");
    if (!rfb || !text) return;
    e.preventDefault();
    rfb.clipboardPasteFrom(text);
    rfb.sendKey(XK.Control_L, "ControlLeft", true);
    rfb.sendKey(XK.v, "KeyV");
    rfb.sendKey(XK.Control_L, "ControlLeft", false);
  };

  // The toolbar button keeps focus where it is on pointerdown, so "is the
  // hidden input focused" is still true here when the keyboard is up.
  const toggleKeyboard = () => {
    const input = hiddenInputRef.current;
    if (keyboardOpen && input && document.activeElement === input) {
      setKeyboardOpen(false);
      input.blur();
    } else {
      setKeyboardOpen(true);
      // Inside the click: the trusted gesture iOS needs to raise the keyboard.
      input?.focus({ preventScroll: true });
    }
  };

  // ---- Actions -------------------------------------------------------------

  const updatePrefs = useCallback(
    (patch: Partial<DesktopPrefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        writeDesktopPrefs(desktop.id, next);
        return next;
      });
    },
    [desktop.id]
  );

  const runAction = async (kind: "restart" | "stop", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const restart = () => {
    if (!api) return;
    void runAction("restart", async () => {
      // The daemon restarts only a stopped desktop (409 otherwise).
      if (desktopRef.current.status === "running") await api.stopDesktop(desktop.id);
      await api.restartDesktop(desktop.id);
    });
  };
  const stop = () => {
    if (!api) return;
    void runAction("stop", () => api.stopDesktop(desktop.id));
  };
  const windowAction = (win: DesktopWindow, action: DesktopWindowAction) => {
    if (!api) return;
    api.desktopWindowAction(desktop.id, win.id, action).catch((err: unknown) => setActionError(errorText(err)));
  };

  // ---- Render --------------------------------------------------------------

  let overlay: React.ReactNode = null;
  const restartButton = (
    <button
      type="button"
      onClick={restart}
      disabled={busy !== null || !api}
      className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
    >
      {busy === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
      Restart
    </button>
  );
  if (!vncAvailable) {
    overlay = <span>Desktop tabs require a remote (HTTP) connection.</span>;
  } else if (desktop.status === "starting") {
    overlay = (
      <>
        <Loader2 size={20} className="animate-spin text-neutral-500" />
        <span>Starting desktop…</span>
      </>
    );
  } else if (desktop.status === "stopped") {
    overlay = (
      <>
        <Power size={20} className="text-neutral-500" />
        <span>Desktop stopped</span>
        {restartButton}
      </>
    );
  } else if (desktop.status === "error") {
    overlay = (
      <>
        <span className="text-danger">Desktop failed</span>
        {desktop.error && (
          <pre className="max-h-40 w-full max-w-lg overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-900 p-2 text-left font-mono text-[11px] text-neutral-300">
            {desktop.error}
          </pre>
        )}
        {installHint && (
          <div className="flex w-full max-w-lg flex-col gap-1 text-left">
            <span className="text-xs text-neutral-500">Missing host tools — install with:</span>
            <code className="select-all break-all rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-300">
              {installHint}
            </code>
          </div>
        )}
        {restartButton}
      </>
    );
  } else if (conn === "connecting" || conn === "idle") {
    overlay = active ? (
      <>
        <Loader2 size={20} className="animate-spin text-neutral-500" />
        <span>Connecting…</span>
      </>
    ) : null;
  } else if (conn === "reconnecting") {
    overlay = (
      <>
        <Loader2 size={20} className="animate-spin text-neutral-500" />
        <span>Reconnecting…</span>
        {connError && <span className="max-w-sm text-xs text-neutral-500">{connError}</span>}
      </>
    );
  }

  return (
    // `data-desktop-view` marks this subtree as owning its own keystrokes: the
    // app's global shortcuts (`SHORTCUT_BAIL_SELECTOR`) stand down inside it so
    // keys reach the desktop's apps.
    <div ref={rootRef} data-desktop-view className="flex h-full w-full flex-col bg-neutral-950" onPaste={onPaste}>
      <DesktopToolbar
        desktop={desktop}
        narrow={narrow}
        touch={touch}
        prefs={prefs}
        onPrefs={updatePrefs}
        audio={audio}
        connected={conn === "connected"}
        remoteClipboard={remoteClipboard}
        keyboardOpen={keyboardOpen}
        onToggleKeyboard={toggleKeyboard}
        onSendClipboard={sendClipboard}
        onWindowAction={windowAction}
        onLaunchApp={onLaunchApp}
        onOpenApps={() => setAppsOpen(true)}
        onOpenInfo={() => setInfoOpen(true)}
        onRestart={restart}
        onStop={stop}
        onCloseTab={onCloseTab}
      />
      {actionError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-danger-soft px-3 py-1 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate" title={actionError}>
            {actionError}
          </span>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* noVNC appends its own screen + canvas here; React renders no children into it. */}
        <div ref={targetRef} className="absolute inset-0 touch-none" />
        {overlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-neutral-950/90 px-4 py-6 text-center text-sm text-neutral-400">
            {overlay}
          </div>
        )}
        {/* Invisible ON-SCREEN input for the touch keyboard (iOS won't raise the
            keyboard for far-offscreen fields): 1×1 px, opacity 0, 16px font so
            iOS doesn't zoom on focus. */}
        <input
          ref={hiddenInputRef}
          aria-label="Desktop keyboard input"
          className="absolute bottom-0 left-0 h-px w-px opacity-0"
          style={{ fontSize: 16 }}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {touch && keyboardOpen && (
        <DesktopKeyStrip latched={latched} onToggleModifier={toggleModifier} onKey={(keysym) => pressKeysym(keysym)} />
      )}
      <DesktopAppsDialog open={appsOpen} onClose={() => setAppsOpen(false)} api={api} desktop={desktop} />
      <DesktopInfoDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        desktop={desktop}
        prefs={prefs}
        audio={audio}
        connection={{ state: conn, rttMs, qualityLevel, desktopName }}
      />
    </div>
  );
}
