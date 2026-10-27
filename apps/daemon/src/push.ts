import type { FastifyInstance } from "fastify";
import {
  PUSH_NOTIFY_BODY_MAX_CHARS,
  PUSH_NOTIFY_TITLE_MAX_CHARS,
  sanitizeApprovalLabel,
  sanitizeApprovalProse,
  type PushInfoResponse,
  type PushNotificationEvent,
  type PushNotifyRequest,
  type PushNotifyResponse,
  type PushSubscribeRequest,
  type SessionSummary
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import {
  type PushConfig,
  type PushSubscriptionRecord,
  createDefaultPushConfig,
  parsePushConfig
} from "@orquester/config";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import webpush from "web-push";

/** VAPID `sub` claim — a contact URI, per the Web Push spec. */
const VAPID_SUBJECT = "mailto:orquester@example.com";

/** Minimum gap between attention pushes for the SAME session (avoids bell spam). */
const DEBOUNCE_MS = 30_000;

/** The sentence fragment each structural push type reads as in the title. */
const STRUCTURAL_PUSH_VERB = {
  "needs-input": "needs your input",
  finished: "finished",
  "plan-ready": "has a plan ready"
} as const;

/**
 * `notify_user` rate limits (unified MCP design 2026-10-15 §4.1, §5.6): one push per agent chat per 5 minutes, one per
 * external credential per minute. A person's own request (the GUI, a local client) is not limited.
 */
export const AGENT_PUSH_THREAD_INTERVAL_MS = 5 * 60_000;
export const AGENT_PUSH_CREDENTIAL_INTERVAL_MS = 60_000;
/** 429 code of a rate-limited `POST /api/push/notify`. */
const PUSH_RATE_LIMITED = "RATE_LIMITED";

/** Where an agent push counts against a limit: the calling chat, or the external credential; null — not limited. */
export function pushRateKey(principal: CallerPrincipal | undefined): { key: string; intervalMs: number } | null {
  if (principal?.kind === "agent") return { key: `thread:${principal.threadId}`, intervalMs: AGENT_PUSH_THREAD_INTERVAL_MS };
  if (principal?.kind === "external") return { key: `credential:${principal.credentialId ?? "external"}`, intervalMs: AGENT_PUSH_CREDENTIAL_INTERVAL_MS };
  return null;
}

interface Logger {
  error(...args: unknown[]): void;
}

/**
 * Web Push endpoints are always public https URLs (real browser push services —
 * FCM, Mozilla, WNS — are all https). Reject anything else at subscribe time so a
 * stored endpoint can't turn the daemon's outbound web-push POST into a blind SSRF
 * against loopback / link-local / private / metadata addresses.
 */
export function isValidPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("[") // reject bracketed IPv6 literals (fc00::/7, fe80::, ::1)
  ) {
    return false;
  }
  return true;
}

/**
 * Owns the daemon's Web Push state (push.json): a VAPID keypair generated lazily
 * on first need, plus the set of browser subscriptions. Fires an "attention"
 * push when an agent session rings the terminal bell.
 *
 * Security invariants:
 *   - push.json is written 0600 — `vapid.privateKey` is secret material and is
 *     NEVER returned by any API (only the public key + a count cross the wire).
 *   - Send/persist errors are logged, never thrown into the daemon lifecycle.
 *   - A subscription that the push service reports as gone (404/410) is dropped.
 */
export class PushService {
  private config: PushConfig | null = null;
  private loading: Promise<PushConfig> | null = null;
  /** Last-push timestamp per `<sessionId>:<type>` key, for the per-type debounce. */
  private readonly lastPushAt = new Map<string, number>();
  /** Last agent push per rate key (`pushRateKey`), for `notify_user`'s limits. */
  private readonly lastAgentPushAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly onNotification: ((event: PushNotificationEvent) => void) | undefined;

