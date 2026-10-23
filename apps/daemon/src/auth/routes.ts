/**
 * Auth routes of both transports (`authRoutes`, `@orquester/api`):
 *
 * - `info` and `login` are public on the remote transport (the bearer hook lets them through);
 *   everything else is gated there like any `/api` route. Over the unix socket all of them work
 *   without a token, and there is no "current" session.
 * - `login` and `verifyPassword` bcrypt-check a password. Each wrong guess counts against the
 *   per-IP password throttle (no burst collapse), and one IP runs at most one check at a time, so
 *   parallel guesses cannot outrun the count.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authRoutes,
  type AuthIssuedTokenResponse,
  type AuthLoginRequest,
  type AuthSessionsResponse,
  type CreateApiTokenRequest,
  type RevokeAuthSessionsResponse,
  type VerifyPasswordRequest,
  type VerifyPasswordResponse
} from "@orquester/api";

import { AuthSessionsUnavailableError, StalePasswordError, cleanLabel, deviceLabelFromUserAgent, type AuthSessionStore, type VerifiedAuthSession } from "./sessions.ts";
import { clientIp, type LoginThrottle } from "./throttle.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The remote bearer's session (the bearer hook); null over the unix socket and on public routes. */
    authSession: VerifiedAuthSession | null;
  }
}

/** Longest password the routes accept (bcrypt reads only the first 72 bytes anyway). */
const PASSWORD_MAX = 1024;

export interface AuthRouteDeps {
  mode: "local" | "remote";
  store: AuthSessionStore;
  /** Wrong password guesses, per IP. Distinct from the bearer hook's throttle. */
  passwordThrottle: LoginThrottle;
  /** The live credential (read per request: a config save replaces it). */
  credentials: () => { username: string; passwordHash: string | undefined };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Whether `username` and `password` match, with no early return: the username compare and the
 * bcrypt check always both run, so a wrong username is indistinguishable from a wrong password.
 */
async function passwordMatches(
  credentials: { username: string; passwordHash: string | undefined },
  username: string | undefined,
  password: string,
  checkUsername: boolean
): Promise<boolean> {
  if (!credentials.passwordHash) return false;
  const userOk = timingSafeEqual(sha256((username ?? "").trim().toLowerCase()), sha256(credentials.username));
  const passOk = await bcrypt.compare(password, credentials.passwordHash).catch(() => false);
  return (userOk || !checkUsername) && passOk;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const checking = new Set<string>();

  /**
   * Run one password check for the request's IP: refused (429) while the IP is locked out or
   * already has one in flight; a `false` result counts as a failure, a `true` one clears the IP.
   */
  const guarded = async (
    request: FastifyRequest,
    reply: FastifyReply,
    check: () => Promise<boolean>
  ): Promise<boolean | null> => {
    const ip = clientIp(request);
    const retryAfterMs = deps.passwordThrottle.retryAfterMs(ip);
    if (retryAfterMs > 0 || checking.has(ip)) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      await reply.code(429).send({ code: "TOO_MANY_ATTEMPTS", message: "Too many failed password attempts. Try again later." });
      return null;
    }
    checking.add(ip);
    try {
      const ok = await check();
      if (ok) deps.passwordThrottle.recordSuccess(ip);
      else deps.passwordThrottle.recordFailure(ip, true);
      return ok;
    } finally {
      checking.delete(ip);
    }
  };

  app.get(authRoutes.info, async () => {
    const authRequired = deps.mode === "remote" && Boolean(deps.credentials().passwordHash);
    return { authRequired, requiresUsername: authRequired };
  });

  app.post<{ Body: AuthLoginRequest }>(authRoutes.login, async (request, reply): Promise<AuthIssuedTokenResponse | void> => {
    const body = (request.body ?? {}) as Partial<AuthLoginRequest>;
    if (typeof body.password !== "string" || body.password.length === 0 || body.password.length > PASSWORD_MAX || (body.username !== undefined && typeof body.username !== "string")) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "`password` (and an optional `username`) must be strings." });
    }
    const credentials = deps.credentials();
    if (!credentials.passwordHash) {
      return reply.code(409).send({ code: "AUTH_DISABLED", message: "No password is set for remote access." });
    }
    const password = body.password;
    const ok = await guarded(request, reply, () => passwordMatches(credentials, body.username, password, true));
    if (ok === null) return;
    if (!ok) {
      return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: "Incorrect username or password." });
    }
    try {
      const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined;
      // Bound to the hash bcrypt checked: a password change that landed meanwhile refuses it.
      return await deps.store.create("device", cleanLabel(body.label, deviceLabelFromUserAgent(userAgent)), credentials.passwordHash);
    } catch (error) {
      if (error instanceof StalePasswordError) {
        return reply.code(401).send({ code: "INVALID_CREDENTIALS", message: error.message });
      }
      if (error instanceof AuthSessionsUnavailableError) {
        return reply.code(503).send({ code: "AUTH_SESSIONS_UNAVAILABLE", message: error.message });
      }
      throw error;
    }
  });

  app.post(authRoutes.logout, async (request, reply) => {
    if (request.authSession) await deps.store.revoke(request.authSession.id);
    return reply.code(204).send();
  });

  app.post<{ Body: VerifyPasswordRequest }>(authRoutes.verifyPassword, async (request, reply): Promise<VerifyPasswordResponse | void> => {
    const password = (request.body as Partial<VerifyPasswordRequest> | undefined)?.password;
    if (typeof password !== "string" || password.length > PASSWORD_MAX) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "`password` must be a string." });
    }
    const credentials = deps.credentials();
    if (!credentials.passwordHash) return { ok: false };
    // A wrong retype answers `ok: false`, never 401: the caller's session is still good.
    const ok = await guarded(request, reply, () => passwordMatches(credentials, undefined, password, false));
    if (ok === null) return;
    return { ok };
  });

  app.get(authRoutes.sessions, async (request): Promise<AuthSessionsResponse> => ({
    sessions: deps.store.list(request.authSession?.id ?? null)
  }));

  app.post(authRoutes.revokeOthers, async (request): Promise<RevokeAuthSessionsResponse> => ({
    revoked: await deps.store.revokeAllExcept(request.authSession?.id ?? null)
  }));

  app.delete<{ Params: { id: string } }>(`${authRoutes.sessions}/:id`, async (request, reply) => {
    if (!(await deps.store.revoke(request.params.id))) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "No such session." });
    }
    return reply.code(204).send();
  });

  app.post<{ Body: CreateApiTokenRequest }>(authRoutes.tokens, async (request, reply): Promise<AuthIssuedTokenResponse | void> => {
    const label = (request.body as Partial<CreateApiTokenRequest> | undefined)?.label;
    if (typeof label !== "string" || !label.trim()) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Name the token (`label`)." });
    }
    try {
      return await deps.store.create("api", label);
    } catch (error) {
      if (error instanceof AuthSessionsUnavailableError) {
        return reply.code(503).send({ code: "AUTH_SESSIONS_UNAVAILABLE", message: error.message });
      }
      throw error;
    }
  });
}
