// The graph layout worker (bundled as its own file via `./graph-layout.worker.ts?worker`, loaded
// with the first graph shown): arranges one graph per message, answering with its positions.
import { computeLayout, type LayoutRequest, type LayoutResponse } from "./graph-layout";

// The DOM lib types `self` as a Window; describe the dedicated-worker surface used here.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
};

worker.onmessage = (event) => {
  const { id, ...request } = event.data;
  try {
    worker.postMessage({ id, positions: computeLayout(request) });
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