  constructor(
    /** Absolute path to push.json (resolved by the daemon via pushConfigPath). */
    private readonly configPath: string,
    private readonly logger: Logger = console,
    opts?: {
      now?: () => number;
      /** Sees every push past its debounce or rate limit, subscribers or not (the daemon publishes it on the event bus). */
      onNotification?: (event: PushNotificationEvent) => void;
    }
  ) {
    this.now = opts?.now ?? Date.now;
    this.onNotification = opts?.onNotification;
  }

  // --- Persistence ---------------------------------------------------------

  private async load(): Promise<PushConfig> {
    if (this.config) {
      return this.config;
    }
    if (!this.loading) {
      this.loading = (async () => {
        let cfg: PushConfig;
        try {
          cfg = parsePushConfig(JSON.parse(await readFile(this.configPath, "utf8")));
        } catch {
          cfg = createDefaultPushConfig();
        }
        this.config = cfg;
        return cfg;
      })();
    }
    return this.loading;
  }

  /**
   * Persist atomically (tmp file + rename) at 0600 — push.json holds the VAPID
   * private key at rest (same care as accounts.json / sessions.json's atomic write).
   */
  private async persist(config: PushConfig): Promise<void> {
    const tmpPath = `${this.configPath}.tmp`;
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600).catch(() => undefined);
    await rename(tmpPath, this.configPath);
  }

  /** Lazily generate + persist the VAPID keypair on first need. */
  private async ensureVapid(): Promise<NonNullable<PushConfig["vapid"]>> {
    const config = await this.load();
    if (config.vapid) {
      return config.vapid;
    }
    const keys = webpush.generateVAPIDKeys();
    config.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: VAPID_SUBJECT };
    await this.persist(config);
    return config.vapid;
  }

  // --- Public API ----------------------------------------------------------

  /** Triggers lazy VAPID generation; returns only the PUBLIC key + a count. */
  async info(): Promise<PushInfoResponse> {
    const vapid = await this.ensureVapid();
    const config = await this.load();
    return {
      supported: true,
      vapidPublicKey: vapid.publicKey,
      subscriptionCount: config.subscriptions.length
    };
  }

  /** Upsert a browser subscription, keyed by its endpoint. */
  async subscribe(sub: PushSubscribeRequest): Promise<void> {
    if (!isValidPushEndpoint(sub.endpoint)) {
      throw new Error("invalid push endpoint");
    }
    const config = await this.load();
    const record: PushSubscriptionRecord = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: new Date().toISOString(),
      ...(sub.userAgent ? { userAgent: sub.userAgent } : {})
    };
    config.subscriptions = [
      ...config.subscriptions.filter((s) => s.endpoint !== sub.endpoint),
      record
    ];
    await this.persist(config);
  }

  /** Remove a subscription by endpoint. No-op (no write) when absent. */
  async unsubscribe(endpoint: string): Promise<void> {
    const config = await this.load();
    const remaining = config.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (remaining.length !== config.subscriptions.length) {
      config.subscriptions = remaining;
      await this.persist(config);
    }
  }

  /**
   * Debounce guard keyed by `<sessionId>:<type>`. Evicts stale entries (so the
   * map stays bounded — session ids are never otherwise removed on close), then
   * returns true if `key` pushed within the last {@link DEBOUNCE_MS}.
   */
  private debounced(key: string, now: number): boolean {
    for (const [k, ts] of this.lastPushAt) {
      if (now - ts >= DEBOUNCE_MS) {
        this.lastPushAt.delete(k);
      }
    }
    const last = this.lastPushAt.get(key) ?? 0;
    if (now - last < DEBOUNCE_MS) {
      return true;
    }
    this.lastPushAt.set(key, now);
    return false;
  }

  /** Bell fallback push for sessions without hook coverage. */
  async notifyAttention(session: SessionSummary): Promise<void> {
    await this.notify(session, "bell", "needs your attention");
  }

  /**
   * Structural push from agent-hook transitions and from the chat activity
   * ladder. `plan-ready` is its own kind, not a `needs-input` with different
   * copy: a finished turn that left a plan on the table is neither blocked on
   * an answer nor finished with the work.
   */
  async notifyStructural(
    session: SessionSummary,
    type: "needs-input" | "finished" | "plan-ready"
  ): Promise<void> {
    await this.notify(session, type, STRUCTURAL_PUSH_VERB[type]);
  }

  /**
   * An Orquester approval card opened (unified MCP design 2026-10-15 §7.5; `agent-chat/summary.ts` calls it once per
   * card): "Approval needed: <card title>", the chat and its project as the body, deep-linked to the session. NO action
   * button — approval happens only on the card — and nothing but the card's own (already sanitised) title. Debounced
   * per session like every attention push. Never throws.
   */
  async notifyApprovalNeeded(session: SessionSummary, cardTitle: string): Promise<void> {
    try {
      if (this.debounced(`${session.id}:approval`, this.now())) {
        return;
      }
      const project = session.projectPath ? basename(session.projectPath) : "";
      await this.send({
        kind: "approval",
        title: sanitizeApprovalLabel(`Approval needed: ${cardTitle}`, PUSH_NOTIFY_TITLE_MAX_CHARS),
        body: sanitizeApprovalLabel(project ? `${session.title} in ${project}` : session.title, PUSH_NOTIFY_BODY_MAX_CHARS),
        tag: `session-${session.id}`,
        sessionId: session.id
      });
    } catch (error) {
      this.logger.error("approval push failed", error);
    }
  }

  /**
   * An agent's own push (`notify_user`, `POST /api/push/notify`): `title` and `body` flattened to safe text and cut to
   * their caps, deep-linked to `sessionId` (`tag: session-<id>`) when given; no action button. `rate` is the caller's
   * limit ({@link pushRateKey}): a key that pushed within its interval is refused with the wait left, and every accepted
   * call takes its slot, delivered or not (no subscriber, push unsupported), so a limit cannot be probed around.
   */
  async notifyAgent(
    input: PushNotifyRequest,
    rate: { key: string; intervalMs: number } | null
  ): Promise<{ ok: true; sent: number } | { ok: false; retryAfterMs: number }> {
    if (rate) {
      const now = this.now();
      for (const [key, at] of this.lastAgentPushAt) {
        if (now - at >= AGENT_PUSH_THREAD_INTERVAL_MS) this.lastAgentPushAt.delete(key);
      }
      const last = this.lastAgentPushAt.get(rate.key);
      if (last !== undefined && now - last < rate.intervalMs) {
        return { ok: false, retryAfterMs: rate.intervalMs - (now - last) };
      }
      this.lastAgentPushAt.set(rate.key, now);
    }
    const title = sanitizeApprovalLabel(input.title, PUSH_NOTIFY_TITLE_MAX_CHARS);
    const body = input.body ? sanitizeApprovalProse(input.body, PUSH_NOTIFY_BODY_MAX_CHARS).trim() : "";
    const sessionId = input.sessionId ?? "";
    try {
      const sent = await this.send({
        kind: "agent",
        title,
        body,
        tag: sessionId ? `session-${sessionId}` : "orquester-agent",
        ...(sessionId ? { sessionId } : {})
      });
      return { ok: true, sent };
    } catch (error) {
      this.logger.error("agent push failed", error);
      return { ok: true, sent: 0 };
    }
  }

  private async notify(session: SessionSummary, type: "bell" | "needs-input" | "finished" | "plan-ready", verb: string): Promise<void> {
    try {
      if (this.debounced(`${session.id}:${type}`, this.now())) {
        return;
      }
      const project = session.projectPath ? basename(session.projectPath) : "";
      await this.send({
        kind: type === "bell" ? "attention" : type,
        title: project ? `${session.title} in ${project} ${verb}` : `${session.title} ${verb}`,
        body: "",
        tag: `session-${session.id}`,
        sessionId: session.id
      });
    } catch (error) {
      this.logger.error("push notify failed", error);
    }
  }

  /**
   * A finished workflow run's push (workflows spec §5.11). The caller debounces per workflow; this
   * only delivers. `workflowId`/`runId` ride the payload for the deep link. Never throws.
   */
  async notifyWorkflowRun(payload: { title: string; body: string; tag: string; workflowId: string; runId: string }): Promise<void> {
    try {
      await this.send({ kind: "workflow", ...payload });
    } catch (error) {
      this.logger.error("workflow push failed", error);
    }
  }

  /** Send a fixed test payload to every subscription; returns the count delivered. */
  async sendTest(): Promise<number> {
    const payload = JSON.stringify({
      title: "Orquester test notification",
      body: "Push notifications are working.",
      tag: "orquester-test",
      sessionId: ""
    });
    return this.deliver(payload);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Hand a push to the observer, then to every subscription. The Web Push payload is the event without its
   * `kind`, with `sessionId` always present ("" when the push opens no session) as the service worker reads it.
   */
  private async send(event: PushNotificationEvent): Promise<number> {
    try {
      this.onNotification?.(event);
    } catch (error) {
      this.logger.error("push observer failed", error);
    }
    const { kind: _kind, ...payload } = event;
    return this.deliver(JSON.stringify({ ...payload, sessionId: event.sessionId ?? "" }));
  }

  /**
   * Send `payload` to every subscription; drop any the push service reports as
   * gone (404/410) and persist. Returns how many were accepted. Never throws.
   */
  private async deliver(payload: string): Promise<number> {
    const vapid = await this.ensureVapid();
    const config = await this.load();
    if (config.subscriptions.length === 0) {
      return 0;
    }

    const dead: string[] = [];
    let sent = 0;
    await Promise.all(
      config.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payload,
            { vapidDetails: vapid }
          );
          sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            dead.push(sub.endpoint);
          } else {
            this.logger.error("push send failed", error);
          }
        }
      })
    );

    if (dead.length > 0) {
      config.subscriptions = config.subscriptions.filter((s) => !dead.includes(s.endpoint));
      await this.persist(config).catch((error) => this.logger.error("push persist failed", error));
    }
    return sent;
  }
}

