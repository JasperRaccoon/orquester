/**
 * Installing one verified tooling archive inside a box, over its
 * `BoxConnection` only (spec §10): the same stage → verify → extract →
 * smoke-test → rename steps as the host installer (`plugins/ts-rust/installer.ts`).
 *
 *   tooling/<tool>/.tmp/<version>-<uuid>/archive.tgz   streamed from the host cache (binary)
 *   tooling/<tool>/.tmp/<version>-<uuid>/extract/      `tar -xzf` in the box (`tar.exe` on Windows)
 *   tooling/<tool>/versions/<version>/                 the archive's `stripPrefix` dir, renamed in
 *                                                      once its entry binary passed the smoke test
 *
 * The version dir carries a marker naming the integrity it was installed
 * from, so a provision that finds it in place installs nothing. Any failure
 * removes the staging dir and leaves `versions/` as it was.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { finished } from "node:stream/promises";

import type { BoxConnection } from "../contracts.ts";
import { type ToolArtifact, type ToolingStep, ToolingStepError, type ToolingTargetContext } from "./types.ts";

/** Written into each installed version dir: what it was installed from. */
export const TOOLING_INSTALL_MARKER = ".orq-tooling.json";
export const TOOLING_EXTRACT_TIMEOUT_MS = 2 * 60_000;
export const TOOLING_SMOKE_TEST_TIMEOUT_MS = 30_000;
/** Output kept from a process run in the box (the rest is dropped). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface BoxRunResult {
  /** Null when killed by a signal, never started, or timed out. */
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the process did not start (ENOENT, EACCES, …). */
  spawnError?: string;
}

/**
 * Run a command in the box to completion: no shell, killed at `timeoutMs` or
 * when `signal` aborts (then `timedOut`, or a "cancelled" error).
 */
export async function runInBox(
  connection: BoxConnection,
  options: { command: string; args: string[]; cwd?: string; timeoutMs: number; signal: AbortSignal }
): Promise<BoxRunResult> {
  if (options.signal.aborted) throw new Error("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  // A deadline, not a wait: the process ends when it ends.
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const proc = connection.exec({ command: options.command, args: options.args, cwd: options.cwd, signal: controller.signal });
    proc.stdin.end();
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (size >= MAX_OUTPUT_BYTES) return;
        chunks.push(bytes.subarray(0, MAX_OUTPUT_BYTES - size));
        size += bytes.byteLength;
      });
      return () => Buffer.concat(chunks).toString("utf8");
    };
    const stdout = collect(proc.stdout);
    const stderr = collect(proc.stderr);
    const killOnAbort = () => proc.kill("SIGKILL");
    controller.signal.addEventListener("abort", killOnAbort, { once: true });
    const outcome = await new Promise<{ code: number | null; signal: string | null } | { error: Error }>((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
      proc.once("error", (error) => resolve({ error }));
    });
    controller.signal.removeEventListener("abort", killOnAbort);
    if (options.signal.aborted) throw new Error("cancelled");
    if ("error" in outcome) {
      if (timedOut) return { exitCode: null, signal: null, stdout: stdout(), stderr: stderr(), timedOut: true };
      const code = (outcome.error as NodeJS.ErrnoException).code;
      return { exitCode: null, signal: null, stdout: stdout(), stderr: stderr(), timedOut: false, spawnError: code ?? outcome.error.message };
    }
    // The exit can come before the last output: read both streams to their end.
    await Promise.all([finished(proc.stdout).catch(() => undefined), finished(proc.stderr).catch(() => undefined)]);
    return { exitCode: timedOut ? null : outcome.code, signal: outcome.signal, stdout: stdout(), stderr: stderr(), timedOut };
  } finally {
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", onAbort);
  }
}

