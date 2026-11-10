// Test doubles for desktop automation: a DesktopAutomation that records what it was asked to do
// (no X server), and a screenshot encoder that fits the long edge the way the image workers do.

import type { DesktopModifier, DesktopRect, DesktopSize } from "@orquester/api";
import type { DesktopScreenshotEncoder } from "./automation-service.ts";
import type { DesktopAutomation, DesktopCapture, DesktopWaitOptions, DesktopWaitResult, XButton } from "./automation/types.ts";

export type FakeAutomationCall =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; button: XButton; down: boolean }
  | { kind: "click"; x: number; y: number; button: XButton; count: number; modifiers: DesktopModifier[] }
  | { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; button: XButton }
  | { kind: "scroll"; at: { x: number; y: number } | null; direction: string; amount: number }
  | { kind: "key"; combo: string; repeat: number }
  | { kind: "type"; text: string }
  | { kind: "setClipboard"; text: string }
  | { kind: "capture"; region?: DesktopRect }
  | { kind: "wait"; options: Omit<DesktopWaitOptions, "signal"> };

export class FakeDesktopAutomation implements DesktopAutomation {
  closed = false;
  closes = 0;
  display: DesktopSize = { width: 1280, height: 800 };
  cursor = { x: 5, y: 5 };
  sequence = 41;
  clipboard = "";
  readonly calls: FakeAutomationCall[] = [];
  /** Runs inside type() with its signal, after the call is recorded (a test holds the input in flight). */
  duringType: ((signal: AbortSignal | undefined) => Promise<void>) | null = null;

  size(): DesktopSize {
    return { ...this.display };
  }

  seq(): number {
    return this.sequence;
  }

  async pointer(): Promise<{ x: number; y: number }> {
    return { ...this.cursor };
  }

  async capture(region?: DesktopRect): Promise<DesktopCapture> {
    this.calls.push({ kind: "capture", ...(region ? { region } : {}) });
    const rect = region ?? { x: 0, y: 0, ...this.display };
    return { width: rect.width, height: rect.height, origin: { x: rect.x, y: rect.y }, rgb: Buffer.alloc(0), seq: this.sequence, display: this.size(), cursor: { ...this.cursor } };
  }

  async wait(options: DesktopWaitOptions): Promise<DesktopWaitResult> {
    const { signal: _signal, ...rest } = options;
    this.calls.push({ kind: "wait", options: rest });
    // A change wait since an earlier sequence than this engine's own has its change already.
    const changed = options.for === "change" && options.since !== undefined && options.since < this.sequence;
    return { changed, timedOut: false, seq: this.sequence, waitedMs: changed ? 0 : 1_200 };
  }

  // Input with an aborted signal never starts, as the engine's queue has it.
  async move(x: number, y: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "move", x, y });
    this.cursor = { x, y };
  }

  async button(button: XButton, down: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "button", button, down });
  }

  async click(x: number, y: number, button: XButton, count: number, modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "click", x, y, button, count, modifiers: [...modifiers] });
    this.cursor = { x, y };
    this.sequence += 1;
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, button: XButton, _modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "drag", from, to, button });
  }

  async scroll(at: { x: number; y: number } | null, direction: "up" | "down" | "left" | "right", amount: number, _modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "scroll", at, direction, amount });
  }

  async key(combo: string, repeat: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "key", combo, repeat });
  }

  async type(text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "type", text });
    await this.duringType?.(signal);
  }

  async getClipboard(): Promise<string> {
    return this.clipboard;
  }

  async setClipboard(text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.calls.push({ kind: "setClipboard", text });
    this.clipboard = text;
  }

  onResize(): () => void {
    return () => {};
  }

  /** When set, close() resolves only once it does (a server slow to take the clean-up). */
  closing: Promise<void> | null = null;

  async close(): Promise<void> {
    this.closed = true;
    this.closes += 1;
    await this.closing;
  }

  /** The input calls only (no captures or waits). */
  input(): FakeAutomationCall[] {
    return this.calls.filter((call) => call.kind !== "capture" && call.kind !== "wait");
  }
}

/** PNG bytes ("png:<w>x<h>") scaled so the long edge fits `maxSize`, as the image workers' encoder does. */
export const fakeScreenshotEncoder: DesktopScreenshotEncoder = async (capture: DesktopCapture, maxSize: number) => {
  const scale = Math.max(1, Math.max(capture.width, capture.height) / maxSize);
  const width = Math.round(capture.width / scale);
  const height = Math.round(capture.height / scale);
  return { mimeType: "image/png", data: Buffer.from(`png:${width}x${height}`), width, height, scale };
};
