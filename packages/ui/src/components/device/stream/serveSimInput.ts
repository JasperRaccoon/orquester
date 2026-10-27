// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * iOS input: `…/vendor/serve-sim/helper/ws?device=<udid>`, binary messages of
 * a 1-byte tag and a JSON payload. Up: `0x03` touch, `0x04` button, `0x06`
 * HID key, `0x07` orientation. Down: `0x83` input admitted (nothing is sent
 * before it), `0x82` screen config. Reconnects with jittered backoff.
 */

import { backoffDelayMs, RECONNECT_BACKOFF, scheduleRetry, type PendingRetry } from "../../../lib/connection/backoff.ts";
import { HID_USAGE_LEFT_SHIFT, textToHidStrokes } from "./keymap.ts";
import { clampUnit } from "./pointer.ts";
import {
  DeviceStreamError,
  resolveDeps,
  type DeviceOrientation,
  type DeviceScreenConfig,
  type StreamDeps,
  type TouchPhase
} from "./types.ts";

export const IOS_MSG_TOUCH = 0x03;
export const IOS_MSG_BUTTON = 0x04;
export const IOS_MSG_KEY = 0x06;
export const IOS_MSG_ORIENTATION = 0x07;
export const IOS_TAG_SCREEN_CONFIG = 0x82;
export const IOS_TAG_INPUT_ADMITTED = 0x83;

export type ServeSimButton = "home" | "app_switcher" | "lock";

