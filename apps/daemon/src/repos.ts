import type { RepoSummary } from "@orquester/api";

import { AccountError } from "./accounts";

const GITHUB_API = "https://api.github.com";

/**
 * Token-only GitHub REST helpers for the project-from-repo flow (no
 * `AccountsService` dependency — `AccountsService` reads the token and delegates
 * here). They mirror the fetch/error shape of `AccountsService.github()`: Bearer
 * auth, `Accept: application/vnd.github+json`, and an `AccountError` (400 for
 * 401/403 so the route maps a bad/expired token to a client error, else 502) on
 * any non-2xx. The token appears only in the `Authorization` header — never in a
 * URL, argv, or log line.
 */

/** Options for creating a repo: `owner` may be the user's `login` or an org. */
export interface CreateRepoOptions {
  /** The chosen owner (the user's login or an org login). */
  owner: string;
  /** The authenticated user's own login (to decide user vs. org endpoint). */
  login: string;
  name: string;
  visibility: "private" | "public";
  description?: string;
}

/** Authenticated GitHub REST call; throws AccountError on a non-2xx. */
async function github(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Response> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "orquester",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const hint =
      response.status === 401 || response.status === 403
        ? " (check the token's scopes: repo, read:org)"
        : "";
    throw new AccountError(
      response.status === 401 || response.status === 403 ? 400 : 502,
      `GitHub ${method} ${path} → ${response.status}${hint}. ${detail.slice(0, 200)}`
    );
  }
  return response;
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

/**
 * List every repo the account can reach (owner/collaborator/org member),
 * following `Link` pagination to completion. The first request goes through the
 * shared `github()` helper; subsequent pages reuse the absolute `next` URLs.
 */
export async function listRepos(token: string): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  let url:
    | string
    | undefined = `${GITHUB_API}/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=pushed`;
  while (url) {
    // `url` is absolute; pass the path-relative remainder to github() so the
    // Bearer auth/error shape is shared (the next-page URLs carry api.github.com).
    const path = url.slice(GITHUB_API.length);
    const response = await github(token, "GET", path);
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
}

/** List the org logins the account belongs to (for the create-owner picker). */
export async function listOrgs(token: string): Promise<string[]> {
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

/**
 * Create a repo under the user (`POST /user/repos` when `owner === login`) or an
 * org (`POST /orgs/:owner/repos`). `auto_init: true` so the repo has a default
 * branch + README and the immediate clone is non-empty.
 */
export async function createRepo(token: string, opts: CreateRepoOptions): Promise<RepoSummary> {
  const body = {
    name: opts.name,
    private: opts.visibility === "private",
    auto_init: true,
    ...(opts.description ? { description: opts.description } : {})
  };
  const path =
    opts.owner === opts.login
      ? "/user/repos"
      : `/orgs/${encodeURIComponent(opts.owner)}/repos`;
  const response = await github(token, "POST", path, body);
  return toRepoSummary((await response.json()) as Record<string, unknown>);
}
