/**
 * Auth routes of both transports (`authRoutes`, `@orquester/api`):
 *
 * - `info` and `login` are public on the remote transport (the bearer hook lets them through);
 *   everything else is gated there like any `/api` route. Over the unix socket all of them work
 *   without a token, and there is no "current" session.
 * - `login` and `verifyPassword` bcrypt-check a password. Each wrong guess counts against the
 *   per-IP password throttle (no burst collapse), and one IP runs at most one check at a time, so
 *   parallel guesses cannot outrun the count.
 * - Second factor (design 2026-11-22-login-second-factor): while it is on, a correct password at
 *   `login` (remote transport) answers a challenge, and `secondFactorLogin` trades the challenge
 *   plus a code for the token. Wrong codes have their own counters, which a correct password never
 *   clears: per IP (5 → 15 min doubling to 24 h), across every IP ({@link GLOBAL_CODE_MAX_FAILS}),
 *   and per challenge ({@link CHALLENGE_MAX_ATTEMPTS}). Every lockout guards only the public sign-in
 *   steps: bearer requests, streams, WebSockets and `/mcp` never consult them, and the bearer-gated
 *   management routes ignore the global one, so a signed-in owner can always turn the factor off.
 * - The management routes and API-token minting re-prove the owner on the remote transport
 *   (password, and a code while the factor is on); a wrong proof is 403 `INVALID_PROOF`, never 401.
 *   Over the unix socket no proof is asked for.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  authErrorCodes,
  authRoutes,
  type AuthIssuedTokenResponse,
  type AuthLoginRequest,
  type AuthLoginResponse,
  type AuthRecoveryCodesResponse,
  type AuthSecondFactorChallenge,
  type AuthSecondFactorEnableRequest,
  type AuthSecondFactorLoginRequest,
  type AuthSecondFactorProof,
  type AuthSecondFactorSetupRequest,
  type AuthSecondFactorSetupResponse,
  type AuthSecondFactorStatusResponse,
  type AuthSessionsResponse,
  type CreateApiTokenRequest,
  type RevokeAuthSessionsResponse,
  type VerifyPasswordRequest,
  type VerifyPasswordResponse
} from "@orquester/api";

import { AuthSessionsUnavailableError, StalePasswordError, cleanLabel, deviceLabelFromUserAgent, type AuthSessionStore, type VerifiedAuthSession } from "./sessions.ts";
import { SecondFactorUnavailableError, type SecondFactorStore } from "./second-factor.ts";
import { LoginThrottle, clientIp } from "./throttle.ts";
import { generateTotpSecret, otpauthUri } from "./totp.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The remote bearer's session (the bearer hook); null over the unix socket and on public routes. */
    authSession: VerifiedAuthSession | null;
  }
}

/** Longest password the routes accept (bcrypt reads only the first 72 bytes anyway). */
const PASSWORD_MAX = 1024;
/** Longest code accepted (a recovery code with generous spacing). */
const CODE_MAX = 64;
/** A second-factor challenge lives this long after the password. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong codes one challenge takes before it is void. */
const CHALLENGE_MAX_ATTEMPTS = 5;
/** Pending challenges kept at most (only a correct password makes one); the oldest go first. */
const CHALLENGES_MAX = 256;
/** Wrong sign-in codes from every IP together that lock all public code entry (15 min doubling). */
const GLOBAL_CODE_MAX_FAILS = 20;
/** The global code counter's single key. */
const EVERY_IP = "*";
/** A pending enrollment's secret lives this long in memory. */
const PENDING_SETUP_TTL_MS = 10 * 60 * 1000;
/** The pending-enrollment key of the unix socket (which has no session). */
const LOCAL_SETUP_KEY = "unix-socket";

interface Challenge {
  ip: string;
  /** The bcrypt hash the password was checked against: a password change voids the challenge. */
  passwordHash: string;
  label: string;
  expiresAt: number;
  attempts: number;
}

export interface AuthRouteDeps {
  mode: "local" | "remote";
  store: AuthSessionStore;
  /** Wrong password guesses, per IP. Distinct from the bearer hook's throttle. */
  passwordThrottle: LoginThrottle;
  /** The live credential (read per request: a config save replaces it). */
  credentials: () => { username: string; passwordHash: string | undefined };
  /** The login second factor; its clock also runs the challenges and the code lockouts. */
  secondFactor: SecondFactorStore;
  /** Pushes the owner a sign-in alert (rate-limited by the push service). */
  push?: { notifySignInAlert(body: string): Promise<void> };
  logger?: Pick<Console, "warn" | "error">;
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

