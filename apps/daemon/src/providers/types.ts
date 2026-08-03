import type { GitProviderId, OwnerSummary, RepoSummary } from "@orquester/api";

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

/** Clone transports for a repo; `ssh` is absent on HTTPS-only instances. */
export interface CloneUrls {
  ssh?: string;
  https: string;
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
}

/** One git-credential-store line; username+token percent-encoded. */
export function buildCredentialFileLine(spec: CredentialSpec, token: string): string {
  return `https://${encodeURIComponent(spec.username)}:${encodeURIComponent(token)}@${spec.host}\n`;
}
