/**
 * Config and transcript sync — the box side, built only from the core `orq-agent` methods
 * (`fs.stat`, `fs.readdir`, `fs.rm`, `exec`, file channels): manifests come from `fs.readdir`
 * walks, and file hashes from ONE `exec` per batch of `sha256sum` / `shasum -a 256` / `openssl`
 * (POSIX) or .NET's SHA-256 (Windows PowerShell). If no hash tool runs, the bytes are read over
 * the file channel and hashed on the host.
 *
 * Every function takes HOST paths and maps them with `hostToBoxPath` itself, so callers never
 * build a box path (Windows boxes put host paths under `C:\orq\`).
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { hostToBoxPath, type BoxFsStat } from "@orquester/api";

import type { BoxConnection } from "../contracts.ts";
import { MAX_SYNC_FILE_BYTES } from "./host-fs.ts";
import { isSafeEntryName } from "./rules.ts";

/** Box entry of a walk, keyed by its HOST path. */
export interface BoxFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface BoxTree {
  files: Map<string, BoxFile>;
  dirs: Set<string>;
}

const READDIR_CONCURRENCY = 8;
const HASH_BATCH_FILES = 200;
const HASH_BATCH_ARG_BYTES = 96 * 1024;
const HASH_TIMEOUT_MS = 120_000;
const MAX_DEPTH = 24;

export function boxPathOf(connection: BoxConnection, hostPath: string): string {
  return hostToBoxPath(connection.paths, hostPath);
}

export async function boxStat(connection: BoxConnection, hostPath: string, signal?: AbortSignal): Promise<BoxFsStat | null> {
  return connection.request("fs.stat", { path: boxPathOf(connection, hostPath), followSymlinks: true }, { signal });
}

/**
 * Walk box dirs below each of `starts` (host paths). `accept(hostPath, isDir)` decides what is
 * entered or reported. Box-side symlinks to files are reported with their target's size;
 * symlinked dirs are not entered (the host never puts a link in a box). A listed name that cannot
 * be one path segment (empty, `.`, `..`, a separator, NUL) is dropped: only a hostile or broken
 * box lists one, and every reported path may become a host path.
 */
