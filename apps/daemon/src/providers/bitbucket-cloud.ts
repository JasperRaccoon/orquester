import type { OwnerSummary, RepoSummary } from "@orquester/api";

import { AccountError } from "../account-error";
import { TtlCache } from "./ttl-cache";
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

/**
 * Bitbucket Cloud (`bitbucket.org`) provider.
 *
 * REST is `https://api.bitbucket.org/2.0` authenticated with **Basic
 * email:token** — Atlassian API tokens are not Bearer credentials. Git over
 * HTTPS uses the fixed username `x-bitbucket-api-token-auth` with the same
 * token. SSH always targets `ssh.bitbucket.org`: the legacy `bitbucket.org` SSH
 * endpoint is retired on 2026-11-12, so clone URLs are rebuilt rather than read
 * from the API (which may still advertise the old host).
 */

const API = "https://api.bitbucket.org/2.0";
const SSH_HOST = "ssh.bitbucket.org";

/** Fixed git-over-HTTPS username that pairs with an Atlassian API token. */
const CLOUD_GIT_USERNAME = "x-bitbucket-api-token-auth";

const SCOPES =
  "read:repository, write:repository, read:workspace, read:user, read:ssh-key, write:ssh-key (all :bitbucket, on a SCOPED API token)";

/** Loosely-typed decoded JSON object. */
type Json = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function authHeader(creds: ProviderCreds): string {
  // Atlassian API tokens authenticate REST via Basic email:token — NOT Bearer.
  return "Basic " + Buffer.from(`${creds.email ?? ""}:${creds.token}`).toString("base64");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read the scopes a 403 says are missing. Scoped Atlassian API tokens answer
 * `{"error": {"message": "Your credentials lack one or more required privilege
 * scopes.", "detail": {"granted": [...], "required": [...]}}}`; null when the
 * body is not that shape.
 */
function missingScopesOf(body: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return /privilege scope/i.test(body) ? [] : null;
  }
  const error = (parsed as { error?: { message?: unknown; detail?: unknown } } | null)?.error;
  const message = typeof error?.message === "string" ? error.message : "";
  const detail = error?.detail as { required?: unknown } | undefined;
  const required = Array.isArray(detail?.required)
    ? detail.required.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (required.length === 0 && !/scope/i.test(message)) {
    return null;
  }
  return required;
}

/** One Bitbucket Cloud answer: its status, decoded JSON and headers. */
interface CloudResponse {
  status: number;
  data: Json | undefined;
  headers: Headers;
}

/**
 * A Bitbucket Cloud REST call; throws on a non-2xx (and on a 304 only when the
 * caller sent no ETag). `creds: null` reads anonymously (public repos).
 */
async function bbRequest(
  creds: ProviderCreds | null,
  method: string,
  pathOrUrl: string,
  opts: { body?: unknown; etag?: string } = {},
  retry = 2
): Promise<CloudResponse> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  const { body, etag } = opts;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(creds ? { Authorization: authHeader(creds) } : {}),
        Accept: "application/json",
        "User-Agent": "orquester",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(etag ? { "If-None-Match": etag } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new GitRemoteError(
      502,
      `Bitbucket ${method} ${pathOrUrl} failed: ${error instanceof Error ? error.message : "network error"}`,
      "upstream"
    );
  }
  if (res.status === 429 && retry > 0) {
    // Bitbucket REST has a ~1,000 req/h floor — back off and retry.
    await sleep((3 - retry) * 2000);
    return bbRequest(creds, method, pathOrUrl, opts, retry - 1);
  }
  if (res.status === 304 && etag) {
    return { status: 304, data: undefined, headers: res.headers };
  }
  if (!res.ok) {
    const fullText = await res.text().catch(() => "");
    const text = fullText.slice(0, 200);
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      throw new GitRemoteError(
        429,
        `Bitbucket ${method} ${pathOrUrl} → 429: rate limit exceeded. ${text}`,
        "rate_limited",
        res.status,
        wait
      );
    }
    const missing = res.status === 403 ? missingScopesOf(fullText) : null;
    if (missing) {
      const pullRequests =
        /\/pullrequests/.test(pathOrUrl) || missing.some((scope) => scope.startsWith("read:pullrequest"));
      throw new GitRemoteError(
        400,
        pullRequests
          ? "The Bitbucket token lacks the read:pullrequest scope — create a scoped Atlassian API token that includes read:pullrequest:bitbucket to watch pull requests."
          : `The Bitbucket token lacks a required scope${missing.length ? ` (${missing.join(", ")})` : ""}. Scopes: ${SCOPES}.`,
        "missing_scope",
        res.status
      );
    }
    const unauthorized = res.status === 401 || res.status === 403;
    const hint = unauthorized
      ? ` (use a SCOPED Atlassian API token — plain tokens fail; scopes: ${SCOPES}; REST username is your Atlassian account EMAIL)`
      : "";
    throw new GitRemoteError(
      unauthorized ? 400 : 502,
      `Bitbucket ${method} ${pathOrUrl} → ${res.status}${hint}. ${text}`,
      unauthorized ? "auth" : res.status === 404 ? "not_found" : "upstream",
      res.status
    );
  }
  return {
    status: res.status,
    data: res.status === 204 ? undefined : ((await res.json()) as Json),
    headers: res.headers
  };
}

