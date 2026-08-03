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
  let ca: string;
  try {
    ca = await readFile(caCertPath, "utf8");
  } catch {
    throw new AccountError(
      500,
      "This account's CA certificate file is missing or unreadable — reconnect the account and paste the PEM bundle again."
    );
  }
  return new Agent({ connect: { ca } });
}

/** OpenSSL/Node verification codes that mean "we don't trust this certificate". */
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

/** First `code` found on the error or anywhere down its `cause` chain. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Turn a rejected `fetch` into something a user can act on. Node surfaces every
 * transport failure as `TypeError: fetch failed` and hides the real reason on
 * `error.cause` — so a self-signed/internal-CA instance (the most common v1 DC
 * setup) would otherwise read as a bare "fetch failed" with no pointer to the
 * per-account CA field that fixes it.
 */
export function describeFetchFailure(error: unknown): string {
  const code = errorCode(error);
  if (code && TLS_ERROR_CODES.has(code)) {
    return `TLS verification failed (${code}) — if the instance uses a self-signed or internal-CA certificate, add its CA certificate (PEM) to this account.`;
  }
  if (code) {
    return `${code} — could not reach the instance (check the base URL, DNS, VPN and firewall).`;
  }
  return error instanceof Error ? error.message : "unknown error";
}

/** `fetch` with the transport failure mapped to an actionable `AccountError`. */
async function dcFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new AccountError(502, `Bitbucket Server request failed: ${describeFetchFailure(error)}`);
  }
}