  const factor = deps.secondFactor;
  const logger = deps.logger ?? console;
  const now = () => factor.now();
  // Wrong codes per IP. Distinct from `passwordThrottle`: the attacker this guards against knows
  // the password, and a correct one clears that count.
  const codeThrottle = new LoginThrottle({ now });
  // Wrong sign-in codes from every IP together (an attacker spreading guesses over addresses).
  const globalCodeThrottle = new LoginThrottle({ maxFails: GLOBAL_CODE_MAX_FAILS, now });
  /** Challenges by the SHA-256 of their token. */
  const challenges = new Map<string, Challenge>();
  /** Pending enrollments by the caller's session id ({@link LOCAL_SETUP_KEY} over the socket). */
  const pendingSetups = new Map<string, { secret: string; expiresAt: number }>();
  const challengeKey = (token: string): string => createHash("sha256").update(token).digest("hex");

  const tooManyCodes = async (reply: FastifyReply, retryAfterMs: number): Promise<null> => {
    reply.header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    await reply.code(429).send({ code: authErrorCodes.tooManyAttempts, message: "Too many wrong codes. Try again later." });
    return null;
  };

  const invalidProof = (reply: FastifyReply, field: "password" | "code") =>
    reply.code(403).send({
      code: authErrorCodes.invalidProof,
      field,
      message: field === "password" ? "Incorrect password." : "That code didn't work."
    });

  const factorUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({ code: authErrorCodes.secondFactorUnavailable, message: new SecondFactorUnavailableError().message });

  /** Run `handler`; a second factor that turns out unusable answers 503. */
  const orUnavailable = async <T>(reply: FastifyReply, handler: () => Promise<T>): Promise<T | void> => {
    try {
      return await handler();
    } catch (error) {
      if (error instanceof SecondFactorUnavailableError) return factorUnavailable(reply);
      throw error;
    }
  };

  /**
   * Tell the owner their password has leaked: a log warning (the IP, never the code), the
   * Settings alert, and a push (at most one per 15 minutes). Never throws.
   */
  const alertOwner = (ip: string, event: "wrong-code" | "lockout"): void => {
    if (event === "wrong-code") {
      logger.warn(`auth: a correct password was followed by a wrong second-factor code from ${ip}; the password may have leaked.`);
    } else {
      logger.warn(`auth: ${GLOBAL_CODE_MAX_FAILS} wrong second-factor codes; signing in with a code is locked for every address for a while (latest from ${ip}). Existing sessions keep working.`);
    }
    factor.recordFailedChallenge(ip).catch((error: unknown) => {
      if (!(error instanceof SecondFactorUnavailableError)) logger.error("auth: could not record the failed second-factor attempt", error instanceof Error ? error.name : typeof error);
    });
    const body =
      event === "wrong-code"
        ? `Someone entered your Orquester password from ${ip} but not a valid code. Change your password.`
        : `Repeated wrong codes after your Orquester password (latest from ${ip}): new sign-ins are paused for a while. Change your password.`;
    void deps.push?.notifySignInAlert(body).catch(() => undefined);
  };

  /**
   * Run one code check for the request's IP: refused (429) while the IP's code entry is locked
   * (or, for the public sign-in step, all code entry is), or it already has a check in flight. A
   * `false` result counts as a wrong code; a `true` one clears the IP. Over the unix socket nothing
   * is counted.
   */
  const codeGuarded = async (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: "sign-in" | "management",
    check: () => Promise<boolean>
  ): Promise<boolean | null> => {
    if (deps.mode === "local") return check();
    const ip = clientIp(request);
    const retryAfterMs = Math.max(codeThrottle.retryAfterMs(ip), scope === "sign-in" ? globalCodeThrottle.retryAfterMs(EVERY_IP) : 0);
    if (retryAfterMs > 0 || checking.has(ip)) return tooManyCodes(reply, retryAfterMs);
    checking.add(ip);
    try {
      const ok = await check();
      if (ok) {
        codeThrottle.recordSuccess(ip);
        // Only the owner can produce a right code, so a completed sign-in also clears the global
        // count: their own typos, spread over months, must not add up to a lockout.
        if (scope === "sign-in") globalCodeThrottle.recordSuccess(EVERY_IP);
      } else {
        codeThrottle.recordFailure(ip, true);
        if (scope === "sign-in") {
          globalCodeThrottle.recordFailure(EVERY_IP, true);
          if (globalCodeThrottle.retryAfterMs(EVERY_IP) > 0) alertOwner(ip, "lockout");
        }
      }
      return ok;
    } finally {
      checking.delete(ip);
    }
  };

