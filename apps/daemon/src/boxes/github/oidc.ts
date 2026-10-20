/**
 * GitHub Actions OIDC tokens (spec §5 "Authentication", §11.2): macOS runners
 * prove which dispatch they belong to with a JWT GitHub signs for the job, so the
 * control repo holds no secret.
 *
 * Where a runner sends it:
 * - Downloading `orq-agent`: `GET <daemonUrl>/api/boxes/agent/darwin-arm64` with
 *   `Authorization: GitHubOIDC <jwt>` and `X-Orq-Box-Id: <boxId>`
 *   ({@link GITHUB_OIDC_AUTH_SCHEME}, {@link BOX_ID_HEADER}, parsed by
 *   {@link parseGithubOidcAuthorization}).
 * - Connecting: `orq-agent` with `ORQ_GITHUB_OIDC=1` requests its own JWT from the
 *   runner (`ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=<daemon origin>`, bearer
 *   `ACTIONS_ID_TOKEN_REQUEST_TOKEN`) for every connect and sends it in `hello`
 *   as `{ kind: "github-oidc", boxId, jwt }`.
 *
 * In both cases the audience is the daemon's origin (`https://host[:port]`, no
 * path), and the daemon checks repository and run id against the dispatch it
 * recorded for the box (`StoredBox.providerRef`).
 */

import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

import type { GithubOidcExpectation, VerifyGithubOidc } from "../contracts.ts";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** `Authorization: GitHubOIDC <jwt>` on box-authenticated HTTP routes. */
export const GITHUB_OIDC_AUTH_SCHEME = "GitHubOIDC";
/** Names the box a GitHub OIDC request is for (the JWT itself only names the run). */
export const BOX_ID_HEADER = "X-Orq-Box-Id";

/** Clock skew tolerated on exp/nbf/iat. */
const CLOCK_SKEW_SECONDS = 60;
/** How long fetched signing keys are trusted before they are fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` refetches the keys (GitHub rotates them), at most this often. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** The JWT and box id from `Authorization: GitHubOIDC <jwt>` + `X-Orq-Box-Id`; null when the scheme differs. */
export function parseGithubOidcAuthorization(
  authorization: string | undefined,
  boxIdHeader: string | undefined
): { jwt: string; boxId: string } | null {
  if (authorization === undefined || boxIdHeader === undefined) return null;
  const match = /^GitHubOIDC\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization.trim());
  const boxId = boxIdHeader.trim();
  if (!match || !/^[A-Za-z0-9-]{8,64}$/.test(boxId)) return null;
  return { jwt: match[1]!, boxId };
}

/** The daemon origin used as audience, from a daemon URL that may carry a base path. */
export function githubOidcAudience(daemonUrl: string): string {
  return new URL(daemonUrl).origin;
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signedData: Buffer;
  signature: Buffer;
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error("not base64url");
  return Buffer.from(segment, "base64url");
}

function parseJwt(jwt: string): JwtParts | null {
  const segments = jwt.split(".");
  if (segments.length !== 3) return null;
  try {
    const header = JSON.parse(decodeSegment(segments[0]!).toString("utf8")) as unknown;
    const payload = JSON.parse(decodeSegment(segments[1]!).toString("utf8")) as unknown;
    if (typeof header !== "object" || header === null || typeof payload !== "object" || payload === null) return null;
    return {
      header: header as Record<string, unknown>,
      payload: payload as Record<string, unknown>,
      signedData: Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
      signature: decodeSegment(segments[2]!)
    };
  } catch {
    return null;
  }
}

interface KeyCache {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  inflight: Promise<Map<string, KeyObject>> | null;
}

