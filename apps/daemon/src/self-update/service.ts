// Self-update (spec docs/superpowers/specs/2026-11-13-self-update-design.md): whether the commit
// the daemon runs is behind its install's branch on GitHub, and the trigger for the host updater.
//
// The checkout's `origin` is read from its git config as files (no git child). A check asks
// GitHub's compare API (unauthenticated) at start and hourly; a failed check keeps the last result
// and records why. The host updater (a root systemd unit) is asked to run by creating the request
// file; it removes that file when it starts and records its run in the status file, which the
// daemon only reads.

import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSelfUpdateRun, type SelfUpdateRun, type SelfUpdateStatusResponse } from "@orquester/api";
import { gitCommonDirOf, gitDirOf } from "../build-info.ts";

export interface SelfUpdateLogger {
  warn(message: string): void;
}

export interface SelfUpdateDeps {
  /** The checkout the daemon runs from; null when it is not in one. */
  repoRoot: string | null;
  /** The commit the daemon runs (full sha); null when unknown. */
  commit: string | null;
  /** `selfUpdateRequestPath(baseDir)`: creating it asks the host updater to run. */
  requestPath: string;
  /** The host updater's status file (`ORQUESTER_SELF_UPDATE_STATUS`); null when this install cannot update itself. */
  statusPath: string | null;
  fetch?: typeof fetch;
  /** Between checks; default one hour. */
  intervalMs?: number;
  /** The branch the install tracks; default `main`. */
  branch?: string;
  logger?: SelfUpdateLogger;
  /** Epoch ms; default `Date.now`. */
  now?: () => number;
}

/**
 * "started" carries the request time (ISO): the run that starts at or after it is this request's.
 * "busy" carries when the update in the way began (its run's start, or its pending request's time).
 */
export type SelfUpdateRequestResult =
  | { started: true; requestedAt: string }
  | { busy: true; requestedAt: string }
  | "unavailable";

const DEFAULT_INTERVAL_MS = 3_600_000;
const CHECK_TIMEOUT_MS = 15_000;
/**
 * A run still "running" this long after it started was cut off (the host rebooted or the updater was
 * killed before it could record the outcome): it is reported as failed, so it neither blocks the
 * next request nor keeps a client waiting. A real run — build, health wait, even a revert with its
 * own rebuild and health wait — ends well within it.
 */
const STALE_RUN_MS = 3 * 60 * 60 * 1000;
/**
 * The path unit takes a request within moments; one still there after this was never taken (the
 * unit is not active), so it is reported, and a new request replaces it.
 */
const STALLED_REQUEST_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const NAME = "[A-Za-z0-9._-]+";
const GITHUB_REMOTES = [
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME})$`, "i"),
  new RegExp(`^https://(?:[^@/\\s]+@)?github\\.com/(${NAME})/(${NAME})$`, "i"),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME})$`, "i")
];

/** `owner/name` of a GitHub remote URL (scp-like, https, ssh); null for any other remote. */
export function githubRepoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/$/, "");
  for (const pattern of GITHUB_REMOTES) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const owner = match[1]!;
    const name = match[2]!.replace(/\.git$/i, "");
    if (!name || owner === "." || owner === ".." || name === "." || name === "..") return null;
    return `${owner}/${name}`;
  }
  return null;
}

