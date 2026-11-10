/**
 * Which stream backend a desktop viewer uses for one connection attempt (spec 2026-11-10 R4.6):
 * voxl only when the desktop streams with it and its stream is usable, this page is a secure
 * context, WebCodecs decodes H.264, and voxl has not failed to connect three times in a row; RFB
 * otherwise. A fallback from a voxl desktop carries a one-line reason for the Info dialog.
 */

import type { DesktopSummary, DesktopVideoBackend } from "@orquester/api";

/** Consecutive voxl connection failures (closed before its `hello`) after which the view uses RFB. */
export const VOXL_MAX_FAILURES = 3;

/** What this browser offers voxl. */
export interface VoxlViewerSupport {
  secureContext: boolean;
  /** `VideoDecoder` exists. */
  webCodecs: boolean;
  /** `VideoDecoder.isConfigSupported` accepts H.264 High (voxl's x264 profile, which covers Main and Baseline). */
  h264: boolean;
}

export type DesktopBackendChoice =
  | { backend: "voxl" }
  /** `reason`: why a voxl desktop fell back (null when the desktop streams with RFB anyway). */
  | { backend: "rfb"; reason: string | null };

/** The desktop's video backend; absent (an older daemon) or unknown reads as `rfb`. */
export function desktopVideo(desktop: Pick<DesktopSummary, "video">): DesktopVideoBackend {
  return desktop.video === "voxl" ? "voxl" : "rfb";
}

/**
 * The desktop's voxl stream can take a viewer: `ready`, or `starting` — the daemon starts voxl when
 * its first viewer connects and holds that connection until voxl answers, so a starting stream is
 * one to wait for, not to fall back from. Only `unavailable` (or no stream state) means RFB. The
 * view reconnects when this flips, not on every state change.
 */
export function voxlStreamUsable(desktop: Pick<DesktopSummary, "video" | "voxl">): boolean {
  if (desktopVideo(desktop) !== "voxl") return false;
  const state = desktop.voxl?.state;
  return state === "ready" || state === "starting";
}

/** Why this viewer cannot show voxl, or null when it can. */
export function viewerUnsupportedReason(support: VoxlViewerSupport): string | null {
  if (!support.secureContext) return "Fast video needs a secure (HTTPS) page";
  if (!support.webCodecs) return "This browser has no WebCodecs video decoder";
  if (!support.h264) return "This browser cannot decode H.264 video";
  return null;
}

export function chooseDesktopBackend(input: {
  desktop: Pick<DesktopSummary, "video" | "voxl">;
  support: VoxlViewerSupport;
  /** Consecutive voxl connection failures the view has counted. */
  voxlFailures: number;
}): DesktopBackendChoice {
  const { desktop, support, voxlFailures } = input;
  if (desktopVideo(desktop) !== "voxl") return { backend: "rfb", reason: null };
  if (!voxlStreamUsable(desktop)) {
    const reason = desktop.voxl?.reason;
    return { backend: "rfb", reason: reason ? `Fast video is unavailable: ${reason}` : "Fast video is unavailable" };
  }
  const unsupported = viewerUnsupportedReason(support);
  if (unsupported) return { backend: "rfb", reason: unsupported };
  if (voxlFailures >= VOXL_MAX_FAILURES) {
    return { backend: "rfb", reason: `Fast video failed to connect ${voxlFailures} times in a row` };
  }
  return { backend: "voxl" };
}
