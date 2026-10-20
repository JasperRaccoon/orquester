/**
 * Forge links: the GitHub URLs (and GitLab / Bitbucket change-request URLs)
 * the agent chat renders as compact pills, and the daemon route that reads a
 * GitHub pull request, issue or commit behind one for its hover card.
 *
 * The parser is shared on purpose: the UI decides what a link looks like, and
 * the daemon re-parses the same URL before it spends any GitHub quota on it,
 * so a client can never steer the daemon at anything but the GitHub REST
 * resource the link names.
 *
 * Only `github.com` (and `www.github.com`) is GitHub here. A look-alike host —
 * `github.com.example`, `evilgithub.com`, a userinfo trick such as
 * `https://github.com@example.com/` — or any port, credential or non-http(s)
 * scheme is not a forge link and renders as the plain link it is.
 */

// ---------------------------------------------------------------------------
// Parsed links
// ---------------------------------------------------------------------------

/** A `#L10`, `#L10-L20` or `#L10C3-L20C9` anchor on a blob link. */
export interface GitHubLineRange {
  start: number;
  /** Absent for a single line. */
  end?: number;
}

/** The sub-page of a pull request a link opens. */
export type GitHubPullTab = "files" | "commits" | "checks";

export type GitHubLinkTarget =
  | {
      kind: "pull";
      number: number;
      tab?: GitHubPullTab;
      /** The link points at one comment or review thread (`#discussion_r…`, `#issuecomment-…`). */
      comment?: boolean;
    }
  | { kind: "issue"; number: number; comment?: boolean }
  | { kind: "discussion"; number: number; comment?: boolean }
  | {
      kind: "commit";
      /** As written in the URL (7–40 hex digits), lowercased. */
      sha: string;
      /** Set for `/pull/N/commits/<sha>`. */
      pullNumber?: number;
    }
  | { kind: "repo" }
  | {
      kind: "blob" | "tree";
      /**
       * The first segment after `blob/` / `tree/`. A branch with a slash in its
       * name is ambiguous in a GitHub URL; the first segment is the common case.
       */
      ref: string;
      /** Repo-relative, no leading slash; "" for the root of a tree. */
      path: string;
      lines?: GitHubLineRange;
    }
  | {
      kind: "release";
      /** Absent: the releases list, or the latest release when `latest`. */
      tag?: string;
      latest?: boolean;
    }
  | { kind: "actions-run"; runId: number; jobId?: number };

export type GitHubLink = {
  forge: "github";
  /** The URL as parsed (normalized by `URL`). */
  url: string;
  /** As written in the URL (GitHub is case-insensitive; compare lowercased). */
  owner: string;
  repo: string;
} & GitHubLinkTarget;

/** A GitLab merge request or a Bitbucket pull request: a styled pill, never fetched. */
export interface ChangeRequestLink {
  forge: "gitlab" | "bitbucket";
  kind: "pull";
  url: string;
  host: string;
  /** The project path, e.g. `group/sub/project` or `workspace/repo`. */
  repository: string;
  number: number;
}

export type ForgeLink = GitHubLink | ChangeRequestLink;

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/** GitHub logins: alphanumerics and single hyphens, never leading with one, at most 39. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const LINE_ANCHOR_PATTERN = /^L(\d{1,7})(?:C\d{1,5})?(?:-L(\d{1,7})(?:C\d{1,5})?)?$/;
/** Anchors that point at one comment or review thread of an issue, PR or discussion. */
const COMMENT_ANCHOR_PATTERN = /^(?:discussion_r\d+|issuecomment-\d+|pullrequestreview-\d+|discussioncomment-\d+|r\d+)$/;

/**
 * First path segments that are GitHub's own pages, not an owner. A link to
 * `github.com/settings/tokens` is no repository.
 */
const RESERVED_OWNERS = new Set([
  "about",
  "account",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "customer-stories",
  "dashboard",
  "discussions",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "logout",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "readme",
  "search",
  "security",
  "sessions",
  "settings",
  "signup",
  "site",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
  "users"
]);

function parseHttpUrl(href: string): URL | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A credential or a port is never a forge's own web URL.
  if (url.username || url.password || url.port) return null;
  return url;
}

function pathSegments(url: URL): string[] | null {
  const raw = url.pathname.split("/").slice(1);
  if (raw.at(-1) === "") raw.pop();
  const segments: string[] = [];
  for (const segment of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // An empty segment (`//`) or a traversal segment is no forge route.
    if (decoded.length === 0 || decoded === "." || decoded === "..") return null;
    segments.push(decoded);
  }
  return segments;
}

