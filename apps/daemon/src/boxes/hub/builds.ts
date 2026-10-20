/**
 * `orq-agent` builds served by `boxRoutes.agentBinary` and pushed by the
 * version handshake. Builds come from `apps/box-agent/dist` (`pnpm --filter
 * @orquester/box-agent build`), else from `boxAgentBuildsDir(appdir)`; when
 * neither has a manifest the hub can build into the appdir itself (needs Go).
 * Every served file is checked against its manifest sha256 first.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOX_AGENT_PLATFORMS } from "@orquester/api";
import { boxAgentBuildsDir } from "@orquester/config";

import type { BoxHubLogger } from "./hub.ts";

/** `apps/box-agent`. */
export const BOX_AGENT_SOURCE_DIR = fileURLToPath(new URL("../../../../box-agent/", import.meta.url));

export interface BoxAgentBuild {
  platform: string;
  version: string;
  path: string;
  sha256: string;
  size: number;
}

export interface BoxAgentBuilds {
  /** The version boxes should run; null when no build is available. */
  current(): Promise<{ version: string } | null>;
  /** One platform's verified build; null when there is none. */
  resolve(platform: string): Promise<BoxAgentBuild | null>;
}

interface Manifest {
  version: string;
  platforms: Record<string, { sha256: string; size: number }>;
}

function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, platforms } = value as { version?: unknown; platforms?: unknown };
  if (typeof version !== "string" || typeof platforms !== "object" || platforms === null) return null;
  const out: Manifest["platforms"] = {};
  for (const [platform, entry] of Object.entries(platforms as Record<string, unknown>)) {
    const { sha256, size } = (entry ?? {}) as { sha256?: unknown; size?: unknown };
    if (typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) && typeof size === "number") out[platform] = { sha256, size };
  }
  return { version, platforms: out };
}

export interface BoxAgentBuildsOptions {
  appdir: string;
  /** Directories searched for `manifest.json`, in order (default: box-agent dist, then the appdir cache). */
  dirs?: string[];
  /** Build into the appdir cache when no manifest exists (default true). */
  autoBuild?: boolean;
  logger?: BoxHubLogger;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function createBoxAgentBuilds(options: BoxAgentBuildsOptions): BoxAgentBuilds {
  const cacheDir = boxAgentBuildsDir(options.appdir);
  const dirs = options.dirs ?? [join(BOX_AGENT_SOURCE_DIR, "dist"), cacheDir];
  const autoBuild = options.autoBuild ?? true;
  /** path → verified (mtime, size); re-hashed when the file changes. */
  const verified = new Map<string, { mtimeMs: number; size: number }>();
  let building: Promise<void> | null = null;
  let buildFailed = false;

  const findManifest = async (): Promise<{ dir: string; manifest: Manifest } | null> => {
    for (const dir of dirs) {
      try {
        const manifest = parseManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
        if (manifest) return { dir, manifest };
      } catch {
        // Missing or unreadable: try the next directory.
      }
    }
    return null;
  };

  const build = (): Promise<void> => {
    building ??= (async () => {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      options.logger?.info("building orq-agent", { outDir: cacheDir });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "scripts/build.ts", "--out", cacheDir], {
          cwd: BOX_AGENT_SOURCE_DIR,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`orq-agent build failed (${code}): ${stderr.trim()}`))));
      });
    })().finally(() => {
      building = null;
    });
    return building;
  };

  const manifest = async (): Promise<{ dir: string; manifest: Manifest } | null> => {
    const found = await findManifest();
    if (found || !autoBuild || buildFailed) return found;
    try {
      await build();
    } catch (error) {
      // Do not retry a failing build on every connect; a daemon restart retries.
      buildFailed = true;
      options.logger?.warn("orq-agent build unavailable", { error: (error as Error).message });
      return null;
    }
    return findManifest();
  };

  return {
    async current() {
      const found = await manifest();
      return found ? { version: found.manifest.version } : null;
    },
    async resolve(platform) {
      if (!BOX_AGENT_PLATFORMS.includes(platform)) return null;
      const found = await manifest();
      const entry = found?.manifest.platforms[platform];
      if (!found || !entry) return null;
      const path = join(found.dir, platform, platform.startsWith("win32-") ? "orq-agent.exe" : "orq-agent");
      let info;
      try {
        info = await stat(path);
      } catch {
        return null;
      }
      const cached = verified.get(path);
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        if (info.size !== entry.size || (await sha256File(path)) !== entry.sha256) {
          options.logger?.warn("orq-agent build does not match its manifest", { platform });
          return null;
        }
        verified.set(path, { mtimeMs: info.mtimeMs, size: info.size });
      }
      return { platform, version: found.manifest.version, path, sha256: entry.sha256, size: entry.size };
    }
  };
}
