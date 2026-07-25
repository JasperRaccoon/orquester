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
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Pinned CLIProxyAPI SOURCE tarball for locally-patched builds. When any
 * `deploy/cliproxy-patches/*.patch` exists, `installBinary` builds from this
 * (sha256-verified) source with the patches applied instead of shipping the
 * stock release binary — the same self-sufficiency route as the original kimi
 * translator patch. `buildTag` marks the produced version string.
 */
export const CLIPROXY_SOURCE = {
  version: "v7.2.95",
  url: "https://github.com/router-for-me/CLIProxyAPI/archive/refs/tags/v7.2.95.tar.gz",
  sha256: "d1b2112ef7b3441ddb2c4c5b75443c257ca08ed8b42d26343b6a485a007a8e4c",
  buildTag: "+orq1"
} as const;

/** Injected download surface so unit tests copy a fixture tarball (no network). */
export interface InstallDeps {
  fetchTarball(url: string, destTmp: string): Promise<void>;
  /** Injected process runner (git apply / go build) so unit tests fake the
   *  toolchain. Defaults to execFile. */
  run?(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ stdout: string }>;
}

/** The committed patches dir, resolved relative to this source file (the daemon
 *  runs from source via tsx, so the repo layout is stable at runtime). */
export function patchesDir(): string {
  return fileURLToPath(new URL("../../../deploy/cliproxy-patches", import.meta.url));
}

/** Sorted absolute paths of committed `*.patch` files (empty when none/missing). */
export async function listPatches(dir: string = patchesDir()): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith(".patch"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Prefer an appdir-local Go toolchain (`<appdir>/go/bin/go` — provisioned by
 *  the deploy runbook, no systemd PATH changes needed), else rely on PATH. */
async function resolveGo(daemonDir: string): Promise<string> {
  const appdirGo = join(dirname(daemonDir), "go", "bin", "go");
  return (await exists(appdirGo)) ? appdirGo : "go";
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
  expectedSha: string = CLIPROXY_RELEASE.sha256,
  opts?: { patches?: string[]; sourceSha?: string }
): Promise<{ installed: boolean; version: string }> {
  // Opt-in patched path: the CALLER decides (index.ts passes listPatches()) so
  // stock unit tests and pre-patch installs keep the plain release behavior.
  if (opts?.patches && opts.patches.length > 0) {
    return buildPatchedBinary(daemonDir, deps, opts.patches, opts.sourceSha ?? CLIPROXY_SOURCE.sha256);
  }
  const root = cliproxyDir(daemonDir);
  const tmpDir = join(root, ".tmp");

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
    const listing = await exec("tar", ["-tzf", tarball]);
    const entries = listing.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    const candidates = entries.filter((entry) => !entry.endsWith("/") && basename(entry) === BINARY_NAME);
    if (candidates.length === 0) {
      throw new Error("cliproxy binary '" + BINARY_NAME + "' not found in release tarball");
    }
    if (candidates.length > 1) {
      throw new Error("cliproxy binary '" + BINARY_NAME + "' matched multiple release tarball entries: " + candidates.join(", "));
    }
    const entryPath = candidates[0];
    await exec("tar", ["-xzf", tarball, "-C", extractDir, entryPath]);
    const extracted = join(extractDir, entryPath);

    await promoteBinary(daemonDir, extracted);

    return { installed: true, version: CLIPROXY_RELEASE.version };
  } finally {
    await rm(tarball, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
}

/** Move a freshly-produced binary into `bin/`, keeping any prior one in
 *  `bin.prev/` for `rollbackBinary`. Shared by the stock and patched paths. */
async function promoteBinary(daemonDir: string, producedPath: string): Promise<void> {
  const root = cliproxyDir(daemonDir);
  const binDir = join(root, "bin");
  const prevDir = join(root, "bin.prev");
  const binPath = join(binDir, BINARY_NAME);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  if (await exists(binPath)) {
    await mkdir(prevDir, { recursive: true, mode: 0o700 });
    await rename(binPath, join(prevDir, BINARY_NAME));
  }
  await rename(producedPath, binPath);
  await chmod(binPath, 0o755);
}

/**
 * Download the pinned SOURCE tarball, sha256-verify it, apply the committed
 * patches with `git apply`, `go build` the server, and promote the result with
 * the same bin.prev rollback discipline as the stock path. The Go build cache
 * lives under `<appdir>/tmp` (already the daemon's writable TMPDIR carve-out)
 * so rebuilds after the first are fast.
 */
export async function buildPatchedBinary(
  daemonDir: string,
  deps: InstallDeps,
  patches: string[],
  expectedSha: string = CLIPROXY_SOURCE.sha256
): Promise<{ installed: boolean; version: string }> {
  const run = deps.run ?? ((cmd, args, o) => exec(cmd, args, { ...o, maxBuffer: 32 * 1024 * 1024 }));
  const root = cliproxyDir(daemonDir);
  const tmpDir = join(root, ".tmp");
  const appdir = dirname(daemonDir);

  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tarball = join(tmpDir, "source-" + process.pid + "-" + Date.now() + ".tgz");
  const extractDir = join(tmpDir, "src-" + process.pid + "-" + Date.now());

  try {
    await deps.fetchTarball(CLIPROXY_SOURCE.url, tarball);
    const actualSha = await sha256File(tarball);
    if (actualSha !== expectedSha) {
      throw new Error("cliproxy source sha256 mismatch");
    }

    await mkdir(extractDir, { recursive: true, mode: 0o700 });
    await exec("tar", ["-xzf", tarball, "-C", extractDir]);
    const roots = (await readdir(extractDir)).filter((name) => !name.startsWith("."));
    if (roots.length !== 1) {
      throw new Error("cliproxy source tarball has no single root dir");
    }
    const srcDir = join(extractDir, roots[0]);

    for (const patch of patches) {
      await run("git", ["apply", patch], { cwd: srcDir });
    }

    const goBin = await resolveGo(daemonDir);
    const builtPath = join(extractDir, BINARY_NAME);
    await run(
      goBin,
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", builtPath, "./cmd/server"],
      {
        cwd: srcDir,
        env: {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOCACHE: join(appdir, "tmp", "go-cache"),
          GOMODCACHE: join(appdir, "tmp", "go-mod"),
          GOFLAGS: "-mod=mod"
        }
      }
    );
    if (!(await exists(builtPath))) {
      throw new Error("cliproxy patched build produced no binary");
    }

    await promoteBinary(daemonDir, builtPath);
    return { installed: true, version: CLIPROXY_SOURCE.version + CLIPROXY_SOURCE.buildTag };
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
