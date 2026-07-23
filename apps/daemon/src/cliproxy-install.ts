/**
 * Verified stock-binary install for the managed CLIProxyAPI service.
 *
 * Ships the pinned upstream release binary — no Go/source build (spike F3). The
 * SHA-256 digest is the integrity check, not the tag: the tarball is downloaded
 * to a private temp file, hashed, and rejected on mismatch before anything is
 * moved into place. Installs atomically, keeping any prior binary in `bin.prev/`
 * so a bad bump can be rolled back.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { cliproxyDir } from "@orquester/config";

const exec = promisify(execFile);

/** Pinned CLIProxyAPI release. Bump version + per-platform sha256 deliberately. */
export const CLIPROXY_RELEASE = {
  version: "v7.2.95",
  asset: "CLIProxyAPI_7.2.95_linux_amd64.tar.gz",
  sha256: "826604e2dbf11913b0f373047f7bca1829eb2bab8a45d3a1916cc2534c7a9fd5"
} as const;

/** The binary name inside the release tarball and installed under `bin/`. */
const BINARY_NAME = "cli-proxy-api";

/** Injected download surface so unit tests copy a fixture tarball (no network). */
export interface InstallDeps {
  fetchTarball(url: string, destTmp: string): Promise<void>;
}

/** The pinned release download URL. */
export function releaseUrl(): string {
  return (
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/" +
    CLIPROXY_RELEASE.version +
    "/" +
    CLIPROXY_RELEASE.asset
  );
}

/** Real streamed `fetch`-to-file download. Used by `index.ts`, NOT by unit tests. */
export const defaultFetchTarball: InstallDeps["fetchTarball"] = async (url, destTmp) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error("cliproxy binary download failed: HTTP " + res.status);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destTmp));
};

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download, sha256-verify, and atomically install the release binary.
 *
 * The tarball is written to a private `cliproxyDir/.tmp` file, hashed, and
 * rejected on mismatch (`Error("cliproxy binary sha256 mismatch")`) before any
 * install step. Any current `bin/cli-proxy-api` is moved to `bin.prev/` first,
 * so `rollbackBinary` can restore it. Pure install: idempotency/version-skip is
 * the caller's decision. `expectedSha` defaults to the pinned digest; tests pass
 * the fixture's real digest.
 */
export async function installBinary(
  daemonDir: string,
  deps: InstallDeps,
  expectedSha: string = CLIPROXY_RELEASE.sha256
): Promise<{ installed: boolean; version: string }> {
  const root = cliproxyDir(daemonDir);
  const tmpDir = join(root, ".tmp");
  const binDir = join(root, "bin");
  const prevDir = join(root, "bin.prev");
  const binPath = join(binDir, BINARY_NAME);

  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tarball = join(tmpDir, "download-" + process.pid + "-" + Date.now() + ".tgz");
  const extractDir = join(tmpDir, "extract-" + process.pid + "-" + Date.now());

  try {
    await deps.fetchTarball(releaseUrl(), tarball);

    const actualSha = await sha256File(tarball);
    if (actualSha !== expectedSha) {
      throw new Error("cliproxy binary sha256 mismatch");
    }

    await mkdir(extractDir, { recursive: true, mode: 0o700 });
    await exec("tar", ["-xzf", tarball, "-C", extractDir, BINARY_NAME]);
    const extracted = join(extractDir, BINARY_NAME);

    await mkdir(binDir, { recursive: true, mode: 0o700 });
    if (await exists(binPath)) {
      await mkdir(prevDir, { recursive: true, mode: 0o700 });
      await rename(binPath, join(prevDir, BINARY_NAME));
    }
    await rename(extracted, binPath);
    await chmod(binPath, 0o755);

    return { installed: true, version: CLIPROXY_RELEASE.version };
  } finally {
    await rm(tarball, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
}

/**
 * Restore the previous binary from `bin.prev/` back into `bin/`. Returns false
 * if there is no prior binary to roll back to.
 */
export async function rollbackBinary(daemonDir: string): Promise<boolean> {
  const root = cliproxyDir(daemonDir);
  const binPath = join(root, "bin", BINARY_NAME);
  const prevPath = join(root, "bin.prev", BINARY_NAME);
  if (!(await exists(prevPath))) return false;
  await mkdir(join(root, "bin"), { recursive: true, mode: 0o700 });
  await rm(binPath, { force: true });
  await rename(prevPath, binPath);
  await chmod(binPath, 0o755);
  return true;
}
