import { readFile } from "node:fs/promises";

import type { OwnerSummary, RepoSummary } from "@orquester/api";
import { Agent } from "undici";

import { AccountError } from "../account-error";
import type {
  CloneUrls,
  CreateRepoOpts,
  CredentialSpec,
  GitProvider,
  KeyUpload,
  ParsedRepo,
  ProviderCreds,
  ProviderIdentity,
  SshProbe,
  UrlContext
} from "./types";

/**
 * Bitbucket Server / Data Center ("Bitbucket Enterprise").
 *
 * Everything is instance-relative: `creds.baseUrl` carries the scheme, host,
 * optional port and any context path (`https://bb.corp.com/bitbucket`). REST
 * lives under `{base}/rest/api/1.0` (plus `{base}/rest/ssh/1.0` for keys) and is
 * authenticated with `Authorization: Bearer <http access token>` — DC 10.x
 * disables Basic auth by default, and Bearer works for personal *and*
 * project/repo tokens.
 *
 * Two DC-specific invariants:
 * - **Never derive clone URLs.** Admins can move the SSH endpoint to a different
 *   host/port and the HTTPS URL carries the context path, so URLs always come
 *   from `links.clone[]` (see `pickCloneUrls`).
 * - **TLS may be internal-CA/self-signed.** Every fetch goes through an undici
 *   `Agent` seeded with the account's PEM bundle when `caCertPath` is set.
 */

const SCOPES = "an HTTP access token with Repository write (and Project read) permission";

/** Deep link to the instance's per-user SSH keys page (manual-upload fallback). */
function manualKeysUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/plugins/servlet/ssh/account/keys`;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Normalized instance base URL (no trailing slash); 400 when unset. */
function base(creds: { baseUrl?: string }): string {
  if (!creds.baseUrl) {
    throw new AccountError(400, "The Bitbucket Server base URL is required.");
  }
  return creds.baseUrl.replace(/\/+$/, "");
}

/**
 * `AccountError` that remembers the raw HTTP status, so callers can branch on
 * 401/403/409 without re-parsing the message. Still an `AccountError`, so route
 * handlers map `.status` exactly as before.
 */
class DcHttpError extends AccountError {
  constructor(
    status: number,
    message: string,
    readonly httpStatus: number
  ) {
    super(status, message);
  }
}

/** Per-account CA bundle → undici dispatcher; undefined means "system CAs". */
async function dispatcherFor(caCertPath?: string): Promise<Agent | undefined> {
  if (!caCertPath) {
    return undefined;
  }
  const ca = await readFile(caCertPath, "utf8");
  return new Agent({ connect: { ca } });
}

/** Authenticated DC REST call; throws `DcHttpError` on a non-2xx. */
async function dc(
  creds: ProviderCreds,
  method: string,
  path: string,
  body?: unknown,
  retry = 1
): Promise<any> {
  const dispatcher = await dispatcherFor(creds.caCertPath);
  const response = await fetch(`${base(creds)}${path}`, {
    method,
    // Bearer works for personal AND project/repo tokens, and survives DC 10.x
    // instances that disable Basic auth.
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/json",
      "User-Agent": "orquester",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    // Non-standard RequestInit key understood by Node's undici-backed fetch.
    ...(dispatcher ? ({ dispatcher } as object) : {})
  });
  if (response.status === 429 && retry > 0) {
    // DC rate limiting (token-bucket, admin-configured) — one backoff retry.
    await sleep(2000);
    return dc(creds, method, path, body, retry - 1);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    if (response.status === 403 && /Basic Authentication has been disabled/i.test(text)) {
      throw new DcHttpError(
        502,
        "The instance rejected Basic auth — this is unexpected since Orquester uses Bearer; check for a proxy rewriting the Authorization header.",
        response.status
      );
    }
    const unauthorized = response.status === 401 || response.status === 403;
    const hint = unauthorized ? ` (check the token: ${SCOPES})` : "";
    throw new DcHttpError(
      unauthorized ? 400 : 502,
      `Bitbucket Server ${method} ${path} → ${response.status}${hint}. ${text}`,
      response.status
    );
  }
  return response.status === 204 ? undefined : response.json();
}

/** DC pagination: {values, isLastPage, nextPageStart}. */
async function dcAll(creds: ProviderCreds, path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let start = 0;
  for (;;) {
    const page = await dc(creds, "GET", `${path}${sep}limit=100&start=${start}`);
    out.push(...(page?.values ?? []));
    if (!page || page.isLastPage !== false || page.nextPageStart == null) {
      return out;
    }
    start = page.nextPageStart;
  }
}

/**
 * Unauthenticated instance probe; also used at connect time for context-path
 * validation (a wrong context path 404s here before the token is ever sent).
 */
export async function probeServer(
  baseUrl: string,
  caCertPath?: string
): Promise<{ version: string; displayName: string }> {
  const dispatcher = await dispatcherFor(caCertPath);
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/rest/api/1.0/application-properties`, {
    headers: { Accept: "application/json", "User-Agent": "orquester" },
    ...(dispatcher ? ({ dispatcher } as object) : {})
  });
  if (!response.ok) {
    throw new AccountError(
      400,
      `Not a reachable Bitbucket Server/Data Center at this base URL (application-properties → ${response.status}). Check the URL — including any context path like /bitbucket.`
    );
  }
  const props = (await response.json().catch(() => ({}))) as {
    version?: unknown;
    displayName?: unknown;
  };
  return { version: String(props.version ?? ""), displayName: String(props.displayName ?? "") };
}

