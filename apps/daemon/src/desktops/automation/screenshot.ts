/**
 * A desktop capture as the image an agent gets (spec 2026-11-10 R1.8): the raw pixels from
 * `DesktopAutomation.capture()` are converted to RGB (`./pixels.ts`; their buffer is transferred
 * to the worker, so the capture's `pixels` is empty afterwards), scaled down (area average) so its
 * long edge is at most `maxSize`, then sent as PNG when its base64 fits the MCP image cap
 * ({@link DEVICE_SCREENSHOT_MAX_BASE64_CHARS}), else as a JPEG halved until it does. The work runs
 * in the daemon's image workers (`devices/image-pool.ts`), never on the event loop.
 *
 * For the routes:
 *
 *     const capture = await automation.capture(region);
 *     const shot = await encodeDesktopScreenshot(capture, maxSize ?? DESKTOP_SCREENSHOT_DEFAULT_MAX);
 *     // shot.data: the image bytes (base64 them for the response); shot.width × shot.height its size;
 *     // a point (px, py) in it is display (capture.origin.x + px * shot.scale, capture.origin.y + py * shot.scale).
 *
 * It rejects with `ImagePoolBusyError` when the workers' queue is full, and with a `RangeError`
 * for a `maxSize` that is not a positive integer (the routes validate 320–3840 first).
 */

import { DESKTOP_SCREENSHOT_DEFAULT_MAX } from "@orquester/api";

import { deviceImages } from "../../devices/image-pool.ts";
import { DEVICE_SCREENSHOT_MAX_BASE64_CHARS, type FittedScreenshot } from "../../devices/screenshot-image.ts";
import type { DesktopCapture } from "./types.ts";

export interface EncodedDesktopScreenshot {
  mimeType: FittedScreenshot["mimeType"];
  data: Buffer;
  /** The image's size. */
  width: number;
  height: number;
  /** Display pixels per image pixel (≥ 1): the capture's width over the image's. */
  scale: number;
}

export async function encodeDesktopScreenshot(
  capture: Pick<DesktopCapture, "width" | "height" | "pixels" | "format">,
  maxSize: number = DESKTOP_SCREENSHOT_DEFAULT_MAX
): Promise<EncodedDesktopScreenshot> {
  if (!Number.isInteger(maxSize) || maxSize < 1) throw new RangeError(`maxSize must be a positive integer, not ${maxSize}`);
  const fitted = await deviceImages.fitPixels(capture, maxSize, DEVICE_SCREENSHOT_MAX_BASE64_CHARS);
  return { ...fitted, scale: capture.width / fitted.width };
}
