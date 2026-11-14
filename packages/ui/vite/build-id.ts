/// <reference types="node" />
// The app build, shared by the web and desktop builds: the checkout's short git
// commit, as the `__ORQUESTER_BUILD__` define the connection diagnostics report
// (`src/lib/connection/client-info.ts`), and in the web build also as a
// `build-id` file at the root of the dist. The daemon reports the `build-id` of
// the web app it serves (`webBuild` in `/api/info`), so a page whose build
// differs from it is a stale page that a reload replaces.

import { execFileSync } from "node:child_process";

/** Keep in step with `WEB_BUILD_ID_FILE` in `apps/daemon/src/build-info.ts`. */
const WEB_BUILD_ID_FILE = "build-id";

/** The checkout's short commit, or "unknown". Read it once per build and pass it to both helpers below. */
export function orquesterBuildId(): string {
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

export function orquesterBuildDefine(build: string = orquesterBuildId()): Record<string, string> {
  return { __ORQUESTER_BUILD__: JSON.stringify(build) };
}

// The slice of Vite's plugin API used here, typed structurally (see `excalidraw-assets.ts`).
interface EmitAssetContext {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

interface BuildIdFilePlugin {
  name: string;
  apply: "build";
  generateBundle(this: EmitAssetContext): void;
}

/** Writes `build` (the same value as the build's define) to `<outDir>/build-id`; nothing when it is unknown. */
export function orquesterBuildIdFile(build: string): BuildIdFilePlugin {
  return {
    name: "orquester:build-id",
    apply: "build",
    generateBundle() {
      if (build === "unknown") return;
      this.emitFile({ type: "asset", fileName: WEB_BUILD_ID_FILE, source: `${build}\n` });
    }
  };
}