/** A small text file from the box; null when it does not exist. */
export async function readBoxText(connection: BoxConnection, path: string, maxBytes = 64 * 1024): Promise<string | null> {
  const info = await connection.request("fs.stat", { path });
  if (info === null || info.kind !== "file" || info.size > maxBytes) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  // Bounded by the stat's size: a file that grew since is read up to it, and never past `maxBytes`.
  const stream = await connection.readFile(path, { length: info.size });
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface InstallArtifactOptions {
  /** The verified archive in the host cache. */
  archivePath: string;
  signal: AbortSignal;
  now: () => Date;
}

/**
 * Install `artifact` in the box unless its version dir already holds it.
 * Resolves whether anything was installed; throws a {@link ToolingStepError}.
 */
export async function installArtifactInBox(
  connection: BoxConnection,
  context: ToolingTargetContext,
  artifact: ToolArtifact,
  options: InstallArtifactOptions
): Promise<boolean> {
  const rules = context.path;
  const windows = context.target.os === "win32";
  const versionsDir = context.versionsDir(artifact.tool);
  const versionDir = context.versionDir(artifact.tool, artifact.version);
  const entrySegments = artifact.entry.split("/");

  if (await isInstalled(connection, context, artifact)) return false;

  const stagingRoot = rules.join(rules.dirname(versionsDir), ".tmp");
  const staging = rules.join(stagingRoot, `${artifact.version}-${randomUUID()}`);
  const signal = options.signal;
  try {
    // Leftovers of a provision cut short (provisions of one box run one at a time).
    await step("upload", signal, async () => {
      await connection.request("fs.rm", { path: stagingRoot, recursive: true, force: true });
      await connection.request("fs.mkdir", { path: rules.join(staging, "extract"), recursive: true, mode: 0o700 });
      const archive = rules.join(staging, "archive.tgz");
      await connection.writeFile(archive, createReadStream(options.archivePath), { mode: 0o600, mkdirs: true });
      const [sent, landed] = await Promise.all([stat(options.archivePath), connection.request("fs.stat", { path: archive })]);
      if (landed?.size !== sent.size) {
        throw new Error(`the box received ${landed?.size ?? 0} of ${sent.size} bytes`);
      }
    });

    const installDir = rules.join(staging, "extract", ...artifact.stripPrefix.split("/").filter((part) => part.length > 0));
    const binary = rules.join(installDir, ...entrySegments);
    await step("extract", signal, async () => {
      // Relative archive path with cwd: GNU tar would read a `C:`-style path as a remote host.
      const result = await runInBox(connection, {
        command: windows ? "tar.exe" : "tar",
        args: ["-xzf", "archive.tgz", "-C", "extract"],
        cwd: staging,
        timeoutMs: TOOLING_EXTRACT_TIMEOUT_MS,
        signal
      });
      if (result.spawnError) throw new Error(`tar failed to start (${result.spawnError})`);
      if (result.timedOut) throw new Error(`tar did not finish within ${TOOLING_EXTRACT_TIMEOUT_MS / 1000}s`);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim().split(/\r?\n/)[0];
        throw new Error(detail ? `tar failed: ${detail}` : `tar exited with ${result.exitCode ?? result.signal}`);
      }
      const info = await connection.request("fs.stat", { path: binary });
      if (info?.kind !== "file") {
        // The path inside the archive below its top dir: `lib/tsc` (tsc-rs), `tsrs`.
        throw new Error(`the archive has no ${[...artifact.stripPrefix.split("/").slice(1), ...entrySegments].filter(Boolean).join("/")}`);
      }
      if (!windows) {
        await connection.request("fs.chmod", { path: installDir, mode: 0o755 });
        await connection.request("fs.chmod", { path: binary, mode: 0o755 });
      }
    });

    await step("smoke-test", signal, async () => {
      const timeoutMs = artifact.smokeTest.timeoutMs ?? TOOLING_SMOKE_TEST_TIMEOUT_MS;
      const name = `${artifact.tool} ${artifact.smokeTest.args.join(" ")}`.trim();
      const result = await runInBox(connection, { command: binary, args: artifact.smokeTest.args, cwd: installDir, timeoutMs, signal });
      if (result.spawnError) throw new Error(`${name} failed to start (${result.spawnError})`);
      if (result.timedOut) throw new Error(`${name} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      if (result.exitCode !== 0) {
        throw new Error(`${name} exited with ${result.exitCode === null ? "a signal" : `code ${result.exitCode}`}`);
      }
      if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith(artifact.smokeTest.expectLinePrefix))) {
        throw new Error(`${name} printed no "${artifact.smokeTest.expectLinePrefix.trim()}" line`);
      }
    });

    await step("install", signal, async () => {
      const marker = { tool: artifact.tool, version: artifact.version, integrity: artifact.integrity, installedAt: options.now().toISOString() };
      await connection.writeFile(rules.join(installDir, TOOLING_INSTALL_MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o644 });
      await connection.request("fs.mkdir", { path: versionsDir, recursive: true });
      // A dir of this version without a matching marker is an older or broken install.
      await connection.request("fs.rm", { path: versionDir, recursive: true, force: true });
      await connection.request("fs.rename", { from: installDir, to: versionDir });
    });
    return true;
  } finally {
    await connection.request("fs.rm", { path: staging, recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether the version dir holds this exact release (marker integrity and entry binary). */
async function isInstalled(connection: BoxConnection, context: ToolingTargetContext, artifact: ToolArtifact): Promise<boolean> {
  const versionDir = context.versionDir(artifact.tool, artifact.version);
  try {
    const text = await readBoxText(connection, context.path.join(versionDir, TOOLING_INSTALL_MARKER));
    if (text === null) return false;
    const marker = JSON.parse(text) as { integrity?: unknown };
    if (marker.integrity !== artifact.integrity) return false;
    const entry = await connection.request("fs.stat", { path: context.path.join(versionDir, ...artifact.entry.split("/")) });
    return entry?.kind === "file";
  } catch {
    return false;
  }
}

/** Delete every installed version of `tool` in the box but `keep`. Best effort: a running binary on Windows cannot go. */
export async function pruneBoxVersions(connection: BoxConnection, context: ToolingTargetContext, tool: string, keep: string): Promise<void> {
  const versionsDir = context.versionsDir(tool);
  const entries = await connection.request("fs.readdir", { path: versionsDir }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === keep) continue;
    await connection
      .request("fs.rm", { path: context.path.join(versionsDir, entry.name), recursive: true, force: true })
      .catch(() => undefined);
  }
}

/** Run one step: abort-aware, any failure rethrown as a {@link ToolingStepError} for that step. */
async function step(name: ToolingStep, signal: AbortSignal, body: () => Promise<void>): Promise<void> {
  try {
    if (signal.aborted) throw new Error("cancelled");
    await body();
  } catch (error) {
    if (error instanceof ToolingStepError) throw error;
    if (signal.aborted) throw new ToolingStepError(name, "cancelled");
    throw new ToolingStepError(name, error instanceof Error ? error.message : String(error));
  }
}
