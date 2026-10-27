/**
 * Tailscale for boxes (spec §6), over the Tailscale API v2 with either an API
 * access token (`tskey-api-…`, used as a bearer) or an OAuth client (client
 * credentials → access token, cached until shortly before it expires).
 *
 * - {@link TailscaleKeys.mintAuthKey}: a single-use, pre-authorized, ephemeral auth
 *   key tagged `tag:orq-box`; the box joins with `--hostname orq-<boxId>`.
 * - {@link TailscaleKeys.removeNode}: deletes the box's node(s) by that hostname
 *   (only nodes carrying `tag:orq-box`).
 * - `checkTailnetPolicy()` / {@link policySnippet}: whether the owner's policy
 *   declares the tag and restricts it, and the snippet the settings page shows.
 *   Orquester never edits the policy.
 *
 * Credentials and minted keys never appear in errors or logs.
 */

import type { TailscaleKeys } from "../contracts.ts";
import { providerRequest } from "../providers/http.ts";

export const TAILSCALE_BOX_TAG = "tag:orq-box";
const PROVIDER = "Tailscale";
const DEFAULT_API = "https://api.tailscale.com";
/** Refresh an OAuth access token this long before it expires. */
const OAUTH_EXPIRY_MARGIN_MS = 60_000;
/** Tailscale caps key descriptions at 50 characters. */
const DESCRIPTION_MAX = 50;

export type TailscaleCredentials = { apiToken: string } | { oauthClientId: string; oauthClientSecret: string };

export interface TailscaleKeysDeps {
  /** Read on every call, so credential changes in the settings take effect at once. */
  credentials: () => TailscaleCredentials | null;
  /** Default `-` (the credentials' own tailnet). */
  tailnet?: string;
  /** Default https://api.tailscale.com. */
  apiUrl?: string;
}

export interface TailnetPolicyCheck {
  /** `tagOwners` declares `tag:orq-box`. */
  tagOwner: boolean;
  /** A grant (or ACL) lets `tag:orq-box` reach specific destinations, not everything. */
  boxGrant: boolean;
  /** A rule lets `tag:orq-box` (directly or via `*`) reach every destination. */
  unrestricted: boolean;
  /** One line for the settings page. */
  message: string;
}

