/// <reference types="node" />
// Vite `define` shared by the web and desktop builds: the checkout's short git
// commit as `__ORQUESTER_BUILD__`, the app build the connection diagnostics
// report (`src/lib/connection/client-info.ts`). The daemon reports its own the
// same way, so a stale cached web app shows up as a different build.

import { execFileSync } from "node:child_process";

function shortCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

export function orquesterBuildDefine(): Record<string, string> {
  return { __ORQUESTER_BUILD__: JSON.stringify(shortCommit()) };
}
