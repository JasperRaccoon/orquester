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
 * **The box is untrusted.** Every name a box lists must be one plain path segment (`walkBox` drops
 * the rest), a session id must be one too, and a host write lands only below the session dir's
 * realpath without following any link under it (`hostTargetBelow`; appends open with
 * `O_NOFOLLOW`), never in the daemon's deny roots, and never on a temp file of either side.
 *
 * **Transfer.** `*.jsonl` files are append-only: when the host copy is a prefix of the box's
 * (checked with a hash of that prefix computed in the box), only the new tail travels; a file
 * that shrank or changed earlier bytes, and every other file, travels whole (streamed to a temp
 * file + rename on the host). Unchanged files (box and host copies as last mirrored) cost a stat
 * per side. Operations on one box run one at a time, so overlapping pulls never interleave.
 *
 * **Resume.** A resume never overwrites a box copy that is ahead of the host (a turn that ran on
 * after its pull was lost: the leftover CLI is stopped first by the agent host): a box `*.jsonl`
 * whose first host-size bytes are the host copy has its tail mirrored to the host instead; a box
 * copy that changed since its last sync in any other way has diverged and is kept (warned). A
 * copy the box did not change since its last sync is replaced by the host's.
 *
 * **Relocated sessions (Claude).** When a session's cwd moves into another project folder (an
 * `EnterWorktree` into `<cwd>/.claude/worktrees/<name>`), the CLI MOVES the transcript and its
 * sidecar into that folder and writes on there; `--resume` from the cwd still finds it there
 * (its recorded cwd is below the cwd) — unless a copy sits in the cwd's own folder, which
 * shadows it. So the folders of paths below the cwd that hold the session (`<cwd folder>-…`,
 * paired by suffix) are mirrored too; after a pull, a host copy in a folder the box no longer
 * holds the transcript in is deleted when it is where the box's live copy began (the host
 * mirrors the move), and kept with a warning otherwise; and a resume pushes only into the
 * folders where the box holds the transcript — a box without one gets the host's newest copy,
 * where the CLI last wrote it — never a stale copy beside the live one.
 *
 * **One history per box.** The host's account homes all link their history dir (Claude `projects`,
 * Codex and Grok `sessions`) to one shared dir, so a chat moving between accounts keeps one
 * transcript. A POSIX box with identity paths gets the same link at every CLI start. A real dir an
 * earlier sync left in an account home is merged into the shared one first, the longest `*.jsonl`
 * (the newest other file) winning per file, and what lost stays in `<entry>.pre-share`. Files of a
 * running CLI must not move, so a box running another CLI of that agent is merged at a later start.
 * Until then, and on boxes without links, a home can hold a copy older than the chat: a resume
 * replaces a shorter copy that is no prefix of the host's, and a pull never shortens a host
 * transcript, so an account's old copy can neither be resumed nor overwrite the conversation.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";

import { hostToBoxPath, type BoxFsStat } from "@orquester/api";

import type { BoxAgentId, BoxConnection, BoxHub, BoxTranscriptSync } from "../contracts.ts";
import { boxPathOf, boxStat, execBoxHasher, runBoxProcess, walkBox, writeBoxFile, type BoxHasher, type BoxHashItem } from "./box-fs.ts";
import { hostTargetBelow, orAbsent, sha256File, writeHostStreamAtomic } from "./host-fs.ts";
import { defaultSyncDenyRoots, isDeniedRealPath, isDeniedTranscriptPath, isSafeEntryName, isSafeRelPath, isTempName } from "./rules.ts";

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
  /** The daemon's appdir: its secret places (`defaultSyncDenyRoots`) are never written. */
  appdir: string;
  /** Realpath roots never written (replaces the appdir's defaults). */
  denyRoots?: readonly string[];
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
/** The dir of a config root that every account home shares on the host. */
const HISTORY_DIR: Partial<Record<TranscriptRequest["agent"], string>> = { claude: "projects", codex: "sessions", grok: "sessions" };

