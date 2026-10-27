/**
 * `device_action` on a vphone research VM (`DeviceHost.performAction`), mapped onto vphoned RPCs
 * (`Skills/vphone-guest-control/references/rpc-methods.md` in vphone-cli; coordinates are screen
 * points):
 *
 * | action | vphoned |
 * |---|---|
 * | snapshot | `ui.tree` → `@eN [role] "label"` lines, refs kept per lease |
 * | tap / long_press | ref: `ui.tap_element {identifier}` when the id is unique, else `input.tap` at the frame's center; x/y: `input.tap` / `input.long_press` |
 * | fill / type | tap the ref, then `input.type`; `input.type` |
 * | press | `input.button` (home, power, volume-up/-down), `input.key return` |
 * | swipe / scroll | `input.swipe {x1,y1,x2,y2}` |
 * | open_app / close_app / open_url | `apps.launch` / `apps.terminate` / `apps.open_url` |
 * | screenshot / logs / wait / location | `screen.screenshot` / `logs.syslog` / `ui.wait` / `location.set` |
 *
 * `rotate`, `appearance` and `permissions` have no safe vphoned equivalent and are refused with a
 * clear error. No **force** method is ever called (the client refuses them too).
 */

import { DEVICE_LOGS_MAX_SECONDS, DEVICE_WAIT_MAX_MS, type DeviceDirection, type DevicePoint, type DevicePressKey } from "@orquester/api";

import { DeviceError } from "../../errors.ts";
import type { DeviceActionOutcome, DeviceActionRequest } from "../../host.ts";
import { frameCenter, parseUiTree, renderSnapshot, type VphoneSnapshot, type VphoneUiElement } from "./snapshot.ts";

