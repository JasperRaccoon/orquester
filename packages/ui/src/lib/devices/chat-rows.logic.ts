/**
 * Devices — how a chat row of a device tool reads (devices spec §10.3), pure: "Opened Pixel 9",
 * "Tapped “Search”", "Took a screenshot of Pixel 9". The row's `deviceLink` (the result's
 * `deviceRef`) carries the device's name, the action and its action-log summary when the daemon
 * filled them; the name may also come from the devices store (a resolver the caller passes).
 */

import { isDeviceActionKind, readDeviceToolReference, DEVICE_TOOL_REFERENCE_KEY, type DeviceActionKind, type DeviceToolReference } from "@orquester/api";
import { sessionToolReferences } from "@orquester/api/agent-chat";

/** The device's display name from somewhere other than the reference (the devices store). */
export type DeviceNameResolver = (reference: DeviceToolReference) => string | undefined;

/**
 * A session-tool row's `deviceRef`, completed with the `action` and `summary` the same (live,
 * un-slimmed) result carries beside it when the reference itself lacks them. `reference` is the
 * already validated one (`deviceToolReferenceOfActivityData`); everything read here is validated
 * again through `readDeviceToolReference`.
 */
export function completeDeviceReference(reference: DeviceToolReference, data: Record<string, unknown>): DeviceToolReference {
  if (reference.action !== undefined && reference.summary !== undefined) return reference;
  const found = sessionToolReferences(data, [DEVICE_TOOL_REFERENCE_KEY, "action", "summary"]);
  if (!found) return reference;
  const merged = readDeviceToolReference({
    ...reference,
    ...(reference.action === undefined && isDeviceActionKind(found.action) ? { action: found.action } : {}),
    ...(reference.summary === undefined && typeof found.summary === "string" ? { summary: found.summary } : {})
  });
  return merged ?? reference;
}

/** "Tapped @e7 “Search”" → "Tapped “Search”": the ref only stays when nothing names the target. */
function deviceSummaryWords(summary: string): string {
  const text = summary.trim();
  if (!/[“"]/.test(text)) return text;
  return text.replace(/(^|\s)@e\d+\s+(?=[“"])/, "$1").replace(/\s{2,}/g, " ");
}

const ACTION_VERBS: Readonly<Record<DeviceActionKind, (name: string) => string>> = {
  snapshot: (name) => `Read the screen of ${name}`,
  screenshot: (name) => `Took a screenshot of ${name}`,
  tap: (name) => `Tapped on ${name}`,
  long_press: (name) => `Long-pressed on ${name}`,
  fill: (name) => `Filled a field on ${name}`,
  type: (name) => `Typed on ${name}`,
  press: (name) => `Pressed a key on ${name}`,
  swipe: (name) => `Swiped on ${name}`,
  scroll: (name) => `Scrolled on ${name}`,
  open_app: (name) => `Opened an app on ${name}`,
  close_app: (name) => `Closed an app on ${name}`,
  open_url: (name) => `Opened a link on ${name}`,
  logs: (name) => `Read logs of ${name}`,
  rotate: (name) => `Rotated ${name}`,
  appearance: (name) => `Changed the appearance of ${name}`,
  location: (name) => `Set the location of ${name}`,
  permissions: (name) => `Changed permissions on ${name}`,
  wait: (name) => `Waited on ${name}`
};

/** Actions whose own words beat the summary (it adds nothing the verb does not say). */
const NAMED_ACTIONS: ReadonlySet<DeviceActionKind> = new Set(["snapshot", "screenshot"]);

/**
 * The words of a device tool's row, or undefined to keep the tool's generic label (`list_devices`,
 * another tool, or a row without a reference).
 */
export function deviceToolRowLabel(
  tool: string,
  reference: DeviceToolReference | undefined,
  resolveName?: DeviceNameResolver
): string | undefined {
  if (!reference) return undefined;
  const known = reference.name ?? resolveName?.(reference);
  const name = known && known.trim().length > 0 ? known.trim() : undefined;
  switch (tool) {
    case "open_device":
      return name ? `Opened ${name}` : "Opened a device";
    case "close_device":
      return name ? `Closed ${name}` : "Closed a device";
    case "device_install":
      return `Installed a build on ${name ?? "a device"}`;
    case "device_action": {
      const action = reference.action;
      if (action !== undefined && NAMED_ACTIONS.has(action)) return ACTION_VERBS[action](name ?? "a device");
      if (reference.summary) return deviceSummaryWords(reference.summary);
      if (action !== undefined) return ACTION_VERBS[action](name ?? "a device");
      return name ? `Used ${name}` : undefined;
    }
    default:
      return undefined;
  }
}