const ORIENTATIONS: ReadonlySet<string> = new Set(["portrait", "portrait_upside_down", "landscape_left", "landscape_right"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

/** Validate a `0x82` payload; null when it is not a usable screen config. */
export function parseScreenConfig(payload: unknown): DeviceScreenConfig | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const { width, height, orientation } = record;
  if (typeof width !== "number" || !(width > 0) || !Number.isFinite(width)) return null;
  if (typeof height !== "number" || !(height > 0) || !Number.isFinite(height)) return null;
  if (typeof orientation !== "string" || !ORIENTATIONS.has(orientation)) return null;
  return {
    width,
    height,
    orientation: orientation as DeviceOrientation,
    ...(typeof record.inputUnavailable === "boolean" ? { inputUnavailable: record.inputUnavailable } : {})
  };
}

/**
 * serve-sim streams the raw portrait framebuffer even when the simulator is in
 * landscape; map a point in the screen as displayed into that raw space.
 */
export function rawSimulatorPoint(screen: DeviceScreenConfig | null, x: number, y: number): { x: number; y: number } {
  if (!screen || screen.width > screen.height) return { x, y };
  switch (screen.orientation) {
    case "landscape_left":
      return { x: y, y: 1 - x };
    case "landscape_right":
      return { x: 1 - y, y: x };
    case "portrait_upside_down":
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

export interface ServeSimInputOptions {
  /** Full WebSocket URL; the caller's API client has already added the auth token. */
  readonly url: string;
  /** Input admitted (and not marked unavailable) or lost; `reason` explains a loss. */
  readonly onReady?: (ready: boolean, reason?: string) => void;
  readonly onScreenConfig?: (config: DeviceScreenConfig) => void;
  readonly onWarning?: (message: string) => void;
  /** The socket was refused for auth; it stops reconnecting. */
  readonly onError?: (error: DeviceStreamError) => void;
  readonly deps?: Partial<StreamDeps>;
}

export class ServeSimInputSocket {
  private readonly deps: StreamDeps;
  private socket: WebSocket | null = null;
  private admitted = false;
  private screen: DeviceScreenConfig | null = null;
  private retry: PendingRetry | null = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly options: ServeSimInputOptions) {
    this.deps = resolveDeps(options.deps);
    this.connect();
  }

  /** Admitted and the simulator's input is available. */
  get ready(): boolean {
    return this.admitted && !this.screen?.inputUnavailable && this.socket !== null;
  }

  get screenConfig(): DeviceScreenConfig | null {
    return this.screen;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.retry?.cancel();
    this.retry = null;
    const socket = this.socket;
    this.socket = null;
    this.admitted = false;
    try {
      socket?.close();
    } catch {
      // Already closing.
    }
  }

  /** Normalized 0..1 coordinates in the screen as displayed; rotated into serve-sim's raw framebuffer space. */
  sendTouch(phase: TouchPhase, x: number, y: number): boolean {
    const point = rawSimulatorPoint(this.screen, clampUnit(x), clampUnit(y));
    return this.send(IOS_MSG_TOUCH, { type: phase, x: point.x, y: point.y });
  }

  sendButton(button: ServeSimButton): boolean {
    return this.send(IOS_MSG_BUTTON, { button });
  }

  /** HID keyboard usage; `key` (the typed character) lets serve-sim type it when the simulator's hardware keyboard is off. */
  sendKey(type: "down" | "up", usage: number, key?: string): boolean {
    return this.send(IOS_MSG_KEY, key === undefined ? { type, usage } : { type, usage, key });
  }

  /**
   * Type `text` as US-layout keystrokes. Only printable ASCII, tab and newline
   * can be typed; false when some characters were skipped or nothing was sent.
   */
  sendText(text: string): boolean {
    const { strokes, unsupported } = textToHidStrokes(text);
    for (const { usage, shift } of strokes) {
      if (shift && !this.sendKey("down", HID_USAGE_LEFT_SHIFT)) return false;
      if (!this.sendKey("down", usage) || !this.sendKey("up", usage)) return false;
      if (shift && !this.sendKey("up", HID_USAGE_LEFT_SHIFT)) return false;
    }
    if (unsupported > 0) this.options.onWarning?.(`${unsupported} character(s) can't be typed into the simulator.`);
    return unsupported === 0;
  }

  sendOrientation(orientation: DeviceOrientation): boolean {
    return this.send(IOS_MSG_ORIENTATION, { orientation });
  }

  private send(tag: number, payload: unknown): boolean {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== this.deps.WebSocket.OPEN) return false;
    try {
      socket.send(taggedJson(tag, payload));
      return true;
    } catch {
      return false;
    }
  }

  private setReady(previous: boolean, reason?: string): void {
    const ready = this.ready;
    if (ready !== previous) this.options.onReady?.(ready, reason);
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new this.deps.WebSocket(this.options.url);
    } catch (cause) {
      this.scheduleReconnect(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.admitted = false;
    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 1) return;
      const before = this.ready;
      if (bytes[0] === IOS_TAG_INPUT_ADMITTED) {
        this.admitted = true;
        this.attempt = 0;
        this.setReady(before);
        return;
      }
      if (bytes[0] !== IOS_TAG_SCREEN_CONFIG) return;
      let payload: unknown;
      try {
        payload = JSON.parse(decoder.decode(bytes.subarray(1)));
      } catch {
        this.options.onWarning?.("Unreadable simulator screen config.");
        return;
      }
      const config = parseScreenConfig(payload);
      if (!config) {
        this.options.onWarning?.("Invalid simulator screen config.");
        return;
      }
      this.screen = config;
      this.options.onScreenConfig?.(config);
      this.setReady(before, config.inputUnavailable ? "Simulator input is in use by another client." : undefined);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      const before = this.ready;
      this.socket = null;
      this.admitted = false;
      const reason = event.reason || `closed ${event.code}`;
      this.setReady(before, reason);
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.closed = true;
        this.options.onError?.(new DeviceStreamError("unauthorized", "The device input refused this session's credentials.", true));
        return;
      }
      this.scheduleReconnect(reason);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed) return;
    this.options.onWarning?.(`Device input disconnected (${reason}); reconnecting.`);
    const delay = backoffDelayMs(this.attempt++, RECONNECT_BACKOFF, this.deps.random);
    this.retry = scheduleRetry(delay, (woken) => {
      this.retry = null;
      if (woken) this.attempt = 0;
      this.connect();
    });
  }
}
