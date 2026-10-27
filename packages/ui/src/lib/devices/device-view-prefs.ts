/**
 * Devices — the Device panel's viewing preferences, per browser (spec §10.4): 3D or Flat per
 * device model, and whether the action log drawer is open. Stored in localStorage under
 * `orq.device.view.<platform>:<profile>` and `orq.device.panel`, validated field by field on read
 * like `desktop-prefs.ts`: a blob another bundle wrote keeps its valid fields and every invalid one
 * falls back to its default. Never throws.
 */

export type DeviceViewMode = "3d" | "flat";

export interface DeviceViewPrefs {
  /** What the user picked; null until they pick (the panel then defaults to 3D on H.264 streams). */
  mode: DeviceViewMode | null;
}

export interface DevicePanelPrefs {
  /** The action log drawer under the device is open. */
  logOpen: boolean;
}

const VIEW_PREFIX = "orq.device.view.";
const PANEL_KEY = "orq.device.panel";

export const DEFAULT_DEVICE_VIEW_PREFS: Readonly<DeviceViewPrefs> = Object.freeze({ mode: null });
export const DEFAULT_DEVICE_PANEL_PREFS: Readonly<DevicePanelPrefs> = Object.freeze({ logOpen: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key a device model's preference lives under: the profile ("pixel-9"), else the device name. */
export function deviceViewKey(device: { platform: string; profile: string; name?: string }): string {
  const id = device.profile || device.name || "device";
  return `${device.platform}:${id}`.slice(0, 200);
}

export function sanitizeDeviceViewPrefs(raw: unknown): DeviceViewPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_DEVICE_VIEW_PREFS };
  return { mode: raw.mode === "3d" || raw.mode === "flat" ? raw.mode : DEFAULT_DEVICE_VIEW_PREFS.mode };
}

/**
 * The view to show: the user's pick, else 3D for an H.264 stream and Flat for MJPEG or screenshots
 * (a soft picture in 3D reads worse than a sharp flat one), else 3D while the transport is unknown.
 */
export function effectiveDeviceViewMode(prefs: DeviceViewPrefs, transport: string | null): DeviceViewMode {
  if (prefs.mode) return prefs.mode;
  return transport === "serve-sim-mjpeg" || transport === "screenshots" ? "flat" : "3d";
}

export function sanitizeDevicePanelPrefs(raw: unknown): DevicePanelPrefs {
  if (!isRecord(raw)) return { ...DEFAULT_DEVICE_PANEL_PREFS };
  return { logOpen: typeof raw.logOpen === "boolean" ? raw.logOpen : DEFAULT_DEVICE_PANEL_PREFS.logOpen };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string): unknown {
  try {
    const text = storage()?.getItem(key);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable — the preference just doesn't persist */
  }
}

export function readDeviceViewPrefs(key: string): DeviceViewPrefs {
  return sanitizeDeviceViewPrefs(read(VIEW_PREFIX + key));
}

export function writeDeviceViewPrefs(key: string, prefs: DeviceViewPrefs): void {
  write(VIEW_PREFIX + key, prefs);
}

export function readDevicePanelPrefs(): DevicePanelPrefs {
  return sanitizeDevicePanelPrefs(read(PANEL_KEY));
}

export function writeDevicePanelPrefs(prefs: DevicePanelPrefs): void {
  write(PANEL_KEY, prefs);
}
