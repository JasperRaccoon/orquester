/**
 * `BoxTranscriptSync` (spec §8.5): provider transcripts are written in the box and mirrored to the
 * host account home at the identical paths after every turn, so the host's history readers
 * (`agent-conversations.ts`, the adapters' history code) and a later resume keep working; before
 * a resume in a box, the session's files go into the box first.
 *
 * What a session's files are, per CLI (paths relative to the config root the CLI ran with):
 *
 * - Claude: `projects/<encoded cwd>/<session>.jsonl` plus the `<session>/` sidecar dir
 *   (`subagents/*.jsonl`, `tool-results/*`). The encoding is the CLI's: every character outside
 *   `[A-Za-z0-9]` becomes `-`, and names longer than 200 characters end in a hash (matched by
 *   prefix, as `agent-conversations.ts` does).
 * - Codex: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. Its SQLite state DB is never
 *   copied: Codex rebuilds it from the rollouts in the box's `CODEX_HOME` on its own (the
 *   agent-host's Codex launcher decides when to seed it, as `agent-isolation/codex-seed.ts` does on
 *   the host).
 * - Grok: `sessions/<encodeURIComponent(cwd)>/<session id>/` (`summary.json`, `updates.jsonl`, …).
 * - OpenCode: its sessions live in a SQLite DB (`opencode.db`), not in files, so the session goes
 *   through `opencode export <id>` on one side and `opencode import <file>` on the other. Import
 *   keeps the session id, adds the messages and parts it does not have yet (checked on 1.18.34)
 *   and leaves an existing session row as it is, so a mirrored session's title and time are those
 *   of its first import. Import takes the session's directory from its cwd, so it runs in `cwd`.
 *
 * **Box paths.** A box spells the cwd as `hostToBoxPath(cwd)` (Windows: `C:\orq\…`) and may record
 * its realpath instead (macOS: `/var` → `/private/var`), so the encoded folder of each spelling is
 * read and mapped to the host's own encoding of `cwd`; a resume pushes into each spelling.
 *
 * **Transfer.** `*.jsonl` files are append-only: when the host copy is a prefix of the box's
 * (checked with a hash of that prefix computed in the box), only the new tail travels; a file
 * that shrank or changed earlier bytes, and every other file, travels whole (temp + rename on the
 * host). Unchanged files (box size and mtime as last mirrored) cost one stat.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { hostToBoxPath } from "@orquester/api";

import type { BoxAgentId, BoxConnection, BoxHub, BoxTranscriptSync } from "../contracts.ts";
import { boxPathOf, boxStat, execBoxHasher, runBoxProcess, walkBox, writeBoxFile, type BoxHasher } from "./box-fs.ts";
import { sha256File, writeHostFileAtomic } from "./host-fs.ts";
import { isDeniedTranscriptPath, SYNC_TEMP_MARKER } from "./rules.ts";

export interface TranscriptRequest {
  agent: BoxAgentId | "opencode";
  /** The config root the CLI ran with (host path): `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`. */
  configRoot: string;
  /** The session's cwd (host path). */
  cwd: string;
  /** The provider session id; null = a session whose id is not known yet (pull every changed file). */
  sessionRef: string | null;
}

export interface HostRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export type HostRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }
) => Promise<HostRunResult>;

export interface BoxTranscriptSyncOptions {
  hub: Pick<BoxHub, "get">;
  hasher?: BoxHasher;
  logger?: { warn?(message: string): void };
  opencode?: {
    /** The host's `opencode` executable (the registry's resolved binary). Default `opencode`. */
    hostCommand?: string;
    hostEnv?: Record<string, string>;
    /** The box's `opencode`. Default `opencode` (on the box PATH). */
    boxCommand?: string;
    boxEnv?: Record<string, string>;
  };
  /** Runs host processes (tests replace it). */
  runHost?: HostRunner;
}

/** Claude's name for a cwd's transcript dir (the SDK's `sanitizePath`). */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const CLAUDE_DIR_NAME_MAX = 200;
const OPENCODE_TIMEOUT_MS = 120_000;

/** One host dir and the box dir standing for it. */
interface DirPair {
  host: string;
  /** A HOST-shaped path whose `hostToBoxPath` is the box dir (so box helpers can map it). */
  box: string;
}

interface FileToMirror {
  /** Host-shaped path of the box file (see {@link DirPair.box}). */
  box: string;
  host: string;
  size: number;
  mtimeMs: number;
}

const defaultRunHost: HostRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
      timeout: options.timeoutMs
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });

export class BoxTranscriptSyncService implements BoxTranscriptSync {
  private readonly hasher: BoxHasher;
  private readonly runHost: HostRunner;
  /** `<boxId>|<box file>` → the box file's size and mtime when it was last mirrored. */
  private readonly mirrored = new Map<string, { size: number; mtimeMs: number }>();

