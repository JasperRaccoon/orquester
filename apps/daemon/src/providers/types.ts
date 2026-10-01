import type { GitProviderId, OwnerSummary, RepoSummary } from "@orquester/api";

import { AccountError } from "../account-error";

/**
 * The provider seam: everything forge-specific (REST shapes, clone-URL forms,
 * SSH endpoints, credential-store hosts) lives behind `GitProvider`, so
 * `AccountsService` keeps only the provider-agnostic lifecycle (keygen,
 * `includeIf` binding, credential files).
 *
 * Implementations are stateless singletons — the account's secrets and
 * instance coordinates are passed in per call via `ProviderCreds`/`UrlContext`.
 */

/** Per-call credentials + instance coordinates read from the stored account. */
export interface ProviderCreds {
  /** Provider token (GitHub PAT, Atlassian API token, DC HTTP access token). */
  token: string;
  /** BB Cloud only: Atlassian account email (REST Basic auth username). */
  email?: string;
  /** bitbucket-server only: instance base URL including any context path. */
  baseUrl?: string;
  /** bitbucket-server only: the DC username, when the API needs it. */
  username?: string;
  /** bitbucket-server only: absolute path to a PEM CA bundle. */
  caCertPath?: string;
}

/** Who the token authenticates as, normalized across providers. */
export interface ProviderIdentity {
  /** Provider login (GitHub login, Bitbucket nickname, DC username). */
  login: string;
  /** Secondary id some APIs need: BB Cloud account UUID (braces included), DC user slug. */
  loginRef?: string;
  /** `git config user.name`. */
  name: string;
  /** `git config user.email`. */
  email: string;
}

/** Result of an SSH-key upload: the remote id, or a URL to paste it manually. */
export interface KeyUpload {
  keyId?: string;
  manualUrl?: string;
}

/** A repo reference parsed out of a user-entered URL/shorthand. */
export interface ParsedRepo {
  owner: string;
  repo: string;
}

/**
 * Clone transports for a repo. `ssh` is absent on HTTPS-only instances; `https`
 * is absent on DC instances where the admin disabled HTTP(S) SCM hosting. At
 * least one is always present (providers throw when a repo exposes neither).
 */
export interface CloneUrls {
  ssh?: string;
  https?: string;
}

/** Host + username for one git-credential-store entry. */
export interface CredentialSpec {
  /** Host, including a non-standard port ("bb.corp.com:8443"). */
  host: string;
  username: string;
}

/** An `ssh -T` probe: where to connect and how to read the greeting. */
export interface SshProbe {
  /** SSH target, e.g. "git@github.com". */
  target: string;
  /** Non-default SSH port, when the provider uses one (DC: 7999). */
  port?: number;
  parse: (text: string) => { ok: boolean; login?: string; message?: string };
}

/** Options for creating a repo; `owner` is an id from `listOwners`. */
export interface CreateRepoOpts {
  owner: string;
  name: string;
  visibility: "private" | "public";
  description?: string;
}

/** Instance coordinates needed to build URLs for a given account. */
export interface UrlContext {
  baseUrl?: string;
  sshHost?: string;
}

/**
 * A pull request, normalised across providers (the git trigger's `pr` payload
 * is built from it). `state` folds GitHub's `closed` + `merged_at` and
 * Bitbucket's `MERGED`/`DECLINED`/`SUPERSEDED` into three values.
 */
export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  /** The PR's web page. */
  url: string;
  /** The author's login (GitHub login, Bitbucket nickname, DC username). */
  author: string;
  /** Source branch name. */
  head: string;
  /** Target branch name. */
  base: string;
  /**
   * The source branch's head commit. Bitbucket Cloud's listing carries only an
   * ABBREVIATED hash (12 hex); compare it as a prefix of a full sha.
   */
  headSha: string;
  state: "open" | "merged" | "closed";
  /** ISO timestamp of the PR's last update. */
  updatedAt: string;
}

/** A GitHub release (Bitbucket has none — see `GitProvider.supportsReleases`). */
export interface ReleaseInfo {
  id: string;
  /** The release title; the tag name when the release has none. */
  name: string;
  tag: string;
  body: string;
  url: string;
  prerelease: boolean;
  draft: boolean;
  /** ISO timestamp; null for a draft (never published). */
  publishedAt: string | null;
}

