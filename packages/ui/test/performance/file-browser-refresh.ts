/**
 * React Profiler benchmark for unchanged file-tree refreshes.
 * Run from packages/ui:
 * TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs test/performance/file-browser-refresh.ts
 * No server: filesystem responses are JSON-round-tripped in memory. Focus events
 * exercise the same refresh callback used by the 3-second active-tab poll.
 */
import { performance } from "node:perf_hooks";
import { createElement, Profiler } from "react";
import { JSDOM } from "jsdom";
import type { FsEntry } from "@orquester/api";
import type { ApiClient } from "../../src/lib/api-client";
import { OrquesterProvider } from "../../src/context/orquester-context";

const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost/" });
for (const name of ["window", "document", "HTMLElement", "Element", "Node", "navigator", "Event", "MouseEvent", "localStorage"] as const) {
  Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FileBrowser } = await import("../../src/components/files/FileBrowser");
const rootPath = "/workspace/project";
const fileCount = Number(process.env.PERF_FILE_COUNT ?? 1000);
const iterations = Number(process.env.PERF_ITERATIONS ?? 30);
const entries: FsEntry[] = Array.from({ length: fileCount }, (_, i) => ({
  name: `source-${i}.ts`, path: `${rootPath}/source-${i}.ts`, kind: "file", size: 100 + i
}));
let requests = 0;
const api = {
  listFiles: async (path: string) => {
    requests++;
    return { path, parent: "/workspace", entries: JSON.parse(JSON.stringify(entries)) as FsEntry[] };
  },
  getFsCapabilities: async () => ({ folderZip: true })
} as unknown as ApiClient;
const root = createRoot(document.getElementById("root")!);
let commits = 0;
let actualDurationMs = 0;
await act(async () => root.render(createElement(OrquesterProvider, {
  runtime: "web", api, useTitlebar: false,
  children: createElement(Profiler, {
    id: "file-browser", onRender: (_id, _phase, duration) => { commits++; actualDurationMs += duration; },
    children: createElement(FileBrowser, { rootPath, active: true })
  })
})));
// Warm React and the focus path before collecting samples.
for (let i = 0; i < 5; i++) await act(async () => window.dispatchEvent(new Event("focus")));
commits = 0;
actualDurationMs = 0;
requests = 0;
const samples: number[] = [];
for (let i = 0; i < iterations; i++) {
  const start = performance.now();
  await act(async () => window.dispatchEvent(new Event("focus")));
  samples.push(performance.now() - start);
}
const sorted = [...samples].sort((a, b) => a - b);
console.log(JSON.stringify({ fileCount, iterations, requests, commits, actualDurationMs,
  medianRefreshMs: sorted[Math.floor(sorted.length / 2)], totalRefreshMs: samples.reduce((sum, value) => sum + value, 0),
  renderedFiles: document.querySelectorAll("button > span.flex-1.truncate").length
}, null, 2));
await act(async () => root.unmount());
dom.window.close();
