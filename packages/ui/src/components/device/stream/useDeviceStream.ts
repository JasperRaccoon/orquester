/**
 * `useDeviceStream` owns one device's live stream while `enabled` (the panel is
 * visible): it creates the canvas the decoder paints (hand it to
 * `<DeviceViewport source={canvas}>` and forward `onFrame` to its
 * `notifyFrame()`), picks the transport, opens the video session and input
 * channel, and tears everything down when disabled or unmounted.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { capabilities, chooseTransport, type BrowserStreamCaps, type HostStreamCaps } from "./capabilities.ts";
import { mapKeyboardEvent, type KeyboardEventLike, type KeyPhase } from "./keymap.ts";
import { createPointerThrottle, type PointerThrottle } from "./pointer.ts";
import { ScreenshotPollSession } from "./screenshots.ts";
import { ServeEmuSession } from "./serveEmu.ts";
import { ServeSimH264Session } from "./serveSimH264.ts";
import { ServeSimInputSocket, type ServeSimButton } from "./serveSimInput.ts";
import { ServeSimMjpegSession } from "./serveSimMjpeg.ts";
import {
  DeviceStreamError,
  type DeviceButton,
  type DeviceOrientation,
  type DevicePlatform,
  type DeviceScreenConfig,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceTransport,
  type DeviceVideoSession,
  type StreamDeps,
  type TouchPhase
} from "./types.ts";

export interface DeviceStreamUrls {
  /**
   * The video URL, auth already added: the serve-emu WebSocket (Android), or
   * serve-sim `stream.avcc` / `stream.mjpeg` (iOS; the other is derived by
   * swapping the file name).
   */
  readonly video: string;
  /** iOS: the serve-sim helper input WebSocket. Android input rides the video socket. */
  readonly input?: string;
  /** iOS: MJPEG URL, when it isn't `video` with `stream.avcc` → `stream.mjpeg`. */
  readonly mjpeg?: string;
  /** Android: screenshot URL for browsers that can't decode H.264. */
  readonly screenshot?: string;
}

export interface UseDeviceStreamOptions {
  readonly platform: DevicePlatform;
  readonly urls: DeviceStreamUrls;
  /** Connect only while true (the panel is visible). */
  readonly enabled: boolean;
  /** Force a transport; otherwise chosen from browser and host capabilities. */
  readonly transport?: DeviceTransport;
  readonly hostCaps?: HostStreamCaps;
  /** A frame was painted into `canvas` (call the viewport's `notifyFrame()`). Not a render trigger. */
  readonly onFrame?: () => void;
  readonly onWarning?: (message: string) => void;
  /** Test seam: browser APIs for the sessions. */
  readonly deps?: Partial<StreamDeps>;
  /** Test seam: browser capabilities instead of probing WebCodecs. */
  readonly browserCaps?: BrowserStreamCaps;
}

export interface DeviceStreamHandle {
  /** The canvas the stream paints; null only without a DOM. Stable for the hook's lifetime. */
  readonly canvas: HTMLCanvasElement | null;
  readonly state: DeviceStreamState;
  readonly error: DeviceStreamError | null;
  /** Refreshed once a second while connected (debug tooltip). */
  readonly stats: DeviceStreamStats | null;
  /** The transport in use, or null while capabilities are probed. */
  readonly transport: DeviceTransport | null;
  /** iOS: serve-sim's screen config; Android: the decoded frame size. */
  readonly screenConfig: DeviceScreenConfig | null;
  /** Input is accepted (iOS admitted, Android socket open). */
  readonly inputReady: boolean;
  /** Normalized 0..1 in the screen as displayed; moves are coalesced to one per animation frame. */
  sendTouch(phase: TouchPhase, x: number, y: number): void;
  /** False when the platform has no such button (Back on iOS) or input is not ready. */
  sendButton(name: DeviceButton): boolean;
  /** Map a browser key event to the device; false when unmapped or not sent. */
  sendKey(event: KeyboardEventLike, phase: KeyPhase): boolean;
  /** Android: chunked text; iOS: US-layout keystrokes (printable ASCII only). */
  sendText(text: string): boolean;
  /** iOS: turn the simulator (serve-sim's orientation message); false on Android or before input is ready. */
  sendOrientation(orientation: DeviceOrientation): boolean;
}

