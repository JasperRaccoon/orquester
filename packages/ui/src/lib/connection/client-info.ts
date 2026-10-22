import type { Runtime } from "../../types";

/** Set by the web and desktop Vite builds (`vite/build-id.ts`); absent under tests. */
declare const __ORQUESTER_BUILD__: string | undefined;

/** This app's build: the checkout's short commit, or "unknown". */
export const CLIENT_BUILD: string =
  typeof __ORQUESTER_BUILD__ === "string" && __ORQUESTER_BUILD__ ? __ORQUESTER_BUILD__ : "unknown";

/** "Desktop app", "Web app (installed)" or "Web browser", for the diagnostics report. */
export function clientRuntimeLabel(runtime: Runtime): string {
  if (runtime === "desktop") return "Desktop app";
  if (typeof window === "undefined") return "Web browser";
  const standalone =
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? "Web app (installed)" : "Web browser";
}