/** Authenticated Bitbucket Cloud REST call; throws GitRemoteError on a non-2xx. */
async function bb(
  creds: ProviderCreds,
  method: string,
  pathOrUrl: string,
  body?: unknown
): Promise<Json | undefined> {
  return (await bbRequest(creds, method, pathOrUrl, { body })).data;
}

/** Follows Bitbucket's `{values, next}` pagination. */
async function bbAll(creds: ProviderCreds, firstPath: string): Promise<Json[]> {
  const out: Json[] = [];
  let url: string | undefined = firstPath;
  while (url) {
    const page = await bb(creds, "GET", url);
    const values = page?.values;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (value && typeof value === "object") {
          out.push(value as Json);
        }
      }
    }
    url = str(page?.next);
  }
  return out;
}

/** Map one Bitbucket Cloud repo JSON object to the wire `RepoSummary`. */
function toCloudRepoSummary(repo: Json): RepoSummary {
  const fullName = str(repo.full_name) ?? "";
  const [owner, nameFromFullName] = fullName.split("/");
  const links = (repo.links ?? {}) as { clone?: unknown };
  const clones = Array.isArray(links.clone)
    ? (links.clone as Array<{ name?: unknown; href?: unknown }>)
    : [];
  const httpsRaw = str(clones.find((clone) => clone.name === "https")?.href);
  const mainbranch = (repo.mainbranch ?? {}) as { name?: unknown };
  return {
    fullName,
    owner: owner ?? "",
    name: str(repo.slug) ?? nameFromFullName ?? "",
    private: repo.is_private === true,
    // The API may still emit the legacy bitbucket.org ssh host during the
    // 2026 migration window — always build the new-host form ourselves.
    sshUrl: `git@${SSH_HOST}:${fullName}.git`,
    // The advertised https href embeds the viewer's username — strip it so the
    // URL works for any credential-store entry.
    httpsUrl: httpsRaw
      ? httpsRaw.replace(/^https:\/\/[^@/]*@/, "https://")
      : `https://bitbucket.org/${fullName}.git`,
    defaultBranch: str(mainbranch.name) ?? "",
    description: str(repo.description) ?? null
  };
}

/**
 * Parse `https://[user@]bitbucket.org/ws/r`, `git@[ssh.]bitbucket.org:ws/r.git`,
 * or `ws/r`. The optional `user@` userinfo segment is what Bitbucket Cloud's
 * Clone dialog actually puts on the clipboard (`https://<nickname>@…`); it is
 * ignored — git gets credentials from the credential store instead.
 */
function parseCloudRepoUrl(input: string): ParsedRepo | null {
  const part = "[A-Za-z0-9._-]+";
  const httpsRe = new RegExp(
    `^https?://(?:[^@/]+@)?bitbucket\\.org/(${part})/(${part}?)(?:\\.git)?/?$`,
    "i"
  );
  const sshRe = new RegExp(`^git@(?:ssh\\.)?bitbucket\\.org:(${part})/(${part}?)(?:\\.git)?$`, "i");
  const shortRe = new RegExp(`^(${part})/(${part})$`);
  const match = input.match(httpsRe) ?? input.match(sshRe) ?? input.match(shortRe);
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  return owner && repo ? { owner, repo } : null;
}