  constructor(private readonly options: BoxTranscriptSyncOptions) {
    this.hasher = options.hasher ?? execBoxHasher;
    this.runHost = options.runHost ?? defaultRunHost;
  }

  async pullAfterTurn(boxId: string, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    const connection = this.connection(boxId);
    if (request.agent === "opencode") {
      await this.opencodePull(connection, request, signal);
      return;
    }
    const files: FileToMirror[] = [];
    for (const pair of await this.dirPairs(connection, request, signal)) {
      const tree = await walkBox(connection, [pair.box], (path) => this.inSession(request, pair.box, path), signal);
      for (const file of tree.files.values()) {
        const rel = file.path.slice(pair.box.length + 1);
        const host = `${pair.host}/${rel}`;
        if (isDeniedTranscriptPath(host) || rel.includes(SYNC_TEMP_MARKER)) continue;
        const seen = this.mirrored.get(`${boxId}|${file.path}`);
        if (seen && seen.size === file.size && seen.mtimeMs === file.mtimeMs) continue;
        files.push({ box: file.path, host, size: file.size, mtimeMs: file.mtimeMs });
      }
    }
    await this.mirrorToHost(connection, files, signal);
  }

  async pushForResume(boxId: string, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    if (request.sessionRef === null) return; // a new session has nothing to resume
    const connection = this.connection(boxId);
    if (request.agent === "opencode") {
      await this.opencodePush(connection, request, signal);
      return;
    }
    const pairs = await this.dirPairs(connection, request, signal, { forPush: true });
    // The host dirs are shared by every spelling; list each once.
    const hostFiles = new Map<string, string[]>();
    for (const pair of pairs) {
      if (!hostFiles.has(pair.host)) hostFiles.set(pair.host, await this.hostSessionFiles(request, pair.host));
    }
    for (const pair of pairs) {
      const rels = hostFiles.get(pair.host) ?? [];
      const targets = rels.map((rel) => ({ rel, box: `${pair.box}/${rel}`, host: `${pair.host}/${rel}` }));
      const present: { index: number; size: number }[] = [];
      for (const [index, target] of targets.entries()) {
        const info = await boxStat(connection, target.box, signal);
        const local = await stat(target.host).catch(() => null);
        if (info?.kind === "file" && local && info.size === local.size) present.push({ index, size: info.size });
      }
      const same = new Set<number>();
      if (present.length > 0) {
        const hashes = await this.hasher(connection, present.map(({ index }) => ({ path: targets[index]!.box })), signal);
        for (const [position, { index }] of present.entries()) {
          if (hashes[position] === (await sha256File(targets[index]!.host))) same.add(index);
        }
      }
      for (const [index, target] of targets.entries()) {
        signal.throwIfAborted();
        if (!same.has(index)) await writeBoxFile(connection, target.box, createReadStream(target.host), 0o600);
        const info = await boxStat(connection, target.box, signal);
        if (info) this.mirrored.set(`${connection.boxId}|${target.box}`, { size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  private connection(boxId: string): BoxConnection {
    const connection = this.options.hub.get(boxId);
    if (!connection?.connected) throw Object.assign(new Error("The box is not connected."), { code: "BOX_NOT_READY" });
    return connection;
  }

  /** The cwd as the box may spell it: its mapped path, and its realpath in the box when different. */
  private async boxCwds(connection: BoxConnection, cwd: string, signal: AbortSignal): Promise<string[]> {
    const mapped = hostToBoxPath(connection.paths, cwd);
    const real = await connection.request("fs.realpath", { path: mapped }, { signal }).catch(() => null);
    return real !== null && real !== mapped ? [mapped, real] : [mapped];
  }

  /**
   * Host-shaped path of a box dir whose LAST segment is `name`, under host dir `parent` (whose box
   * form is `hostToBoxPath(parent)`). Box helpers map it back with `hostToBoxPath`.
   */
  private boxChild(parent: string, name: string): string {
    return `${parent}/${name}`;
  }

  private async dirPairs(connection: BoxConnection, request: TranscriptRequest, signal: AbortSignal, options: { forPush?: boolean } = {}): Promise<DirPair[]> {
    const root = posix.normalize(request.configRoot).replace(/\/+$/, "");
    const spellings = await this.boxCwds(connection, request.cwd, signal);
    if (request.agent === "claude") {
      const projects = `${root}/projects`;
      const hostName = claudeProjectDirName(request.cwd);
      const hostNames = hostName.length <= CLAUDE_DIR_NAME_MAX ? [hostName] : await this.prefixMatches(projects, hostName);
      const pairs: DirPair[] = [];
      for (const spelling of spellings) {
        const boxName = claudeProjectDirName(spelling);
        let boxNames: string[];
        if (boxName.length <= CLAUDE_DIR_NAME_MAX) boxNames = [boxName];
        else if (options.forPush) boxNames = boxName === hostName ? hostNames : [];
        else boxNames = await this.boxPrefixMatches(connection, projects, boxName, signal);
        for (const name of boxNames) {
          // The box folder maps to the host's own folder for this cwd (same name when the spelling is the host's).
          const host = name === hostName || hostNames.includes(name) ? `${projects}/${name}` : `${projects}/${hostNames[0] ?? hostName}`;
          pairs.push({ host, box: this.boxChild(projects, name) });
        }
      }
      return pairs;
    }
    if (request.agent === "codex") {
      return [{ host: `${root}/sessions`, box: `${root}/sessions` }];
    }
    // grok
    const sessions = `${root}/sessions`;
    const hostDir = `${sessions}/${encodeURIComponent(request.cwd)}`;
    return spellings.map((spelling) => ({ host: hostDir, box: this.boxChild(sessions, encodeURIComponent(spelling)) }));
  }

  private async prefixMatches(dir: string, name: string): Promise<string[]> {
    const prefix = `${name.slice(0, CLAUDE_DIR_NAME_MAX)}-`;
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries.filter((entry) => entry.startsWith(prefix));
  }

  private async boxPrefixMatches(connection: BoxConnection, dir: string, name: string, signal: AbortSignal): Promise<string[]> {
    const prefix = `${name.slice(0, CLAUDE_DIR_NAME_MAX)}-`;
    const entries = await connection.request("fs.readdir", { path: boxPathOf(connection, dir) }, { signal }).catch(() => []);
    return entries.filter((entry) => entry.kind === "dir" && entry.name.startsWith(prefix)).map((entry) => entry.name);
  }

  /** Whether a path below a session dir belongs to the request's session. */
  private inSession(request: TranscriptRequest, base: string, path: string): boolean {
    if (path === base) return true;
    const rel = path.slice(base.length + 1);
    if (rel.length === 0 || path.slice(0, base.length + 1) !== `${base}/`) return false;
    const first = rel.split("/")[0]!;
    if (request.sessionRef === null) return true;
    const id = request.sessionRef;
    switch (request.agent) {
      case "claude":
        return first === `${id}.jsonl` || first === id;
      case "codex": {
        // YYYY/MM/DD/rollout-<time>-<id>.jsonl: dirs are entered, files must name the thread.
        const name = posix.basename(rel);
        return !name.endsWith(".jsonl") ? !name.includes(".") : name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`);
      }
      case "grok":
        return first === id;
      default:
        return false;
    }
  }

  /** The session's files under a host dir, relative to it. */
  private async hostSessionFiles(request: TranscriptRequest, dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (path: string, rel: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const child = `${path}/${entry.name}`;
        if (!this.inSession(request, dir, child)) continue;
        if (isDeniedTranscriptPath(child) || entry.name.includes(SYNC_TEMP_MARKER)) continue;
        const info = await stat(child).catch(() => null);
        if (info?.isDirectory()) await walk(child, childRel, depth + 1);
        else if (info?.isFile()) out.push(childRel);
      }
    };
    await walk(dir, "", 0);
    return out.sort();
  }

  // -------------------------------------------------------------------------
  // Mirroring files
  // -------------------------------------------------------------------------

  private async mirrorToHost(connection: BoxConnection, files: readonly FileToMirror[], signal: AbortSignal): Promise<void> {
    if (files.length === 0) return;
    // One box hash batch: the prefix (append-only, grown) or the whole file (same size).
    const plans: { file: FileToMirror; hostSize: number | null; check: "prefix" | "whole" | null }[] = [];
    for (const file of files) {
      const local = await stat(file.host).catch(() => null);
      const hostSize = local?.isFile() ? local.size : null;
      let check: "prefix" | "whole" | null = null;
      if (hostSize !== null && file.box.endsWith(".jsonl") && file.size > hostSize) check = "prefix";
      else if (hostSize !== null && file.size === hostSize) check = "whole";
      plans.push({ file, hostSize, check });
    }
    const checks = plans.filter((plan) => plan.check !== null);
    const hashes = checks.length === 0 ? [] : await this.hasher(connection, checks.map((plan) => ({ path: plan.file.box, length: plan.check === "prefix" ? plan.hostSize! : undefined })), signal);
    const boxHash = new Map(checks.map((plan, index) => [plan, hashes[index] ?? null]));

    for (const plan of plans) {
      signal.throwIfAborted();
      const { file } = plan;
      let action: "skip" | "append" | "whole" = "whole";
      if (plan.check !== null) {
        const hostHash = await sha256File(file.host);
        if (boxHash.get(plan) === hostHash) action = plan.check === "prefix" ? "append" : "skip";
      }
      try {
        if (action === "append") await this.appendTail(connection, file, plan.hostSize!, signal);
        else if (action === "whole") await this.copyWhole(connection, file, signal);
        this.mirrored.set(`${connection.boxId}|${file.box}`, { size: file.size, mtimeMs: file.mtimeMs });
      } catch (error) {
        if (!connection.connected || signal.aborted) throw error;
        this.options.logger?.warn?.(`transcript sync (${connection.boxId}): mirroring ${file.host} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Append the box file's bytes [hostSize, size) to the host file; on failure the host file is cut back. */
  private async appendTail(connection: BoxConnection, file: FileToMirror, hostSize: number, signal: AbortSignal): Promise<void> {
    const stream = await connection.readFile(boxPathOf(connection, file.box), { offset: hostSize, length: file.size - hostSize, signal });
    const handle = await open(file.host, "r+");
    try {
      let position = hostSize;
      try {
        for await (const chunk of stream) {
          const buffer = chunk as Buffer;
          await handle.write(buffer, 0, buffer.length, position);
          position += buffer.length;
        }
        if (position !== file.size) throw new Error(`short read: ${position - hostSize} of ${file.size - hostSize} bytes`);
        await handle.sync();
      } catch (error) {
        await handle.truncate(hostSize).catch(() => undefined);
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  private async copyWhole(connection: BoxConnection, file: FileToMirror, signal: AbortSignal): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    if (file.size > 0) {
      const stream = await connection.readFile(boxPathOf(connection, file.box), { length: file.size, signal });
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
        total += (chunk as Buffer).length;
      }
    }
    if (total !== file.size) throw new Error(`short read: ${total} of ${file.size} bytes`);
    await mkdir(dirname(file.host), { recursive: true, mode: 0o700 });
    await writeHostFileAtomic(file.host, Buffer.concat(chunks), 0o600);
  }

  // -------------------------------------------------------------------------
  // OpenCode
  // -------------------------------------------------------------------------

  private async opencodePull(connection: BoxConnection, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    if (request.sessionRef === null) return; // nothing names the session yet
    const command = this.options.opencode?.boxCommand ?? "opencode";
    const exported = await runBoxProcess(
      connection,
      {
        command,
        args: ["export", request.sessionRef],
        cwd: hostToBoxPath(connection.paths, request.cwd),
        env: this.options.opencode?.boxEnv,
        timeoutMs: OPENCODE_TIMEOUT_MS
      },
      signal
    );
    if (exported.code !== 0) throw new Error(`opencode export failed in the box (exit ${exported.code})`);
    const data = this.checkedExport(exported.stdoutBytes, request.sessionRef);
    const tmp = join(tmpdir(), `orq-opencode-${randomUUID()}.json`);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      const imported = await this.runHost(this.options.opencode?.hostCommand ?? "opencode", ["import", tmp], {
        cwd: request.cwd,
        env: this.options.opencode?.hostEnv,
        timeoutMs: OPENCODE_TIMEOUT_MS,
        signal
      });
      if (imported.code !== 0) throw new Error(`opencode import failed on the host (exit ${imported.code})`);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async opencodePush(connection: BoxConnection, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    const sessionRef = request.sessionRef!;
    const exported = await this.runHost(this.options.opencode?.hostCommand ?? "opencode", ["export", sessionRef], {
      cwd: request.cwd,
      env: this.options.opencode?.hostEnv,
      timeoutMs: OPENCODE_TIMEOUT_MS,
      signal
    });
    if (exported.code !== 0) throw new Error(`opencode export failed on the host (exit ${exported.code})`);
    const data = this.checkedExport(exported.stdout, sessionRef);
    const separator = connection.sys.os === "win32" ? "\\" : "/";
    const boxTmp = `${connection.sys.dataDir.replace(/[\\/]+$/, "")}${separator}orq-opencode-${randomUUID()}.json`;
    await connection.writeFile(boxTmp, data, { mode: 0o600, mkdirs: true });
    try {
      const imported = await runBoxProcess(
        connection,
        {
          command: this.options.opencode?.boxCommand ?? "opencode",
          args: ["import", boxTmp],
          cwd: hostToBoxPath(connection.paths, request.cwd),
          env: this.options.opencode?.boxEnv,
          timeoutMs: OPENCODE_TIMEOUT_MS
        },
        signal
      );
      if (imported.code !== 0) throw new Error(`opencode import failed in the box (exit ${imported.code})`);
    } finally {
      await connection.request("fs.rm", { path: boxTmp, force: true }).catch(() => undefined);
    }
  }

  /** An export must be JSON naming the requested session (never import something else). */
  private checkedExport(data: Buffer, sessionRef: string): Buffer {
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      throw new Error("opencode export did not print JSON");
    }
    const id = (value as { info?: { id?: unknown } } | null)?.info?.id;
    if (id !== sessionRef) throw new Error("opencode export printed another session");
    return data;
  }
}
