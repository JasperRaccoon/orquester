import type { OwnerSummary, RepoSummary } from "@orquester/api";

import { AccountError } from "../account-error";
import type {
  CloneUrls,
  ConditionalListOptions,
  ConditionalPage,
  CreateRepoOpts,
  CredentialSpec,
  GitProvider,
  KeyUpload,
  ParsedRepo,
  ProviderCreds,
  ProviderIdentity,
  PullRequestCheck,
  PullRequestInfo,
  PullRequestRemark,
  PullRequestStatus,
  PullRequestStatusOptions,
  ReleaseInfo,
  SshProbe,
  UrlContext
} from "./types";
import { GitRemoteError, POLL_PAGE_SIZE, retryAfterMs } from "./types";
import { readerKey, WatchReadCache } from "./watch-cache";

const GITHUB_API = "https://api.github.com";

const SCOPES = "write:public_key, user:email, read:user, repo, read:org";

/**
 * Token-only GitHub REST helpers + the `GitProvider` implementation. No
 * `AccountsService` dependency — `AccountsService` reads the token and delegates
 * here. Every call is Bearer auth, `Accept: application/vnd.github+json`, and an
 * `AccountError` (400 for 401/403 so the route maps a bad/expired token to a
 * client error, else 502) on any non-2xx. The token appears only in the
 * `Authorization` header — never in a URL, argv, or log line.
 */

/**
 * One GitHub REST request, never throwing on the HTTP status. `token: null`
 * reads anonymously (public repos; 60 requests/hour per IP). `extraHeaders`
 * carries `If-None-Match` for the polling listings.
 */
async function githubFetch(
  token: string | null,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "orquester",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new GitRemoteError(
      502,
      `GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : "network error"}`,
      "upstream"
    );
  }
}

/**
 * The error for a non-2xx GitHub answer: a rate limit (a 429, or a 403 that
 * says the quota is spent or asks to retry later) is a 429 `rate_limited`
 * carrying when to retry; any other 401/403 a 400 (a bad/expired token or
 * missing scope — the route maps it to a client error); the rest a 502.
 */
async function githubError(response: Response, method: string, path: string): Promise<GitRemoteError> {
  const detail = await response.text().catch(() => "");
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status === 429 || (response.status === 403 && (remaining === "0" || retryAfter !== undefined))) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const wait =
      retryAfter ?? (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined);
    return new GitRemoteError(
      429,
      `GitHub ${method} ${path} → ${response.status}: rate limit exceeded${
        wait !== undefined ? ` (retry in ${Math.ceil(wait / 1000)} s)` : ""
      }. ${detail.slice(0, 200)}`,
      "rate_limited",
      response.status,
      wait
    );
  }
  const unauthorized = response.status === 401 || response.status === 403;
  const hint = unauthorized ? ` (check the token's scopes: ${SCOPES})` : "";
  return new GitRemoteError(
    unauthorized ? 400 : 502,
    `GitHub ${method} ${path} → ${response.status}${hint}. ${detail.slice(0, 200)}`,
    unauthorized ? "auth" : response.status === 404 ? "not_found" : "upstream",
    response.status
  );
}

