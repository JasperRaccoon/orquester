import type { OwnerSummary, RepoSummary } from "@orquester/api";

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
export const CLOUD_GIT_USERNAME = "x-bitbucket-api-token-auth";

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

/** Authenticated Bitbucket Cloud REST call; throws AccountError on a non-2xx. */
async function bb(
  creds: ProviderCreds,
  method: string,
  pathOrUrl: string,
  body?: unknown,
  retry = 2
): Promise<Json | undefined> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
      "User-Agent": "orquester",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && retry > 0) {
    // Bitbucket REST has a ~1,000 req/h floor — back off and retry.
    await sleep((3 - retry) * 2000);
    return bb(creds, method, pathOrUrl, body, retry - 1);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    const hint =
      res.status === 401 || res.status === 403
        ? ` (use a SCOPED Atlassian API token — plain tokens fail; scopes: ${SCOPES}; REST username is your Atlassian account EMAIL)`
        : "";
    throw new AccountError(
      res.status === 401 || res.status === 403 ? 400 : 502,
      `Bitbucket ${method} ${pathOrUrl} → ${res.status}${hint}. ${text}`
    );
  }
  return res.status === 204 ? undefined : ((await res.json()) as Json);
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
export function toCloudRepoSummary(repo: Json): RepoSummary {
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

/** Parse `https://bitbucket.org/ws/r`, `git@[ssh.]bitbucket.org:ws/r.git`, or `ws/r`. */
export function parseCloudRepoUrl(input: string): ParsedRepo | null {
  const part = "[A-Za-z0-9._-]+";
  const httpsRe = new RegExp(`^https?://bitbucket\\.org/(${part})/(${part}?)(?:\\.git)?/?$`, "i");
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

/** The first two fields of an OpenSSH public key ("<type> <base64>"). */
function keyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
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
      if (error instanceof AccountError && /409/.test(error.message)) {
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
    const workspaces = await bbAll(creds, "/user/workspaces");
    const out: RepoSummary[] = [];
    for (const workspace of workspaces) {
      const slug = str(workspace.slug);
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
  },

  async listOwners(creds): Promise<OwnerSummary[]> {
    const workspaces = await bbAll(creds, "/user/workspaces");
    const owners: OwnerSummary[] = [];
    for (const workspace of workspaces) {
      const slug = str(workspace.slug);
      if (slug) {
        owners.push({ id: slug, label: str(workspace.name) ?? slug, kind: "workspace" });
      }
    }
    return owners;
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
  }
};
