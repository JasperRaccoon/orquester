/**
 * vphoned's flat `ui.tree` (`{count, elements: [{label, identifier, role, value, frame:{x,y,width,
 * height}, x, y, clickable, enabled, visible, traits}], pid, source, truncated}`, frames in screen
 * points) as the compact snapshot agents read elsewhere (agent-device's `@eN [role] "label"`
 * lines), with each ref's frame kept so a later `tap @eN` lands on the same element.
 */

import type { DeviceRect } from "../../host.ts";

export interface VphoneUiElement {
  label: string;
  identifier: string;
  role: string;
  value: string;
  frame: DeviceRect;
  enabled: boolean;
  clickable: boolean;
}

export interface VphoneSnapshot {
  text: string;
  /** `e1` → frame. */
  refs: Record<string, DeviceRect>;
  /** `e1` → element (selectors for `ui.tap_element` / `ui.wait`). */
  elements: Record<string, VphoneUiElement>;
}

const LABEL_MAX = 80;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function frameOf(value: unknown): DeviceRect | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** The elements of a `ui.tree` result that have a usable frame, in order. */
export function parseUiTree(result: Record<string, unknown>): VphoneUiElement[] {
  const elements = Array.isArray(result.elements) ? result.elements : [];
  const out: VphoneUiElement[] = [];
  for (const entry of elements) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const frame = frameOf(record.frame);
    if (!frame) continue;
    out.push({
      label: str(record.label).trim(),
      identifier: str(record.identifier).trim(),
      role: str(record.role).trim() || "element",
      value: str(record.value).trim(),
      frame,
      enabled: record.enabled !== false,
      clickable: record.clickable === true
    });
  }
  return out;
}

const quote = (text: string): string => JSON.stringify(text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

/** One line per element: `@e3 [button] "About" id=com.apple.settings.general.about`. */
export function renderSnapshot(elements: readonly VphoneUiElement[], truncated = false): VphoneSnapshot {
  const refs: Record<string, DeviceRect> = {};
  const byRef: Record<string, VphoneUiElement> = {};
  const lines: string[] = [];
  elements.forEach((element, index) => {
    const ref = `e${index + 1}`;
    refs[ref] = element.frame;
    byRef[ref] = element;
    let line = `@${ref} [${element.role}]`;
    if (element.label) line += ` ${quote(element.label)}`;
    if (element.identifier && element.identifier !== element.label) line += ` id=${element.identifier}`;
    if (element.value && element.value !== element.label) line += ` value=${quote(element.value)}`;
    if (!element.enabled) line += " (disabled)";
    lines.push(line);
  });
  if (lines.length === 0) lines.push("(no accessible elements on screen; take a screenshot)");
  if (truncated) lines.push("(more elements were cut off)");
  return { text: lines.join("\n"), refs, elements: byRef };
}

/** The center of a frame, in points. */
export function frameCenter(frame: DeviceRect): { x: number; y: number } {
  return { x: Math.round((frame.x + frame.width / 2) * 100) / 100, y: Math.round((frame.y + frame.height / 2) * 100) / 100 };
}