/** Authenticated DC REST call returning the decoded body + response headers. */
async function dcRequest(
  creds: ProviderCreds,
  method: string,
  path: string,
  body?: unknown,
  retry = 1
): Promise<{ data: any; headers: Headers }> {
  const dispatcher = await dispatcherFor(creds.caCertPath);
  const response = await dcFetch(`${base(creds)}${path}`, {
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
    return dcRequest(creds, method, path, body, retry - 1);
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
  return {
    data: response.status === 204 ? undefined : await response.json(),
    headers: response.headers
  };
}

/** Authenticated DC REST call; throws `DcHttpError` on a non-2xx. */
async function dc(
  creds: ProviderCreds,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  return (await dcRequest(creds, method, path, body)).data;
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
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/rest/api/1.0/application-properties`, {
      headers: { Accept: "application/json", "User-Agent": "orquester" },
      ...(dispatcher ? ({ dispatcher } as object) : {})
    });
  } catch (error) {
    // 400 (not 502): every failure here — untrusted certificate, wrong host —
    // is fixed by the user editing the connect form (CA field / base URL).
    throw new AccountError(400, `Could not reach the instance: ${describeFetchFailure(error)}`);
  }
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
 * Read the HTTPS + SSH clone URLs out of a DC `links.clone[]` array. DC labels
 * the HTTPS entry `name: "http"` even when the href is https; it omits the `ssh`
 * entry when the admin disabled SSH (→ HTTPS-only) and the `http` entry when the
 * admin disabled HTTP(S) SCM hosting instance-wide (→ SSH-only). Either
 * transport may therefore be absent. Credentials the API embeds in the href
 * (`https://jdoe@host/...`) are stripped — git gets them from the credential
 * store instead.
 */
function readCloneUrls(clone: Array<{ name: string; href: string }>): CloneUrls {
  const https = clone.find((entry) => entry.name === "http" || entry.name === "https")?.href;
  const ssh = clone.find((entry) => entry.name === "ssh")?.href;
  return { https: https ? https.replace(/^(https?:\/\/)[^@/]*@/, "$1") : undefined, ssh };
}

/**
 * `readCloneUrls` for callers that need a usable transport (the clone path).
 * Throws only when the repo exposes neither HTTPS nor SSH.
 */
export function pickCloneUrls(clone: Array<{ name: string; href: string }>): CloneUrls {
  const urls = readCloneUrls(clone);
  if (!urls.https && !urls.ssh) {
    throw new AccountError(502, "The repository exposes no clone URL (neither HTTP(S) nor SSH).");
  }
  return urls;
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
  // ssh:// URLs are anchored to the account's SSH host when one was resolved,
  // and otherwise to the instance host from `baseUrl` — a brand-new DC account
  // has no repo to read `sshHost` off yet, but our own repo picker still hands
  // out ssh:// URLs to clone. Any port on those hosts is accepted (DC's SSH
  // endpoint defaults to 7999 but admins move it).
  for (const host of sshCandidateHosts(ctx)) {
    const sshRe = new RegExp(
      `^ssh://(?:[^@/]+@)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::\\d+)?/(~?${part})/(${part}?)(?:\\.git)?$`,
      "i"
    );
    const match = trimmed.match(sshRe);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return null;
}

/** Hostnames an ssh:// clone URL for this account may legitimately point at. */
function sshCandidateHosts(ctx: UrlContext): string[] {
  const hosts: string[] = [];
  if (ctx.sshHost) {
    hosts.push(ctx.sshHost.split(":")[0]);
  }
  if (ctx.baseUrl) {
    try {
      hosts.push(new URL(ctx.baseUrl).hostname);
    } catch {
      /* unparseable baseUrl — the scm/browse patterns already rejected it */
    }
  }
  return [...new Set(hosts.filter(Boolean))];
}

/**
 * Map one DC repo JSON object to the wire `RepoSummary`, or `null` when the repo
 * exposes no clone transport at all. Deliberately non-throwing: one odd repo
 * must not fail the whole listing (and with it the repo picker).
 */
export function toServerRepoSummary(repo: any): RepoSummary | null {
  const projectKey: string = repo?.project?.key ?? "";
  const slug: string = repo?.slug ?? "";
  const { https, ssh } = readCloneUrls(repo?.links?.clone ?? []);
  const primary = ssh ?? https;
  if (!primary) {
    return null;
  }
  return {
    fullName: `${projectKey}/${slug}`,
    owner: projectKey,
    name: slug,
    private: repo?.public !== true,
    // HTTPS-only instances (SSH disabled) still need a usable clone URL here.
    sshUrl: primary,
    ...(https ? { httpsUrl: https } : {}),
    // DC's repo JSON carries no default branch (it needs a second call per repo).
    defaultBranch: "",
    description: repo?.description ?? null
  };
}

/**
 * Resolve the account login from DC's `X-AUSERNAME` response header (the user
 * the request was actually authenticated as), cross-checked against the username
 * the user typed. Throws when the token belongs to someone else, or when the
 * instance served the request anonymously (public instance + bad token).
 * Falls back to the typed username when the header is absent.
 */
export function resolveDcLogin(headerValue: string | null | undefined, typedUsername: string): string {
  if (!headerValue) {
    return typedUsername;
  }
  let authenticated = headerValue.trim();
  try {
    // DC percent-encodes non-ASCII usernames in the header.
    authenticated = decodeURIComponent(authenticated);
  } catch {
    /* not percent-encoded — use it verbatim */
  }
  if (!authenticated || authenticated.toLowerCase() === "anonymous") {
    throw new AccountError(
      400,
      "The instance served this request anonymously — the token was not accepted. Check that it is a valid HTTP access token for this instance."
    );
  }
  if (authenticated.toLowerCase() !== typedUsername.trim().toLowerCase()) {
    throw new AccountError(
      400,
      `This token authenticates as "${authenticated}", but the username entered is "${typedUsername}". Use that username, or a token belonging to "${typedUsername}".`
    );
  }
  return authenticated;
}

export const bitbucketServerProvider: GitProvider = {
  id: "bitbucket-server",
  scopesHint: SCOPES,

  /**
   * The identity comes from the *instance*, not from what the user typed: DC
   * echoes the authenticated user in `X-AUSERNAME` on every REST response, and
   * any authenticated user can read any other user's profile — so trusting the
   * typed username would happily create an account for "alice" out of Bob's
   * token (SSH key uploaded to Bob, HTTPS credential line rejected, and
   * `setToken`'s "this token authenticates as X" guard silently defeated).
   */
  async getIdentity(creds: ProviderCreds): Promise<ProviderIdentity> {
    if (!creds.username) {
      throw new AccountError(400, "The Bitbucket Server username is required.");
    }
    const { data: user, headers } = await dcRequest(
      creds,
      "GET",
      `/rest/api/1.0/users/${encodeURIComponent(creds.username)}`
    );
    const login = resolveDcLogin(headers.get("x-ausername"), creds.username);
    return {
      login,
      loginRef: user?.slug ?? login,
      name: user?.displayName ?? login,
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
    // A repo with no usable clone transport is skipped rather than failing the
    // whole listing (which would blank the repo picker for the account).
    return repos
      .map(toServerRepoSummary)
      .filter((repo): repo is RepoSummary => repo !== null);
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
    const summary = toServerRepoSummary(repo);
    if (!summary) {
      throw new AccountError(
        502,
        "The repository was created but exposes no clone URL (neither HTTP(S) nor SSH)."
      );
    }
    return summary;
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
