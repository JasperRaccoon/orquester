import React, { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
// Vite bundles the worker for both apps/web and apps/desktop (both build the
// renderer with Vite and consume @orquester/ui as source).
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export const PdfViewer: React.FC<{
  path: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, fetchBytes }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (containerRef.current) containerRef.current.replaceChildren();
    setState("loading");

    fetchBytes(path, controller.signal)
      .then(async (bytes) => {
        // pdf.js may detach the buffer; pass a copy so it can't disturb callers.
        const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) break;
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mx-auto mb-3 max-w-full shadow";
          const ctx = canvas.getContext("2d");
          if (ctx && containerRef.current) {
            containerRef.current.appendChild(canvas);
            await page.render({ canvasContext: ctx, viewport }).promise;
          }
        }
        if (!cancelled) setState("ready");
        void doc.destroy();
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) setState("error");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fetchBytes, path]);

  return (
    <div className="relative h-full min-h-0 overflow-auto bg-neutral-900 p-4">
      {state === "loading" && <p className="p-3 text-xs text-neutral-600">Rendering PDF…</p>}
      {state === "error" && <p className="p-3 text-xs text-red-400">Could not render PDF.</p>}
      <div ref={containerRef} />
    </div>
  );
};
