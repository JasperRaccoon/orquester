/**
 * Cross-compiles `orq-agent` (Go, CGO off) from this host to every platform
 * in `BOX_AGENT_PLATFORMS`, and writes `manifest.json` next to the builds:
 * `{ version, platforms: { <platform>: { sha256, size } } }`.
 *
 * Musl platforms get the same static binary as their glibc twin (a CGO-free Go
 * executable needs no libc), built once per GOOS/GOARCH.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOX_AGENT_PLATFORMS } from "@orquester/api";

/** `apps/box-agent`. */
export const BOX_AGENT_SOURCE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export interface BoxAgentManifest {
  version: string;
  platforms: Record<string, { sha256: string; size: number }>;
}

interface GoTarget {
  goos: "linux" | "darwin" | "windows";
  goarch: "amd64" | "arm64";
  exe: string;
}

function goTargetFor(platform: string): GoTarget {
  const [os, arch] = platform.split("-");
  const goos = os === "win32" ? "windows" : os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!goos || !goarch) throw new Error(`Unknown orq-agent platform ${platform}`);
  return { goos, goarch, exe: goos === "windows" ? "orq-agent.exe" : "orq-agent" };
}

export function executableName(platform: string): string {
  return goTargetFor(platform).exe;
}

/** `<package version>+<git short sha>` (`+unknown` outside a git checkout). */
export async function boxAgentVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(BOX_AGENT_SOURCE_DIR, "package.json"), "utf8")) as { version: string };
  let sha = "unknown";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: BOX_AGENT_SOURCE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || sha;
  } catch {
    // Not a git checkout (a packaged daemon): keep "unknown".
  }
  return `${pkg.version}+${sha}`;
}

function runGo(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const go = process.env.GO || "go";
  return new Promise((resolve, reject) => {
    const child = spawn(go, args, { cwd: BOX_AGENT_SOURCE_DIR, env, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => reject(new Error(`cannot run the Go toolchain (${go}): ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`go ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export interface BuildOptions {
  outDir: string;
  version: string;
  platforms?: readonly string[];
}

/** Builds the platforms into `<outDir>/<platform>/orq-agent[.exe]` and writes the manifest. */
export async function buildBoxAgent(options: BuildOptions): Promise<BoxAgentManifest> {
  const platforms = options.platforms ?? BOX_AGENT_PLATFORMS;
  const built = new Map<string, string>();
  const manifest: BoxAgentManifest = { version: options.version, platforms: {} };
  for (const platform of platforms) {
    const target = goTargetFor(platform);
    const key = `${target.goos}/${target.goarch}`;
    const dest = join(options.outDir, platform, target.exe);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    const previous = built.get(key);
    if (previous) {
      await copyFile(previous, tmp);
    } else {
      await runGo(["build", "-trimpath", "-ldflags", `-s -w -X main.version=${options.version}`, "-o", tmp, "."], {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: target.goos,
        GOARCH: target.goarch
      });
    }
    await rename(tmp, dest);
    built.set(key, dest);
    manifest.platforms[platform] = { sha256: await sha256File(dest), size: (await stat(dest)).size };
  }
  await writeFile(join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