async function fetchJson(doFetch: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await doFetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
  });
  if (!response.ok) throw new Error(`GitHub OIDC: ${url} answered HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

async function loadKeys(issuer: string, doFetch: typeof fetch, signal: AbortSignal): Promise<Map<string, KeyObject>> {
  const config = (await fetchJson(doFetch, `${issuer}/.well-known/openid-configuration`, signal)) as { jwks_uri?: unknown };
  const jwksUri = config.jwks_uri;
  // The keys must come from the issuer's own host.
  if (typeof jwksUri !== "string" || new URL(jwksUri).origin !== new URL(issuer).origin) {
    throw new Error("GitHub OIDC: the discovery document has no usable jwks_uri");
  }
  const jwks = (await fetchJson(doFetch, jwksUri, signal)) as { keys?: unknown };
  if (!Array.isArray(jwks.keys)) throw new Error("GitHub OIDC: the JWKS has no keys");
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks.keys as Array<Record<string, unknown>>) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" }));
    } catch {
      // A malformed key is skipped; tokens signed with it fail as "unknown key".
    }
  }
  return keys;
}

function claimString(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function checkClaims(
  payload: Record<string, unknown>,
  expectation: GithubOidcExpectation,
  issuer: string,
  nowSeconds: number
): string | null {
  if (payload.iss !== issuer) return "the token was not issued by GitHub Actions";
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expectation.audience)) return "the token's audience is not this daemon";
  const exp = payload.exp;
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS < nowSeconds) return "the token has expired";
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) {
    return "the token is not valid yet";
  }
  if (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_SECONDS > nowSeconds) return "the token was issued in the future";
  const repository = claimString(payload, "repository");
  if (repository === null || repository.toLowerCase() !== expectation.repository.toLowerCase()) {
    return "the token is for a different repository";
  }
  if (claimString(payload, "run_id") !== expectation.runId) return "the token is for a different workflow run";
  return null;
}

export interface GithubOidcVerifierOptions {
  /** Default {@link GITHUB_OIDC_ISSUER}. */
  issuer?: string;
}

/**
 * A `VerifyGithubOidc` with its own signing-key cache (discovery → JWKS, cached
 * for an hour, refetched early when a token names an unknown key). Failure
 * messages never quote the token.
 */
export function createGithubOidcVerifier(options: GithubOidcVerifierOptions = {}): VerifyGithubOidc {
  const issuer = (options.issuer ?? GITHUB_OIDC_ISSUER).replace(/\/+$/, "");
  const cache: KeyCache = { keys: new Map(), fetchedAt: 0, inflight: null };

  const refresh = (doFetch: typeof fetch, signal: AbortSignal, now: number): Promise<Map<string, KeyObject>> => {
    cache.inflight ??= loadKeys(issuer, doFetch, signal)
      .then((keys) => {
        cache.keys = keys;
        cache.fetchedAt = now;
        return keys;
      })
      .finally(() => {
        cache.inflight = null;
      });
    return cache.inflight;
  };

  return async (jwt, expectation, callOptions) => {
    const now = (callOptions.now ?? Date.now)();
    const doFetch = callOptions.fetch ?? fetch;
    const parts = parseJwt(jwt);
    if (parts === null) return { ok: false, message: "not a JWT" };
    if (parts.header.alg !== "RS256") return { ok: false, message: "unsupported token algorithm" };
    const kid = parts.header.kid;
    if (typeof kid !== "string") return { ok: false, message: "the token names no signing key" };

    let key = now - cache.fetchedAt < JWKS_TTL_MS ? cache.keys.get(kid) : undefined;
    if (key === undefined && (now - cache.fetchedAt >= JWKS_MIN_REFETCH_MS || cache.keys.size === 0)) {
      try {
        key = (await refresh(doFetch, callOptions.signal, now)).get(kid);
      } catch (error) {
        if (callOptions.signal.aborted) throw callOptions.signal.reason;
        return { ok: false, message: `could not fetch GitHub's signing keys: ${(error as Error).message}` };
      }
    }
    if (key === undefined) return { ok: false, message: "the token is signed with an unknown key" };

    if (!verifySignature("RSA-SHA256", parts.signedData, key, parts.signature)) {
      return { ok: false, message: "the token signature is invalid" };
    }
    const problem = checkClaims(parts.payload, expectation, issuer, Math.floor(now / 1000));
    return problem === null ? { ok: true } : { ok: false, message: problem };
  };
}

/** The daemon-wide verifier (one key cache). */
export const verifyGithubOidc: VerifyGithubOidc = createGithubOidcVerifier();
