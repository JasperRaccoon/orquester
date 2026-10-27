import type { ClientRequest, IncomingMessage } from "node:http";

/** Where a chunked GET stream's chunks and its single end go (the renderer's IPC channel). */
interface HttpStreamSink {
  data(chunk: string): void;
  /** Called exactly once. `status`: the error status the server answered instead of a stream. */
  end(status?: number): void;
}

/**
 * Wire a chunked GET (event bus, session output) to `sink`, ending it exactly once however the
 * stream stops: a clean end, an error answer, a failed request, or a response cut mid-body — the
 * daemon destroys a revoked session's streams, and a restart drops them. A cut response never emits
 * `end`, so `close` without `complete` is what reports it; without that the renderer would only
 * notice after its silence timeout.
 */
export function pipeHttpStream(req: ClientRequest, sink: HttpStreamSink): void {
  let ended = false;
  const finish = (status?: number): void => {
    if (ended) return;
    ended = true;
    sink.end(status);
  };
  req.on("error", () => finish());
  req.on("response", (res: IncomingMessage) => {
    const status = res.statusCode ?? 0;
    res.on("error", () => finish());
    if (status >= 400) {
      // An error answer is not stream content: drop its body and report the status instead.
      res.resume();
      res.on("end", () => finish(status));
      res.on("close", () => finish(status));
      return;
    }
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (!ended) sink.data(chunk);
    });
    res.on("end", () => finish());
    res.on("close", () => {
      if (!res.complete) finish();
    });
  });
}