/** ed25519 host/user keys need Server ≥ 6.6; older instances get RSA-4096. */
export function serverVersionSupportsEd25519(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return true;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 6 || (major === 6 && minor >= 6);
}

/**
 * Pick the HTTPS + SSH clone URLs out of a DC `links.clone[]` array. DC labels
 * the HTTPS entry `name: "http"` even when the href is https, and omits the
 * `ssh` entry entirely when the admin disabled SSH (→ HTTPS-only account).
 * Credentials the API embeds in the href (`https://jdoe@host/...`) are stripped —
 * git gets them from the credential store instead.
 */
export function pickCloneUrls(clone: Array<{ name: string; href: string }>): CloneUrls {
  const https = clone.find((entry) => entry.name === "http" || entry.name === "https")?.href;
  const ssh = clone.find((entry) => entry.name === "ssh")?.href;
  if (!https) {
    throw new AccountError(502, "The repository exposes no HTTP clone URL.");
  }
  return { https: https.replace(/^(https?:\/\/)[^@/]*@/, "$1"), ssh };
}

/**
 * Parse the DC repo forms, anchored to *this* account's instance so a URL from
 * another host (or another provider) is rejected rather than mis-cloned:
 * `{base}/scm/KEY/slug.git`, `{base}/projects/KEY/repos/slug/browse`,
 * `{base}/users/name/repos/slug/browse` (→ personal project `~name`),
 * `ssh://git@{sshHost}/KEY/slug.git`, and the `KEY/slug` / `~user/slug` shorthand.
 */
