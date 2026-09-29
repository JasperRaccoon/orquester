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
  PullRequestInfo,
  ReleaseInfo,
  SshProbe,
  UrlContext
} from "./types";
import { GitRemoteError, POLL_PAGE_SIZE, retryAfterMs } from "./types";

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
