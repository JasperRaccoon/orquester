import type { PushInfoResponse, PushSubscribeRequest, SessionSummary } from "@orquester/api";
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
  /** Last-push timestamp per session id, for the per-session debounce. */
  private readonly lastPushAt = new Map<string, number>();

  constructor(
    /** Absolute path to push.json (resolved by the daemon via pushConfigPath). */
    private readonly configPath: string,
    private readonly logger: Logger = console
  ) {}

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
   * Push an "attention" notification for a session that rang the bell. Debounced
   * to at most one push per {@link DEBOUNCE_MS} per session. Logs, never throws.
   */
  async notifyAttention(session: SessionSummary): Promise<void> {
    try {
      const now = Date.now();
      // Evict entries that can no longer affect the debounce window, so the map
      // stays bounded to sessions that rang a bell within the last DEBOUNCE_MS
      // (session ids are never otherwise removed on close).
      for (const [id, ts] of this.lastPushAt) {
        if (now - ts >= DEBOUNCE_MS) {
          this.lastPushAt.delete(id);
        }
      }
      const last = this.lastPushAt.get(session.id) ?? 0;
      if (now - last < DEBOUNCE_MS) {
        return;
      }
      this.lastPushAt.set(session.id, now);

      const project = session.projectPath ? basename(session.projectPath) : "";
      const payload = JSON.stringify({
        title: project
          ? `${session.title} in ${project} needs your attention`
          : `${session.title} needs your attention`,
        body: "",
        tag: `session-${session.id}`,
        sessionId: session.id
      });
      await this.deliver(payload);
    } catch (error) {
      this.logger.error("push notifyAttention failed", error);
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
