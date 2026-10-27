/**
 * The host cache of verified tooling archives for boxes (spec §10):
 * `boxToolingArchivePath(appdir, { tool, version, os, arch, libc })`. Only the
 * daemon downloads; a box receives bytes the daemon checked against the
 * release's sha512 integrity. A cached file is hashed again before every use,
 * so a truncated or altered file is downloaded afresh rather than sent.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { boxToolingArchivePath, boxToolingCacheDir } from "@orquester/config";

import { sha512Base64, sha512Digests } from "../../plugins/ts-rust/installer.ts";
import type { ToolTarget } from "../contracts.ts";
import { type ToolArtifact, ToolingStepError } from "./types.ts";

/** The platform tarballs are ~15–50 MB; a stalled download must not hold a provision forever. */
const TOOLING_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** A tool id or version becomes a directory name: no separators, no "..". */
const SAFE_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

function isSafeToolingSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes("..");
}

export interface ToolingArchiveCacheOptions {
  /** The appdir base; the cache dir comes from the `packages/config` helper. */
  baseDir: string;
}

export class ToolingArchiveCache {
  /** Downloads in flight by cache path: concurrent provisions of one archive share one. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly options: ToolingArchiveCacheOptions) {}

  /** The host path of `artifact` for `target`, verified; downloaded first when no verified copy is cached. */
  async ensure(artifact: ToolArtifact, target: ToolTarget, signal: AbortSignal): Promise<string> {
    if (!isSafeToolingSegment(artifact.tool) || !isSafeToolingSegment(artifact.version)) {
      throw new ToolingStepError("resolve", `invalid tool "${artifact.tool}" or version "${artifact.version}"`);
    }
    if (!artifact.url.startsWith("https://")) {
      throw new ToolingStepError("resolve", `${artifact.tool}@${artifact.version} has no https archive`);
    }
    const digests = sha512Digests(artifact.integrity);
    if (digests.length === 0) {
      throw new ToolingStepError("resolve", `${artifact.tool}@${artifact.version} has no sha512 integrity`);
    }
    const file = boxToolingArchivePath(this.options.baseDir, { ...artifact, ...target });
    let pending = this.inflight.get(file);
    if (!pending) {
      pending = this.fill(file, artifact, digests).finally(() => this.inflight.delete(file));
      this.inflight.set(file, pending);
    }
    return await abortable(pending, signal);
  }

  /** Delete every cached version of `tool` not in `keep` (all platforms). */
  async prune(tool: string, keep: ReadonlySet<string>): Promise<void> {
    if (!isSafeToolingSegment(tool)) return;
    const dir = join(boxToolingCacheDir(this.options.baseDir), tool);
    const versions = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    for (const version of versions) {
      // A download in flight for that version is kept too: a provision is about to use it.
      const downloading = [...this.inflight.keys()].some((file) => resolve(dirname(file)) === resolve(dir, version));
      if (!keep.has(version) && !downloading) {
        await rm(join(dir, version), { recursive: true, force: true });
      }
    }
  }

  private async fill(file: string, artifact: ToolArtifact, digests: string[]): Promise<string> {
    if (await isFile(file)) {
      if (digests.includes(await sha512Base64(file))) return file;
      await rm(file, { force: true });
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const partial = `${file}.tmp-${randomUUID()}`;
    const timeout = AbortSignal.timeout(TOOLING_DOWNLOAD_TIMEOUT_MS);
    try {
      try {
        const response = await fetch(artifact.url, { signal: timeout });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${artifact.url}`);
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(partial, { mode: 0o600 }),
          { signal: timeout }
        );
      } catch (error) {
        const message = timeout.aborted
          ? `timed out after ${Math.round(TOOLING_DOWNLOAD_TIMEOUT_MS / 1000)}s`
          : error instanceof Error
            ? error.message
            : String(error);
        throw new ToolingStepError("download", message);
      }
      if (!digests.includes(await sha512Base64(partial))) {
        throw new ToolingStepError("integrity", "the download does not match the registry's sha512 integrity");
      }
      await rename(partial, file);
      return file;
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }
}

/** `promise`, or a rejection as soon as `signal` aborts (the shared download carries on for others). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ToolingStepError("download", "cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ToolingStepError("download", "cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}
