/**
 * Android foldables' posture through the hub's serve-emu fold route (`vendor/serve-emu/api/fold`):
 * read it, set it (POST `{posture}`), validated. Adapted from T3 Code (MIT, Copyright 2026 T3 Tools
 * Inc.): apps/web/src/components/device/deviceFold.ts.
 */

import type { AndroidFoldPosture } from "./three/DeviceAndroidFoldControls";

export interface AndroidFoldState {
  supported: boolean;
  posture: AndroidFoldPosture | null;
  hingeAngle: number | null;
}

const POSTURES: readonly AndroidFoldPosture[] = ["closed", "half_opened", "opened", "flipped", "tent"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The route's answer, or null when it is not one. */
function parseAndroidFold(payload: unknown): AndroidFoldState | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.fold)) return null;
  const { supported, posture, hingeAngle } = payload.fold;
  if (typeof supported !== "boolean") return null;
  if (posture !== null && !(typeof posture === "string" && (POSTURES as readonly string[]).includes(posture))) return null;
  if (hingeAngle !== null && !(typeof hingeAngle === "number" && Number.isFinite(hingeAngle))) return null;
  return { supported, posture: posture as AndroidFoldPosture | null, hingeAngle: hingeAngle as number | null };
}

/** Where the fold route is: its URL and the transport's auth headers (`ApiClient.deviceHttpRequest`). */
export interface AndroidFoldTarget {
  url: string;
  headers?: Readonly<Record<string, string>>;
}

/** GET (no posture) or POST the fold route; rejects with the hub's message. */
export async function requestAndroidFold(target: AndroidFoldTarget, posture?: "closed" | "opened", signal?: AbortSignal): Promise<AndroidFoldState> {
  const response = await fetch(target.url, {
    method: posture ? "POST" : "GET",
    cache: "no-store",
    headers: { ...target.headers, ...(posture ? { "content-type": "application/json" } : {}) },
    ...(posture ? { body: JSON.stringify({ posture }) } : {}),
    ...(signal ? { signal } : {})
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : isRecord(payload) && typeof payload.message === "string" ? payload.message : null;
    throw new Error(message ?? `The fold command failed (${response.status}).`);
  }
  const state = parseAndroidFold(payload);
  if (!state) throw new Error("The device answered the fold command in an unexpected shape.");
  return state;
}