export interface TailscaleKeysService extends TailscaleKeys {
  /** Delete an auth key by id (cleanup of a key a box never used). Missing keys resolve. */
  deleteAuthKey(options: { keyId: string; signal: AbortSignal }): Promise<void>;
  /** Mint like {@link TailscaleKeys.mintAuthKey} and also return the key's id and expiry. */
  mintAuthKeyDetailed(options: { boxId: string; ttlSeconds: number; signal: AbortSignal }): Promise<{ id: string; key: string; expires: string | null }>;
  checkTailnetPolicy(options: { signal: AbortSignal }): Promise<TailnetPolicyCheck>;
  /** A cheap authenticated read (lists keys) to validate stored credentials; never throws for bad ones. */
  validate(options: { signal: AbortSignal }): Promise<{ ok: true } | { ok: false; message: string }>;
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Whether a source list includes boxes: the tag itself or `*`. */
function coversBoxes(sources: string[]): boolean {
  return sources.includes(TAILSCALE_BOX_TAG) || sources.includes("*");
}

/** Whether a destination list is "everything". ACL destinations are `host:port`; grants use `dst` + `ip`. */
function everywhere(destinations: string[]): boolean {
  return destinations.some((destination) => destination === "*" || destination === "*:*");
}

/** Evaluate a policy (JSON form of the HuJSON file). */
function evaluateTailnetPolicy(policy: Record<string, unknown>): TailnetPolicyCheck {
  const tagOwners = (policy.tagOwners ?? {}) as Record<string, unknown>;
  const tagOwner = Object.prototype.hasOwnProperty.call(tagOwners, TAILSCALE_BOX_TAG);
  let boxGrant = false;
  let unrestricted = false;
  for (const grant of Array.isArray(policy.grants) ? (policy.grants as Array<Record<string, unknown>>) : []) {
    const sources = toStringList(grant.src);
    if (!coversBoxes(sources)) continue;
    if (everywhere(toStringList(grant.dst))) unrestricted = true;
    else if (sources.includes(TAILSCALE_BOX_TAG)) boxGrant = true;
  }
  for (const acl of Array.isArray(policy.acls) ? (policy.acls as Array<Record<string, unknown>>) : []) {
    if (acl.action !== undefined && acl.action !== "accept") continue;
    const sources = toStringList(acl.src);
    if (!coversBoxes(sources)) continue;
    if (everywhere(toStringList(acl.dst))) unrestricted = true;
    else if (sources.includes(TAILSCALE_BOX_TAG)) boxGrant = true;
  }
  let message: string;
  if (!tagOwner) message = `The tailnet policy does not declare ${TAILSCALE_BOX_TAG} in tagOwners; paste the snippet below.`;
  else if (unrestricted) message = `The tailnet policy lets ${TAILSCALE_BOX_TAG} reach every device; restrict it with the grant below.`;
  else if (!boxGrant) message = `The tailnet policy has no grant for ${TAILSCALE_BOX_TAG}; boxes cannot reach the daemon yet.`;
  else message = `The tailnet policy declares ${TAILSCALE_BOX_TAG} and restricts what it can reach.`;
  return { tagOwner, boxGrant, unrestricted, message };
}

/**
 * The policy snippet for the settings page: declare the tag, name the daemon host, and grant
 * boxes only the daemon's ports. Merge it into the existing `hosts`, `tagOwners` and `grants`.
 */
export function policySnippet(daemonHostAlias: string, ports: readonly number[], daemonTailnetIp?: string | null): string {
  const alias = /^[a-z0-9][a-z0-9-]*$/i.test(daemonHostAlias) ? daemonHostAlias : "orq-host";
  const ip = daemonTailnetIp && /^[0-9a-f:.]+$/i.test(daemonTailnetIp) ? daemonTailnetIp : "<this machine's Tailscale IP, 100.x.y.z>";
  const portList = (ports.length > 0 ? ports : [443]).map((port) => `"tcp:${port}"`).join(", ");
  return `// Orquester: the daemon host, for box VMs.
"hosts": {
  "${alias}": "${ip}",
},

// Orquester: box VMs join tagged ${TAILSCALE_BOX_TAG}.
"tagOwners": {
  "${TAILSCALE_BOX_TAG}": ["autogroup:admin"],
},

"grants": [
  // Orquester box VMs may only reach the Orquester daemon.
  {"src": ["${TAILSCALE_BOX_TAG}"], "dst": ["${alias}"], "ip": [${portList}]},
  // If a rule has "src": ["*"], change it to ["autogroup:member"] so boxes stay restricted.
],`;
}

export function createTailscaleKeys(deps: TailscaleKeysDeps): TailscaleKeysService {
  const apiUrl = (deps.apiUrl ?? DEFAULT_API).replace(/\/+$/, "");
  const tailnet = encodeURIComponent(deps.tailnet ?? "-");
  let oauthCache: { clientId: string; token: string; expiresAt: number } | null = null;

  const credentials = (): TailscaleCredentials => {
    const value = deps.credentials();
    if (value === null) throw new Error("Tailscale is not configured");
    return value;
  };

  const accessToken = async (signal: AbortSignal): Promise<string> => {
    const creds = credentials();
    if ("apiToken" in creds) return creds.apiToken;
    if (oauthCache !== null && oauthCache.clientId === creds.oauthClientId && oauthCache.expiresAt - OAUTH_EXPIRY_MARGIN_MS > Date.now()) {
      return oauthCache.token;
    }
    const body = new URLSearchParams({
      client_id: creds.oauthClientId,
      client_secret: creds.oauthClientSecret,
      grant_type: "client_credentials"
    }).toString();
    const response = await providerRequest<{ access_token?: string; expires_in?: number }>(
      PROVIDER,
      {
        method: "POST",
        url: `${apiUrl}/api/v2/oauth/token`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      },
      { signal }
    );
    const token = response.data?.access_token;
    if (typeof token !== "string" || token.length === 0) throw new Error("Tailscale: the OAuth token response had no access token");
    const expiresIn = typeof response.data.expires_in === "number" ? response.data.expires_in : 3600;
    oauthCache = { clientId: creds.oauthClientId, token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  };

  const api = async <T>(
    signal: AbortSignal,
    request: { method?: "GET" | "POST" | "DELETE"; path: string; body?: unknown; okStatuses?: readonly number[]; attempts?: number; accept?: string }
  ): Promise<{ status: number; data: T }> => {
    const token = await accessToken(signal);
    const call = async (): Promise<{ status: number; data: T }> =>
      providerRequest<T>(
        PROVIDER,
        {
          method: request.method ?? "GET",
          url: `${apiUrl}${request.path}`,
          headers: { Authorization: `Bearer ${token}`, ...(request.accept ? { Accept: request.accept } : {}) },
          body: request.body,
          okStatuses: request.okStatuses,
          attempts: request.attempts
        },
        { signal }
      );
    try {
      return await call();
    } catch (error) {
      // A revoked or expired cached OAuth token: forget it so the next call mints a new one.
      if ((error as { status?: number }).status === 401) oauthCache = null;
      throw error;
    }
  };

  const mintAuthKeyDetailed: TailscaleKeysService["mintAuthKeyDetailed"] = async ({ boxId, ttlSeconds, signal }) => {
    const response = await api<{ id?: string; key?: string; expires?: string }>(signal, {
      method: "POST",
      path: `/api/v2/tailnet/${tailnet}/keys`,
      body: {
        capabilities: {
          devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [TAILSCALE_BOX_TAG] } }
        },
        expirySeconds: Math.max(60, Math.floor(ttlSeconds)),
        description: `orq box ${boxId}`.slice(0, DESCRIPTION_MAX)
      },
      // Not idempotent: a retried create could leave a second live key.
      attempts: 1
    });
    const { id, key } = response.data ?? {};
    if (typeof id !== "string" || typeof key !== "string") throw new Error("Tailscale: the key response had no key");
    return { id, key, expires: response.data.expires ?? null };
  };

