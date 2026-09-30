// Imported before "opus-decoder" in opus.worker.ts. The package also carries OpusDecoderWebWorker,
// which evaluates `Worker` and subclasses it at module load; inside a worker without nested-worker
// support (Safari before 15.5, a target of this fallback) that would throw before decoding starts.
// Only the in-thread OpusDecoder is used here, so a placeholder is enough.
const scope = globalThis as { Worker?: unknown };
if (typeof scope.Worker === "undefined") scope.Worker = class UnavailableWorker {};

export {};
