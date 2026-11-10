// The voxl decode worker: owns the WebSocket and the WebCodecs decoders and paints onto the
// OffscreenCanvas the page transferred, so decoding and painting never wait on the page's main
// thread (React renders, layout). Bundled by Vite as its own same-origin file through
// `./voxl.worker.ts?worker` (see voxl-client.ts).
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/worker.ts).

import { openVoxlConnection, type VoxlConnectionHandle } from "./connection";
import type { VoxlFromWorker, VoxlToWorker } from "./worker-protocol";

// The DOM lib types `self` as a Window; describe the dedicated-worker surface used here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<VoxlToWorker>) => void) | null;
  postMessage(message: VoxlFromWorker, transfer?: Transferable[]): void;
  close(): void;
};

let connection: VoxlConnectionHandle | null = null;

scope.onmessage = (event) => {
  const m = event.data;
  switch (m.t) {
    case "init":
      if (connection) return;
      connection = openVoxlConnection(m.url, m.canvas, (e) => {
        if (e.t === "cursor") scope.postMessage(e, [e.buf]);
        else scope.postMessage(e);
      });
      return;
    case "send":
      connection?.send(m.d);
      return;
    case "video":
      connection?.setVideo(m.on);
      return;
    case "close":
      connection?.close();
      connection = null;
      scope.close();
      return;
  }
};

scope.postMessage({ t: "ready" });
