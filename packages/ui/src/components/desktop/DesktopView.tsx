import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Power, RotateCw } from "lucide-react";
import { desktopRoutes, type DesktopSize, type DesktopSummary, type DesktopWindow, type DesktopWindowAction } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../hooks/use-media-query";
import { useSoftKeyboardOpen } from "../../hooks/use-soft-keyboard-open";
import { useDesktopAudio } from "../../lib/desktop-audio";
import { readDesktopPrefs, writeDesktopPrefs, type DesktopPrefs, type DesktopTextSize } from "../../lib/desktop-prefs";
import { DESKTOP_QUALITY_INITIAL } from "../../lib/desktop-quality";
import { backoffDelayMs, scheduleRetry as retryLater, type PendingRetry } from "../../lib/connection/backoff";
import { consumeLatchSet, latchSet, latchedNames, tapLatchIn, type LatchSet } from "../../lib/modifier-latch";
import { useVisualViewportBox } from "../workflows/phone/use-visual-viewport";
import { DesktopToolbar } from "./DesktopToolbar";
import { DesktopAppsDialog, DesktopInfoDialog } from "./DesktopDialogs";
import { DesktopKeyBar, useDesktopHiddenInput } from "./DesktopKeyboard";
import { DesktopTouchCursor, useDesktopTouch } from "./DesktopTouch";
import {
  LATCH_MODIFIERS,
  MODIFIER_KEYSYM,
  XK,
  keysymsForText,
  pasteKeystroke,
  shiftedKeysym,
  type LatchModifier,
  type PasteChord
} from "./desktop-keys";
import { TEXT_SIZE_DEBOUNCE_MS, textSizeDisplaySize } from "./desktop-text-size";
import { sharpFitAllowed } from "./desktop-viewport.logic";
import { createDesktopStreamClient } from "./stream/create-stream-client";
import type { DesktopStreamClient, DesktopStreamEvents, DesktopViewMode } from "./stream/types";
import { DesktopHandoffControls, DesktopHandoffLayer, useDesktopHandoff } from "./handoff/DesktopHandoff";
import { takeoverSink } from "../../lib/desktops/handoff.logic";

export interface DesktopViewProps {
  desktop: DesktopSummary;
  /** This tab is the active tab of the visible project view. */
  active: boolean;
  /** Open the launch dialog targeting this desktop (toolbar "+"). */
  onLaunchApp: () => void;
  /** Close the tab through the normal close flow (confirmation if apps run). */
  onCloseTab: () => void;
}

type ConnState = "idle" | "connecting" | "connected" | "reconnecting";

const RECONNECT_BACKOFF = { baseMs: 500, maxMs: 10_000 };
/** noVNC's own Mac/iOS test (`core/util/browser.js`): there it forwards Cmd as Alt. */
const APPLE_PLATFORM = typeof navigator !== "undefined" && /mac|ipad|iphone|ipod/i.test(navigator.platform);

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** Keyboard Lock (Chromium only; not in the DOM typings). */
function navigatorKeyboard(): { lock?: () => Promise<void>; unlock?: () => void } | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sameSize = (a: DesktopSize | null, b: DesktopSize | null) => a !== null && b !== null && a.width === b.width && a.height === b.height;

