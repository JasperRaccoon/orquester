// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/renderScheduler.ts
export function createRenderScheduler(
  render: () => void,
  request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame,
) {
  let pending: number | null = null;
  let disposed = false;
  return {
    invalidate() {
      if (disposed || pending !== null) return;
      pending = request(() => {
        pending = null;
        if (!disposed) render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}