/**
 * Short-TTL cache for the expensive listings (workspaces × repos is many
 * paginated calls against a ~1,000 req/h REST budget, and the repo picker
 * re-lists on every modal open). Keyed per credential; in-memory only.
 * `createRepo` invalidates so a just-created repo shows up immediately.
 */
const LIST_TTL_MS = 60_000;
const repoListCache = new TtlCache<RepoSummary[]>(LIST_TTL_MS);
const ownerListCache = new TtlCache<OwnerSummary[]>(LIST_TTL_MS);

function listCacheKey(creds: ProviderCreds): string {
  return `${creds.email ?? ""}\0${creds.token}`;
}

/** The first two fields of an OpenSSH public key ("<type> <base64>"). */
function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/**
 * `/user/workspaces` returns `workspace_access` membership envelopes —
 * `{type: "workspace_access", workspace: {slug, name, …}}` — not bare
 * workspace objects. Unwrap, tolerating the bare shape as well.
 */
function workspaceOf(value: Json): Json {
  const nested = value.workspace;
  return nested && typeof nested === "object" ? (nested as Json) : value;
}

/** The account UUID (braces included) the ssh-keys endpoints are keyed on. */
function userRef(identity: ProviderIdentity): string {
  const ref = identity.loginRef ?? identity.login;
  if (!ref) {
    throw new AccountError(502, "Bitbucket did not return the account identity.");
  }
  return encodeURIComponent(ref);
}

