/**
 * One ready device, live (spec §10.1): its stream in the 3D or flat frame, touch and keyboard
 * input, the controller pill and handoff, the agent overlay, the toolbar, and the action log.
 *
 * - Connects only while `visible` (the panel is on screen and the page is not hidden).
 * - The root is `data-device-view` (the app's shortcuts stand down inside it) and focusable: keys
 *   go to the device while it has focus, paste types the clipboard's text, and a 1×1 input raises a
 *   phone's keyboard.
 * - The first touch or key on a device the agent drives takes control (`setDeviceController`) with
 *   a quiet toast; the pill's Give back returns it.
 */

import React from "react";
import { Hand, Loader2, RefreshCw, VideoOff } from "lucide-react";

import { DEVICE_PROFILES, type DeviceActionEntry, type DeviceController, type DeviceLeaseSummary } from "@orquester/api";

import { attachmentRefFromUpload } from "../../lib/agent-chat/transport";
import type { ApiClient } from "../../lib/api-client";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { deliverToComposerDraft } from "../../lib/composer-inbox";
import { deviceViewKey, effectiveDeviceViewMode, readDeviceViewPrefs, writeDeviceViewPrefs, type DeviceViewPrefs } from "../../lib/devices/device-view-prefs";
import { useDeviceHosts } from "../../lib/devices/hooks";
import { logLocalDeviceAction } from "../../lib/devices/local-actions";
import { runDeviceUserAction, setDeviceController } from "../../lib/devices/store";
import { DeviceAgentOverlay } from "./DeviceAgentOverlay";
import { DeviceActionLog } from "./DeviceActionLog";
import type { ActionLogRow } from "./action-log.logic";
import { gestureSummary } from "./action-log.logic";
import {
  controllerPill,
  deviceFoldUrl,
  deviceKeyOf,
  deviceStreamUrls,
  hostStreamCaps,
  inputTakesOver,
  nextRotation,
  rotateControl,
  takeOverToast
} from "./device-panel.logic";
import { DeviceToolbar, type ToolbarLayout } from "./DeviceToolbar";
import { requestAndroidFold, type AndroidFoldState } from "./fold";
import { screenshotTurn, uprightCanvas } from "./screenshot";
import { useDeviceStream, type DeviceButton, type DeviceOrientation } from "./stream";
import { androidFoldAngle } from "./three/DeviceAndroidFoldControls";
import { DeviceViewport, type DeviceViewportHandle, type DeviceViewUnavailable } from "./three/DeviceViewport";

const BUTTON_WORDS: Record<DeviceButton, string> = { home: "Pressed Home", back: "Pressed Back", recents: "Opened the app switcher", power: "Pressed Power" };
const NEXT_ORIENTATION: Record<DeviceOrientation, DeviceOrientation> = {
  portrait: "landscape_left",
  landscape_left: "portrait",
  landscape_right: "portrait",
  portrait_upside_down: "portrait"
};
const NOT_READY = "Waiting for the device's input to connect";

function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function errorText(err: unknown): string {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
}

/** The pill above the device: who drives it, and the handoff button. */
export function ControllerPill(props: { lease: DeviceLeaseSummary; agentName: string; busy: boolean; onChange: (controller: DeviceController) => void }) {
  const pill = controllerPill(props.lease, props.agentName);
  if (!pill) return null;
  const agent = pill.tone === "agent";
  return (
    <div
      className={cn(
        "pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full py-1 pl-2.5 pr-1 text-[12px] shadow-sm ring-1 backdrop-blur",
        agent ? "bg-warn-500/10 text-warn ring-warn-500/35" : "bg-neutral-900/85 text-neutral-200 ring-neutral-700/70"
      )}
      role="status"
      data-controller={props.lease.controller}
    >
      <span aria-hidden className="relative flex h-2 w-2 shrink-0">
        {agent ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60 motion-reduce:animate-none" /> : null}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", agent ? "bg-warn" : "bg-info")} />
      </span>
      <span className="min-w-0 truncate font-medium">{pill.text}</span>
      <button
        type="button"
        disabled={props.busy}
        onClick={() => props.onChange(pill.action.controller)}
        onPointerDown={(event) => event.preventDefault()}
        className={cn(
          "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50",
          agent ? "bg-warn/90 text-neutral-950 hover:bg-warn" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
        )}
      >
        {pill.action.label}
      </button>
    </div>
  );
}

