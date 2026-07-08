import type { ApiClient } from "./api-client";

/**
 * Browser-side Web Push helpers for the web runtime only. These touch the
 * Service Worker / Push / Notification APIs, which exist only in a secure
 * browser context — never in the Electron renderer's preload world — so callers
 * must gate every use behind {@link pushSupported} (the SettingsModal already
 * renders the toggle only for `runtime === "web" && pushSupported()`).
 *
 * The subscription itself is the single global notification preference: if a
 * `PushSubscription` exists on this browser the user is opted in, otherwise not.
 */

/** True when this browser can register a SW, subscribe to push, and notify. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Decode a base64url VAPID public key into the `Uint8Array` that
 * `pushManager.subscribe({ applicationServerKey })` expects.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Back the view with a concrete ArrayBuffer so it satisfies BufferSource
  // (applicationServerKey) under lib.dom's generic Uint8Array typing.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** The active push subscription for this browser, or null when not subscribed. */
export async function getSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * Opt this browser into push: request Notification permission, subscribe via the
 * daemon's VAPID public key (`GET /api/push/info`), then register the
 * subscription with the daemon (`POST /api/push/subscriptions`). Throws on a
 * denied/dismissed permission or any subscribe failure so the caller can revert
 * the toggle and surface a hint.
 */
export async function enablePush(api: ApiClient): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const info = await api.pushInfo();
  if (!info.supported || !info.vapidPublicKey) {
    throw new Error("Push notifications are not available on this server.");
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(info.vapidPublicKey)
  });

  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) {
    // Roll back the browser-side subscription so state stays consistent.
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error("Push subscription is missing encryption keys.");
  }

  await api.pushSubscribe({
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined
  });

  return subscription;
}

/**
 * Opt out: unsubscribe this browser and drop the subscription from the daemon
 * (`DELETE /api/push/subscriptions`). No-op when not currently subscribed.
 */
export async function disablePush(api: ApiClient): Promise<void> {
  const subscription = await getSubscription();
  if (!subscription) {
    return;
  }
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await api.pushUnsubscribe({ endpoint });
}