  return {
    mintAuthKeyDetailed,

    async mintAuthKey(options) {
      return (await mintAuthKeyDetailed(options)).key;
    },

    async deleteAuthKey({ keyId, signal }) {
      await api(signal, { method: "DELETE", path: `/api/v2/tailnet/${tailnet}/keys/${encodeURIComponent(keyId)}`, okStatuses: [404] });
    },

    async removeNode({ boxId, signal }) {
      const hostname = `orq-${boxId}`;
      const response = await api<{ devices?: Array<Record<string, unknown>> }>(signal, { path: `/api/v2/tailnet/${tailnet}/devices` });
      const matches = (response.data?.devices ?? []).filter((device) => {
        const name = typeof device.name === "string" ? device.name : "";
        const named = device.hostname === hostname || name === hostname || name.startsWith(`${hostname}.`);
        // Only ever delete box nodes: a device without the tag is someone's machine.
        return named && toStringList(device.tags).includes(TAILSCALE_BOX_TAG);
      });
      for (const device of matches) {
        const id = typeof device.nodeId === "string" ? device.nodeId : typeof device.id === "string" ? device.id : null;
        if (id === null) continue;
        await api(signal, { method: "DELETE", path: `/api/v2/device/${encodeURIComponent(id)}`, okStatuses: [404] });
      }
    },

    async checkTailnetPolicy({ signal }) {
      const response = await api<Record<string, unknown>>(signal, { path: `/api/v2/tailnet/${tailnet}/acl`, accept: "application/json" });
      if (typeof response.data !== "object" || response.data === null) throw new Error("Tailscale: the policy file is not JSON");
      return evaluateTailnetPolicy(response.data);
    },

    async validate({ signal }) {
      try {
        await api(signal, { path: `/api/v2/tailnet/${tailnet}/keys` });
        return { ok: true };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) return { ok: false, message: "Tailscale rejected the credentials (or they lack the auth_keys scope)" };
        return { ok: false, message: (error as Error).message };
      }
    }
  };
}
