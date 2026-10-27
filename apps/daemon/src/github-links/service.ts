import {
  GITHUB_COMMIT_BODY_MAX,
  GITHUB_TITLE_MAX,
  githubPreviewKey,
  type GitHubChecksSummary,
  type GitHubCommitPreview,
  type GitHubIssuePreview,
  type GitHubItemState,
  type GitHubLinkPreview,
  type GitHubLinkPreviewErrorCode,
  type GitHubPreviewTarget,
  type GitHubPullPreview
} from "@orquester/api";

import { retryAfterMs as parseRetryAfter } from "../providers/types.ts";

/**
 * GitHub link previews: the title, state, author and the rest of a pull
 * request, issue or commit a chat link names, for its pill and hover card
 * (contracts in `@orquester/api` `forge-links.ts`).
 *
 * - **Credentials.** A stored GitHub account's token reads the item when one
 *   is available (`resolveCredential` picks it); otherwise the read is
 *   anonymous, which covers public repos. A token that GitHub refuses (401, an
 *   SSO-gated 403) falls back to one anonymous read. The token travels only in
 *   the `Authorization` header: never in a URL, a log line, an error message
 *   or a response.
 * - **Cache.** Results are kept in memory per credential and item: open items
 *   briefly, closed and merged ones longer, commits longest. Failures are
 *   cached too (a missing item for minutes, GitHub being down for seconds) so a
 *   long transcript cannot hammer GitHub with the same dead link.
 * - **Dedupe and concurrency.** Concurrent asks for one item share one read,
 *   and at most `maxConcurrent` reads run against GitHub at once.
 * - **Rate limits.** A spent quota (429, or a 403 that says so) blocks that
 *   credential until GitHub's reset, answering `RATE_LIMITED` without a call.
 */

const GITHUB_API = "https://api.github.com";

const OPEN_TTL_MS = 2 * 60_000;
const CLOSED_TTL_MS = 10 * 60_000;
const COMMIT_TTL_MS = 30 * 60_000;
const NOT_FOUND_TTL_MS = 5 * 60_000;
const UPSTREAM_TTL_MS = 30_000;
const RATE_LIMIT_MIN_MS = 30_000;
const RATE_LIMIT_DEFAULT_MS = 60_000;
const RATE_LIMIT_MAX_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_ENTRIES = 500;

/** A stored token to read with. Lives only inside the daemon. */
export interface GitHubReadCredential {
  /** The account it belongs to; part of the cache key, never the token itself. */
  accountId: string;
  token: string;
}

const STATUS: Record<GitHubLinkPreviewErrorCode, number> = {
  INVALID_LINK: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM: 502
};

/** A refusal whose `message` is user-facing and never carries a token or a response body. */
export class GitHubLinkPreviewError extends Error {
  readonly status: number;
  constructor(
    readonly code: GitHubLinkPreviewErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "GitHubLinkPreviewError";
    this.status = STATUS[code];
  }
}

export interface GitHubLinkPreviewServiceOptions {
  /** Picks the stored token for `owner`, preferring the account bound to `projectPath`'s workspace. */
  resolveCredential: (input: { owner: string; projectPath?: string }) => Promise<GitHubReadCredential | null>;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxEntries?: number;
  logger?: Pick<Console, "warn">;
}

type Outcome = { ok: true; preview: GitHubLinkPreview } | { ok: false; error: GitHubLinkPreviewError };

interface CacheEntry {
  expiresAt: number;
  outcome: Outcome;
}

/** Why GitHub refused a credential; `auth` is retried anonymously. */
type Refusal =
  | { kind: "not_found" }
  | { kind: "auth" }
  | { kind: "rate_limited"; waitMs: number | undefined }
  | { kind: "upstream"; status?: number };

class RefusalError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.kind);
  }
}

type Json = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function loginOf(value: unknown): string | null {
  return textOrNull(object(value).login);
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Only a URL on github.com may come back as an item's `url`; anything else is rebuilt. */
function htmlUrl(value: unknown, fallback: string): string {
  const candidate = text(value);
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.href;
  } catch {
    /* rebuilt below */
  }
  return fallback;
}