function anchorOf(url: URL): string {
  try {
    return decodeURIComponent(url.hash.slice(1));
  } catch {
    return "";
  }
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || !NUMBER_PATTERN.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseLines(anchor: string): GitHubLineRange | undefined {
  const match = LINE_ANCHOR_PATTERN.exec(anchor);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? undefined : Number(match[2]);
  if (start < 1) return undefined;
  if (end === undefined || end === start) return { start };
  return end > start ? { start, end } : { start: end, end: start };
}

function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "github.com" || host === "www.github.com";
}

/** The GitHub link `href` names, or `null` for anything else (including GitHub pages that are not repo content). */
export function parseGitHubLink(href: string): GitHubLink | null {
  const url = parseHttpUrl(href);
  if (!url || !isGitHubHost(url.hostname)) return null;
  const segments = pathSegments(url);
  if (!segments || segments.length < 2) return null;
  const [owner, rawRepo, section, ...rest] = segments as [string, string, string | undefined, ...string[]];
  if (!OWNER_PATTERN.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const repo = section === undefined ? rawRepo.replace(/\.git$/i, "") : rawRepo;
  if (!REPO_PATTERN.test(repo) || repo === "." || repo === "..") return null;

  const anchor = anchorOf(url);
  const comment = COMMENT_ANCHOR_PATTERN.test(anchor);
  const base = { forge: "github" as const, url: url.href, owner, repo };

  switch (section) {
    case undefined:
      return { ...base, kind: "repo" };
    case "pull": {
      const number = parseNumber(rest[0]);
      if (number === null) return null;
      const tab = rest[1];
      if (tab === undefined) return { ...base, kind: "pull", number, ...(comment ? { comment } : {}) };
      if (tab === "commits" && rest[2] !== undefined) {
        if (!SHA_PATTERN.test(rest[2]) || rest.length > 3) return null;
        return { ...base, kind: "commit", sha: rest[2].toLowerCase(), pullNumber: number };
      }
      // GitHub's newer review UI names the diff tab `changes`.
      const normalized: GitHubPullTab | null =
        tab === "files" || tab === "changes" ? "files" : tab === "commits" ? "commits" : tab === "checks" ? "checks" : null;
      // `/files/<sha>..<sha>` and similar narrow the same tab.
      if (normalized === null) return null;
      return { ...base, kind: "pull", number, tab: normalized, ...(comment ? { comment } : {}) };
    }
    case "issues":
    case "discussions": {
      const number = parseNumber(rest[0]);
      if (number === null || rest.length > 1) return null;
      return { ...base, kind: section === "issues" ? "issue" : "discussion", number, ...(comment ? { comment } : {}) };
    }
    case "commit": {
      const sha = rest[0];
      if (sha === undefined || !SHA_PATTERN.test(sha) || rest.length > 1) return null;
      return { ...base, kind: "commit", sha: sha.toLowerCase() };
    }
    case "blob":
    case "tree": {
      const ref = rest[0];
      if (ref === undefined) return null;
      const path = rest.slice(1).join("/");
      if (section === "blob" && path.length === 0) return null;
      const lines = section === "blob" ? parseLines(anchor) : undefined;
      return { ...base, kind: section, ref, path, ...(lines ? { lines } : {}) };
    }
    case "releases": {
      if (rest.length === 0) return { ...base, kind: "release" };
      if (rest[0] === "latest" && rest.length === 1) return { ...base, kind: "release", latest: true };
      if (rest[0] === "tag" && rest.length >= 2) return { ...base, kind: "release", tag: rest.slice(1).join("/") };
      return null;
    }
    case "actions": {
      if (rest[0] !== "runs") return null;
      const runId = parseNumber(rest[1]);
      if (runId === null) return null;
      if (rest[2] === "job") {
        const jobId = parseNumber(rest[3]);
        return jobId === null ? null : { ...base, kind: "actions-run", runId, jobId };
      }
      // `/attempts/N` and `/workflow` stay on the same run.
      return { ...base, kind: "actions-run", runId };
    }
    default:
      return null;
  }
}

function hostHasLabel(hostname: string, apex: string, label: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === apex || host.split(".").includes(label);
}

/** A GitLab MR (gitlab.com or a host with a `gitlab` label) or a Bitbucket Cloud PR. */
export function parseChangeRequestLink(href: string): ChangeRequestLink | null {
  const url = parseHttpUrl(href);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = pathSegments(url);
  if (!segments) return null;

  if (hostHasLabel(host, "gitlab.com", "gitlab")) {
    const marker = segments.indexOf("-");
    if (marker >= 2 && segments[marker + 1] === "merge_requests") {
      const number = parseNumber(segments[marker + 2]);
      const repository = segments.slice(0, marker);
      if (number !== null && repository.every((segment) => REPO_PATTERN.test(segment))) {
        return { forge: "gitlab", kind: "pull", url: url.href, host, repository: repository.join("/"), number };
      }
    }
    return null;
  }
  if (host === "bitbucket.org" || host === "www.bitbucket.org") {
    const [workspace, repo, section, id] = segments;
    const number = parseNumber(id);
    if (
      workspace !== undefined &&
      repo !== undefined &&
      section === "pull-requests" &&
      number !== null &&
      REPO_PATTERN.test(workspace) &&
      REPO_PATTERN.test(repo)
    ) {
      return { forge: "bitbucket", kind: "pull", url: url.href, host: "bitbucket.org", repository: `${workspace}/${repo}`, number };
    }
  }
  return null;
}

/** Any forge link the chat renders as a pill, or `null` for a plain link. */
export function parseForgeLink(href: string): ForgeLink | null {
  return parseGitHubLink(href) ?? parseChangeRequestLink(href);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface ForgeLinkLabelContext {
  /**
   * The current project's `ProjectSummary.repoKey` (lowercased `host/owner/repo`).
   * A link into that repo drops its `owner/repo`, as GitHub does in its own threads.
   */
  currentRepoKey?: string | null;
}

/** The link is into the project's own GitHub repository. */
export function isCurrentRepo(link: GitHubLink, context: ForgeLinkLabelContext | undefined): boolean {
  const key = context?.currentRepoKey;
  return typeof key === "string" && key.toLowerCase() === `github.com/${link.owner}/${link.repo}`.toLowerCase();
}

const PATH_LABEL_SEGMENTS = 3;

function shortPath(path: string): string {
  const segments = path.split("/");
  return segments.length > PATH_LABEL_SEGMENTS ? `…/${segments.slice(-PATH_LABEL_SEGMENTS).join("/")}` : path;
}

function linesLabel(lines: GitHubLineRange | undefined): string {
  if (!lines) return "";
  return lines.end === undefined ? `#L${lines.start}` : `#L${lines.start}-${lines.end}`;
}

const TAB_SUFFIX: Record<GitHubPullTab, string> = { files: " (files)", commits: " (commits)", checks: " (checks)" };

/**
 * The pill's short label: `owner/repo#123` (`#123` inside the project's own
 * repo), `owner/repo@abc1234`, `repo › path/file.ts#L10-20`, and so on.
 */
export function forgeLinkLabel(link: ForgeLink, context?: ForgeLinkLabelContext): string {
  if (link.forge !== "github") {
    return link.forge === "gitlab" ? `${link.repository}!${link.number}` : `${link.repository}#${link.number}`;
  }
  const own = isCurrentRepo(link, context);
  const full = `${link.owner}/${link.repo}`;
  const prefix = own ? "" : full;
  const scoped = own ? "" : `${link.repo} › `;
  switch (link.kind) {
    case "pull":
      return `${prefix}#${link.number}${link.tab ? TAB_SUFFIX[link.tab] : link.comment ? " (comment)" : ""}`;
    case "issue":
    case "discussion":
      return `${prefix}#${link.number}${link.comment ? " (comment)" : ""}`;
    case "commit":
      return own ? link.sha.slice(0, 7) : `${full}@${link.sha.slice(0, 7)}`;
    case "repo":
      return full;
    case "blob":
      return `${scoped}${shortPath(link.path)}${linesLabel(link.lines)}`;
    case "tree":
      return link.path.length === 0 ? `${link.repo} › ${link.ref}` : `${scoped}${shortPath(link.path)}/`;
    case "release":
      return `${scoped}${link.tag ?? (link.latest ? "latest release" : "releases")}`;
    case "actions-run":
      return `${scoped}run ${link.runId}${link.jobId !== undefined ? ` › job ${link.jobId}` : ""}`;
  }
}

/** A longer description for the pill's `title`/accessible name: what the link is and where. */
export function forgeLinkDescription(link: ForgeLink): string {
  if (link.forge !== "github") {
    return `${link.forge === "gitlab" ? "GitLab merge request" : "Bitbucket pull request"} ${link.repository} #${link.number}`;
  }
  const full = `${link.owner}/${link.repo}`;
  switch (link.kind) {
    case "pull":
      return `Pull request ${full}#${link.number}`;
    case "issue":
      return `Issue ${full}#${link.number}`;
    case "discussion":
      return `Discussion ${full}#${link.number}`;
    case "commit":
      return `Commit ${link.sha.slice(0, 7)} in ${full}${link.pullNumber !== undefined ? ` (pull request #${link.pullNumber})` : ""}`;
    case "repo":
      return `Repository ${full}`;
    case "blob":
      return `File ${link.path}${linesLabel(link.lines)} at ${link.ref} in ${full}`;
    case "tree":
      return `Folder ${link.path || "/"} at ${link.ref} in ${full}`;
    case "release":
      return link.tag ? `Release ${link.tag} of ${full}` : link.latest ? `Latest release of ${full}` : `Releases of ${full}`;
    case "actions-run":
      return `Actions run ${link.runId}${link.jobId !== undefined ? `, job ${link.jobId}` : ""} in ${full}`;
  }
}

// ---------------------------------------------------------------------------
// The preview route
// ---------------------------------------------------------------------------

/** What the daemon can read for a link: a numbered issue-or-PR, or a commit. */
export type GitHubPreviewTarget =
  | { kind: "pull" | "issue"; owner: string; repo: string; number: number }
  | { kind: "commit"; owner: string; repo: string; sha: string };

/**
 * The metadata a link can carry, or `null` (repos, files, releases, runs,
 * discussions and other forges render without a fetch). `/issues/N` stays an
 * issue target; the daemon answers a pull request preview when N is one.
 */
export function githubPreviewTarget(link: ForgeLink): GitHubPreviewTarget | null {
  if (link.forge !== "github") return null;
  if (link.kind === "pull" || link.kind === "issue") {
    return { kind: link.kind, owner: link.owner, repo: link.repo, number: link.number };
  }
  if (link.kind === "commit") return { kind: "commit", owner: link.owner, repo: link.repo, sha: link.sha };
  return null;
}

/** A stable cache key for a preview target (GitHub names are case-insensitive). */
export function githubPreviewKey(target: GitHubPreviewTarget): string {
  const repo = `${target.owner}/${target.repo}`.toLowerCase();
  return target.kind === "commit" ? `commit:${repo}@${target.sha.toLowerCase()}` : `${target.kind}:${repo}#${target.number}`;
}

export const githubLinkRoutes = {
  /**
   * GET `?url=<github url>[&projectPath=<abs project dir>]` → {@link GitHubLinkPreviewResponse}.
   * `projectPath` picks the git account bound to that project's workspace for
   * the read; without one (or with no token) the daemon reads anonymously.
   * Refusals are `{ code, message, retryAfterMs? }` ({@link GitHubLinkPreviewErrorCode}).
   */
  preview: "/api/github/link-preview"
} as const;

/** GitHub's own state model, flattened: a draft PR is `draft`, a merged one `merged`. */
export type GitHubItemState = "open" | "draft" | "merged" | "closed";

/** Check runs on a pull request's head commit (one call; first 100 runs). */
export interface GitHubChecksSummary {
  total: number;
  passed: number;
  failed: number;
  /** Queued or in progress. */
  pending: number;
  /** Skipped, neutral, or stale. */
  skipped: number;
}

export interface GitHubPullPreview {
  kind: "pull";
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: GitHubItemState;
  /** Login; `null` for a deleted account ("ghost"). */
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  /** Conversation comments plus review comments. */
  comments: number;
  /** `null` when the preview came from the issues endpoint and the PR could not be read. */
  headRef: string | null;
  baseRef: string | null;
  /** `owner:branch` when the head lives in a fork. */
  headLabel: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** Only read for an open or draft PR; `null` when not read or not readable. */
  checks: GitHubChecksSummary | null;
}

export interface GitHubIssuePreview {
  kind: "issue";
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  /** Why a closed issue closed; `null` when open or unstated. */
  stateReason: "completed" | "not_planned" | null;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  comments: number;
}

export interface GitHubCommitPreview {
  kind: "commit";
  owner: string;
  repo: string;
  /** The full 40-digit SHA. */
  sha: string;
  url: string;
  /** The message's first line. */
  title: string;
  /** The rest of the message, trimmed and capped at {@link GITHUB_COMMIT_BODY_MAX} characters. */
  body: string;
  /** GitHub login when the author maps to an account, else the git author name. */
  author: string | null;
  authoredAt: string | null;
  committedAt: string | null;
}

export type GitHubLinkPreview = GitHubPullPreview | GitHubIssuePreview | GitHubCommitPreview;

export const GITHUB_COMMIT_BODY_MAX = 600;
export const GITHUB_TITLE_MAX = 300;

export interface GitHubLinkPreviewResponse {
  preview: GitHubLinkPreview;
}

export type GitHubLinkPreviewErrorCode =
  | "INVALID_LINK" // 400 — not a GitHub PR, issue or commit URL
  | "NOT_FOUND" // 404 — missing, or private and no stored account can read it
  | "RATE_LIMITED" // 429 — GitHub's quota for this credential is spent; `retryAfterMs` when known
  | "UPSTREAM"; // 502 — GitHub unreachable or answered with an error

export interface GitHubLinkPreviewError {
  code: GitHubLinkPreviewErrorCode;
  message: string;
  retryAfterMs?: number;
}