/** Authenticated GitHub REST call; throws AccountError on a non-2xx. */
async function github(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<Response> {
  const response = await githubFetch(token, method, path, body);
  if (!response.ok) {
    throw await githubError(response, method, path);
  }
  return response;
}

/**
 * A conditional GET for the polling listings: `If-None-Match` with the last
 * ETag, a 304 → `notModified` (free on GitHub's rate limit), else the decoded
 * array (anything else reads as empty) and the new ETag.
 */
async function githubConditionalList(
  token: string | null,
  path: string,
  etag: string | undefined
): Promise<{ notModified: true } | { notModified?: false; etag?: string; values: Record<string, unknown>[] }> {
  const response = await githubFetch(token, "GET", path, undefined, etag ? { "If-None-Match": etag } : undefined);
  if (response.status === 304) {
    return { notModified: true };
  }
  if (!response.ok) {
    throw await githubError(response, "GET", path);
  }
  const page = (await response.json().catch(() => [])) as unknown;
  const values = Array.isArray(page)
    ? page.filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
    : [];
  const nextEtag = response.headers.get("etag") ?? undefined;
  return { values, ...(nextEtag ? { etag: nextEtag } : {}) };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function loginOf(value: unknown): string {
  return value && typeof value === "object" ? text((value as { login?: unknown }).login) : "";
}

/** Map one GitHub pull JSON object (`GET /repos/:o/:r/pulls`) to `PullRequestInfo`. */
function toGithubPullRequest(pull: Record<string, unknown>): PullRequestInfo {
  const head = (pull.head ?? {}) as { ref?: unknown; sha?: unknown };
  const base = (pull.base ?? {}) as { ref?: unknown };
  const merged = typeof pull.merged_at === "string" && pull.merged_at.length > 0;
  return {
    number: typeof pull.number === "number" ? pull.number : 0,
    title: text(pull.title),
    body: text(pull.body),
    url: text(pull.html_url),
    author: loginOf(pull.user),
    head: text(head.ref),
    base: text(base.ref),
    headSha: text(head.sha),
    state: merged ? "merged" : pull.state === "open" ? "open" : "closed",
    updatedAt: text(pull.updated_at)
  };
}

/** Map one GitHub release JSON object (`GET /repos/:o/:r/releases`) to `ReleaseInfo`. */
function toGithubRelease(release: Record<string, unknown>): ReleaseInfo {
  const tag = text(release.tag_name);
  const id = release.id;
  return {
    id: typeof id === "number" || typeof id === "string" ? String(id) : "",
    name: text(release.name) || tag,
    tag,
    body: text(release.body),
    url: text(release.html_url),
    prerelease: release.prerelease === true,
    draft: release.draft === true,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null
  };
}

// ---------------------------------------------------------------------------
// Pull request watch reads (spec 2026-10-14 §5 "PR watch")
// ---------------------------------------------------------------------------

/** Pages of 100 a watch read follows before calling a listing incomplete. */
const WATCH_MAX_PAGES = 5;

/** Conditional-request cache of the watch reads (ETag → decoded answer). */
const watchCache = new WatchReadCache();
/** The last rate-limit window GitHub reported, per reader (hashed token or "anonymous"). */
const rateWindows = new Map<string, { remaining: number; resetAt: number }>();
/**
 * Requests a reader keeps in hand: a watch read is about six requests, and an anonymous reader has
 * 60 an hour per IP, shared with everything else on the host. Below this, a read is refused as
 * rate-limited until the window resets, without spending a request.
 */
const ANONYMOUS_RESERVE = 6;
const TOKEN_RESERVE = 50;

/** Forget the watch reads' ETags and rate windows (tests). */
export function resetGithubWatchState(): void {
  watchCache.clear();
  rateWindows.clear();
}

/**
 * One GET of a watch read, decoded; throws the shared GitRemoteError on a non-2xx. Conditional:
 * a 304 (free on GitHub's limit) reuses the cached answer. Reads GitHub's `X-RateLimit-*` headers
 * and refuses ahead of time, as rate-limited until the reset, once a reader is down to its reserve.
 */
async function githubGet(token: string | null, path: string): Promise<{ data: unknown; next: string | undefined }> {
  const who = readerKey(token);
  const window = rateWindows.get(who);
  const now = Date.now();
  if (window && window.resetAt > now && window.remaining <= (token ? TOKEN_RESERVE : ANONYMOUS_RESERVE)) {
    throw new GitRemoteError(
      429,
      `GitHub rate limit nearly spent (${window.remaining} requests left until the reset).`,
      "rate_limited",
      undefined,
      window.resetAt - now
    );
  }
  const key = `${who}|${path}`;
  const cached = watchCache.get(key);
  const response = await githubFetch(token, "GET", path, undefined, cached ? { "If-None-Match": cached.etag } : undefined);
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining) && Number.isFinite(reset) && reset > 0) {
    rateWindows.set(who, { remaining, resetAt: reset * 1000 });
  }
  if (response.status === 304 && cached) {
    return { data: cached.data, next: cached.next };
  }
  if (!response.ok) {
    throw await githubError(response, "GET", path);
  }
  const data = (await response.json().catch(() => null)) as unknown;
  const link = nextPageUrl(response.headers.get("link"));
  const next = link?.startsWith(GITHUB_API) ? link.slice(GITHUB_API.length) : undefined;
  const etag = response.headers.get("etag");
  if (etag) watchCache.set(key, { etag, data, ...(next ? { next } : {}) });
  return { data, next };
}