/**
 * `POST /api/push/notify` (`PushNotifyRequest` → `PushNotifyResponse`): an agent's Web Push to the user's devices
 * (`notify_user`). Both transports, like the other push routes. The rate limit keys on `request.principal` — never on
 * anything in the body: an agent chat (and its push always deep-links to that chat, whatever `sessionId` says), an
 * external MCP credential, or nobody for a person's own request. 400 on a bad body, 429 `RATE_LIMITED` with
 * `retryAfterSeconds` past the limit.
 */
export function registerPushNotifyRoute(app: FastifyInstance, push: Pick<PushService, "notifyAgent">): void {
  app.post("/api/push/notify", async (request, reply): Promise<PushNotifyResponse | void> => {
    const body = (request.body ?? {}) as Partial<Record<keyof PushNotifyRequest, unknown>>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    // Empty once flattened to the safe text the push shows (only control or format characters): refused, no slot taken.
    if (!title || title.length > PUSH_NOTIFY_TITLE_MAX_CHARS || sanitizeApprovalLabel(title, PUSH_NOTIFY_TITLE_MAX_CHARS) === "") {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: `title is required, at most ${PUSH_NOTIFY_TITLE_MAX_CHARS} characters.` });
    }
    if (body.body !== undefined && (typeof body.body !== "string" || body.body.length > PUSH_NOTIFY_BODY_MAX_CHARS)) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: `body must be text of at most ${PUSH_NOTIFY_BODY_MAX_CHARS} characters.` });
    }
    if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 200)) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "sessionId must be a session id." });
    }
    const principal = request.principal;
    const sessionId = principal?.kind === "agent" ? principal.threadId : (body.sessionId as string | undefined) || undefined;
    const result = await push.notifyAgent(
      { title, ...(typeof body.body === "string" && body.body.trim() ? { body: body.body } : {}), ...(sessionId ? { sessionId } : {}) },
      pushRateKey(principal)
    );
    if (!result.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
      return reply.code(429).send({ code: PUSH_RATE_LIMITED, message: `Too many notifications: try again in ${retryAfterSeconds} s.`, retryAfterSeconds });
    }
    return { sent: result.sent };
  });
}
