/**
 * The desktop app's loopback relay for live devices (`apps/desktop/src/device-relay.ts`), read from
 * the preload's bridge. Anything but a well-formed loopback relay is none at all: its token goes
 * with every device request.
 */

export interface DesktopDeviceRelay {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  token: string;
}

export function desktopDeviceRelay(): DesktopDeviceRelay | null {
  if (typeof window === "undefined") return null;
  const relay = (window as unknown as { orquesterDesktop?: { deviceRelay?: { origin?: unknown; token?: unknown } | null } }).orquesterDesktop?.deviceRelay;
  if (!relay || typeof relay !== "object") return null;
  const { origin, token } = relay;
  if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) return null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  return { origin, token };
}