  /**
   * Re-prove the owner on the remote transport: the password (through the password throttle),
   * then, when `needCode`, a code (per-IP code limits only). Answers 403 / 429 itself and returns
   * false; over the unix socket always true.
   */
  const proveOwner = async (request: FastifyRequest, reply: FastifyReply, needCode: boolean): Promise<boolean> => {
    if (deps.mode === "local") return true;
    const body = (request.body ?? {}) as AuthSecondFactorProof;
    const password = body.password;
    if (typeof password !== "string" || password.length === 0 || password.length > PASSWORD_MAX) {
      await invalidProof(reply, "password");
      return false;
    }
    const credentials = deps.credentials();
    const passwordOk = await guarded(request, reply, () => passwordMatches(credentials, undefined, password, false));
    if (passwordOk === null) return false;
    if (!passwordOk) {
      await invalidProof(reply, "password");
      return false;
    }
    if (!needCode) return true;
    const code = body.code;
    if (typeof code !== "string" || code.trim().length === 0 || code.length > CODE_MAX) {
      await invalidProof(reply, "code");
      return false;
    }
    const codeOk = await codeGuarded(request, reply, "management", () => factor.verify(code));
    if (codeOk === null) return false;
    if (!codeOk) {
      await invalidProof(reply, "code");
      return false;
    }
    return true;
  };

  const issueChallenge = (ip: string, passwordHash: string, label: string): AuthSecondFactorChallenge => {
    const at = now();
    for (const [key, challenge] of challenges) if (challenge.expiresAt <= at) challenges.delete(key);
    while (challenges.size >= CHALLENGES_MAX) challenges.delete(challenges.keys().next().value as string);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = at + CHALLENGE_TTL_MS;
    challenges.set(challengeKey(token), { ip, passwordHash, label, expiresAt, attempts: 0 });
    return { secondFactorRequired: true, challenge: token, expiresAt: new Date(expiresAt).toISOString() };
  };

  app.get(authRoutes.info, async () => {
    const authRequired = deps.mode === "remote" && Boolean(deps.credentials().passwordHash);
    return { authRequired, requiresUsername: authRequired };
  });

  app.post<{ Body: AuthLoginRequest }>(authRoutes.login, async (request, reply): Promise<AuthLoginResponse | void> => {
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
    const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined;
    const label = cleanLabel(body.label, deviceLabelFromUserAgent(userAgent));
    // A second factor that cannot be read never lets a password alone through (fail closed). With
    // it on, the password alone never yields a token remotely (over the socket it does: trusted
    // local control).
    if (factor.isUnavailable()) return factorUnavailable(reply);
    if (deps.mode === "remote" && factor.isEnabled()) {
      return issueChallenge(clientIp(request), credentials.passwordHash, label);
    }
    try {
      // Bound to the hash bcrypt checked: a password change that landed meanwhile refuses it.
      return await deps.store.create("device", label, credentials.passwordHash);
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

  app.post<{ Body: AuthSecondFactorLoginRequest }>(authRoutes.secondFactorLogin, async (request, reply): Promise<AuthIssuedTokenResponse | void> => {
    const body = (request.body ?? {}) as Partial<AuthSecondFactorLoginRequest>;
    if (typeof body.challenge !== "string" || body.challenge.length > 200 || typeof body.code !== "string" || body.code.length > CODE_MAX || (body.label !== undefined && typeof body.label !== "string")) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "`challenge` and `code` must be strings." });
    }
    const code = body.code;
    const ip = clientIp(request);
    const key = challengeKey(body.challenge);
    const challenge = challenges.get(key);
    const expired = () => reply.code(401).send({ code: authErrorCodes.challengeExpired, message: "Sign-in timed out. Enter your password again." });
    if (!challenge || challenge.expiresAt <= now() || challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      challenges.delete(key);
      return expired();
    }
    // Another address's challenge is refused but left alone: only its own IP may use it up.
    if (challenge.ip !== ip) return expired();
    // A password change, or the factor turned off since the password step, voids it.
    if (deps.credentials().passwordHash !== challenge.passwordHash || !factor.isEnabled()) {
      challenges.delete(key);
      return expired();
    }
    return orUnavailable(reply, async () => {
      const ok = await codeGuarded(request, reply, "sign-in", () => factor.verify(code));
      if (ok === null) return;
      if (!ok) {
        challenge.attempts += 1;
        if (challenge.attempts === 1) alertOwner(ip, "wrong-code");
        if (challenge.attempts >= CHALLENGE_MAX_ATTEMPTS) challenges.delete(key);
        return reply.code(401).send({ code: authErrorCodes.invalidCode, message: "That code didn't work." });
      }
      challenges.delete(key);
      try {
        return await deps.store.create("device", cleanLabel(body.label, challenge.label), challenge.passwordHash);
      } catch (error) {
        if (error instanceof StalePasswordError) return expired();
        if (error instanceof AuthSessionsUnavailableError) {
          return reply.code(503).send({ code: "AUTH_SESSIONS_UNAVAILABLE", message: error.message });
        }
        throw error;
      }
    });
  });

  app.get(authRoutes.secondFactor, async (): Promise<AuthSecondFactorStatusResponse> => factor.status());