const IOS_BUTTONS: Record<DeviceButton, ServeSimButton | null> = {
  home: "home",
  recents: "app_switcher",
  power: "lock",
  back: null
};

/** Swap serve-sim's stream file name, keeping the path prefix and query (auth). */
export function serveSimStreamUrl(url: string, file: "stream.avcc" | "stream.mjpeg"): string {
  return url.replace(/stream\.(?:avcc|mjpeg)(?=$|[?#])/, file);
}

/** Set or delete query parameters on an absolute or relative URL. */
export function withQueryParams(url: string, params: Record<string, string | null>): string {
  const base = "http://relative.invalid";
  const parsed = new URL(url, base);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) parsed.searchParams.delete(key);
    else parsed.searchParams.set(key, value);
  }
  const out = parsed.toString();
  return out.startsWith(base) ? out.slice(base.length) : out;
}

interface Channels {
  video: DeviceVideoSession | null;
  emu: ServeEmuSession | null;
  sim: ServeSimInputSocket | null;
  throttle: PointerThrottle | null;
}

const NO_CHANNELS: Channels = { video: null, emu: null, sim: null, throttle: null };

export function useDeviceStream(options: UseDeviceStreamOptions): DeviceStreamHandle {
  const { platform, urls, enabled, hostCaps } = options;
  const [canvas] = useState<HTMLCanvasElement | null>(() =>
    typeof document === "undefined" ? null : document.createElement("canvas")
  );
  const [probedCaps, setProbedCaps] = useState<BrowserStreamCaps | null>(null);
  const [fallback, setFallback] = useState<{ video: string; transport: DeviceTransport } | null>(null);
  const [state, setState] = useState<DeviceStreamState>("closed");
  const [error, setError] = useState<DeviceStreamError | null>(null);
  const [stats, setStats] = useState<DeviceStreamStats | null>(null);
  const [screenConfig, setScreenConfig] = useState<DeviceScreenConfig | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const channels = useRef<Channels>(NO_CHANNELS);
  const latest = useRef(options);
  latest.current = options;

  const browserCaps = options.browserCaps ?? probedCaps;
  const needsCaps = enabled && !options.transport && !options.browserCaps && probedCaps === null;
  useEffect(() => {
    if (!needsCaps) return;
    let cancelled = false;
    void capabilities().then((caps) => {
      if (!cancelled) setProbedCaps(caps);
    });
    return () => {
      cancelled = true;
    };
  }, [needsCaps]);

  const transport: DeviceTransport | null =
    (fallback?.video === urls.video ? fallback.transport : null) ??
    options.transport ??
    (browserCaps ? chooseTransport({ platform, hostCaps, browserCaps }) : null);

  useEffect(() => {
    if (!enabled || !canvas || !transport) return;
    let open = true;
    const deps = latest.current.deps;
    const onWarning = (message: string) => {
      if (open) latest.current.onWarning?.(message);
    };
    const onFrame = () => {
      if (open) latest.current.onFrame?.();
    };
    const onState = (next: DeviceStreamState, err: DeviceStreamError | null) => {
      if (!open) return;
      setState(next);
      setError(err);
      if (
        next === "error" &&
        transport === "serve-sim-h264" &&
        err?.fatal &&
        (err.code === "unsupported" || err.code === "no-video")
      ) {
        onWarning(`${err.message} Switching to MJPEG.`);
        setFallback({ video: urls.video, transport: "serve-sim-mjpeg" });
      }
    };
    const onAndroidSize = (width: number, height: number) => {
      if (open) setScreenConfig({ width, height, orientation: width > height ? "landscape_left" : "portrait" });
    };
    const onInputReady = (ready: boolean) => {
      if (open) setInputReady(ready);
    };
    const common = { canvas, deps, onFrame, onState, onWarning };
    const next: Channels = { video: null, emu: null, sim: null, throttle: null };
    setState("connecting");
    setError(null);
    setStats(null);

    if (platform === "android") {
      if (transport === "screenshots") {
        if (urls.screenshot) {
          next.video = new ScreenshotPollSession({ ...common, url: urls.screenshot, onVideoSize: onAndroidSize });
        } else {
          setState("error");
          setError(new DeviceStreamError("unsupported", "This browser can't decode the device's video stream.", true));
        }
        next.emu = new ServeEmuSession({
          ...common,
          url: withQueryParams(urls.video, { video: "0", "frame-meta": null }),
          video: false,
          onFrame: undefined,
          onState: undefined,
          onInputReady
        });
      } else {
        next.emu = new ServeEmuSession({ ...common, url: urls.video, onVideoSize: onAndroidSize, onInputReady });
        next.video = next.emu;
      }
    } else {
      next.video =
        transport === "serve-sim-h264"
          ? new ServeSimH264Session({ ...common, url: serveSimStreamUrl(urls.video, "stream.avcc") })
          : new ServeSimMjpegSession({ ...common, url: urls.mjpeg ?? serveSimStreamUrl(urls.video, "stream.mjpeg") });
      if (urls.input) {
        next.sim = new ServeSimInputSocket({
          url: urls.input,
          deps,
          onWarning,
          onReady: onInputReady,
          onScreenConfig: (config) => {
            if (open) setScreenConfig(config);
          }
        });
      }
    }
    next.throttle = createPointerThrottle((phase, x, y) => {
      if (next.emu) next.emu.sendTouch(phase, x, y);
      else next.sim?.sendTouch(phase, x, y);
    });
    channels.current = next;

    const statsTimer = setInterval(() => {
      if (open && next.video) setStats(next.video.stats());
    }, 1_000);

    return () => {
      open = false;
      clearInterval(statsTimer);
      next.throttle?.dispose();
      next.video?.close();
      next.emu?.close();
      next.sim?.close();
      if (channels.current === next) channels.current = NO_CHANNELS;
      setState("closed");
      setInputReady(false);
    };
  }, [enabled, canvas, transport, platform, urls.video, urls.input, urls.mjpeg, urls.screenshot]);

  const sendTouch = useCallback((phase: TouchPhase, x: number, y: number) => {
    channels.current.throttle?.push(phase, x, y);
  }, []);

  const sendButton = useCallback(
    (name: DeviceButton): boolean => {
      const { emu, sim } = channels.current;
      if (platform === "android") return emu?.sendButton(name) ?? false;
      const button = IOS_BUTTONS[name];
      return button !== null && (sim?.sendButton(button) ?? false);
    },
    [platform]
  );

  const sendKey = useCallback(
    (event: KeyboardEventLike, phase: KeyPhase): boolean => {
      const { emu, sim } = channels.current;
      const action = mapKeyboardEvent(platform, event, phase);
      if (!action) return false;
      switch (action.kind) {
        case "hid":
          return sim?.sendKey(action.type, action.usage, action.key) ?? false;
        case "android-key":
          return emu?.sendKey(action.keycode, action.action, action.metaState) ?? false;
        case "text":
          return emu?.sendText(action.text) ?? false;
        case "button":
          return emu?.sendButton(action.button) ?? false;
      }
    },
    [platform]
  );

  const sendText = useCallback(
    (text: string): boolean => {
      const { emu, sim } = channels.current;
      return (platform === "android" ? emu?.sendText(text) : sim?.sendText(text)) ?? false;
    },
    [platform]
  );

  const sendOrientation = useCallback(
    (orientation: DeviceOrientation): boolean => (platform === "ios" ? (channels.current.sim?.sendOrientation(orientation) ?? false) : false),
    [platform]
  );

  return {
    canvas,
    // Before the connect effect runs (or while capabilities are probed) an enabled stream is connecting.
    state: enabled ? (transport && state !== "closed" ? state : "connecting") : "closed",
    error: enabled ? error : null,
    stats,
    transport,
    screenConfig,
    inputReady,
    sendTouch,
    sendButton,
    sendKey,
    sendText,
    sendOrientation
  };
}