export function parseServerRepoUrl(input: string, ctx: UrlContext): ParsedRepo | null {
  const trimmed = input.trim();
  const part = "[A-Za-z0-9._-]+";
  const shortRe = new RegExp(`^(~?${part})/(${part})$`);
  const short = trimmed.match(shortRe);
  if (short) {
    return { owner: short[1], repo: short[2] };
  }
  if (!ctx.baseUrl) {
    return null;
  }
  const baseEsc = ctx.baseUrl.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: Array<{ re: RegExp; personal: boolean }> = [
    { re: new RegExp(`^${baseEsc}/scm/(~?${part})/(${part}?)(?:\\.git)?/?$`, "i"), personal: false },
    { re: new RegExp(`^${baseEsc}/projects/(${part})/repos/(${part})/browse`, "i"), personal: false },
    { re: new RegExp(`^${baseEsc}/users/(${part})/repos/(${part})/browse`, "i"), personal: true }
  ];
  for (const { re, personal } of patterns) {
    const match = trimmed.match(re);
    if (match) {
      return { owner: personal ? `~${match[1]}` : match[1], repo: match[2] };
    }
  }
  if (ctx.sshHost) {
    const [host, port] = ctx.sshHost.split(":");
    const sshRe = new RegExp(
      `^ssh://git@${host.replace(/\./g, "\\.")}${port ? `:${port}` : ""}/(~?${part})/(${part}?)(?:\\.git)?$`,
      "i"
    );
    const match = trimmed.match(sshRe);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

/** Map one DC repo JSON object to the wire `RepoSummary`. */
function toServerRepoSummary(repo: any): RepoSummary {
  const projectKey: string = repo?.project?.key ?? "";
  const slug: string = repo?.slug ?? "";
  const { https, ssh } = pickCloneUrls(repo?.links?.clone ?? []);
  return {
    fullName: `${projectKey}/${slug}`,
    owner: projectKey,
    name: slug,
    private: repo?.public !== true,
    // HTTPS-only instances (SSH disabled) still need a usable clone URL here.
    sshUrl: ssh ?? https,
    httpsUrl: https,
    // DC's repo JSON carries no default branch (it needs a second call per repo).
    defaultBranch: "",
    description: repo?.description ?? null
  };
}

export const bitbucketServerProvider: GitProvider = {
  id: "bitbucket-server",
  scopesHint: SCOPES,

  async getIdentity(creds: ProviderCreds): Promise<ProviderIdentity> {
    if (!creds.username) {
      throw new AccountError(400, "The Bitbucket Server username is required.");
    }
    const user = await dc(creds, "GET", `/rest/api/1.0/users/${encodeURIComponent(creds.username)}`);
    return {
      login: creds.username,
      loginRef: user?.slug ?? creds.username,
      name: user?.displayName ?? creds.username,
      email: user?.emailAddress ?? ""
    };
  },

  /**
   * DC tokens are documented as unable to "update user account details" and
   * behavior varies by instance, so a 401/403 is not fatal: fall back to the
   * manual paste page and let `confirmKey()` verify it later.
   */
  async uploadSshKey(creds, _identity, publicKey, _label): Promise<KeyUpload> {
    try {
      const key = await dc(creds, "POST", "/rest/ssh/1.0/keys", { text: publicKey });
      return key?.id === undefined ? {} : { keyId: String(key.id) };
    } catch (error) {
      if (error instanceof DcHttpError) {
        if (error.httpStatus === 401 || error.httpStatus === 403) {
          return { manualUrl: manualKeysUrl(base(creds)) };
        }
        if (error.httpStatus === 409) {
          throw new AccountError(409, "This SSH key is already registered on the instance.");
        }
        if (error.httpStatus === 400 && /algorithm|key type|key length|too short|bits/i.test(error.message)) {
          throw new AccountError(
            400,
            "The instance rejected the key algorithm/length (admin policy). Reconnect — Orquester will fall back to RSA-4096."
          );
        }
      }
      throw error;
    }
  },

  async findSshKey(creds, _identity, publicKey) {
    const body = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
    const keys = await dcAll(creds, "/rest/ssh/1.0/keys");
    const hit = keys.find(
      (key) => typeof key?.text === "string" && key.text.trim().startsWith(body)
    );
    return hit && hit.id !== undefined ? { keyId: String(hit.id) } : null;
  },

  async removeSshKey(creds, _identity, keyId) {
    await dc(creds, "DELETE", `/rest/ssh/1.0/keys/${encodeURIComponent(keyId)}`);
  },

  async listRepos(creds): Promise<RepoSummary[]> {
    const repos = await dcAll(creds, "/rest/api/1.0/repos?permission=REPO_READ");
    return repos.map(toServerRepoSummary);
  },

  /** Owners are projects, with the user's personal project (`~slug`) first. */
  async listOwners(creds, identity): Promise<OwnerSummary[]> {
    const projects = await dcAll(creds, "/rest/api/1.0/projects");
    return [
      {
        id: `~${identity.loginRef ?? identity.login}`,
        label: `${identity.login} (personal)`,
        kind: "user" as const
      },
      ...projects.map((project) => ({
        id: String(project?.key ?? ""),
        label: String(project?.name ?? project?.key ?? ""),
        kind: "project" as const
      }))
    ];
  },

  /**
   * DC create does **not** auto-init, so the fresh clone is empty — `git clone`
   * of an empty repo succeeds with a warning, which is acceptable.
   */
  async createRepo(creds, _identity, opts: CreateRepoOpts): Promise<RepoSummary> {
    const repo = await dc(
      creds,
      "POST",
      `/rest/api/1.0/projects/${encodeURIComponent(opts.owner)}/repos`,
      {
        name: opts.name,
        scmId: "git",
        forkable: true,
        public: opts.visibility === "public",
        ...(opts.description ? { description: opts.description } : {})
      }
    );
    return toServerRepoSummary(repo);
  },

  parseRepoUrl(input: string, ctx: UrlContext): ParsedRepo | null {
    return parseServerRepoUrl(input, ctx);
  },

  async cloneUrls(creds, ref): Promise<CloneUrls> {
    const repo = await dc(
      creds,
      "GET",
      `/rest/api/1.0/projects/${encodeURIComponent(ref.owner)}/repos/${encodeURIComponent(ref.repo)}`
    );
    return pickCloneUrls(repo?.links?.clone ?? []);
  },

  /** null when the admin disabled SSH (no `sshHost` was resolved) → HTTPS-only. */
  sshProbe(ctx): SshProbe | null {
    if (!ctx.sshHost) {
      return null;
    }
    const [host, port] = ctx.sshHost.split(":");
    return {
      target: `git@${host}`,
      port: port ? Number(port) : undefined,
      // DC's SSH endpoint has no fixed greeting, so treat any non-error output
      // as success rather than matching a login out of it.
      parse: (text) =>
        text && !/denied|refused|unable|error/i.test(text)
          ? { ok: true, login: ctx.login, message: text.slice(0, 200) }
          : { ok: false, message: text.slice(0, 200) || "No response from the SSH endpoint." }
    };
  },

  credentialSpec(ctx): CredentialSpec {
    // `URL.host` keeps a non-default port ("bb.corp.com:8443"); the context path
    // is irrelevant to git's credential lookup.
    return { host: new URL(base(ctx)).host, username: ctx.login };
  }
};