export async function walkBox(
  connection: BoxConnection,
  starts: readonly string[],
  accept: (hostPath: string, isDir: boolean) => boolean,
  signal?: AbortSignal
): Promise<BoxTree> {
  const tree: BoxTree = { files: new Map(), dirs: new Set() };
  let queue: { path: string; depth: number }[] = [];
  for (const start of starts) {
    const info = await boxStat(connection, start, signal);
    if (info === null) continue;
    if (info.kind === "dir") {
      if (accept(start, true)) {
        tree.dirs.add(start);
        queue.push({ path: start, depth: 0 });
      }
    } else if (info.kind === "file" && accept(start, false)) {
      tree.files.set(start, { path: start, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  while (queue.length > 0) {
    const batch = queue.splice(0, READDIR_CONCURRENCY);
    const next: { path: string; depth: number }[] = [];
    await Promise.all(
      batch.map(async ({ path, depth }) => {
        signal?.throwIfAborted();
        const entries = await connection.request("fs.readdir", { path: boxPathOf(connection, path) }, { signal }).catch(() => []);
        for (const entry of entries) {
          if (typeof entry?.name !== "string" || !isSafeEntryName(entry.name)) continue;
          const child = `${path}/${entry.name}`;
          if (entry.kind === "dir") {
            if (depth < MAX_DEPTH && accept(child, true)) {
              tree.dirs.add(child);
              next.push({ path: child, depth: depth + 1 });
            }
          } else if (entry.kind === "file") {
            if (accept(child, false)) tree.files.set(child, { path: child, size: entry.size, mtimeMs: entry.mtimeMs });
          } else if (entry.kind === "symlink" && accept(child, false)) {
            const target = await boxStat(connection, child, signal).catch(() => null);
            if (target?.kind === "file") tree.files.set(child, { path: child, size: target.size, mtimeMs: target.mtimeMs });
          }
        }
      })
    );
    queue = queue.concat(next);
  }
  return tree;
}

async function collect(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`box file larger than ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * A whole box file (or `length` bytes from `offset`); null when it does not exist. At most
 * `maxBytes` (default {@link MAX_SYNC_FILE_BYTES}) are accepted, whatever size the box claims.
 */
export async function readBoxFile(
  connection: BoxConnection,
  hostPath: string,
  options: { offset?: number; length?: number; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<Buffer | null> {
  const info = await boxStat(connection, hostPath, options.signal);
  if (info === null || info.kind !== "file") return null;
  if (options.length === 0) return Buffer.alloc(0);
  const stream = await connection.readFile(boxPathOf(connection, hostPath), {
    offset: options.offset,
    length: options.length,
    signal: options.signal
  });
  return collect(stream, options.maxBytes ?? MAX_SYNC_FILE_BYTES);
}

export async function writeBoxFile(connection: BoxConnection, hostPath: string, data: Buffer | Readable, mode: number): Promise<void> {
  await connection.writeFile(boxPathOf(connection, hostPath), data, { mode, mkdirs: true });
}

export async function removeBoxPath(connection: BoxConnection, hostPath: string, recursive = false): Promise<void> {
  await connection.request("fs.rm", { path: boxPathOf(connection, hostPath), recursive, force: true });
}

// ---------------------------------------------------------------------------
// Hashing in the box
// ---------------------------------------------------------------------------

/** One file to hash: its HOST path and, for a prefix hash, the byte count (else the whole file). */
export interface BoxHashItem {
  path: string;
  length?: number;
}

/** SHA-256 hex per item, in order; null = missing (or not a regular file). */
export type BoxHasher = (connection: BoxConnection, items: readonly BoxHashItem[], signal?: AbortSignal) => Promise<(string | null)[]>;

/**
 * POSIX: `sh -c <script> orq-sync-hash <len|-> <path> …` prints one hash (or `-`) per pair. Paths
 * travel as arguments (never through a shell parse); nothing secret is in them.
 */
export const POSIX_HASH_SCRIPT = [
  "if command -v sha256sum >/dev/null 2>&1; then h() { sha256sum | cut -d' ' -f1; }",
  "elif command -v shasum >/dev/null 2>&1; then h() { shasum -a 256 | cut -d' ' -f1; }",
  "elif command -v openssl >/dev/null 2>&1; then h() { openssl dgst -sha256 | sed 's/^.*= *//'; }",
  "else echo 'no sha256 tool' >&2; exit 3; fi",
  'while [ "$#" -ge 2 ]; do',
  '  n=$1; p=$2; shift 2',
  '  if [ -f "$p" ]; then',
  '    if [ "$n" = "-" ]; then d=$(h < "$p"); else d=$(head -c "$n" < "$p" | h); fi',
  "    printf '%s\\n' \"$d\"",
  "  else printf '%s\\n' '-'; fi",
  "done"
].join("\n");

/**
 * Windows: the list arrives on stdin as `<len|->\t<path>` lines (UTF-8); one hash (or `-`) per
 * line on stdout.
 */
export const POWERSHELL_HASH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
  "$buf = New-Object byte[] 65536",
  "foreach ($line in ([Console]::In.ReadToEnd() -split \"`n\")) {",
  "  $line = $line.TrimEnd(\"`r\")",
  "  if ($line.Length -eq 0) { continue }",
  "  $tab = $line.IndexOf(\"`t\")",
  "  $n = $line.Substring(0, $tab)",
  "  $p = $line.Substring($tab + 1)",
  "  if (-not [System.IO.File]::Exists($p)) { [Console]::Out.WriteLine('-'); continue }",
  "  $sha = [System.Security.Cryptography.SHA256]::Create()",
  "  $fs = [System.IO.File]::OpenRead($p)",
  "  try {",
  "    if ($n -eq '-') { $left = [long]::MaxValue } else { $left = [long]$n }",
  "    while ($left -gt 0) {",
  "      $want = [int][Math]::Min([long]$buf.Length, $left)",
  "      $got = $fs.Read($buf, 0, $want)",
  "      if ($got -le 0) { break }",
  "      [void]$sha.TransformBlock($buf, 0, $got, $null, 0)",
  "      $left -= $got",
  "    }",
  "    [void]$sha.TransformFinalBlock($buf, 0, 0)",
  "    [Console]::Out.WriteLine(([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant())",
  "  } finally { $fs.Dispose(); $sha.Dispose() }",
  "}"
].join("\n");

/** `powershell.exe -EncodedCommand` takes base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one box process to completion with a deadline. */
export async function runBoxProcess(
  connection: BoxConnection,
  options: { command: string; args: string[]; stdin?: string | Buffer; cwd?: string; env?: Record<string, string>; timeoutMs: number },
  signal?: AbortSignal
): Promise<RunResult & { stdoutBytes: Buffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`box process timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const child = connection.exec({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      signal: controller.signal
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    const code = await exited;
    // Output streams may still hold their last chunks after the exit event.
    await Promise.all([finished(child.stdout), finished(child.stderr)]);
    const stdoutBytes = Buffer.concat(out);
    return { code, stdout: stdoutBytes.toString("utf8"), stdoutBytes, stderr: Buffer.concat(err).toString("utf8") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function finished(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", () => resolve());
  });
}

function parseHashLines(stdout: string, count: number): (string | null)[] | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== count) return null;
  const out: (string | null)[] = [];
  for (const line of lines) {
    const value = line.trim().toLowerCase();
    if (value === "-") out.push(null);
    else if (/^[0-9a-f]{64}$/.test(value)) out.push(value);
    else return null;
  }
  return out;
}

async function execHashBatch(connection: BoxConnection, items: readonly BoxHashItem[], signal?: AbortSignal): Promise<(string | null)[] | null> {
  const boxPaths = items.map((item) => boxPathOf(connection, item.path));
  const result =
    connection.sys.os === "win32"
      ? await runBoxProcess(
          connection,
          {
            command: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(POWERSHELL_HASH_SCRIPT)],
            stdin: items.map((item, index) => `${item.length ?? "-"}\t${boxPaths[index]}\n`).join(""),
            timeoutMs: HASH_TIMEOUT_MS
          },
          signal
        )
      : await runBoxProcess(
          connection,
          {
            command: "/bin/sh",
            args: ["-c", POSIX_HASH_SCRIPT, "orq-sync-hash", ...items.flatMap((item, index) => [String(item.length ?? "-"), boxPaths[index]!])],
            timeoutMs: HASH_TIMEOUT_MS
          },
          signal
        );
  if (result.code !== 0) return null;
  return parseHashLines(result.stdout, items.length);
}

/** Hash by reading the bytes over the file channel (no hash tool in the box). */
async function readHashBatch(connection: BoxConnection, items: readonly BoxHashItem[], signal?: AbortSignal): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const item of items) {
    const info = await boxStat(connection, item.path, signal);
    if (info === null || info.kind !== "file") {
      out.push(null);
      continue;
    }
    const hash = createHash("sha256");
    const length = item.length === undefined ? undefined : Math.min(item.length, info.size);
    if (length !== 0) {
      const stream = await connection.readFile(boxPathOf(connection, item.path), { length, signal });
      for await (const chunk of stream) hash.update(chunk as Buffer);
    }
    out.push(hash.digest("hex"));
  }
  return out;
}

function batches(items: readonly BoxHashItem[]): BoxHashItem[][] {
  const out: BoxHashItem[][] = [];
  let current: BoxHashItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(item.path) + 24;
    if (current.length > 0 && (current.length >= HASH_BATCH_FILES || bytes + size > HASH_BATCH_ARG_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The default {@link BoxHasher}: one exec per batch, falling back to reading the files. */
export const execBoxHasher: BoxHasher = async (connection, items, signal) => {
  const out: (string | null)[] = [];
  for (const batch of batches(items)) {
    const hashed = await execHashBatch(connection, batch, signal).catch(() => null);
    out.push(...(hashed ?? (await readHashBatch(connection, batch, signal))));
  }
  return out;
};