/** Conditional-request options for the polling listings. */
export interface ConditionalListOptions {
  /** The `etag` of the previous page: an unchanged listing answers `{notModified: true}`. */
  etag?: string;
  /**
   * Pull requests the caller last saw OPEN. A provider whose listing can miss one (Bitbucket
   * Server/DC lists by creation date, so a long-lived PR merged today is not on its recent
   * MERGED page) looks each missing one up, so its merge or decline is still seen. Others ignore it.
   */
  knownOpen?: readonly number[];
}

/**
 * One page of a polling listing. `notModified` answers a matching ETag (a 304
 * — free on GitHub's rate limit); otherwise `items` (one page, newest first)
 * and the response's `etag` to send next time, when the provider sent one.
 * `unsupported` marks a listing the provider does not have (releases outside
 * GitHub): always `items: []`, never an error.
 */
export type ConditionalPage<T> =
  | { notModified: true }
  | { notModified?: false; etag?: string; items: T[]; unsupported?: true };

/** Page size of the polling listings (one page per poll, newest first). */
export const POLL_PAGE_SIZE = 50;

/**
 * Why a remote read failed, for callers that must tell the cases apart (the
 * git trigger poller shows "auth rejected" / "token lacks read:pullrequest" /
 * backs off on a rate limit). Still an `AccountError`, so routes map `.status`
 * as before.
 */
type GitRemoteErrorKind =
  | "auth"
  | "missing_scope"
  | "rate_limited"
  | "not_found"
  | "unsupported"
  | "timeout"
  | "upstream";

export class GitRemoteError extends AccountError {
  constructor(
    status: number,
    message: string,
    readonly kind: GitRemoteErrorKind,
    /** The upstream HTTP status, when the failure was an HTTP answer. */
    readonly httpStatus?: number,
    /** When the provider said how long to wait (Retry-After / a rate-limit reset). */
    readonly retryAfterMs?: number
  ) {
    super(status, message);
    this.name = "GitRemoteError";
  }
}

/** Parse a `Retry-After` header (seconds or an HTTP date) into ms; undefined when absent/unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** One git-hosting provider. All methods are pure or REST-only (no fs/git). */
export interface GitProvider {
  readonly id: GitProviderId;
  /** Human-readable token scopes/permissions, surfaced in error hints + UI. */
  readonly scopesHint: string;

  getIdentity(creds: ProviderCreds): Promise<ProviderIdentity>;
  uploadSshKey(
    creds: ProviderCreds,
    identity: ProviderIdentity,
    publicKey: string,
    label: string
  ): Promise<KeyUpload>;
  findSshKey(
    creds: ProviderCreds,
    identity: ProviderIdentity,
    publicKey: string
  ): Promise<{ keyId: string } | null>;
  removeSshKey(creds: ProviderCreds, identity: ProviderIdentity, keyId: string): Promise<void>;
  listRepos(creds: ProviderCreds): Promise<RepoSummary[]>;
  listOwners(creds: ProviderCreds, identity: ProviderIdentity): Promise<OwnerSummary[]>;
  createRepo(
    creds: ProviderCreds,
    identity: ProviderIdentity,
    opts: CreateRepoOpts
  ): Promise<RepoSummary>;
  parseRepoUrl(input: string, ctx: UrlContext): ParsedRepo | null;
  cloneUrls(creds: ProviderCreds, ref: ParsedRepo): Promise<CloneUrls>;
  /** null when the provider/instance offers no SSH transport. */
  sshProbe(ctx: UrlContext & { login: string }): SshProbe | null;
  credentialSpec(ctx: UrlContext & { login: string; email?: string }): CredentialSpec;

  /** False when the forge has no releases (Bitbucket): `listReleases` then answers `unsupported`. */
  readonly supportsReleases: boolean;
  /**
   * One page (≤ `POLL_PAGE_SIZE`) of the repo's pull requests in every state,
   * most recently updated first. `creds: null` reads anonymously (public repos
   * on GitHub / Bitbucket Cloud; a DC instance needs an account).
   */
  listPullRequests(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    opts?: ConditionalListOptions
  ): Promise<ConditionalPage<PullRequestInfo>>;
  /** One page of releases, newest first (GitHub only; others answer `unsupported`). */
  listReleases(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    opts?: ConditionalListOptions
  ): Promise<ConditionalPage<ReleaseInfo>>;
}

/** One git-credential-store line; username+token percent-encoded. */
export function buildCredentialFileLine(spec: CredentialSpec, token: string): string {
  return `https://${encodeURIComponent(spec.username)}:${encodeURIComponent(token)}@${spec.host}\n`;
}
