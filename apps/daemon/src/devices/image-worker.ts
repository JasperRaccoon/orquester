/**
 * The image worker's body (`image-pool.ts` starts it with `new Worker(new URL("./image-worker.ts"))`):
 * PNG decode, downscale and JPEG encode (`screenshot-image.ts`), and a desktop capture's pixel
 * conversion (`desktops/automation/pixels.ts`), off the daemon's event loop. It inherits the
 * daemon's `--import tsx`, and imports only those two modules and Node built-ins (erasable
 * TypeScript, so Node's own type stripping loads it too).
 */

import { parentPort } from "node:worker_threads";

import { pixelsToRgb } from "../desktops/automation/pixels.ts";
import { fitRgbScreenshot, fitScreenshot, type FittedScreenshot, thumbnailJpeg } from "./screenshot-image.ts";
import type { ImageWorkerReply, ImageWorkerRequest } from "./image-pool.ts";

const port = parentPort;
if (!port) throw new Error("image-worker.ts runs only as a worker thread");

const bytes = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

port.on("message", (message: ImageWorkerRequest) => {
  let reply: ImageWorkerReply;
  try {
    const { job } = message;
    if (job.kind === "thumbnail") {
      reply = { id: message.id, ok: true, result: { kind: "thumbnail", data: thumbnailJpeg(bytes(job.image), job.width) } };
    } else {
      const fitted: FittedScreenshot =
        job.kind === "fit"
          ? fitScreenshot(bytes(job.png), job.maxBase64Chars)
          : fitRgbScreenshot({ width: job.width, height: job.height, data: pixelsToRgb(job.pixels, job.format, job.width * job.height) }, job.maxLongEdge, job.maxBase64Chars);
      reply = { id: message.id, ok: true, result: { kind: "fit", mimeType: fitted.mimeType, data: fitted.data, width: fitted.width, height: fitted.height } };
    }
  } catch (error) {
    reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