function repoPath(target: GitHubPreviewTarget): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

/** Check runs → counts. Statuses other than `completed` are pending whatever their conclusion. */
function summarizeCheckRuns(payload: unknown): GitHubChecksSummary | null {
  const runs = object(payload).check_runs;
  if (!Array.isArray(runs)) return null;
  const summary: GitHubChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const raw of runs) {
    const run = object(raw);
    summary.total += 1;
    if (run.status !== "completed") {
      summary.pending += 1;
      continue;
    }
    switch (run.conclusion) {
      case "success":
        summary.passed += 1;
        break;
      case "failure":
      case "timed_out":
      case "cancelled":
      case "action_required":
      case "startup_failure":
        summary.failed += 1;
        break;
      default:
        summary.skipped += 1;
    }
  }
  return summary;
}

function mapPull(json: Json, target: GitHubPreviewTarget & { number: number }): GitHubPullPreview {
  const head = object(json.head);
  const base = object(json.base);
  const merged = typeof json.merged_at === "string" && json.merged_at.length > 0;
  const state: GitHubItemState = merged ? "merged" : json.state === "open" ? (json.draft === true ? "draft" : "open") : "closed";
  const headOwner = loginOf(object(head.repo).owner);
  const baseOwner = loginOf(object(base.repo).owner);
  const headLabel = headOwner && baseOwner && headOwner.toLowerCase() !== baseOwner.toLowerCase() ? textOrNull(head.label) : null;
  return {
    kind: "pull",
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    url: htmlUrl(json.html_url, `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`),
    title: cap(text(json.title), GITHUB_TITLE_MAX),
    state,
    author: loginOf(json.user),
    createdAt: textOrNull(json.created_at),
    updatedAt: textOrNull(json.updated_at),
    closedAt: textOrNull(json.closed_at),
    mergedAt: textOrNull(json.merged_at),
    comments: count(json.comments) + count(json.review_comments),
    headRef: textOrNull(head.ref),
    baseRef: textOrNull(base.ref),
    headLabel,
    additions: countOrNull(json.additions),
    deletions: countOrNull(json.deletions),
    changedFiles: countOrNull(json.changed_files),
    checks: null
  };
}

function mapIssue(json: Json, target: GitHubPreviewTarget & { number: number }): GitHubIssuePreview {
  const closed = json.state === "closed";
  return {
    kind: "issue",
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    url: htmlUrl(json.html_url, `https://github.com/${target.owner}/${target.repo}/issues/${target.number}`),
    title: cap(text(json.title), GITHUB_TITLE_MAX),
    state: closed ? "closed" : "open",
    stateReason: closed && (json.state_reason === "completed" || json.state_reason === "not_planned") ? json.state_reason : null,
    author: loginOf(json.user),
    createdAt: textOrNull(json.created_at),
    updatedAt: textOrNull(json.updated_at),
    closedAt: textOrNull(json.closed_at),
    comments: count(json.comments)
  };
}

function mapCommit(json: Json, target: GitHubPreviewTarget & { sha: string }): GitHubCommitPreview {
  const commit = object(json.commit);
  const gitAuthor = object(commit.author);
  const gitCommitter = object(commit.committer);
  const message = text(commit.message).replace(/\r\n/g, "\n");
  const newline = message.indexOf("\n");
  const title = (newline === -1 ? message : message.slice(0, newline)).trim();
  const body = newline === -1 ? "" : message.slice(newline + 1).trim();
  const sha = /^[0-9a-f]{40}$/i.test(text(json.sha)) ? text(json.sha).toLowerCase() : target.sha;
  return {
    kind: "commit",
    owner: target.owner,
    repo: target.repo,
    sha,
    url: htmlUrl(json.html_url, `https://github.com/${target.owner}/${target.repo}/commit/${sha}`),
    title: cap(title, GITHUB_TITLE_MAX),
    body: cap(body, GITHUB_COMMIT_BODY_MAX),
    author: loginOf(json.author) ?? textOrNull(gitAuthor.name),
    authoredAt: textOrNull(gitAuthor.date),
    committedAt: textOrNull(gitCommitter.date)
  };
}