/**
 * Every page of a listing, up to `WATCH_MAX_PAGES`; `pick` reads the array out of a page. `complete`
 * is false when pages were left unread.
 */
async function githubPages(
  token: string | null,
  path: string,
  pick: (data: unknown) => unknown
): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
  const items: Record<string, unknown>[] = [];
  let next: string | undefined = path;
  for (let page = 0; next !== undefined; page += 1) {
    if (page === WATCH_MAX_PAGES) return { items, complete: false };
    const answer = await githubGet(token, next);
    const values = pick(answer.data);
    if (Array.isArray(values)) {
      for (const value of values) {
        if (value && typeof value === "object") items.push(value as Record<string, unknown>);
      }
    }
    next = answer.next;
  }
  return { items, complete: true };
}

const numericId = (value: unknown): number => (typeof value === "number" ? value : 0);

/** A check run's state: unfinished is pending; a finished one by its conclusion. */
function checkRunStatus(run: Record<string, unknown>): PullRequestCheck["status"] {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "action_required":
      return "action-required";
    case "skipped":
    case "stale":
      return "skipped";
    default:
      return "neutral";
  }
}

/**
 * The head commit's checks: its check runs (a re-run's newest run per name — an older run of the
 * same name must not stand for it) and its commit statuses (the combined status already keeps the
 * newest per context; its own `state` is "pending" for a commit with none, so only the list is read).
 */
async function githubChecks(token: string | null, repo: ParsedRepo, sha: string): Promise<PullRequestCheck[]> {
  const commit = `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`;
  const runs = await githubPages(token, `${commit}/check-runs?per_page=100`, (data) =>
    data && typeof data === "object" ? (data as { check_runs?: unknown }).check_runs : undefined
  );
  const newest = new Map<string, Record<string, unknown>>();
  for (const run of runs.items) {
    const name = text(run.name);
    const held = newest.get(name);
    if (!held || numericId(run.id) > numericId(held.id)) newest.set(name, run);
  }
  const checks: PullRequestCheck[] = [...newest.values()].map((run) => ({
    name: text(run.name),
    status: checkRunStatus(run),
    url: text(run.html_url) || text(run.details_url) || null,
    required: null
  }));
  const combined = await githubGet(token, `${commit}/status?per_page=100`);
  const statuses = combined.data && typeof combined.data === "object" ? (combined.data as { statuses?: unknown }).statuses : undefined;
  if (Array.isArray(statuses)) {
    for (const status of statuses as Record<string, unknown>[]) {
      if (!status || typeof status !== "object") continue;
      const state = status.state;
      checks.push({
        name: text(status.context),
        status: state === "success" ? "success" : state === "failure" || state === "error" ? "failure" : "pending",
        url: text(status.target_url) || null,
        required: null
      });
    }
  }
  return checks;
}

/** GitHub's `updated_at` moves on an edit; a comment is "edited" when it differs from `created_at`. */
function editedAt(item: Record<string, unknown>): string | null {
  const created = text(item.created_at);
  const updated = text(item.updated_at);
  return updated && updated !== created ? updated : null;
}

/**
 * Whether the repository vouches for the author (`author_association` OWNER, MEMBER or
 * COLLABORATOR). Anyone else's text — on a public repository, anyone at all — is never quoted to the
 * agent.
 */
function isInsider(item: Record<string, unknown>): boolean {
  const association = item.author_association;
  return association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
}

const REVIEW_STATES: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed"
};

/**
 * Remarks active since `since`: conversation comments and review comments (both filtered by the
 * host on `updated_at`), and submitted reviews (no filter on the host: every page, then filtered
 * here). A review with neither a verdict nor a body is only the envelope of its review comments,
 * which are listed themselves. Null when a listing had more pages than a read follows.
 */