/** One host dir and the box dir standing for it. */
interface DirPair {
  host: string;
  /** A HOST-shaped path whose `hostToBoxPath` is the box dir (so box helpers can map it). */
  box: string;
}

interface FileToMirror {
  /** Host-shaped path of the box file (see {@link DirPair.box}). */
  box: string;
  /** The host session dir it mirrors into, and its path below it (plain names only). */
  base: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

/** Both sides of a file as they were when it was last mirrored or pushed. */
interface Mirrored {
  size: number;
  mtimeMs: number;
  hostSize: number;
  hostMtimeMs: number;
}

const OPEN_EXISTING_NOFOLLOW = constants.O_RDWR | constants.O_NOFOLLOW;

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

/** SHA-256 of a host file's first `length` bytes. */
async function sha256FilePrefix(path: string, length: number): Promise<string> {
  const hash = createHash("sha256");
  if (length > 0) await pipeline(createReadStream(path, { start: 0, end: length - 1 }), hash);
  return hash.digest("hex");
}

/** A session id becomes a path segment and a process argument: one plain name, no option look. */
function checkSessionRef(request: TranscriptRequest): void {
  const id = request.sessionRef;
  if (id !== null && (!isSafeEntryName(id) || id.startsWith("-"))) {
    throw Object.assign(new Error("Refusing a transcript sync for an invalid session id."), { code: "BOX_INVALID_REQUEST" });
  }
}

export class BoxTranscriptSyncService implements BoxTranscriptSync {
  private readonly hasher: BoxHasher;
  private readonly runHost: HostRunner;
  private readonly denyRoots: readonly string[];
  /** `<boxId>|<box file>` → both copies when the file was last mirrored or pushed. */
  private readonly mirrored = new Map<string, Mirrored>();
  /** Per box: the tail of its operation queue. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: BoxTranscriptSyncOptions) {
    this.hasher = options.hasher ?? execBoxHasher;
    this.runHost = options.runHost ?? defaultRunHost;
    this.denyRoots = options.denyRoots ?? defaultSyncDenyRoots(options.appdir);
  }

  async pullAfterTurn(boxId: string, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    checkSessionRef(request);
    await this.queued(boxId, async () => {
      const connection = this.connection(boxId);
      if (request.agent === "opencode") {
        await this.opencodePull(connection, request, signal);
        return;
      }
      const files: FileToMirror[] = [];
      const pairs = await this.dirPairs(connection, request, signal);
      for (const pair of pairs) {
        const tree = await walkBox(connection, [pair.box], (path, isDir) => this.inSession(request, pair.box, path, isDir), signal);
        for (const file of tree.files.values()) {
          const rel = file.path.slice(pair.box.length + 1);
          if (!isSafeRelPath(rel) || rel.split("/").some(isTempName)) continue;
          if (isDeniedTranscriptPath(`${pair.host}/${rel}`, this.denyRoots)) continue;
          if (await this.unchangedSinceMirrored(connection.boxId, file.path, file, `${pair.host}/${rel}`)) continue;
          files.push({ box: file.path, base: pair.host, rel, size: file.size, mtimeMs: file.mtimeMs });
        }
      }
      await this.mirrorToHost(connection, files, signal);
      if (request.agent === "claude" && request.sessionRef !== null) {
        await this.dropMovedHostCopies(connection, pairs, request.sessionRef, signal);
      }
    });
  }

  async pushForResume(boxId: string, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    checkSessionRef(request);
    await this.queued(boxId, async () => {
      const connection = this.connection(boxId);
      await this.shareBoxHistory(connection, request, signal);
      if (request.sessionRef === null) return; // a new session has nothing to resume
      if (request.agent === "opencode") {
        await this.opencodePush(connection, request, signal);
        return;
      }
      const all = await this.dirPairs(connection, request, signal, { forPush: true });
      const resumeHosts = request.agent === "claude" ? await this.claudeResumeHosts(connection, all, request.sessionRef, signal) : null;
      const pairs = resumeHosts === null ? all : all.filter((pair) => resumeHosts.has(pair.host));
      // The host dirs are shared by every spelling; list each once.
      const hostFiles = new Map<string, string[]>();
      for (const pair of pairs) {
        if (!hostFiles.has(pair.host)) hostFiles.set(pair.host, await this.hostSessionFiles(request, pair.host));
      }
      for (const pair of pairs) await this.pushPair(connection, pair, hostFiles.get(pair.host) ?? [], signal);
    });
  }

  // -------------------------------------------------------------------------
  // One history per box
  // -------------------------------------------------------------------------

  /** Make the box's history dir of this config root the link the host's is (see the module doc). */
  private async shareBoxHistory(connection: BoxConnection, request: TranscriptRequest, signal: AbortSignal): Promise<void> {
    const entry = HISTORY_DIR[request.agent];
    if (entry === undefined || connection.paths.kind !== "identity" || connection.sys.os === "win32") return;
    const link = `${posix.normalize(request.configRoot).replace(/\/+$/, "")}/${entry}`;
    const target = await readlink(link).catch(() => null);
    if (target === null || !posix.isAbsolute(target) || posix.basename(target) !== entry) return;
    if (isDeniedTranscriptPath(target, this.denyRoots)) return;
    const info = await connection.request("fs.stat", { path: boxPathOf(connection, link), followSymlinks: false }, { signal });
    if (info?.kind === "symlink") return;
    if (info !== null && info.kind !== "dir") return;
    const aside = `${link}.pre-share`;
    try {
      if (info?.kind === "dir") {
        const procs = await connection.request("proc.list", {}, { signal });
        if (procs.some((proc) => proc.running && proc.procId.startsWith(`agent-${request.agent}-`))) return;
      }
      await connection.request("agent.ensurePaths", { paths: [boxPathOf(connection, target)] }, { signal });
      if (info?.kind === "dir") {
        await this.mergeBoxDir(connection, link, target, signal);
        await connection.request("fs.rename", { from: boxPathOf(connection, link), to: boxPathOf(connection, aside) }, { signal });
      }
      await connection.request("fs.symlink", { target: boxPathOf(connection, target), path: boxPathOf(connection, link) }, { signal });
    } catch (error) {
      if (!connection.connected || signal.aborted) throw error;
      if (info?.kind === "dir" && (await boxStat(connection, link, signal)) === null) {
        await connection.request("fs.rename", { from: boxPathOf(connection, aside), to: boxPathOf(connection, link) }, { signal }).catch(() => undefined);
      }
      this.warn(connection, `${link} stays per account in the box: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Move what `from` holds into `to`; a file that loses to the one already there stays in `from`. */
  private async mergeBoxDir(connection: BoxConnection, from: string, to: string, signal: AbortSignal): Promise<void> {
    for (const entry of await connection.request("fs.readdir", { path: boxPathOf(connection, from) }, { signal })) {
      if (!isSafeEntryName(entry.name) || isTempName(entry.name)) continue;
      const source = `${from}/${entry.name}`;
      const target = `${to}/${entry.name}`;
      const there = await boxStat(connection, target, signal);
      if (there?.kind === "dir" && entry.kind === "dir") {
        await this.mergeBoxDir(connection, source, target, signal);
        continue;
      }
      if (there !== null) {
        const here = await boxStat(connection, source, signal);
        if (here?.kind !== "file" || there.kind !== "file") continue;
        if (entry.name.endsWith(".jsonl") ? here.size <= there.size : here.mtimeMs <= there.mtimeMs) continue;
        // The two swap, so the copy that lost is the one left behind in `from`.
        const swap = `${source}.swap`;
        await connection.request("fs.rename", { from: boxPathOf(connection, target), to: boxPathOf(connection, swap) }, { signal });
        await connection.request("fs.rename", { from: boxPathOf(connection, source), to: boxPathOf(connection, target) }, { signal });
        await connection.request("fs.rename", { from: boxPathOf(connection, swap), to: boxPathOf(connection, source) }, { signal });
        continue;
      }
      await connection.request("fs.rename", { from: boxPathOf(connection, source), to: boxPathOf(connection, target) }, { signal });
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

  /** Run `operation` after every earlier operation on the box (failed ones included). */
  private queued<T>(boxId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(boxId) ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(boxId, tail);
    void tail.then(() => {
      if (this.queues.get(boxId) === tail) this.queues.delete(boxId);
    });
    return result;
  }

  /** The cwd as the box may spell it: its mapped path, and its realpath in the box when different. */
  private async boxCwds(connection: BoxConnection, cwd: string, signal: AbortSignal): Promise<string[]> {
    const mapped = hostToBoxPath(connection.paths, cwd);
    const real = await connection.request("fs.realpath", { path: mapped }, { signal }).catch(() => null);
    return real !== null && real !== mapped ? [mapped, real] : [mapped];
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
          pairs.push({ host, box: `${projects}/${name}` });
        }
      }
      if (request.sessionRef !== null) {
        pairs.push(...(await this.relocatedPairs(connection, projects, hostName, spellings, request.sessionRef, signal)));
      }
      return pairs;
    }
    if (request.agent === "codex") {
      return [{ host: `${root}/sessions`, box: `${root}/sessions` }];
    }
    // grok
    const sessions = `${root}/sessions`;
    const hostDir = `${sessions}/${encodeURIComponent(request.cwd)}`;
    return spellings.map((spelling) => ({ host: hostDir, box: `${sessions}/${encodeURIComponent(spelling)}` }));
  }

  /**
   * Claude folders of paths below the cwd (`<cwd folder>-<suffix>`, e.g. a worktree's under
   * `.claude/worktrees/`) holding the session on either side, paired by suffix: the CLI moves a
   * session into the folder of its new cwd (see "Relocated sessions" in the module doc). The
   * encoding makes `/w/proj-x` read as a path below `/w/proj` too, so only a folder holding the
   * session's own files is taken. A cwd folder name over 200 characters ends in a hash of the
   * whole path, so nothing below it shares a prefix with it: such a cwd has no related folders.
   * A related name that is itself truncated hashes its whole path, so it pairs only between
   * identical spellings.
   */
  private async relocatedPairs(
    connection: BoxConnection,
    projects: string,
    hostName: string,
    spellings: readonly string[],
    sessionRef: string,
    signal: AbortSignal
  ): Promise<DirPair[]> {
    if (hostName.length > CLAUDE_DIR_NAME_MAX) return [];
    const hostEntries = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const boxEntries = await connection.request("fs.readdir", { path: boxPathOf(connection, projects) }, { signal }).catch(() => []);
    const rename = (name: string, from: string, to: string): string | null => {
      if (name.length > CLAUDE_DIR_NAME_MAX) return from === to ? name : null;
      const renamed = `${to}${name.slice(from.length)}`;
      return renamed.length <= CLAUDE_DIR_NAME_MAX && isSafeEntryName(renamed) ? renamed : null;
    };
    const candidates = new Map<string, DirPair>();
    const add = (host: string, box: string): void => {
      if (!candidates.has(box)) candidates.set(box, { host: `${projects}/${host}`, box: `${projects}/${box}` });
    };
    for (const spelling of spellings) {
      const boxName = claudeProjectDirName(spelling);
      if (boxName.length > CLAUDE_DIR_NAME_MAX) continue;
      for (const entry of boxEntries) {
        if (entry.kind !== "dir" || !isSafeEntryName(entry.name) || !entry.name.startsWith(`${boxName}-`)) continue;
        const host = rename(entry.name, boxName, hostName);
        if (host !== null) add(host, entry.name);
      }
      for (const entry of hostEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith(`${hostName}-`)) continue;
        const box = rename(entry.name, hostName, boxName);
        if (box !== null) add(entry.name, box);
      }
    }
    const pairs: DirPair[] = [];
    for (const pair of candidates.values()) {
      const held =
        (await boxStat(connection, `${pair.box}/${sessionRef}.jsonl`, signal)) !== null ||
        (await boxStat(connection, `${pair.box}/${sessionRef}`, signal)) !== null ||
        (await orAbsent(lstat(`${pair.host}/${sessionRef}.jsonl`))) !== null ||
        (await orAbsent(lstat(`${pair.host}/${sessionRef}`))) !== null;
      if (held) pairs.push(pair);
    }
    return pairs;
  }

  /** Every pair's box copy of the Claude session's transcript that exists, as the box stats it. */
  private async boxSessionCopies(connection: BoxConnection, pairs: readonly DirPair[], sessionRef: string, signal: AbortSignal): Promise<{ pair: DirPair; box: string; info: BoxFsStat }[]> {
    const copies: { pair: DirPair; box: string; info: BoxFsStat }[] = [];
    for (const pair of pairs) {
      const box = `${pair.box}/${sessionRef}.jsonl`;
      const info = await boxStat(connection, box, signal);
      if (info?.kind === "file") copies.push({ pair, box, info });
    }
    return copies;
  }

  /**
   * After a pull: a host copy of the transcript in a folder where the box no longer has one was
   * moved away by the CLI (relocated). When it is where the box's live copy (the newest) began,
   * the host mirrors the move and deletes it, so no reader or resume takes it for the session;
   * anything else is kept and warned about.
   */
  private async dropMovedHostCopies(connection: BoxConnection, pairs: readonly DirPair[], sessionRef: string, signal: AbortSignal): Promise<void> {
    const copies = await this.boxSessionCopies(connection, pairs, sessionRef, signal);
    if (copies.length === 0) return;
    const live = copies.reduce((newest, copy) => (copy.info.mtimeMs > newest.info.mtimeMs ? copy : newest));
    const holding = new Set(copies.map((copy) => copy.pair.host));
    for (const host of new Set(pairs.map((pair) => pair.host))) {
      if (holding.has(host)) continue;
      const path = `${host}/${sessionRef}.jsonl`;
      if (isDeniedTranscriptPath(path, this.denyRoots)) continue;
      const local = await orAbsent(lstat(path));
      if (!local?.isFile()) continue;
      if (live.info.size >= local.size) {
        const [boxHash] = await this.hasher(connection, [{ path: live.box, length: local.size }], signal);
        if (boxHash === (await sha256FilePrefix(path, local.size))) {
          await rm(path, { force: true });
          continue;
        }
      }
      this.warn(connection, `${path} is not where the box's relocated copy of the session began; the host keeps it`);
    }
  }

  /**
   * Before a Claude resume: the host folders whose files go into the box, null for all. Where the
   * box holds the transcript, only there (a copy beside it would shadow it: the CLI resumes the
   * cwd folder's first); a box without one gets the host's newest copy, which is where the CLI
   * last wrote it.
   */
  private async claudeResumeHosts(connection: BoxConnection, pairs: readonly DirPair[], sessionRef: string | null, signal: AbortSignal): Promise<Set<string> | null> {
    if (sessionRef === null) return null;
    const copies = await this.boxSessionCopies(connection, pairs, sessionRef, signal);
    if (copies.length > 0) return new Set(copies.map((copy) => copy.pair.host));
    let newest: { host: string; mtimeMs: number } | null = null;
    for (const host of new Set(pairs.map((pair) => pair.host))) {
      const local = await orAbsent(stat(`${host}/${sessionRef}.jsonl`));
      if (local?.isFile() && (newest === null || local.mtimeMs > newest.mtimeMs)) newest = { host, mtimeMs: local.mtimeMs };
    }
    return newest === null ? null : new Set([newest.host]);
  }

  private async prefixMatches(dir: string, name: string): Promise<string[]> {
    const prefix = `${name.slice(0, CLAUDE_DIR_NAME_MAX)}-`;
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries.filter((entry) => entry.startsWith(prefix));
  }

  private async boxPrefixMatches(connection: BoxConnection, dir: string, name: string, signal: AbortSignal): Promise<string[]> {
    const prefix = `${name.slice(0, CLAUDE_DIR_NAME_MAX)}-`;
    const entries = await connection.request("fs.readdir", { path: boxPathOf(connection, dir) }, { signal }).catch(() => []);
    return entries.filter((entry) => entry.kind === "dir" && isSafeEntryName(entry.name) && entry.name.startsWith(prefix)).map((entry) => entry.name);
  }

  /** Whether a path below a session dir belongs to the request's session. */
  private inSession(request: TranscriptRequest, base: string, path: string, isDir: boolean): boolean {
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
        // YYYY/MM/DD/rollout-<time>-<id>.jsonl: the date dirs are entered, files must name the thread.
        const name = posix.basename(rel);
        return isDir ? /^\d+$/.test(name) : name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`);
      }
      case "grok":
        return first === id;
      default:
        return false;
    }
  }

  /** The session's files under a host dir, relative to it (credential files, by name or realpath, never). */
  private async hostSessionFiles(request: TranscriptRequest, dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (path: string, rel: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const child = `${path}/${entry.name}`;
        if (isDeniedTranscriptPath(child, this.denyRoots) || isTempName(entry.name)) continue;
        // Names first: a big sessions tree costs a stat only for what may belong to the session.
        if (!this.inSession(request, dir, child, true) && !this.inSession(request, dir, child, false)) continue;
        const info = await stat(child).catch(() => null);
        if (info?.isDirectory() && this.inSession(request, dir, child, true)) await walk(child, childRel, depth + 1);
        else if (info?.isFile() && this.inSession(request, dir, child, false)) {
          const real = await realpath(child).catch(() => null);
          if (real !== null && !isDeniedRealPath(real, this.denyRoots)) out.push(childRel);
        }
      }
    };
    await walk(dir, "", 0);
    return out.sort();
  }

  // -------------------------------------------------------------------------
  // Mirroring files
  // -------------------------------------------------------------------------

  private warn(connection: BoxConnection, message: string): void {
    this.options.logger?.warn?.(`transcript sync (${connection.boxId}): ${message}`);
  }

  /** Whether neither copy changed since the file was last mirrored or pushed. */
  private async unchangedSinceMirrored(boxId: string, boxPath: string, box: { size: number; mtimeMs: number }, host: string): Promise<boolean> {
    const seen = this.mirrored.get(`${boxId}|${boxPath}`);
    if (!seen || seen.size !== box.size || seen.mtimeMs !== box.mtimeMs) return false;
    const local = await lstat(host).catch(() => null);
    return local !== null && local.size === seen.hostSize && local.mtimeMs === seen.hostMtimeMs;
  }

  /** Remember both copies (the host one at `host`) as they are now. */
  private async remember(boxId: string, boxPath: string, box: { size: number; mtimeMs: number }, host: string): Promise<void> {
    const local = await stat(host).catch(() => null);
    if (local === null) return;
    this.mirrored.set(`${boxId}|${boxPath}`, { size: box.size, mtimeMs: box.mtimeMs, hostSize: local.size, hostMtimeMs: local.mtimeMs });
  }

  private async mirrorToHost(connection: BoxConnection, files: readonly FileToMirror[], signal: AbortSignal): Promise<void> {
    if (files.length === 0) return;
    // Where each file lands (refused ones are skipped), then one box hash batch: the prefix
    // (append-only, grown) or the whole file (same size).
    const plans: { file: FileToMirror; target: string; hostSize: number | null; check: "prefix" | "whole" | null }[] = [];
    for (const file of files) {
      let target: string;
      try {
        target = await hostTargetBelow(file.base, file.rel);
      } catch (error) {
        if (signal.aborted) throw error;
        this.warn(connection, `not mirroring ${file.base}/${file.rel}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (isDeniedTranscriptPath(target, this.denyRoots)) continue;
      const local = await orAbsent(lstat(target));
      const hostSize = local?.isFile() ? local.size : null;
      if (hostSize !== null && file.rel.endsWith(".jsonl") && file.size < hostSize) {
        this.warn(connection, `not mirroring ${target}: the box's copy is shorter than the host's`);
        continue;
      }
      let check: "prefix" | "whole" | null = null;
      if (hostSize !== null && file.rel.endsWith(".jsonl") && file.size > hostSize) check = "prefix";
      else if (hostSize !== null && file.size === hostSize) check = "whole";
      plans.push({ file, target, hostSize, check });
    }
    const checks = plans.filter((plan) => plan.check !== null);
    const hashes = checks.length === 0 ? [] : await this.hasher(connection, checks.map((plan) => ({ path: plan.file.box, length: plan.check === "prefix" ? plan.hostSize! : undefined })), signal);
    const boxHash = new Map(checks.map((plan, index) => [plan, hashes[index] ?? null]));

    for (const plan of plans) {
      signal.throwIfAborted();
      const { file, target } = plan;
      let action: "skip" | "append" | "whole" = "whole";
      if (plan.check !== null) {
        const hostHash = await sha256File(target);
        if (boxHash.get(plan) === hostHash) action = plan.check === "prefix" ? "append" : "skip";
      }
      try {
        if (action === "append") await this.appendTail(connection, file, target, plan.hostSize!, signal);
        else if (action === "whole") await this.copyWhole(connection, file, target, signal);
        await this.remember(connection.boxId, file.box, file, target);
      } catch (error) {
        if (!connection.connected || signal.aborted) throw error;
        this.warn(connection, `mirroring ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Append the box file's bytes [hostSize, size) to the host file (opened without following a
   * link); on failure the host file is cut back.
   */
  private async appendTail(connection: BoxConnection, file: Pick<FileToMirror, "box" | "size">, target: string, hostSize: number, signal: AbortSignal): Promise<void> {
    const handle = await open(target, OPEN_EXISTING_NOFOLLOW);
    try {
      if ((await handle.stat()).size !== hostSize) throw new Error("the host copy changed meanwhile");
      const stream = await connection.readFile(boxPathOf(connection, file.box), { offset: hostSize, length: file.size - hostSize, signal });
      let position = hostSize;
      try {
        for await (const chunk of stream) {
          const buffer = chunk as Buffer;
          if (position + buffer.length > file.size) throw new Error("the box sent more than it said");
          await handle.write(buffer, 0, buffer.length, position);
          position += buffer.length;
        }
        if (position !== file.size) throw new Error(`short read: ${position - hostSize} of ${file.size - hostSize} bytes`);
        await handle.sync();
      } catch (error) {
        stream.destroy();
        await handle.truncate(hostSize).catch(() => undefined);
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  /** The whole box file, streamed to a temp file beside `target` and renamed over it. */
  private async copyWhole(connection: BoxConnection, file: FileToMirror, target: string, signal: AbortSignal): Promise<void> {
    const source = file.size > 0 ? await connection.readFile(boxPathOf(connection, file.box), { length: file.size, signal }) : [];
    await writeHostStreamAtomic(target, source, 0o600, {
      maxBytes: file.size,
      check: ({ bytes }) => (bytes === file.size ? null : `short read: ${bytes} of ${file.size} bytes`)
    });
  }

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  /** Push one dir pair's host files into the box (see "Resume" in the module doc). */
  private async pushPair(connection: BoxConnection, pair: DirPair, rels: readonly string[], signal: AbortSignal): Promise<void> {
    type Plan = {
      rel: string;
      box: string;
      host: string;
      hostSize: number;
      info: BoxFsStat | null;
      /** The box hash asked for (whole file, or its first `length` bytes) and the host hash to compare it with. */
      hash: (BoxHashItem & { hostLength: number | null }) | null;
    };
    const plans: Plan[] = [];
    for (const rel of rels) {
      const host = `${pair.host}/${rel}`;
      const local = await stat(host).catch(() => null);
      if (!local?.isFile()) continue;
      const box = `${pair.box}/${rel}`;
      const found = await boxStat(connection, box, signal);
      const info = found?.kind === "file" ? found : null;
      let hash: Plan["hash"] = null;
      if (info !== null) {
        if (info.size === local.size) hash = { path: box, hostLength: null };
        else if (rel.endsWith(".jsonl") && info.size > local.size) hash = { path: box, length: local.size, hostLength: null };
        else if (rel.endsWith(".jsonl")) hash = { path: box, hostLength: info.size };
      }
      plans.push({ rel, box, host, hostSize: local.size, info, hash });
    }
    const asked = plans.filter((plan) => plan.hash !== null);
    const hashes = asked.length === 0 ? [] : await this.hasher(connection, asked.map((plan) => ({ path: plan.hash!.path, length: plan.hash!.length })), signal);
    const boxHash = new Map(asked.map((plan, index) => [plan, hashes[index] ?? null]));

    for (const plan of plans) {
      signal.throwIfAborted();
      const { info } = plan;
      let action: "push" | "same" | "pull-tail" | "diverged" = "push";
      if (info !== null) {
        const unchanged = await this.boxUnchangedSinceSync(connection.boxId, plan.box, info);
        let matches = false;
        if (plan.hash !== null) {
          const hostHash = plan.hash.hostLength === null ? await sha256File(plan.host) : await sha256FilePrefix(plan.host, plan.hash.hostLength);
          matches = boxHash.get(plan) === hostHash;
        }
        if (matches && info.size === plan.hostSize) action = "same";
        else if (matches && info.size > plan.hostSize) action = "pull-tail"; // the box is ahead
        else if (matches || unchanged) action = "push"; // the host is ahead, or only the host changed
        else if (plan.rel.endsWith(".jsonl") && info.size < plan.hostSize) action = "push"; // an account's old copy: the chat went on elsewhere
        else action = "diverged";
      }
      if (action === "diverged") {
        this.warn(connection, `${plan.host} diverged between the host and the box; the box keeps its copy for the resume`);
        continue;
      }
      if (action === "pull-tail") {
        try {
          const target = await hostTargetBelow(pair.host, plan.rel);
          await this.appendTail(connection, { box: plan.box, size: info!.size }, target, plan.hostSize, signal);
          await this.remember(connection.boxId, plan.box, info!, target);
        } catch (error) {
          if (!connection.connected || signal.aborted) throw error;
          // The box keeps its (longer) copy either way; the next pull tries again.
          this.warn(connection, `mirroring the box's newer ${plan.host} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (action === "push") await writeBoxFile(connection, plan.box, createReadStream(plan.host), 0o600);
      const after = action === "same" ? info : await boxStat(connection, plan.box, signal);
      if (after) await this.remember(connection.boxId, plan.box, after, plan.host);
    }
  }

  /** Whether the box copy is as it was when last mirrored or pushed. */
  private async boxUnchangedSinceSync(boxId: string, boxPath: string, info: { size: number; mtimeMs: number }): Promise<boolean> {
    const seen = this.mirrored.get(`${boxId}|${boxPath}`);
    return seen !== undefined && seen.size === info.size && seen.mtimeMs === info.mtimeMs;
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