  app.post<{ Body: AuthSecondFactorSetupRequest }>(authRoutes.secondFactorSetup, async (request, reply): Promise<AuthSecondFactorSetupResponse | void> => {
    if (factor.isUnavailable()) return factorUnavailable(reply);
    if (factor.isEnabled()) {
      return reply.code(409).send({ code: authErrorCodes.secondFactorEnabled, message: "Two-step sign-in is already on." });
    }
    if (!(await proveOwner(request, reply, false))) return;
    const at = now();
    for (const [key, pending] of pendingSetups) if (pending.expiresAt <= at) pendingSetups.delete(key);
    const secret = generateTotpSecret();
    const expiresAt = at + PENDING_SETUP_TTL_MS;
    pendingSetups.set(request.authSession?.id ?? LOCAL_SETUP_KEY, { secret, expiresAt });
    const hostHeader = typeof request.headers.host === "string" ? request.headers.host.trim().slice(0, 255) : "";
    return {
      secret,
      otpauthUri: otpauthUri({ secret, username: deps.credentials().username, host: hostHeader || "orquester" }),
      expiresAt: new Date(expiresAt).toISOString()
    };
  });

  app.post<{ Body: AuthSecondFactorEnableRequest }>(authRoutes.secondFactorEnable, async (request, reply): Promise<AuthRecoveryCodesResponse | void> => {
    const code = (request.body as Partial<AuthSecondFactorEnableRequest> | undefined)?.code;
    if (typeof code !== "string" || code.length > CODE_MAX) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "`code` must be a string." });
    }
    if (factor.isUnavailable()) return factorUnavailable(reply);
    const enabledAlready = () => reply.code(409).send({ code: authErrorCodes.secondFactorEnabled, message: "Two-step sign-in is already on." });
    if (factor.isEnabled()) return enabledAlready();
    const setupKey = request.authSession?.id ?? LOCAL_SETUP_KEY;
    const pending = pendingSetups.get(setupKey);
    if (!pending || pending.expiresAt <= now()) {
      pendingSetups.delete(setupKey);
      return reply.code(409).send({ code: authErrorCodes.noPendingSetup, message: "Set-up timed out. Start again." });
    }
    return orUnavailable(reply, async () => {
      const outcome: { result: Awaited<ReturnType<SecondFactorStore["enable"]>> } = { result: "invalid-code" };
      const ok = await codeGuarded(request, reply, "management", async () => {
        outcome.result = await factor.enable(pending.secret, code);
        return outcome.result !== "invalid-code";
      });
      if (ok === null) return;
      const result = outcome.result;
      if (result === "invalid-code") return invalidProof(reply, "code");
      if (result === "enabled") return enabledAlready();
      pendingSetups.delete(setupKey);
      // Sessions from before the factor go; the caller just proved password and code. API tokens stay.
      await deps.store.revokeDevicesExcept(request.authSession?.id ?? null);
      return { recoveryCodes: result };
    });
  });

  app.post<{ Body: AuthSecondFactorProof }>(authRoutes.secondFactorRecoveryCodes, async (request, reply): Promise<AuthRecoveryCodesResponse | void> => {
    const disabled = () => reply.code(409).send({ code: authErrorCodes.secondFactorDisabled, message: "Two-step sign-in is off." });
    if (factor.isUnavailable()) return factorUnavailable(reply);
    if (!factor.isEnabled()) return disabled();
    return orUnavailable(reply, async () => {
      if (!(await proveOwner(request, reply, true))) return;
      const codes = await factor.regenerateRecoveryCodes();
      if (!codes) return disabled();
      return { recoveryCodes: codes };
    });
  });

  app.post<{ Body: AuthSecondFactorProof }>(authRoutes.secondFactorDisable, async (request, reply) => {
    const disabled = () => reply.code(409).send({ code: authErrorCodes.secondFactorDisabled, message: "Two-step sign-in is off." });
    if (factor.isUnavailable()) return factorUnavailable(reply);
    if (!factor.isEnabled()) return disabled();
    return orUnavailable(reply, async () => {
      if (!(await proveOwner(request, reply, true))) return;
      if (!(await factor.disable())) return disabled();
      return reply.code(204).send();
    });
  });

  app.post(authRoutes.secondFactorDismissAlert, async (_request, reply) =>
    orUnavailable(reply, async () => {
      await factor.dismissAlert();
      return reply.code(204).send();
    })
  );

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
    // A stolen device session must not turn itself into a permanent credential: remotely the
    // owner re-proves the password, and a code while the factor is on.
    if (deps.mode === "remote" && factor.isUnavailable()) return factorUnavailable(reply);
    const proven = await orUnavailable(reply, () => proveOwner(request, reply, factor.isEnabled()));
    if (!proven) return;
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
