/**
 * The image worker's body (`image-pool.ts` starts it with `new Worker(new URL("./image-worker.ts"))`):
 * PNG decode, downscale and JPEG encode (`screenshot-image.ts`) off the daemon's event loop. It
 * inherits the daemon's `--import tsx`, and imports only `screenshot-image.ts` and Node built-ins
 * (erasable TypeScript, so Node's own type stripping loads it too).
 */

import { parentPort } from "node:worker_threads";

import { fitScreenshot, thumbnailJpeg } from "./screenshot-image.ts";
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
      const fitted = fitScreenshot(bytes(job.png), job.maxBase64Chars);
      reply = { id: message.id, ok: true, result: { kind: "fit", mimeType: fitted.mimeType, data: fitted.data, width: fitted.width, height: fitted.height } };
    }
  } catch (error) {
    reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