export function DesktopView({ desktop, active, onLaunchApp, onCloseTab }: DesktopViewProps) {
  const api = useAppStore((s) => s.api);
  const visible = useDocumentVisible();
  const narrow = !useMediaQuery("(min-width: 640px)");
  const coarse = useMediaQuery("(pointer: coarse)");

  const rootRef = useRef<HTMLDivElement>(null);
  /** The view's box: it takes the touch layer's pointer events and never transforms. */
  const viewportRef = useRef<HTMLDivElement>(null);
  /** Around the client's container: the local zoom's CSS transform goes here. */
  const stageRef = useRef<HTMLDivElement>(null);
  /** The stream client mounts its video here. */
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<DesktopStreamClient | null>(null);
  /** The modifiers of the paste chord the view held back from the client, until its `paste` event. */
  const pasteChordRef = useRef<PasteChord | null>(null);

  const [prefs, setPrefs] = useState<DesktopPrefs>(() => readDesktopPrefs(desktop.id));
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;

  const [conn, setConn] = useState<ConnState>("idle");
  const connRef = useRef(conn);
  connRef.current = conn;
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [qualityLevel, setQualityLevel] = useState(DESKTOP_QUALITY_INITIAL);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [desktopName, setDesktopName] = useState<string | null>(null);
  /** The display's size as the stream client reports it (the daemon's until it has). */
  const [streamSize, setStreamSize] = useState<DesktopSize | null>(null);
  const displaySize = streamSize ?? desktop.size;
  const displaySizeRef = useRef(displaySize);
  displaySizeRef.current = displaySize;
  const [connError, setConnError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restart" | "stop" | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [latches, setLatches] = useState<LatchSet<LatchModifier>>(() => latchSet(LATCH_MODIFIERS));
  const latchesRef = useRef(latches);
  latchesRef.current = latches;
  const [installHint, setInstallHint] = useState<string | null>(null);

  // ---- Touch -----------------------------------------------------------------

  // A touch device: a coarse pointer, or any touch seen on the view. The touch
  // layer, key bar and View-menu options are for those only (spec R3.8).
  const [touchSeen, setTouchSeen] = useState(false);
  const touch = coarse || touchSeen;
  const touchRef = useRef(touch);
  touchRef.current = touch;
  // Local zoom and sharp fit follow the last input: a mouse on a touch laptop
  // gets the plain view back.
  const [lastPointer, setLastPointer] = useState<"touch" | "fine" | null>(null);
  const touchRendering = touch && lastPointer !== "fine";
  const touchRenderingRef = useRef(touchRendering);
  touchRenderingRef.current = touchRendering;
  const inputMode = prefs.inputMode ?? "trackpad";
  /** The text-size preset in effect (touch devices only); `fit` lets `prefs.view` apply. */
  const textSize: DesktopTextSize = touch ? (prefs.textSize ?? "fit") : "fit";
  const textSizeRef = useRef(textSize);
  textSizeRef.current = textSize;
  // R2.3: while an agent works the desktop, no viewer changes its size.
  const agentControls = desktop.control?.controller === "agent";
  const agentControlsRef = useRef(agentControls);
  agentControlsRef.current = agentControls;

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
  /** `drivingRef` for rendering (sharp fit), updated only when it flips. */
  const [driving, setDrivingState] = useState(false);

  /** The client's view mode for the current prefs, handover and touch state. */
  const clientViewMode = useCallback((): DesktopViewMode => {
    const { view, fixedMode } = prefsRef.current;
    // A preset sizes the display itself (requestPreset); the client only scales it.
    if (textSizeRef.current !== "fit") return { kind: "fixed-scale" };
    if (view === "fit") return { kind: "fit", driveSize: drivingRef.current && !agentControlsRef.current };
    // Touch pans with the local zoom instead of noVNC's drag-to-pan.
    return fixedMode === "pan" && !touchRenderingRef.current ? { kind: "fixed-pan" } : { kind: "fixed-scale" };
  }, []);

  /** The size this viewer asked for and has not seen applied yet. */
  const pendingSizeRef = useRef<DesktopSize | null>(null);
  const requestDisplaySize = useCallback((size: DesktopSize) => {
    pendingSizeRef.current = size;
    clientRef.current?.requestSize(size);
  }, []);
  useEffect(() => {
    if (sameSize(pendingSizeRef.current, displaySize)) pendingSizeRef.current = null;
  }, [displaySize]);

  // Text-size presets: the display follows the view's size, debounced, while
  // this viewer drives it and no agent controls the desktop.
  const presetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestPreset = useCallback(() => {
    presetTimerRef.current = null;
    const preset = textSizeRef.current;
    const client = clientRef.current;
    const viewport = viewportRef.current;
    if (preset === "fit" || !client || !viewport || connRef.current !== "connected") return;
    if (!drivingRef.current || agentControlsRef.current) return;
    const rect = viewport.getBoundingClientRect();
    const size = textSizeDisplaySize(preset, { width: rect.width, height: rect.height }, window.devicePixelRatio || 1);
    if (size && !sameSize(size, displaySizeRef.current)) requestDisplaySize(size);
  }, [requestDisplaySize]);
  const schedulePreset = useCallback(() => {
    if (textSizeRef.current === "fit") return;
    if (presetTimerRef.current !== null) clearTimeout(presetTimerRef.current);
    presetTimerRef.current = setTimeout(requestPreset, TEXT_SIZE_DEBOUNCE_MS);
  }, [requestPreset]);
  useEffect(
    () => () => {
      if (presetTimerRef.current !== null) clearTimeout(presetTimerRef.current);
    },
    []
  );
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => schedulePreset());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [schedulePreset]);

  const setDriving = useCallback(
    (on: boolean) => {
      drivingRef.current = on;
      setDrivingState(on);
      const mode = clientViewMode();
      if (mode.kind === "fit") clientRef.current?.setViewMode(mode);
      if (on) schedulePreset();
    },
    [clientViewMode, schedulePreset]
  );

  // ---- Connection ----------------------------------------------------------

  const shouldConnect = active && visible && desktop.status === "running" && vncAvailable;

  useEffect(() => {
    const container = containerRef.current;
    if (!shouldConnect || !api || !container) return;
    let disposed = false;
    let attempt = 0;
    let retryTimer: PendingRetry | null = null;
    let client: DesktopStreamClient | null = null;

    const drop = () => {
      if (!client) return;
      if (clientRef.current === client) clientRef.current = null;
      client.dispose();
      client = null;
    };

    const scheduleRetry = () => {
      if (disposed) return;
      // Shared jittered backoff; a wake (back online, tab visible) redials at once.
      const delay = backoffDelayMs(attempt, RECONNECT_BACKOFF);
      attempt += 1;
      setConn("reconnecting");
      retryTimer = retryLater(delay, (woken) => {
        if (woken) attempt = 0;
        void start();
      });
    };

    const start = async () => {
      retryTimer = null;
      // A new client per attempt: the factory picks the backend each time.
      const c = createDesktopStreamClient(desktopRef.current, { socketUrl: (path) => api.desktopSocketUrl(path) });
      client = c;
      clientRef.current = c;
      c.setNativeInput(!touchRef.current);
      c.setViewMode(clientViewMode());
      const current = () => !disposed && client === c;
      const events: DesktopStreamEvents = {
        state: (state, reason) => {
          if (!current()) return;
          if (state === "connected") {
            attempt = 0;
            setConn("connected");
            setConnError(null);
            // Opening/activating the tab in a focused window counts as local
            // input: a lone viewer should fit the tab without an extra click.
            if (document.hasFocus()) {
              const focused = document.activeElement;
              if (!focused || focused === document.body) c.focus();
              setDriving(true);
            }
            // The view effect re-applies the mode and requests a fixed size
            // once `conn` flips to "connected".
          } else if (state === "disconnected") {
            if (reason) setConnError(reason);
            drop();
            scheduleRetry();
          }
        },
        size: (size) => {
          if (current()) setStreamSize(size);
        },
        clipboard: (text) => {
          if (current()) setRemoteClipboard(text);
        },
        stats: (stats) => {
          if (!current()) return;
          if (stats.rttMs !== undefined) setRttMs(stats.rttMs);
          if (stats.quality !== undefined) setQualityLevel(stats.quality);
        },
        name: (name) => {
          if (current()) setDesktopName(name);
        }
      };
      try {
        await c.connect(container, events);
      } catch (err) {
        if (!current()) return;
        setConnError(errorText(err));
        drop();
        scheduleRetry();
      }
    };

    setConn("connecting");
    void start();
    return () => {
      disposed = true;
      retryTimer?.cancel();
      drop();
      setConn("idle");
    };
  }, [shouldConnect, api, desktop.id, setDriving, clientViewMode]);

  // Re-apply the view whenever it changes. A fixed size or a preset is
  // requested only when what it depends on changes (a choice, a connection, an
  // agent giving the desktop back), not when the mode alone does (touch ↔
  // mouse), so another viewer's size is not taken back for nothing.
  const fixedKey = `${prefs.fixedSize?.width ?? 0}x${prefs.fixedSize?.height ?? 0}`;
  const requestKey = [prefs.view, fixedKey, textSize, agentControls, conn].join(":");
  const viewKey = [requestKey, prefs.fixedMode ?? "", touchRendering].join(":");
  const lastRequestKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    client.setViewMode(clientViewMode());
    const same = lastRequestKeyRef.current === requestKey;
    lastRequestKeyRef.current = requestKey;
    if (conn !== "connected" || agentControlsRef.current) return;
    if (same) {
      // setViewMode dropped the client's retries: renew a request not applied yet.
      if (pendingSizeRef.current) client.requestSize(pendingSizeRef.current);
      return;
    }
    pendingSizeRef.current = null;
    const { view, fixedSize } = prefsRef.current;
    if (textSizeRef.current !== "fit") schedulePreset();
    else if (view === "fixed" && fixedSize) requestDisplaySize(fixedSize);
    // viewKey captures every field the mode and the request read.
  }, [viewKey, requestKey, conn, clientViewMode, schedulePreset, requestDisplaySize]);

  // The client's own touch handling stays off on touch devices (the touch layer drives input).
  useEffect(() => {
    clientRef.current?.setNativeInput(!touch);
  }, [touch]);

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
    // Paste chord on the display: keep it away from the client (which would
    // send a bare Ctrl+V, pasting the desktop's stale clipboard) and let the
    // browser fire a real `paste` event, handled below. Capture phase on the
    // root runs before the client's listeners inside its container.
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && containerRef.current?.contains(e.target as Node)) {
        e.stopPropagation();
        pasteChordRef.current = { shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
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

  const keyboardOpenRef = useRef(keyboardOpen);
  keyboardOpenRef.current = keyboardOpen;

  /** Hand the keyboard to the display (to the hidden input while the touch keyboard is up). */
  const focusDisplay = useCallback(() => {
    if (keyboardOpenRef.current) hiddenInputRef.current?.focus({ preventScroll: true });
    else clientRef.current?.focus();
  }, []);

  // A window that became active (raised from the window list, launched from
  // the dialog, left on top when another closed) gets the keys typed next: the
  // display takes the focus back from a toolbar button or a closed dialog,
  // never from a field the user is typing in or from outside the view.
  useEffect(() => {
    if (!active || conn !== "connected" || desktop.activeWindowId === null) return;
    const focused = document.activeElement;
    const idle =
      !focused ||
      focused === document.body ||
      (focused instanceof HTMLButtonElement && rootRef.current?.contains(focused) === true);
    if (idle) focusDisplay();
  }, [desktop.activeWindowId, active, conn, focusDisplay]);

  // ---- Fullscreen ------------------------------------------------------------

  // The whole page goes fullscreen (the toolbar's menus and dialogs are portals
  // on <body>, which an element-fullscreen would hide) and the view covers it.
  // Keyboard Lock (Chromium) then routes browser and system shortcuts — Ctrl+W,
  // Ctrl+T, Ctrl+N, Alt+Tab, Esc — to the desktop instead of closing the tab;
  // holding Esc leaves fullscreen.
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenAvailable = typeof document !== "undefined" && document.fullscreenEnabled === true;
  useEffect(() => {
    if (!fullscreen) return;
    const onChange = () => {
      if (document.fullscreenElement !== document.documentElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    // Fullscreen may already have ended (Esc) before this listener existed.
    onChange();
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      navigatorKeyboard()?.unlock?.();
      // Unmounted while fullscreen (the tab closed): leave it.
      if (document.fullscreenElement === document.documentElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [fullscreen]);
  // Leaving the tab (or the desktop stopping) leaves fullscreen too.
  useEffect(() => {
    if (fullscreen && (!active || desktop.status !== "running") && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [fullscreen, active, desktop.status]);
  const toggleFullscreen = () => {
    if (fullscreen) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setFullscreen(false);
      return;
    }
    // Inside the click: requestFullscreen needs the user gesture.
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(
      () => {
        setFullscreen(true);
        void navigatorKeyboard()?.lock?.().catch(() => undefined);
        focusDisplay();
      },
      (err: unknown) => setActionError(`Fullscreen is not available: ${errorText(err)}`)
    );
  };
  // Fullscreen covers the layout viewport; on touch devices it follows the
  // visual one instead, so the soft keyboard never covers the desktop (R3.4).
  const viewportBox = useVisualViewportBox(fullscreen && touch);

  // An error'd desktop may be a host problem: show the install hint if any.
  useEffect(() => {
    if (desktop.status !== "error" || !api) {
      setInstallHint(null);
      return;
    }
    const ctrl = new AbortController();
    // boxes: a VM desktop's prerequisites are its VM's.
    api.desktopHostStatus(ctrl.signal, desktop.box?.id ? desktop.projectPath : undefined).then(
      (host) => setInstallHint(host.available ? null : host.installHint),
      () => undefined
    );
    return () => ctrl.abort();
  }, [desktop.status, api, desktop.box?.id, desktop.projectPath]);

  // ---- Keys & clipboard ----------------------------------------------------

  /** What the touch layer, key bar and soft keyboard send: the client, and the agent handoff's implicit takeover. */
  const handoffInputRef = useRef<() => void>(() => undefined);
  const inputSink = useMemo(() => takeoverSink(() => clientRef.current, () => handoffInputRef.current()), []);

  /** The latched modifiers apply to one key or click: spend the one-shots. */
  const spendLatches = useCallback(() => {
    const next = consumeLatchSet(latchesRef.current);
    if (next === latchesRef.current) return;
    latchesRef.current = next;
    setLatches(next);
  }, []);

  /** Press and release `keysym` with the latched (and any extra) modifiers held. */
  const pressKeysym = useCallback(
    (keysym: number, extra: LatchModifier[] = []) => {
      if (!clientRef.current) return;
      const latched = latchedNames(latchesRef.current);
      const mods = LATCH_MODIFIERS.filter((m) => latched.includes(m) || extra.includes(m));
      const key = mods.includes("shift") ? shiftedKeysym(keysym) : keysym;
      for (const m of mods) inputSink.key(MODIFIER_KEYSYM[m], true);
      inputSink.key(key, true);
      inputSink.key(key, false);
      for (const m of [...mods].reverse()) inputSink.key(MODIFIER_KEYSYM[m], false);
      spendLatches();
    },
    [spendLatches, inputSink]
  );

  const typeText = useCallback(
    (text: string) => {
      for (const keysym of keysymsForText(text)) pressKeysym(keysym);
    },
    [pressKeysym]
  );

  useDesktopHiddenInput(hiddenInputRef, typeText, pressKeysym);

  const tapModifier = useCallback((m: LatchModifier, timeStamp: number) => {
    const next = tapLatchIn(latchesRef.current, m, timeStamp);
    latchesRef.current = next;
    setLatches(next);
  }, []);

  /** The touch layer's clicks and drags hold the latched modifiers too. */
  const takeModifiers = useCallback(() => {
    const keys = latchedNames(latchesRef.current).map((m) => MODIFIER_KEYSYM[m]);
    spendLatches();
    return keys;
  }, [spendLatches]);

  const touchStore = useDesktopTouch({
    viewportRef,
    stageRef,
    client: () => clientRef.current,
    sink: inputSink,
    displaySize,
    connected: conn === "connected",
    rendering: touchRendering,
    sharp: sharpFitAllowed({
      touchRendering,
      fitDrivesSize: textSize === "fit" && prefs.view === "fit" && driving && !agentControls,
      textSize
    }),
    directPen: touch,
    mode: inputMode,
    takeModifiers,
    onTouch: () => {
      setTouchSeen(true);
      setLastPointer("touch");
    },
    onFinePointer: () => setLastPointer("fine"),
    focusDisplay
  });

  // The Clipboard panel's Send. This machine's clipboard gets the text too:
  // a paste chord on the display hands that clipboard over first, so it would
  // otherwise replace what was just sent with whatever was copied before.
  const sendClipboard = useCallback((text: string) => {
    clientRef.current?.setClipboard(text);
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  /** Hand `text` (when there is any) to the desktop's clipboard, then send its paste keystroke. */
  const pasteIntoDesktop = useCallback(
    (text: string, chord: PasteChord | null) => {
      if (!clientRef.current) return;
      if (text) inputSink.setClipboard(text);
      for (const step of pasteKeystroke(chord, APPLE_PLATFORM)) inputSink.key(step.keysym, step.down, step.code);
    },
    [inputSink]
  );

  // Local paste inside the view (the chord on the display, or the soft
  // keyboard's paste): hand the text to the desktop's clipboard, then Ctrl+V.
  // With no text here (an empty clipboard, an image) the desktop pastes its own.
  const onPaste = (e: React.ClipboardEvent) => {
    // React bubbles synthetic events out of portals: a paste into the clipboard
    // popover's textarea must stay a normal paste.
    const where = e.target as Node;
    if (!rootRef.current?.contains(where)) return;
    if (where instanceof HTMLElement && where.isContentEditable) return;
    if ((where instanceof HTMLTextAreaElement || where instanceof HTMLInputElement) && where !== hiddenInputRef.current) return;
    const text = e.clipboardData.getData("text/plain");
    const chord = pasteChordRef.current;
    pasteChordRef.current = null;
    if (!clientRef.current) return;
    e.preventDefault();
    pasteIntoDesktop(text, chord);
  };

  // The key bar's Paste (iOS keyboards have no paste key): read this device's
  // clipboard inside the tap's gesture.
  const pasteFromKeyBar = () => {
    // A paste is not a key: it disarms a one-shot modifier rather than carry it.
    spendLatches();
    const read = navigator.clipboard?.readText?.();
    if (!read) {
      setActionError("Clipboard unavailable — allow paste access and try again.");
      return;
    }
    read.then(
      (text) => pasteIntoDesktop(text, null),
      () => setActionError("Clipboard unavailable — allow paste access and try again.")
    );
  };

  // The key bar is up while the soft keyboard is, and can be toggled.
  const softKeyboard = useSoftKeyboardOpen();
  const sawSoftKeyboardRef = useRef(false);
  useEffect(() => {
    if (!touch) return;
    if (softKeyboard && document.activeElement === hiddenInputRef.current) {
      sawSoftKeyboardRef.current = true;
      setKeyboardOpen(true);
    } else if (!softKeyboard && sawSoftKeyboardRef.current) {
      // Dismissed with the system's own control: the bar goes with it.
      sawSoftKeyboardRef.current = false;
      setKeyboardOpen(false);
    }
  }, [softKeyboard, touch]);

  // The toolbar button keeps focus where it is on pointerdown, so "is the
  // hidden input focused" is still true here when the keyboard is up.
  const toggleKeyboard = () => {
    const input = hiddenInputRef.current;
    if (keyboardOpen && input && document.activeElement === input) {
      hideKeyboard();
    } else {
      setKeyboardOpen(true);
      // A keyboard dismissed by the system leaves the input focused: refocus to raise it again.
      if (input && document.activeElement === input) input.blur();
      // Inside the click: the trusted gesture iOS needs to raise the keyboard.
      input?.focus({ preventScroll: true });
    }
  };
  const hideKeyboard = () => {
    sawSoftKeyboardRef.current = false;
    setKeyboardOpen(false);
    keyboardOpenRef.current = false;
    hiddenInputRef.current?.blur();
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
    // The window the user picked takes the keys typed next, not the pill.
    if (action !== "close") focusDisplay();
    api.desktopWindowAction(desktop.id, win.id, action).catch((err: unknown) => setActionError(errorText(err)));
  };

  // ---- Agent handoff (spec 2026-11-10 §3) ----------------------------------
  const handoff = useDesktopHandoff({ root: rootRef, viewport: viewportRef, stage: stageRef }, desktop, conn === "connected");
  handoffInputRef.current = handoff.inputReachedDesktop;

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
  // Why it stopped or failed (a host exit, a VM that restarted or went away).
  const errorNote = desktop.error && (
    <pre className="max-h-40 w-full max-w-lg overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-800 bg-neutral-900 p-2 text-left font-mono text-[11px] text-neutral-300">
      {desktop.error}
    </pre>
  );
  if (!vncAvailable) {
    overlay = <span>Desktop tabs require a remote (HTTP) connection.</span>;
  } else if (desktop.status === "starting") {
    overlay = (
      <>
        <Loader2 size={20} className="animate-spin text-neutral-500" />
        <span>Starting desktop…</span>
        {/* boxes: what a VM desktop is waiting on (its VM, the desktop packages' install). */}
        {desktop.statusDetail && <span className="max-w-sm truncate text-xs text-neutral-500">{desktop.statusDetail}</span>}
      </>
    );
  } else if (desktop.status === "stopped") {
    overlay = (
      <>
        <Power size={20} className="text-neutral-500" />
        <span>Desktop stopped</span>
        {errorNote}
        {restartButton}
      </>
    );
  } else if (desktop.status === "error") {
    overlay = (
      <>
        <span className="text-danger">Desktop failed</span>
        {errorNote}
        {installHint && (
          <div className="flex w-full max-w-lg flex-col gap-1 text-left">
            <span className="text-xs text-neutral-500">{desktop.box ? "In the VM:" : "Missing host tools — install with:"}</span>
            <code className="select-all break-all rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-300">
              {installHint}
            </code>
          </div>
        )}
        {restartButton}
      </>
    );
  } else if (desktop.box && !desktop.box.connected) {
    // boxes: the VM's link is down; the desktop keeps running there.
    overlay = (
      <>
        <Loader2 size={20} className="animate-spin text-neutral-500" />
        <span>The VM is not connected</span>
        <span className="max-w-sm text-xs text-neutral-500">The desktop keeps running there; the view comes back with the VM.</span>
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
    <div
      ref={rootRef}
      data-desktop-view
      className={cn("flex flex-col bg-neutral-950", fullscreen ? "app-no-drag fixed inset-0 z-[90]" : "h-full w-full")}
      style={fullscreen && touch ? { top: viewportBox.top, height: viewportBox.height, bottom: "auto" } : undefined}
      onPaste={onPaste}
    >
      <DesktopToolbar
        desktop={desktop}
        narrow={narrow}
        touch={touch}
        panAvailable={!touchRendering}
        prefs={prefs}
        onPrefs={updatePrefs}
        audio={audio}
        connected={conn === "connected"}
        remoteClipboard={remoteClipboard}
        keyboardOpen={keyboardOpen}
        onToggleKeyboard={toggleKeyboard}
        fullscreen={fullscreen}
        onToggleFullscreen={fullscreenAvailable ? toggleFullscreen : null}
        fullscreenLocksKeys={typeof navigatorKeyboard()?.lock === "function"}
        onSendClipboard={sendClipboard}
        onWindowAction={windowAction}
        onLaunchApp={onLaunchApp}
        onOpenApps={() => setAppsOpen(true)}
        onOpenInfo={() => setInfoOpen(true)}
        onRestart={restart}
        onStop={stop}
        onCloseTab={onCloseTab}
        handoff={<DesktopHandoffControls handoff={handoff} narrow={narrow} />}
      />
      {actionError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-danger-soft px-3 py-1 text-xs text-danger" data-desktop-handoff="">
          <span className="min-w-0 flex-1 truncate" title={actionError}>
            {actionError}
          </span>
          <button type="button" onClick={() => setActionError(null)} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          // R3.7: no page pan/zoom, selection or long-press callout on touch.
          touch && "touch-none select-none [-webkit-touch-callout:none]"
        )}
      >
        <div ref={stageRef} className="absolute inset-0">
          {/* The stream client appends its video here; React renders no children into it. */}
          <div ref={containerRef} className="absolute inset-0 touch-none" />
        </div>
        {touchRendering && inputMode === "trackpad" && conn === "connected" && <DesktopTouchCursor store={touchStore} />}
        <DesktopHandoffLayer handoff={handoff} streamRoot={containerRef} display={desktop.size} />
        {overlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-neutral-950/90 px-4 py-6 text-center text-sm text-neutral-400">
            {overlay}
          </div>
        )}
        {/* Invisible ON-SCREEN input for the touch keyboard (iOS won't raise the
            keyboard for far-offscreen fields): 1×1 px, opacity 0, 16px font so
            iOS doesn't zoom on focus. `select-text`: iOS won't type into a field
            inside a user-select: none box. */}
        <input
          ref={hiddenInputRef}
          aria-label="Desktop keyboard input"
          className="absolute bottom-0 left-0 h-px w-px select-text opacity-0"
          style={{ fontSize: 16 }}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {touch && keyboardOpen && (
        <DesktopKeyBar
          latches={latches}
          onTapModifier={tapModifier}
          onKey={pressKeysym}
          onCtrlAltDel={() => pressKeysym(XK.Delete, ["ctrl", "alt"])}
          onPaste={pasteFromKeyBar}
          onHide={hideKeyboard}
        />
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
