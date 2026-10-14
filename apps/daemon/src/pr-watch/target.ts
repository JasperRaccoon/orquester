/**
 * Pull request watches — which pull request a `watch_pull_request(url | number)` names.
 *
 * A web URL names its repository and number: GitHub `…/owner/repo/pull/12`, Bitbucket Cloud
 * `…/workspace/repo/pull-requests/12`, Bitbucket Server/DC `…/projects/KEY/repos/slug/pull-requests/12`
 * (and `…/users/name/repos/slug/…`), each with any trailing tab (`/files`, `/overview`, `/diff`…),
 * query or fragment. The repository part becomes a URL the providers' own grammars read
 * (`GitProvider.parseRepoUrl`; DC wants its `/browse` form). A number alone is read against the
 * project's `origin`, by the caller.
 */

import { repoDisplayName, repoKeyOf, stripUrlCredentials } from "../workflows/git-remote/index.ts";

export interface PullRequestTarget {
  /** Credential-free repository URL the provider reads. */
  repoUrl: string;
  /** `host/owner/repo`, lowercased: one repository whatever URL form names it. */
  repoKey: string;
  /** "owner/repo" as shown. */
  repository: string;
  number: number;
}

const MAX_URL_LENGTH = 2_000;

/** The pull request a web URL names, or null when it is not one. */
export function parsePullRequestUrl(input: string): PullRequestTarget | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  const match = /^(.*?)\/(pull|pull-requests)\/(\d{1,9})(?:\/.*)?$/.exec(path);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const repoPath = match[1]!;
  // DC's repository page is `…/repos/slug/browse`; its pull requests sit beside it.
  const dc = match[2] === "pull-requests" && /\/(projects|users)\/[^/]+\/repos\/[^/]+$/.test(repoPath);
  const repoUrl = stripUrlCredentials(`${url.protocol}//${url.host}${repoPath}${dc ? "/browse" : ""}`);
  return withKey(repoUrl, number);
}

/** A target for `number` in the repository `remoteUrl` (the project's `origin`), or null. */
export function targetInRemote(remoteUrl: string, number: number): PullRequestTarget | null {
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return withKey(stripUrlCredentials(remoteUrl.trim()), number);
}

function withKey(repoUrl: string, number: number): PullRequestTarget | null {
  const repoKey = repoKeyOf(repoUrl);
  if (repoKey === null) return null;
  return { repoUrl, repoKey, repository: repoDisplayName(repoUrl), number };
}