async function githubRemarks(
  token: string | null,
  repo: ParsedRepo,
  number: number,
  since: string | undefined
): Promise<PullRequestRemark[] | null> {
  const query = `per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const asArray = (data: unknown) => data;
  // One after another: a read's requests never fan out against the host's limits.
  const issueComments = await githubPages(token, `${repoPath(repo)}/issues/${number}/comments?${query}`, asArray);
  const reviewComments = await githubPages(token, `${repoPath(repo)}/pulls/${number}/comments?${query}`, asArray);
  const reviews = await githubPages(token, `${repoPath(repo)}/pulls/${number}/reviews?per_page=100`, asArray);
  if (!issueComments.complete || !reviewComments.complete || !reviews.complete) return null;
  const remarks: PullRequestRemark[] = [];
  for (const comment of issueComments.items) {
    remarks.push({
      id: `ic:${numericId(comment.id)}`,
      kind: "comment",
      author: loginOf(comment.user) || null,
      trusted: isInsider(comment),
      body: text(comment.body),
      createdAt: text(comment.created_at),
      editedAt: editedAt(comment),
      path: null,
      url: text(comment.html_url) || null,
      reviewState: null
    });
  }
  for (const comment of reviewComments.items) {
    remarks.push({
      id: `rc:${numericId(comment.id)}`,
      kind: "review-comment",
      author: loginOf(comment.user) || null,
      trusted: isInsider(comment),
      body: text(comment.body),
      createdAt: text(comment.created_at),
      editedAt: editedAt(comment),
      path: text(comment.path) || null,
      url: text(comment.html_url) || null,
      reviewState: null
    });
  }
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  for (const review of reviews.items) {
    const state = text(review.state);
    const submitted = text(review.submitted_at);
    if (state === "PENDING" || !submitted) continue;
    if (state === "COMMENTED" && text(review.body).trim() === "") continue;
    if (!Number.isNaN(sinceMs) && Date.parse(submitted) < sinceMs) continue;
    remarks.push({
      id: `rv:${numericId(review.id)}`,
      kind: "review",
      author: loginOf(review.user) || null,
      trusted: isInsider(review),
      body: text(review.body),
      createdAt: submitted,
      editedAt: null,
      path: null,
      url: text(review.html_url) || null,
      reviewState: REVIEW_STATES[state] ?? state.toLowerCase()
    });
  }
  return remarks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** `mergeable` is null while GitHub computes it; `dirty` / `false` is a conflict with the base. */
function githubMergeability(pull: Record<string, unknown>): PullRequestStatus["mergeability"] {
  if (pull.mergeable_state === "dirty" || pull.mergeable === false) return "conflicting";
  if (pull.mergeable === null || pull.mergeable === undefined || pull.mergeable_state === "unknown") return "unknown";
  return "clean";
}

function repoPath(repo: ParsedRepo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/** `github()` + JSON decode (204s and empty bodies come back as `{}`). */
async function githubJson(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<Record<string, unknown> & { id?: number; login?: string; name?: string }> {
  const response = await github(token, method, path, body);
  if (response.status === 204) {
    return {};
  }
  return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/** Map one GitHub repo JSON object to the wire `RepoSummary`. */
function toRepoSummary(repo: Record<string, unknown>): RepoSummary {
  const owner =
    typeof repo.owner === "object" && repo.owner !== null
      ? (repo.owner as { login?: unknown }).login
      : undefined;
  return {
    fullName: typeof repo.full_name === "string" ? repo.full_name : "",
    owner: typeof owner === "string" ? owner : "",
    name: typeof repo.name === "string" ? repo.name : "",
    private: repo.private === true,
    sshUrl: typeof repo.ssh_url === "string" ? repo.ssh_url : "",
    httpsUrl: typeof repo.clone_url === "string" ? repo.clone_url : undefined,
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "",
    description: typeof repo.description === "string" ? repo.description : null
  };
}

/**
 * Parse the `Link` header for the `rel="next"` URL, or undefined when there is
 * no next page. GitHub paginates `GET /user/repos` this way.
 */
function nextPageUrl(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** List the org logins the account belongs to (for the create-owner picker). */
async function listOrgs(token: string): Promise<string[]> {
  const response = await github(token, "GET", "/user/orgs?per_page=100");
  const orgs = (await response.json()) as unknown;
  if (!Array.isArray(orgs)) {
    return [];
  }
  return orgs
    .map((org) =>
      org && typeof org === "object" ? (org as { login?: unknown }).login : undefined
    )
    .filter((login): login is string => typeof login === "string");
}

/** The first two fields of an OpenSSH public key ("<type> <base64>") — the form GitHub stores. */
function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

export const githubProvider: GitProvider = {
  id: "github",
  scopesHint: SCOPES,

  /** login + name from `GET /user`, then the primary verified email (noreply fallback). */
  async getIdentity(creds: ProviderCreds): Promise<ProviderIdentity> {
    const user = await githubJson(creds.token, "GET", "/user");
    const login = typeof user?.login === "string" ? user.login : "";
    const name = typeof user?.name === "string" && user.name ? user.name : login;
    if (!login) {
      throw new AccountError(502, "GitHub did not return a login for this token.");
    }

    let email = "";
    try {
      const response = await github(creds.token, "GET", "/user/emails");
      const emails = (await response.json()) as unknown;
      if (Array.isArray(emails)) {
        const primary = emails.find(
          (e): e is { email: string; primary?: boolean; verified?: boolean } =>
            typeof e === "object" && e !== null && typeof (e as { email?: unknown }).email === "string"
        );
        const chosen =
          emails.find(
            (e) => (e as { primary?: boolean; verified?: boolean }).primary && (e as { verified?: boolean }).verified
          ) ?? primary;
        email = (chosen as { email?: string } | undefined)?.email ?? "";
      }
    } catch {
      /* fall through to the noreply fallback */
    }
    if (!email) {
      const githubId = typeof user?.id === "number" ? user.id : 0;
      email = `${githubId}+${login}@users.noreply.github.com`;
    }

    return { login, name, email };
  },

  async uploadSshKey(creds, _identity, publicKey, label): Promise<KeyUpload> {
    const upload = await githubJson(creds.token, "POST", "/user/keys", {
      title: label,
      key: publicKey
    });
    return typeof upload?.id === "number" ? { keyId: String(upload.id) } : {};
  },

  async findSshKey(creds, _identity, publicKey) {
    const body = keyBody(publicKey);
    const response = await github(creds.token, "GET", "/user/keys?per_page=100");
    const keys = (await response.json()) as unknown;
    if (!Array.isArray(keys)) {
      return null;
    }
    const hit = keys.find(
      (key) =>
        key &&
        typeof key === "object" &&
        typeof (key as { key?: unknown }).key === "string" &&
        keyBody((key as { key: string }).key) === body
    ) as { id?: unknown } | undefined;
    return hit && (typeof hit.id === "number" || typeof hit.id === "string")
      ? { keyId: String(hit.id) }
      : null;
  },

  async removeSshKey(creds, _identity, keyId) {
    await github(creds.token, "DELETE", `/user/keys/${encodeURIComponent(keyId)}`);
  },

  /**
   * List every repo the account can reach (owner/collaborator/org member),
   * following `Link` pagination to completion. The first request goes through the
   * shared `github()` helper; subsequent pages reuse the absolute `next` URLs.
   */
  async listRepos(creds): Promise<RepoSummary[]> {
    const repos: RepoSummary[] = [];
    let url: string | undefined = `${GITHUB_API}/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=pushed`;
    while (url) {
      // `url` is absolute; pass the path-relative remainder to github() so the
      // Bearer auth/error shape is shared (the next-page URLs carry api.github.com).
      const path = url.slice(GITHUB_API.length);
      const response = await github(creds.token, "GET", path);
      const page = (await response.json()) as unknown;
      if (Array.isArray(page)) {
        for (const repo of page) {
          if (repo && typeof repo === "object") {
            repos.push(toRepoSummary(repo as Record<string, unknown>));
          }
        }
      }
      url = nextPageUrl(response.headers.get("link"));
    }
    return repos;
  },

  async listOwners(creds, identity): Promise<OwnerSummary[]> {
    const orgs = await listOrgs(creds.token);
    return [
      { id: identity.login, label: identity.login, kind: "user" as const },
      ...orgs.map((org) => ({ id: org, label: org, kind: "org" as const }))
    ];
  },

  /**
   * Create a repo under the user (`POST /user/repos` when `owner === login`) or an
   * org (`POST /orgs/:owner/repos`). `auto_init: true` so the repo has a default
   * branch + README and the immediate clone is non-empty.
   */
  async createRepo(creds, identity, opts: CreateRepoOpts): Promise<RepoSummary> {
    const body = {
      name: opts.name,
      private: opts.visibility === "private",
      auto_init: true,
      ...(opts.description ? { description: opts.description } : {})
    };
    const path =
      opts.owner === identity.login
        ? "/user/repos"
        : `/orgs/${encodeURIComponent(opts.owner)}/repos`;
    const response = await github(creds.token, "POST", path, body);
    return toRepoSummary((await response.json()) as Record<string, unknown>);
  },

  parseRepoUrl(input: string, _ctx: UrlContext): ParsedRepo | null {
    const trimmed = input.trim();
    const part = "[A-Za-z0-9._-]+";
    const repoRe = new RegExp(`^(${part})/(${part}?)$`);
    const httpsRe = new RegExp(`^https?://github\\.com/(${part})/(${part}?)(?:\\.git)?/?$`, "i");
    const sshRe = new RegExp(`^git@github\\.com:(${part})/(${part}?)(?:\\.git)?$`, "i");
    const match = trimmed.match(httpsRe) ?? trimmed.match(sshRe) ?? trimmed.match(repoRe);
    if (!match) {
      return null;
    }
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    return owner && repo ? { owner, repo } : null;
  },

  async cloneUrls(_creds, ref): Promise<CloneUrls> {
    return {
      ssh: `git@github.com:${ref.owner}/${ref.repo}.git`,
      https: `https://github.com/${ref.owner}/${ref.repo}.git`
    };
  },

  sshProbe(_ctx): SshProbe {
    return {
      target: "git@github.com",
      // GitHub's `ssh -T` always exits non-zero (it doesn't grant a shell), so
      // callers parse stdout/stderr rather than trusting the exit code.
      parse: (text) => {
        const match = /Hi ([^!]+)!/.exec(text);
        return match
          ? { ok: true, login: match[1], message: text.slice(0, 200) }
          : { ok: false, message: text.slice(0, 200) || "No greeting from GitHub." };
      }
    };
  },

  credentialSpec(ctx): CredentialSpec {
    return { host: "github.com", username: ctx.login };
  },

  supportsReleases: true,

  async listPullRequests(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    opts?: ConditionalListOptions
  ): Promise<ConditionalPage<PullRequestInfo>> {
    const page = await githubConditionalList(
      creds?.token || null,
      `${repoPath(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=${POLL_PAGE_SIZE}`,
      opts?.etag
    );
    if (page.notModified) {
      return { notModified: true };
    }
    return { items: page.values.map(toGithubPullRequest), ...(page.etag ? { etag: page.etag } : {}) };
  },

  /**
   * `GET /repos/:o/:r/pulls/:n`, then — only while it is open — the head commit's check runs and
   * statuses and the remarks since `opts.remarksSince` (comments, review comments, reviews). Six
   * requests or so per read on an authenticated token (5 000/h); anonymous reads share 60/h per IP.
   */
  async getPullRequestStatus(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    number: number,
    opts?: PullRequestStatusOptions
  ): Promise<PullRequestStatus> {
    const token = creds?.token || null;
    const answer = await githubGet(token, `${repoPath(repo)}/pulls/${number}`);
    const pull = (answer.data && typeof answer.data === "object" ? answer.data : {}) as Record<string, unknown>;
    const info = toGithubPullRequest(pull);
    const status: PullRequestStatus = {
      number: info.number || number,
      title: info.title,
      url: info.url,
      state: info.state,
      author: info.author,
      headSha: info.headSha || null,
      headBranch: info.head,
      baseBranch: info.base,
      mergeability: info.state === "open" ? githubMergeability(pull) : "unknown",
      checks: [],
      remarks: []
    };
    if (status.state !== "open") return status;
    const checks = status.headSha ? await githubChecks(token, repo, status.headSha) : [];
    const remarks = await githubRemarks(token, repo, number, opts?.remarksSince);
    return { ...status, checks, remarks };
  },

  async listReleases(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    opts?: ConditionalListOptions
  ): Promise<ConditionalPage<ReleaseInfo>> {
    // GitHub lists releases newest first (by creation); drafts only reach a
    // token with push access.
    const page = await githubConditionalList(
      creds?.token || null,
      `${repoPath(repo)}/releases?per_page=${POLL_PAGE_SIZE}`,
      opts?.etag
    );
    if (page.notModified) {
      return { notModified: true };
    }
    return { items: page.values.map(toGithubRelease), ...(page.etag ? { etag: page.etag } : {}) };
  }
};