export interface DeviceLiveViewProps {
  api: ApiClient | null;
  lease: DeviceLeaseSummary;
  name: string;
  agentName: string;
  /** The visible chat (screenshots land in its composer). */
  sessionId: string;
  visible: boolean;
  layout: ToolbarLayout;
  actions: readonly DeviceActionEntry[];
  logRows: readonly ActionLogRow[];
  logOpen: boolean;
  onToggleLog: () => void;
  logLoading: boolean;
  logError: string | null;
  onRelease: (shutdown: boolean) => void;
  releasing: boolean;
  /** A short-lived notice in the panel ("Copied", errors). */
  onNotice: (text: string, tone?: "info" | "danger") => void;
}

export function DeviceLiveView(props: DeviceLiveViewProps): React.ReactElement {
  const { lease, api } = props;
  const docVisible = useDocumentVisible();
  const urls = React.useMemo(() => (api ? deviceStreamUrls(api, lease) : null), [api, lease.hostId, lease.stream?.kind, lease.stream?.deviceParam]);
  // Retry: one render with the stream off, then on again (a fresh connection).
  const [restarting, setRestarting] = React.useState(false);
  React.useEffect(() => {
    if (restarting) setRestarting(false);
  }, [restarting]);
  const viewport = React.useRef<DeviceViewportHandle>(null);
  const streamUrls = React.useMemo(
    () => ({ video: urls?.video ?? "", ...(urls?.input ? { input: urls.input } : {}), ...(urls?.screenshot ? { screenshot: urls.screenshot } : {}) }),
    [urls]
  );
  // iOS: H.264 (and with it the 3D view) only where the host says its encoder works (physical Macs).
  const h264 = hostStreamCaps(useDeviceHosts(), lease.hostId).h264;
  const hostCaps = React.useMemo(() => ({ h264 }), [h264]);
  const stream = useDeviceStream({
    platform: lease.platform,
    urls: streamUrls,
    hostCaps,
    enabled: props.visible && docVisible && urls !== null && !restarting,
    onFrame: () => viewport.current?.notifyFrame()
  });

  // --- View mode (per device model, persisted) ---------------------------------------------
  const viewKey = deviceViewKey(lease);
  const [prefs, setPrefs] = React.useState<DeviceViewPrefs>(() => readDeviceViewPrefs(viewKey));
  React.useEffect(() => setPrefs(readDeviceViewPrefs(viewKey)), [viewKey]);
  const mode = effectiveDeviceViewMode(prefs, stream.transport);
  const [unavailable, setUnavailable] = React.useState<DeviceViewUnavailable | null>(null);
  const setMode = (next: "3d" | "flat") => {
    const value = { mode: next };
    setPrefs(value);
    writeDeviceViewPrefs(viewKey, value);
    if (next === "3d") setUnavailable(null);
  };

  // --- Control handoff ---------------------------------------------------------------------
  const [controllerBusy, setControllerBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const tookOver = React.useRef(false);
  React.useEffect(() => {
    if (lease.controller === "agent") tookOver.current = false;
  }, [lease.controller]);
  React.useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const changeController = React.useCallback(
    (controller: DeviceController, why: "button" | "input") => {
      if (!api || controllerBusy) return;
      setControllerBusy(true);
      void setDeviceController(api, lease.id, controller)
        .then(() => {
          logLocalDeviceAction(lease.id, controller === "user" ? "Took control" : `Gave control back to ${props.agentName}`);
          if (why === "input") setToast(takeOverToast(props.agentName));
          else setToast(null);
        })
        .catch((err) => props.onNotice(errorText(err), "danger"))
        .finally(() => setControllerBusy(false));
    },
    [api, controllerBusy, lease.id, props.agentName, props.onNotice]
  );
  /** Any input: the first one on an agent-driven device takes over. */
  const noteInput = React.useCallback(() => {
    if (!inputTakesOver(lease) || tookOver.current) return;
    tookOver.current = true;
    changeController("user", "input");
  }, [lease, changeController]);

  // --- Touch -------------------------------------------------------------------------------
  const gesture = React.useRef<{ x: number; y: number; at: number; lastX: number; lastY: number } | null>(null);
  const onTouch = React.useCallback(
    (phase: "begin" | "move" | "end", x: number, y: number) => {
      stream.sendTouch(phase, x, y);
      if (phase === "begin") {
        noteInput();
        gesture.current = { x, y, at: Date.now(), lastX: x, lastY: y };
      } else if (phase === "move" && gesture.current) {
        gesture.current.lastX = x;
        gesture.current.lastY = y;
      } else if (phase === "end" && gesture.current) {
        const start = gesture.current;
        gesture.current = null;
        logLocalDeviceAction(lease.id, gestureSummary(start, { x, y }, Date.now() - start.at));
      }
    },
    [stream.sendTouch, noteInput, lease.id]
  );

  // --- Keyboard ----------------------------------------------------------------------------
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const hiddenInput = React.useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = React.useState(false);
  const typedRun = React.useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null });
  const noteTyping = (chars: number) => {
    const run = typedRun.current;
    run.count += chars;
    if (run.timer) clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      logLocalDeviceAction(lease.id, `Typed ${run.count} character${run.count === 1 ? "" : "s"}`);
      run.count = 0;
      run.timer = null;
    }, 1200);
  };
  React.useEffect(
    () => () => {
      if (typedRun.current.timer) clearTimeout(typedRun.current.timer);
    },
    []
  );
  const onKey = (event: React.KeyboardEvent, phase: "down" | "up") => {
    if (event.nativeEvent.isComposing) return;
    // Keys typed into the menus or buttons stay theirs.
    const target = event.target as HTMLElement;
    if (target !== rootRef.current && target !== hiddenInput.current) return;
    // The phone keyboard's text arrives as `beforeinput`; only its non-text keys come here.
    if (target === hiddenInput.current && (event.key.length === 1 || event.key === "Backspace" || event.key === "Unidentified")) return;
    // Paste is the browser's: it fires `paste`.
    if (phase === "down" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (!stream.inputReady) return;
    if (phase === "down") noteInput();
    if (stream.sendKey(event, phase)) {
      event.preventDefault();
      event.stopPropagation();
      if (phase === "down" && event.key.length === 1) noteTyping(1);
    }
  };
  React.useEffect(() => {
    const input = hiddenInput.current;
    if (!input) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "insertText" || event.inputType === "insertReplacementText" || event.inputType === "insertCompositionText") {
        if (event.data) {
          noteInput();
          stream.sendText(event.data);
          noteTyping(event.data.length);
        }
        event.preventDefault();
      } else if (event.inputType === "deleteContentBackward") {
        stream.sendKey({ key: "Backspace", code: "Backspace" }, "down");
        stream.sendKey({ key: "Backspace", code: "Backspace" }, "up");
        event.preventDefault();
      } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        stream.sendKey({ key: "Enter", code: "Enter" }, "down");
        stream.sendKey({ key: "Enter", code: "Enter" }, "up");
        event.preventDefault();
      }
    };
    input.addEventListener("beforeinput", onBeforeInput);
    return () => input.removeEventListener("beforeinput", onBeforeInput);
  });
  const onPaste = (event: React.ClipboardEvent) => {
    const target = event.target as HTMLElement;
    if (target !== rootRef.current && target !== hiddenInput.current) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    noteInput();
    if (stream.sendText(text)) logLocalDeviceAction(lease.id, `Pasted ${text.length} character${text.length === 1 ? "" : "s"}`);
    else props.onNotice("The device isn't taking input yet.", "danger");
  };
  const toggleKeyboard = () => {
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (focused) {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    (touch ? hiddenInput.current : rootRef.current)?.focus();
  };

  // --- Buttons, rotation, screenshot ----------------------------------------------------------
  const pressButton = (button: DeviceButton) => {
    noteInput();
    if (stream.sendButton(button)) logLocalDeviceAction(lease.id, BUTTON_WORDS[button]);
    else props.onNotice("The device isn't taking input yet.", "danger");
  };
  const orientation: DeviceOrientation = stream.screenConfig?.orientation ?? "portrait";
  // The daemon's user actions (not hub input): it hands control to the user and logs them as theirs.
  const [pending, setPending] = React.useState<"rotate" | "restart_app" | null>(null);
  const userAction = (kind: "rotate" | "restart_app") => {
    if (!api || pending) return;
    if (inputTakesOver(lease) && !tookOver.current) {
      tookOver.current = true;
      setToast(takeOverToast(props.agentName));
    }
    setPending(kind);
    runDeviceUserAction(api, lease.id, kind === "rotate" ? { kind, orientation: nextRotation(orientation) } : { kind })
      .then(({ entry }) => {
        if (kind === "restart_app") props.onNotice(entry.summary);
      })
      .catch((err) => props.onNotice(errorText(err), "danger"))
      .finally(() => setPending(null));
  };
  const rotate = () => {
    // Android emulators turn through their accelerometer (the daemon), so the captured video turns too.
    if (lease.platform === "android") {
      userAction("rotate");
      return;
    }
    noteInput();
    const next = NEXT_ORIENTATION[orientation];
    if (stream.sendOrientation(next)) logLocalDeviceAction(lease.id, next.startsWith("landscape") ? "Rotated to landscape" : "Rotated to portrait");
  };
  const [shooting, setShooting] = React.useState(false);
  const screenshot = async (download: boolean) => {
    const canvas = stream.canvas;
    if (!canvas || canvas.width === 0) return;
    setShooting(true);
    try {
      // serve-sim's frames stay portrait while iOS is in landscape: turn the capture upright.
      const frame = uprightCanvas(canvas, screenshotTurn(lease.platform, { width: canvas.width, height: canvas.height }, orientation));
      const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The frame could not be captured.");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `${(props.name || "device").replace(/[^\w.-]+/g, "-")}-${stamp}.png`;
      if (download || !api) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        logLocalDeviceAction(lease.id, "Downloaded a screenshot");
        return;
      }
      const uploaded = await api.uploadSessionFile(props.sessionId, { name, type: "image/png" }, blob, () => {});
      deliverToComposerDraft(props.sessionId, { text: "", attachments: [attachmentRefFromUpload(uploaded, { name, type: "image/png" })] });
      logLocalDeviceAction(lease.id, "Added a screenshot to the message");
      props.onNotice("Screenshot added to your message");
    } catch (err) {
      logLocalDeviceAction(lease.id, "Screenshot", { ok: false, error: errorText(err) });
      props.onNotice(errorText(err), "danger");
    } finally {
      setShooting(false);
    }
  };

  // --- Fold (Android foldables) -------------------------------------------------------------
  const profile = DEVICE_PROFILES.find((entry) => entry.id === lease.profile);
  const foldable = lease.platform === "android" && profile?.formFactor === "foldable";
  const foldUrl = api && foldable ? deviceFoldUrl(api, lease) : null;
  const [fold, setFold] = React.useState<AndroidFoldState | null>(null);
  const [foldPending, setFoldPending] = React.useState(false);
  const [foldError, setFoldError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!foldUrl || !props.visible) return;
    const abort = new AbortController();
    requestAndroidFold(foldUrl, undefined, abort.signal).then(setFold, (err) => {
      if (!abort.signal.aborted) setFoldError(errorText(err));
    });
    return () => abort.abort();
  }, [foldUrl, props.visible]);
  const changeFold = (posture: "closed" | "opened") => {
    if (!foldUrl) return;
    noteInput();
    setFoldPending(true);
    setFoldError(null);
    requestAndroidFold(foldUrl, posture)
      .then((state) => {
        setFold(state);
        logLocalDeviceAction(lease.id, posture === "closed" ? "Folded the device" : "Unfolded the device");
      })
      .catch((err) => setFoldError(errorText(err)))
      .finally(() => setFoldPending(false));
  };

  // --- Derived ------------------------------------------------------------------------------
  const live = stream.state === "live" || stream.state === "stalled";
  const inputControl = { enabled: stream.inputReady, reason: stream.inputReady ? null : NOT_READY };
  const screenSize = stream.screenConfig ? { width: stream.screenConfig.width, height: stream.screenConfig.height } : null;
  const inputBlocked = stream.screenConfig?.inputUnavailable === true;

  const toolbar = (
    <DeviceToolbar
      layout={props.layout}
      platform={lease.platform}
      input={inputControl}
      onButton={pressButton}
      rotate={{ ...rotateControl(lease.platform, { inputReady: stream.inputReady, live, pending: pending === "rotate" }), onRotate: rotate }}
      screenshot={{ enabled: live && !shooting, reason: shooting ? "Taking a screenshot…" : "Waiting for video", pending: shooting, onShot: (download) => void screenshot(download) }}
      keyboard={{ enabled: stream.inputReady, reason: NOT_READY, active: focused, onToggle: toggleKeyboard }}
      view={{
        mode: unavailable ? "flat" : mode,
        unavailable: unavailable?.message ?? null,
        enabled: true,
        onMode: setMode,
        onReset: () => viewport.current?.resetView()
      }}
      {...(foldable
        ? {
            fold: {
              posture: fold?.posture ?? null,
              pending: foldPending,
              enabled: Boolean(foldUrl) && (fold?.supported ?? true),
              error: foldError,
              onChange: changeFold
            }
          }
        : {})}
      more={{
        releasing: props.releasing,
        restarting: pending === "restart_app",
        onRestartApp: () => userAction("restart_app"),
        onRelease: () => props.onRelease(false),
        onPowerOff: () => props.onRelease(true),
        onCopyKey: () => {
          void copyText(deviceKeyOf(lease)).then((ok) => props.onNotice(ok ? "Device key copied" : "Couldn't copy the device key", ok ? "info" : "danger"));
        }
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      data-device-view=""
      tabIndex={0}
      aria-label={`${props.name}. Keys and paste go to the device while it has focus.`}
      className="group/device relative flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => onKey(event, "down")}
      onKeyUp={(event) => onKey(event, "up")}
      onPaste={onPaste}
      onFocus={() => setFocused(rootRef.current?.contains(document.activeElement) === true && (document.activeElement === rootRef.current || document.activeElement === hiddenInput.current))}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next !== rootRef.current && next !== hiddenInput.current) {
          setFocused(false);
          viewport.current?.cancelInput();
        }
      }}
    >
      <div className="flex shrink-0 justify-center px-3 pt-2.5">
        <ControllerPill lease={lease} agentName={props.agentName} busy={controllerBusy} onChange={(controller) => changeController(controller, "button")} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          className={cn(
            "relative m-2 min-h-0 min-w-0 flex-1 rounded-2xl transition-shadow motion-reduce:transition-none",
            focused && "ring-1 ring-info/50"
          )}
        >
          <DeviceViewport
            ref={viewport}
            source={stream.canvas}
            platform={lease.platform}
            deviceName={lease.name}
            profileName={lease.profile}
            screen={screenSize}
            orientation={orientation}
            mode={mode}
            onTouch={onTouch}
            onModeUnavailable={setUnavailable}
            foldAngle={foldable ? androidFoldAngle(fold?.posture ?? null, fold?.hingeAngle ?? null) : null}
          />
          <DeviceAgentOverlay
            entries={props.actions}
            screen={lease.screen}
            orientation={orientation}
            project={(x, y) => viewport.current?.projectPoint(x, y) ?? null}
            active={live}
          />
          {!live ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 text-center" aria-live="polite">
              {stream.state === "error" ? (
                <div className="mx-6 flex max-w-xs flex-col items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950/90 px-4 py-3">
                  <VideoOff size={18} aria-hidden className="text-danger" />
                  <p className="text-[12px] leading-relaxed text-neutral-300">{stream.error?.message ?? "The video stopped."}</p>
                  <button
                    type="button"
                    onClick={() => setRestarting(true)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-neutral-100 px-2.5 py-1 text-[12px] font-medium text-neutral-900 hover:bg-white"
                  >
                    <RefreshCw size={12} aria-hidden />
                    Retry
                  </button>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-full bg-neutral-950/80 px-3 py-1.5 text-[12px] text-neutral-400 ring-1 ring-neutral-800">
                  <Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" />
                  {docVisible ? "Connecting video…" : "Paused while the page is hidden"}
                </div>
              )}
            </div>
          ) : null}
          {stream.state === "stalled" ? (
            <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full bg-neutral-950/85 px-2.5 py-1 text-[11px] text-neutral-400 ring-1 ring-neutral-800">
              Waiting for device video…
            </div>
          ) : null}
          {inputBlocked ? (
            <div className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full bg-neutral-950/85 px-2.5 py-1 text-[11px] text-warn ring-1 ring-warn-500/30">
              Another viewer holds this simulator's input
            </div>
          ) : null}
          {toast ? (
            <div className="absolute bottom-3 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-900/95 py-1 pl-2.5 pr-1 text-[11.5px] text-neutral-200 shadow-lg ring-1 ring-neutral-700" role="status">
              <Hand size={12} aria-hidden className="shrink-0 text-info" />
              <span className="truncate">{toast}</span>
              <button
                type="button"
                onClick={() => changeController("agent", "button")}
                onPointerDown={(event) => event.preventDefault()}
                className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-200 hover:bg-neutral-700"
              >
                Give back
              </button>
            </div>
          ) : focused && live ? (
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-neutral-950/80 px-2.5 py-1 text-[11px] text-neutral-400 ring-1 ring-neutral-800 transition-opacity group-hover/device:opacity-100">
              Typing goes to {props.name}
            </div>
          ) : null}
        </div>
        {props.layout === "rail" ? <div className="flex shrink-0 flex-col justify-center py-2 pr-2">{toolbar}</div> : null}
      </div>
      {props.layout === "bar" ? <div className="shrink-0 px-2 pb-2">{toolbar}</div> : null}
      <DeviceActionLog
        rows={props.logRows}
        open={props.logOpen}
        onToggle={props.onToggleLog}
        loading={props.logLoading}
        error={props.logError}
        {...(props.layout === "bar" ? { maxHeight: 220 } : {})}
      />
      {/* An on-screen 1×1 input for phone keyboards (iOS raises none for an off-screen field); 16px so iOS doesn't zoom. */}
      <input
        ref={hiddenInput}
        aria-label={`Type on ${props.name}`}
        className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
        style={{ fontSize: 16 }}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
      />
    </div>
  );
}
