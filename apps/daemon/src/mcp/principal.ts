/**
 * The principal plumbing (unified MCP design 2026-10-15; `@orquester/api` `agent-chat/principal.ts`
 * is the contract): ONE process-wide `nonce → {principal, expiresAt}` registry, the `onRequest` hook
 * both Fastify apps install, the external `/mcp` credential id, and the remote transport's
 * stripping of socket-trusted body fields.
 *
 * Who is which principal:
 * - `agent` — minted by the catalog executor (`executor.ts`) for every daemon request a chat
 *   caller's tool makes (`DaemonApi.request(…, {principal})`).
 * - `external` — minted by the external `/mcp` transport (`server.ts`) for every daemon request an
 *   external MCP client's tool call makes, with {@link externalCredentialId}.
 * - `user` — every request WITHOUT a token: the GUI on either app, a local CLI on the socket, the
 *   daemon's own workers through the internal client, and a remote client calling the REST API
 *   directly with the bearer (not through `/mcp` tools). That last one is the user acting: the
 *   bearer is the user's own credential, and only tool calls through `/mcp` are an external agent.
 *
 * Token rules (hard): ≥ 128 bits from `crypto.randomBytes`, base64url; single use (consumed on the
 * first resolve, deleted by the minter in a `finally`); 30 s from minting to resolve; never
 * logged, echoed, stored or forwarded — the registry keys are the only copy, and nothing here logs;
 * a request that carries the header with an unknown, used or expired token is refused 401
 * `PRINCIPAL_TOKEN_INVALID`, never downgraded to `user`.
 */

import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  agentChatCommandPath,
  agentChatRoutes,
  PRINCIPAL_TOKEN_HEADER,
  PRINCIPAL_TOKEN_INVALID,
  PRINCIPAL_TOKEN_MIN_BYTES,
  PRINCIPAL_TOKEN_TTL_MS,
  stripRemoteInterruptFields,
  stripRemoteMergeBackFields,
  stripRemoteTurnFields,
  USER_PRINCIPAL,
  type CallerPrincipal
} from "@orquester/api/agent-chat";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is acting (`registerPrincipalHook`): `user` unless a live in-process token says otherwise. */
    principal: CallerPrincipal;
  }
}

interface Entry {
  principal: CallerPrincipal;
  expiresAt: number;
}

/** The registry. Process-wide on purpose: both apps resolve against the same nonces. */
const live = new Map<string, Entry>();

/** The clock; tests swap it ({@link setPrincipalClockForTests}). */
let clock: () => number = Date.now;

/** Drop every expired entry (cheap: the registry holds only in-flight requests). */
function sweep(now: number): void {
  for (const [token, entry] of live) {
    if (entry.expiresAt <= now) live.delete(token);
  }
}

/**
 * Mint a single-use token for `principal`. The caller sends it in {@link PRINCIPAL_TOKEN_HEADER}
 * and MUST call `release()` in a `finally` once its request settled, resolved or not.
 */
export function mintPrincipalToken(principal: CallerPrincipal): { token: string; release(): void } {
  const now = clock();
  sweep(now);
  const token = randomBytes(PRINCIPAL_TOKEN_MIN_BYTES).toString("base64url");
  // A copy: the minter's object can never change what a route reads.
  live.set(token, { principal: structuredClone(principal), expiresAt: now + PRINCIPAL_TOKEN_TTL_MS });
  return { token, release: () => void live.delete(token) };
}

/** Consume `token`: its principal when live, else null. A token resolves at most once. */
export function resolvePrincipalToken(token: string): CallerPrincipal | null {
  const entry = live.get(token);
  if (entry === undefined) return null;
  live.delete(token);
  if (entry.expiresAt <= clock()) return null;
  return entry.principal;
}

/** How many tokens are outstanding (tests: every minter releases its token). */
export function livePrincipalTokenCount(): number {
  return live.size;
}

/** Tests only: a fake clock for expiry. */
export function setPrincipalClockForTests(now: (() => number) | null): void {
  clock = now ?? Date.now;
}

/**
 * Decorate `request.principal` and resolve the token header on EVERY request of `app`. Install it
 * on both apps, after the bearer hook (an unauthenticated request never reaches the registry).
 * The header is removed once read, so nothing downstream — a proxy to the agent host, a log — can
 * see it.
 */
export function registerPrincipalHook(app: FastifyInstance): void {
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    const raw = request.headers[PRINCIPAL_TOKEN_HEADER];
    request.principal = USER_PRINCIPAL;
    if (raw === undefined) return;
    delete request.headers[PRINCIPAL_TOKEN_HEADER];
    const principal = typeof raw === "string" ? resolvePrincipalToken(raw) : null;
    if (principal === null) {
      // Never echo the token, never say which rule it failed.
      return reply.code(401).send({ code: PRINCIPAL_TOKEN_INVALID, message: "The request's principal token is not valid." });
    }
    request.principal = principal;
  });
}

/**
 * The external MCP credential's stable id (`CallerPrincipal.external.credentialId`): a hash of
 * the credential's IDENTITY (the configured username), never of the bearer or its secret half —
 * the same for every bearer that authenticates as that user, and useless to anyone who reads it.
 */
export function externalCredentialId(username: string | undefined | null): string {
  return `cred_${createHash("sha256").update(`orquester-external-mcp-credential\u0000${username ?? ""}`).digest("hex").slice(0, 24)}`;
}

/** The route patterns whose socket-trusted body fields the remote transport strips. */
const TURN_ROUTE = decodeURIComponent(agentChatCommandPath(":id", "turn"));
const MERGE_BACK_ROUTE = decodeURIComponent(agentChatRoutes.mergeBack(":id"));
const INTERRUPT_ROUTE = decodeURIComponent(agentChatCommandPath(":id", "interrupt"));

const isObjectBody = (body: unknown): body is object => body !== null && typeof body === "object" && !Array.isArray(body);

/**
 * Remote transport only: remove the socket-trusted fields (`causedBy`, an interrupt's `cause`) from
 * turn, merge-back and interrupt bodies before any route sees them (`stripRemoteTurnFields`,
 * `stripRemoteMergeBackFields`, `stripRemoteInterruptFields`).
 * Applies to every request on the remote app — the GUI, a direct REST client, and the external
 * `/mcp`'s own in-process calls (external turns start a fresh exchange, spec §13).
 */
export function registerRemoteFieldStripping(app: FastifyInstance): void {
  app.addHook("preValidation", async (request: FastifyRequest) => {
    if (request.method !== "POST" || !isObjectBody(request.body)) return;
    const route = request.routeOptions.url;
    if (route === TURN_ROUTE) request.body = stripRemoteTurnFields(request.body);
    else if (route === MERGE_BACK_ROUTE) request.body = stripRemoteMergeBackFields(request.body);
    else if (route === INTERRUPT_ROUTE) request.body = stripRemoteInterruptFields(request.body);
  });
}