/** The `url` of `[remote "origin"]` in the checkout's git config; null when unreadable or absent. */
function readOriginUrl(repoRoot: string): string | null {
  const gitDir = gitDirOf(repoRoot);
  if (gitDir === null) return null;
  let text: string;
  try {
    text = readFileSync(join(gitCommonDirOf(gitDir), "config"), "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (!entry) continue;
    const value = entry[1]!.trim();
    return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "GitHub did not answer in time";
  return "GitHub could not be reached";
}

export class SelfUpdateService {
  private readonly deps: SelfUpdateDeps;
  private readonly branch: string;
  private readonly repo: string | null;
  private readonly fetch: typeof fetch;
  private readonly logger: SelfUpdateLogger;
  private latest: string | null = null;
  private behindBy = 0;
  private checkedAt: string | null = null;
  private error: string | null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private aborts = new AbortController();

  constructor(deps: SelfUpdateDeps) {
    this.deps = deps;
    this.branch = deps.branch ?? "main";
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.logger = deps.logger ?? console;
    const origin = deps.repoRoot === null ? null : readOriginUrl(deps.repoRoot);
    this.repo = origin === null ? null : githubRepoFromRemoteUrl(origin);
    this.error = this.cannotCheck();
  }

  /** Checks now (in the background), then every interval. */
  start(): void {
    if (this.timer !== null) return;
    if (this.aborts.signal.aborted) this.aborts = new AbortController();
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.aborts.abort();
  }

  /** One comparison with the branch head on GitHub; never throws. Overlapping calls share it. */
  check(): Promise<void> {
    this.inFlight ??= this.compare().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async status(): Promise<SelfUpdateStatusResponse> {
    return {
      current: this.deps.commit,
      branch: this.branch,
      repo: this.repo,
      latest: this.latest,
      behindBy: this.behindBy,
      checkedAt: this.checkedAt,
      error: this.error,
      canUpdate: this.deps.statusPath !== null,
      run: await this.readRun(),
      requestStalled: this.deps.statusPath !== null && (await this.requestAgeMs()) > STALLED_REQUEST_MS
    };
  }

  /**
   * Asks the host updater to run: "busy" while a run is going or a request is pending. A request the
   * updater never took (stalled) is replaced, so a retry works once its path unit is running again.
   */
  async requestUpdate(): Promise<SelfUpdateRequestResult> {
    if (this.deps.statusPath === null) return "unavailable";
    const run = await this.readRun();
    if (run?.state === "running") return { busy: true, requestedAt: run.startedAt };
    if ((await this.requestAgeMs()) > STALLED_REQUEST_MS) await unlink(this.deps.requestPath).catch(() => undefined);
    await mkdir(dirname(this.deps.requestPath), { recursive: true });
    const requestedAt = new Date(this.now()).toISOString();
    try {
      await writeFile(this.deps.requestPath, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Pending: the run it starts is the next one, which begins after the request was made.
      const age = await this.requestAgeMs();
      return { busy: true, requestedAt: new Date(age < 0 ? this.now() : this.now() - age).toISOString() };
    }
    return { started: true, requestedAt };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** How long the pending request has waited (ms); -1 when there is none. */
  private async requestAgeMs(): Promise<number> {
    try {
      return this.now() - (await stat(this.deps.requestPath)).mtimeMs;
    } catch {
      return -1;
    }
  }

  private cannotCheck(): string | null {
    if (this.repo === null) return "This install's origin is not a GitHub repository";
    if (this.deps.commit === null) return "The running commit is unknown";
    return null;
  }

  private async compare(): Promise<void> {
    const reason = this.cannotCheck();
    if (reason !== null) {
      this.error = reason;
      return;
    }
    const url = `https://api.github.com/repos/${this.repo}/compare/${encodeURIComponent(this.branch)}...${this.deps.commit}`;
    let failure: string;
    try {
      const response = await this.fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "orquester-daemon", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.any([this.aborts.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
      });
      if (response.ok) {
        const result = parseCompare(await response.json().catch(() => null));
        if (result !== null) {
          this.latest = result.latest;
          this.behindBy = result.behindBy;
          this.checkedAt = new Date().toISOString();
          this.error = null;
          return;
        }
        failure = "GitHub answered an unexpected response";
      } else {
        await response.body?.cancel().catch(() => undefined);
        failure =
          response.status === 404
            ? "GitHub doesn't know this repository or commit (a private repository, or a commit that was never pushed)"
            : response.status === 403 || response.status === 429
              ? `GitHub refused the check (${response.status}, likely its rate limit); it is retried hourly`
              : `GitHub answered ${response.status}`;
      }
    } catch (error) {
      if (this.aborts.signal.aborted) return;
      failure = messageOf(error);
    }
    this.error = failure;
    this.logger.warn(`self-update: the update check failed (${failure})`);
  }

  private async readRun(): Promise<SelfUpdateRun | null> {
    if (this.deps.statusPath === null) return null;
    try {
      const run = parseSelfUpdateRun(JSON.parse(await readFile(this.deps.statusPath, "utf8")));
      if (run?.state === "running" && this.now() - Date.parse(run.startedAt) > STALE_RUN_MS) return { ...run, state: "failed" };
      return run;
    } catch {
      return null;
    }
  }
}

/** The branch head and how far the running commit is behind it, from a compare answer (base = branch). */
function parseCompare(value: unknown): { latest: string; behindBy: number } | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const base = record.base_commit as Record<string, unknown> | null | undefined;
  const latest = base !== null && typeof base === "object" ? base.sha : undefined;
  if (typeof latest !== "string" || !SHA.test(latest) || typeof record.status !== "string") return null;
  if (record.status !== "behind") return { latest, behindBy: 0 };
  const behindBy = record.behind_by;
  return typeof behindBy === "number" && Number.isInteger(behindBy) && behindBy >= 0 ? { latest, behindBy } : null;
}