function ttlFor(preview: GitHubLinkPreview): number {
  if (preview.kind === "commit") return COMMIT_TTL_MS;
  return preview.state === "open" || preview.state === "draft" ? OPEN_TTL_MS : CLOSED_TTL_MS;
}

function describe(target: GitHubPreviewTarget): string {
  const repo = `${target.owner}/${target.repo}`;
  return target.kind === "commit" ? `${repo}@${target.sha.slice(0, 7)}` : `${repo}#${target.number}`;
}

/** A tiny FIFO semaphore: at most `limit` reads in flight. */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class GitHubLinkPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Outcome>>();
  /** Credential key → when its spent quota resets. */
  private readonly blockedUntil = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly limiter: Limiter;
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: GitHubLinkPreviewServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.limiter = new Limiter(Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.logger = options.logger ?? console;
  }

  /** The preview, or a {@link GitHubLinkPreviewError}. Never throws anything else. */
  async preview(target: GitHubPreviewTarget, projectPath?: string): Promise<GitHubLinkPreview> {
    let credential: GitHubReadCredential | null = null;
    try {
      credential = await this.options.resolveCredential({ owner: target.owner, ...(projectPath ? { projectPath } : {}) });
    } catch {
      // An unreadable accounts file reads as "no account": public repos still preview.
      credential = null;
    }
    const credentialKey = credential ? `account:${credential.accountId}` : "anonymous";
    const key = `${credentialKey}|${githubPreviewKey(target)}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return this.settle(cached.outcome);
    if (cached) this.cache.delete(key);

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.load(target, credential, credentialKey).then((outcome) => {
        this.remember(key, outcome);
        return outcome;
      });
      this.inflight.set(key, pending);
      void pending.finally(() => this.inflight.delete(key));
    }
    return this.settle(await pending);
  }

  private settle(outcome: Outcome): GitHubLinkPreview {
    if (outcome.ok) return outcome.preview;
    throw outcome.error;
  }

  private remember(key: string, outcome: Outcome): void {
    const now = Date.now();
    let ttl: number;
    if (outcome.ok) ttl = ttlFor(outcome.preview);
    else if (outcome.error.code === "NOT_FOUND") ttl = NOT_FOUND_TTL_MS;
    else if (outcome.error.code === "RATE_LIMITED") ttl = outcome.error.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS;
    else ttl = UPSTREAM_TTL_MS;
    this.cache.delete(key);
    this.cache.set(key, { expiresAt: now + ttl, outcome });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private rateLimited(credentialKey: string): GitHubLinkPreviewError | null {
    const until = this.blockedUntil.get(credentialKey);
    if (until === undefined) return null;
    const wait = until - Date.now();
    if (wait <= 0) {
      this.blockedUntil.delete(credentialKey);
      return null;
    }
    return new GitHubLinkPreviewError("RATE_LIMITED", "GitHub's rate limit is spent; previews resume shortly.", wait);
  }

  private async load(target: GitHubPreviewTarget, credential: GitHubReadCredential | null, credentialKey: string): Promise<Outcome> {
    try {
      return { ok: true, preview: await this.readWith(target, credential, credentialKey) };
    } catch (error) {
      if (error instanceof GitHubLinkPreviewError) return { ok: false, error };
      this.logger.warn(`[github-links] preview of ${describe(target)} failed unexpectedly: ${error instanceof Error ? error.name : "error"}`);
      return { ok: false, error: new GitHubLinkPreviewError("UPSTREAM", "GitHub could not be read.") };
    }
  }

  /** Read with the credential; a refused token falls back to one anonymous read. */
  private async readWith(target: GitHubPreviewTarget, credential: GitHubReadCredential | null, credentialKey: string): Promise<GitHubLinkPreview> {
    try {
      return await this.readAs(target, credential?.token ?? null, credentialKey);
    } catch (error) {
      if (credential && error instanceof RefusalError && error.refusal.kind === "auth") {
        return this.readAs(target, null, "anonymous");
      }
      throw error;
    }
  }

  private async readAs(target: GitHubPreviewTarget, token: string | null, credentialKey: string): Promise<GitHubLinkPreview> {
    const blocked = this.rateLimited(credentialKey);
    if (blocked) throw blocked;
    try {
      return await this.limiter.run(() => this.read(target, token));
    } catch (error) {
      if (!(error instanceof RefusalError)) throw error;
      const { refusal } = error;
      switch (refusal.kind) {
        case "auth":
          // Retried anonymously by the caller when a token was used; anonymously it means "not readable".
          if (token) throw error;
          throw new GitHubLinkPreviewError("NOT_FOUND", `GitHub would not show ${describe(target)}.`);
        case "not_found":
          throw new GitHubLinkPreviewError(
            "NOT_FOUND",
            `${describe(target)} was not found${token ? "" : " (a private repository needs a connected GitHub account)"}.`
          );
        case "rate_limited": {
          const wait = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, refusal.waitMs ?? RATE_LIMIT_DEFAULT_MS));
          this.blockedUntil.set(credentialKey, Date.now() + wait);
          throw new GitHubLinkPreviewError(
            "RATE_LIMITED",
            token ? "GitHub's rate limit for this account is spent." : "GitHub's anonymous rate limit is spent; connect a GitHub account for more.",
            wait
          );
        }
        case "upstream":
          throw new GitHubLinkPreviewError("UPSTREAM", `GitHub could not be read${refusal.status ? ` (HTTP ${refusal.status})` : ""}.`);
      }
    }
  }

  private async read(target: GitHubPreviewTarget, token: string | null): Promise<GitHubLinkPreview> {
    if (target.kind === "commit") {
      return mapCommit(await this.get(`${repoPath(target)}/commits/${encodeURIComponent(target.sha)}`, token), target);
    }
    if (target.kind === "issue") {
      const issue = await this.get(`${repoPath(target)}/issues/${target.number}`, token);
      // `/issues/N` names a pull request too; GitHub redirects the page, so read it as one.
      if (!issue.pull_request) return mapIssue(issue, target);
    }
    const json = await this.get(`${repoPath(target)}/pulls/${target.number}`, token);
    const pull = mapPull(json, target as GitHubPreviewTarget & { number: number });
    const head = text(object(json.head).sha);
    if ((pull.state === "open" || pull.state === "draft") && /^[0-9a-f]{40}$/i.test(head)) {
      pull.checks = await this.checks(target, head, token);
    }
    return pull;
  }

  /** Best effort, one call: a PR whose checks cannot be read still previews. */
  private async checks(target: GitHubPreviewTarget, head: string, token: string | null): Promise<GitHubChecksSummary | null> {
    try {
      const summary = summarizeCheckRuns(await this.get(`${repoPath(target)}/commits/${head}/check-runs?per_page=100`, token));
      return summary && summary.total > 0 ? summary : null;
    } catch {
      return null;
    }
  }

  /** One authenticated-or-anonymous GET; a non-2xx is a {@link RefusalError}. */
  private async get(path: string, token: string | null): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API}${path}`, {
        method: "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "orquester"
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new RefusalError({ kind: "upstream" });
    }
    if (response.ok) return object(await response.json().catch(() => null));
    // Drain the body without reading it into any message.
    await response.body?.cancel().catch(() => undefined);
    const remaining = response.headers.get("x-ratelimit-remaining");
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), Date.now());
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || retryAfter !== undefined))) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const wait = retryAfter ?? (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined);
      throw new RefusalError({ kind: "rate_limited", waitMs: wait });
    }
    if (response.status === 401 || response.status === 403) throw new RefusalError({ kind: "auth" });
    if (response.status === 404 || response.status === 410 || response.status === 422) throw new RefusalError({ kind: "not_found" });
    throw new RefusalError({ kind: "upstream", status: response.status });
  }
}