export const bitbucketCloudProvider: GitProvider = {
  id: "bitbucket-cloud",
  scopesHint: SCOPES,

  async getIdentity(creds): Promise<ProviderIdentity> {
    if (!creds.email) {
      throw new AccountError(400, "The Atlassian account email is required.");
    }
    const user = await bb(creds, "GET", "/user");
    const uuid = str(user?.uuid);
    if (!uuid) {
      throw new AccountError(502, "Bitbucket did not return the account identity.");
    }
    const nickname = str(user?.nickname);
    const displayName = str(user?.display_name);
    return {
      login: nickname ?? displayName ?? "bitbucket-user",
      loginRef: uuid, // "{...}" braces included
      name: displayName ?? nickname ?? "bitbucket-user",
      email: creds.email
    };
  },

  async uploadSshKey(creds, identity, publicKey, label): Promise<KeyUpload> {
    try {
      const key = await bb(creds, "POST", `/users/${userRef(identity)}/ssh-keys`, {
        key: publicKey,
        label
      });
      return { keyId: str(key?.uuid) };
    } catch (error) {
      if (error instanceof GitRemoteError && error.httpStatus === 409) {
        throw new AccountError(
          409,
          "Bitbucket rejected the key: an identical SSH key is already registered to another Bitbucket account or workspace (keys are globally unique)."
        );
      }
      throw error;
    }
  },

  async findSshKey(creds, identity, publicKey) {
    const body = keyBody(publicKey);
    const keys = await bbAll(creds, `/users/${userRef(identity)}/ssh-keys`);
    const hit = keys.find((key) => {
      const value = str(key.key);
      return value ? value.trim().startsWith(body) : false;
    });
    const keyId = hit ? str(hit.uuid) : undefined;
    return keyId ? { keyId } : null;
  },

  async removeSshKey(creds, identity, keyId) {
    await bb(
      creds,
      "DELETE",
      `/users/${userRef(identity)}/ssh-keys/${encodeURIComponent(keyId)}`
    );
  },

  async listRepos(creds): Promise<RepoSummary[]> {
    return repoListCache.get(listCacheKey(creds), async () => {
      const memberships = await bbAll(creds, "/user/workspaces");
      const out: RepoSummary[] = [];
      for (const membership of memberships) {
        const slug = str(workspaceOf(membership).slug);
        if (!slug) {
          continue;
        }
        const repos = await bbAll(
          creds,
          `/repositories/${encodeURIComponent(slug)}?role=member&pagelen=100`
        );
        out.push(...repos.map(toCloudRepoSummary));
      }
      return out;
    });
  },

  async listOwners(creds): Promise<OwnerSummary[]> {
    return ownerListCache.get(listCacheKey(creds), async () => {
      const memberships = await bbAll(creds, "/user/workspaces");
      const owners: OwnerSummary[] = [];
      for (const membership of memberships) {
        const workspace = workspaceOf(membership);
        const slug = str(workspace.slug);
        if (slug) {
          owners.push({ id: slug, label: str(workspace.name) ?? slug, kind: "workspace" });
        }
      }
      return owners;
    });
  },

  async createRepo(creds, _identity, opts: CreateRepoOpts): Promise<RepoSummary> {
    const slug = opts.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const repo = await bb(
      creds,
      "POST",
      `/repositories/${encodeURIComponent(opts.owner)}/${encodeURIComponent(slug)}`,
      {
        scm: "git",
        is_private: opts.visibility === "private",
        description: opts.description ?? ""
      }
    );
    repoListCache.invalidate(listCacheKey(creds));
    return toCloudRepoSummary(repo ?? {});
  },

  parseRepoUrl(input: string, _ctx: UrlContext): ParsedRepo | null {
    return parseCloudRepoUrl(input.trim());
  },

  async cloneUrls(_creds, ref): Promise<CloneUrls> {
    return {
      ssh: `git@${SSH_HOST}:${ref.owner}/${ref.repo}.git`,
      https: `https://bitbucket.org/${ref.owner}/${ref.repo}.git`
    };
  },

  sshProbe(_ctx): SshProbe {
    return {
      target: `git@${SSH_HOST}`,
      // Bitbucket's `ssh -T` never grants a shell either — parse the greeting.
      parse: (text) => {
        const match = /logged in as ([^\s.]+)/i.exec(text);
        return match
          ? { ok: true, login: match[1], message: text.slice(0, 200) }
          : { ok: false, message: text.slice(0, 200) || "No greeting from Bitbucket." };
      }
    };
  },

  credentialSpec(_ctx): CredentialSpec {
    return { host: "bitbucket.org", username: CLOUD_GIT_USERNAME };
  },

  supportsReleases: false,

  /**
   * `GET /repositories/:ws/:slug/pullrequests` in every live state, most
   * recently updated first. Needs `read:pullrequest` on a scoped token — a 403
   * naming it is a `missing_scope` GitRemoteError the UI can warn on.
   */
  async listPullRequests(
    creds: ProviderCreds | null,
    repo: ParsedRepo,
    opts?: ConditionalListOptions
  ): Promise<ConditionalPage<PullRequestInfo>> {
    const path =
      `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pullrequests` +
      `?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=${POLL_PAGE_SIZE}`;
    const res = await bbRequest(creds?.token ? creds : null, "GET", path, { etag: opts?.etag });
    if (res.status === 304) {
      return { notModified: true };
    }
    const values = Array.isArray(res.data?.values) ? (res.data.values as unknown[]) : [];
    const etag = res.headers.get("etag") ?? undefined;
    return {
      items: values
        .filter((value): value is Json => !!value && typeof value === "object")
        .map(toCloudPullRequest),
      ...(etag ? { etag } : {})
    };
  },

  /** Bitbucket has no releases (the editor offers "tag" there). */
  async listReleases(): Promise<ConditionalPage<ReleaseInfo>> {
    return { items: [], unsupported: true };
  }
};

/** Map one Bitbucket Cloud pull request JSON object to `PullRequestInfo`. */
function toCloudPullRequest(pr: Json): PullRequestInfo {
  const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
  const source = obj(pr.source);
  const destination = obj(pr.destination);
  const author = obj(pr.author);
  const state = str(pr.state);
  return {
    number: typeof pr.id === "number" ? pr.id : 0,
    title: str(pr.title) ?? "",
    body: str(pr.description) ?? "",
    url: str(obj(obj(pr.links).html).href) ?? "",
    author: str(author.nickname) ?? str(author.display_name) ?? "",
    head: str(obj(source.branch).name) ?? "",
    base: str(obj(destination.branch).name) ?? "",
    // The listing's hash is abbreviated (12 hex) — see PullRequestInfo.headSha.
    headSha: str(obj(source.commit).hash) ?? "",
    state: state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed",
    updatedAt: str(pr.updated_on) ?? ""
  };
}