/** What an action needs from the VM and its lease. */
export interface VphoneActionTarget {
  call(method: string, params: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
  /** The screen in points (portrait), when known. */
  screen(): { width: number; height: number } | null;
  /** The lease's last snapshot. */
  snapshot(): VphoneSnapshot | null;
  setSnapshot(snapshot: VphoneSnapshot): void;
}

const SNAPSHOT_MAX_ELEMENTS = 400;
const LOG_MAX_LINES = 300;
const LOG_TEXT_MAX = 40_000;
/** A screen size to aim directional swipes at when the VM did not report one. */
const FALLBACK_SCREEN = { width: 402, height: 874 };

const PRESS: Readonly<Record<DevicePressKey, { method: "input.button" | "input.key"; name: string; twice?: boolean } | null>> = {
  home: { method: "input.button", name: "home" },
  lock: { method: "input.button", name: "power" },
  volume_up: { method: "input.button", name: "volume-up" },
  volume_down: { method: "input.button", name: "volume-down" },
  enter: { method: "input.key", name: "return" },
  // iPhones without a Home button open the switcher with a double Home press too.
  app_switch: { method: "input.button", name: "home", twice: true },
  back: null
};

export async function performVphoneAction(target: VphoneActionTarget, action: DeviceActionRequest, signal: AbortSignal): Promise<DeviceActionOutcome> {
  const call = (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => target.call(method, params, { signal, ...(timeoutMs ? { timeoutMs } : {}) });
  switch (action.action) {
    case "snapshot": {
      const result = await call("ui.tree", { max_elements: SNAPSHOT_MAX_ELEMENTS }, 20_000);
      const snapshot = renderSnapshot(parseUiTree(result), result.truncated === true);
      target.setSnapshot(snapshot);
      const count = Object.keys(snapshot.refs).length;
      return { text: snapshot.text, refs: snapshot.refs, summary: `Snapshot: ${count} element${count === 1 ? "" : "s"}` };
    }
    case "tap":
    case "fill": {
      const outcome = await tap(target, action, call);
      if (action.action === "tap") return outcome;
      await call("input.type", { text: action.text ?? "" }, typingTimeout(action.text));
      return { ...outcome, summary: `Filled ${outcome.target ?? "the field"} with ${(action.text ?? "").length} characters` };
    }
    case "long_press": {
      const { point, target: label } = action.ref !== undefined ? resolveRef(target, action.ref) : { point: pointOf(action), target: undefined };
      const seconds = Math.max(0.1, Math.min(10, (action.durationMs ?? 1000) / 1000));
      await call("input.long_press", { x: point.x, y: point.y, seconds }, 30_000);
      return { point, ...(label ? { target: label } : {}), summary: `Long-pressed ${label ?? `(${point.x}, ${point.y})`}` };
    }
    case "type": {
      await call("input.type", { text: action.text ?? "" }, typingTimeout(action.text));
      return { summary: `Typed ${(action.text ?? "").length} characters` };
    }
    case "press": {
      const key = action.key!;
      const press = PRESS[key];
      if (!press) throw new DeviceError("INVALID_ARGUMENT", "iPhones have no Back button: tap the app's own back control, or swipe right from the left edge.");
      await call(press.method, { name: press.name });
      if (press.twice) await call(press.method, { name: press.name });
      return { summary: `Pressed ${key.replace("_", " ")}` };
    }
    case "swipe":
    case "scroll": {
      const { from, to } = action.from && action.to && action.action === "swipe" ? { from: action.from, to: action.to } : directional(target, action.direction!, action.action === "scroll");
      await call("input.swipe", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, seconds: 0.3 }, 30_000);
      return { from, to, summary: action.action === "scroll" ? `Scrolled ${action.direction}` : action.direction ? `Swiped ${action.direction}` : "Swiped" };
    }
    case "open_app": {
      const result = await call("apps.launch", { bundle_id: action.app }, 60_000);
      const verified = result.frontmost_verified !== false;
      return {
        summary: `Opened ${action.app}`,
        ...(verified ? {} : { text: `${action.app} started, but iOS did not confirm it is in front. Take a screenshot to check.` })
      };
    }
    case "close_app":
      await call("apps.terminate", { bundle_id: action.app });
      return { summary: `Closed ${action.app}` };
    case "open_url":
      await call("apps.open_url", { url: action.url }, 60_000);
      return { summary: `Opened ${action.url}` };
    case "screenshot": {
      const result = await call("screen.screenshot", {}, 60_000);
      const data = typeof result.data === "string" ? Buffer.from(result.data, "base64") : null;
      if (!data || data.length < 3 || data[0] !== 0xff || data[1] !== 0xd8) throw new DeviceError("UNAVAILABLE", "The research iPhone sent no usable screenshot. Try again.");
      const width = typeof result.width === "number" ? result.width : 0;
      const height = typeof result.height === "number" ? result.height : 0;
      return { image: { mimeType: "image/jpeg", data, width, height }, summary: "Took a screenshot" };
    }
    case "logs": {
      const seconds = Math.max(1, Math.min(DEVICE_LOGS_MAX_SECONDS, Math.round(action.seconds ?? 5)));
      const result = await call("logs.syslog", { seconds, max_lines: LOG_MAX_LINES }, (seconds + 30) * 1000);
      const text = logText(result);
      return { text: text || "(no log lines)", summary: `Read ${seconds} s of logs` };
    }
    case "wait": {
      const timeoutMs = Math.max(100, Math.min(DEVICE_WAIT_MAX_MS, action.timeoutMs ?? 10_000));
      const selector = action.ref !== undefined ? selectorOf(elementOf(target, action.ref)) : { text: action.text };
      await call("ui.wait", { ...selector, timeout: timeoutMs / 1000 }, timeoutMs + 15_000);
      return { summary: `Waited for ${action.ref ?? JSON.stringify(action.text)}` };
    }
    case "location":
      await call("location.set", { latitude: action.lat, longitude: action.lon });
      return { summary: `Set the location to ${action.lat}, ${action.lon}` };
    case "rotate":
    case "appearance":
    case "permissions":
      throw new DeviceError("INVALID_ARGUMENT", `${action.action} is not available on research iPhones (vphone). Change it in the iPhone's Settings app instead.`);
  }
}

async function tap(
  target: VphoneActionTarget,
  action: DeviceActionRequest,
  call: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
): Promise<DeviceActionOutcome> {
  if (action.ref === undefined) {
    const point = pointOf(action);
    await call("input.tap", { x: point.x, y: point.y });
    return { point, summary: `Tapped (${point.x}, ${point.y})` };
  }
  const element = elementOf(target, action.ref);
  const { point, target: label } = resolveRef(target, action.ref);
  const snapshot = target.snapshot();
  const unique =
    element.identifier !== "" && snapshot !== null && Object.values(snapshot.elements).filter((entry) => entry.identifier.includes(element.identifier)).length === 1;
  if (unique) await call("ui.tap_element", { identifier: element.identifier }, 20_000);
  else await call("input.tap", { x: point.x, y: point.y });
  return { point, target: label, summary: `Tapped ${label}` };
}

function typingTimeout(text: string | undefined): number {
  // `input.type` sends one key per 30 ms by default.
  return 30_000 + (text?.length ?? 0) * 60;
}

function pointOf(action: DeviceActionRequest): DevicePoint {
  return { x: action.x!, y: action.y! };
}

function elementOf(target: VphoneActionTarget, ref: string): VphoneUiElement {
  const id = ref.replace(/^@/, "");
  const element = target.snapshot()?.elements[id];
  if (!element) throw new DeviceError("INVALID_ARGUMENT", `There is no ${ref.startsWith("@") ? ref : `@${ref}`} in the last snapshot. Take a new snapshot first.`);
  return element;
}

function resolveRef(target: VphoneActionTarget, ref: string): { point: DevicePoint; target: string } {
  const element = elementOf(target, ref);
  const name = ref.startsWith("@") ? ref : `@${ref}`;
  return { point: frameCenter(element.frame), target: element.label ? `${name} ${element.label}` : name };
}

function selectorOf(element: VphoneUiElement): Record<string, unknown> {
  if (element.identifier) return { identifier: element.identifier };
  if (element.label) return { text: element.label };
  throw new DeviceError("INVALID_ARGUMENT", "That element has no label or identifier to wait for; wait for its text instead.");
}

function directional(target: VphoneActionTarget, direction: DeviceDirection, scroll: boolean): { from: DevicePoint; to: DevicePoint } {
  const screen = target.screen() ?? FALLBACK_SCREEN;
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const dy = Math.round(screen.height * 0.3);
  const dx = Math.round(screen.width * 0.3);
  // A scroll moves the content: scrolling down drags the finger up.
  const finger = scroll ? ({ up: "down", down: "up", left: "right", right: "left" } as const)[direction] : direction;
  switch (finger) {
    case "up":
      return { from: { x: cx, y: cy + dy }, to: { x: cx, y: cy - dy } };
    case "down":
      return { from: { x: cx, y: cy - dy }, to: { x: cx, y: cy + dy } };
    case "left":
      return { from: { x: cx + dx, y: cy }, to: { x: cx - dx, y: cy } };
    case "right":
      return { from: { x: cx - dx, y: cy }, to: { x: cx + dx, y: cy } };
  }
}

/** The log lines of a `logs.syslog` result, whatever IcliKit named them. */
export function logText(result: Record<string, unknown>): string {
  const lines = [result.lines, result.logs, result.entries, result.messages].find(Array.isArray) as unknown[] | undefined;
  let text: string;
  if (lines) {
    text = lines
      .map((line) => {
        if (typeof line === "string") return line;
        if (line !== null && typeof line === "object") {
          const record = line as Record<string, unknown>;
          const message = [record.message, record.text, record.line, record.msg].find((value) => typeof value === "string") as string | undefined;
          const process = typeof record.process === "string" ? `${record.process}: ` : "";
          return message !== undefined ? `${process}${message}` : JSON.stringify(line);
        }
        return String(line);
      })
      .join("\n");
  } else {
    const raw = [result.output, result.text, result.log].find((value) => typeof value === "string") as string | undefined;
    text = raw ?? (Object.keys(result).length > 0 ? JSON.stringify(result) : "");
  }
  return text.length > LOG_TEXT_MAX ? `${text.slice(text.length - LOG_TEXT_MAX)}\n(earlier lines cut)` : text;
}
