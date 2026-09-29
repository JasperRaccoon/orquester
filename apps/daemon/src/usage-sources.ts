import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage, UsageWindow } from "@orquester/api";
import { type UsagePrefs, parseAppConfig } from "@orquester/config";
import { claudePlanLabel, currentScopedWindows, currentWindow, findLastCodexTokenCount, parseClaudeUsage, parseCodexUsage, parseCodexWhamUsage, parseGrokBilling } from "./usage-parse";
import { decodeJwtPayload, parseCodexIdentity, parseGrokIdentity } from "./agent-account-identity";
import { CLAUDE_SESSION_WINDOW_ID, CLAUDE_WEEKLY_WINDOW_ID } from "./agent-host/adapters/claude/usage.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
// cli-chat-proxy enforces the first-party client headers (426 without them);
// pinned to a grok CLI release — bump alongside grok releases.
const GROK_CLIENT_VERSION = "0.2.118";

export async function readUsagePrefs(appConfigFile: string): Promise<UsagePrefs> {
  try {
    return parseAppConfig(JSON.parse(await readFile(appConfigFile, "utf8"))).usage;
  } catch {
    // ENOENT / corrupt → defaults (enabled).
    return { enabled: true, agents: {}, chip: "busiest" };
  }
}

/** Backoff from a 429, honoring Retry-After (seconds) with a floor. */
function retryAfterMs(res: Response, floorMs: number): number {
  const secs = Number(res.headers.get("retry-after"));
  return Number.isFinite(secs) && secs > 0 ? Math.max(secs * 1000, floorMs) : floorMs;
}

/** Anthropic's usage endpoint answers ~1 request per 5 minutes per account (429, `retry-after: 300`). */
const CLAUDE_USAGE_MIN_INTERVAL_MS = 5 * 60_000;
/** A live reading (off a model response) this recent makes a poll pointless. */
const CLAUDE_LIVE_FRESH_MS = 5 * 60_000;
/** A reading older than this is served greyed. */
const CLAUDE_USAGE_STALE_AFTER_MS = 15 * 60_000;
/** A `Retry-After` longer than this is not believed. */
const CLAUDE_MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

/**
 * What one Claude usage source remembers, persisted (`ClaudeUsageStateStore`) so a daemon restart
 * neither starts blank nor re-asks an endpoint the previous process asked a minute ago — which was
 * a 429 and five minutes of "usage updating…" after every deploy.
 */
export interface ClaudeUsageRecord {
  /** The last good reading (`asOf` stamped). */
  lastGood: AgentUsage | null;
  /** When the endpoint was last asked (ms epoch), whatever it answered. */
  lastFetchAt: number;
  /** Not before this (ms epoch): a 429's `Retry-After`, or a short pause after a failure. */
  retryAt: number;
  /** When the last live reading arrived (ms epoch). */
  liveAt: number;
  /** The last attempt failed with nothing newer since: the reading is served greyed. */
  failed: boolean;
}

export interface ClaudeUsageStateStore {
  get(key: string): ClaudeUsageRecord | undefined;
  set(key: string, record: ClaudeUsageRecord): void;
}

/** A live reading of an account's windows, off its own model responses. */
export interface ClaudeLiveUsage {
  session?: UsageWindow | null;
  weekly?: UsageWindow | null;
  /** When the reading was taken (ms epoch). */
  observedAt: number;
}

/**
 * A chat thread's live windows (the host's `ProviderUsageWindow`s, Claude's ids) as a
 * {@link ClaudeLiveUsage}: only the two account windows, a window the reading does not carry is
 * left as it was. Null when the reading carries neither or its time does not parse.
 */
export function claudeLiveUsageFromWindows(
  windows: ReadonlyArray<{ id: string; usedPercent: number; resetsAt?: string }>,
  observedAt: string
): ClaudeLiveUsage | null {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return null;
  const window = (id: string): UsageWindow | undefined => {
    const found = windows.find((w) => w.id === id);
    if (!found || !Number.isFinite(found.usedPercent)) return undefined;
    const percent = Math.max(0, Math.min(100, found.usedPercent));
    return { percent, ...(found.resetsAt ? { resetsAt: found.resetsAt } : {}) };
  };
  const session = window(CLAUDE_SESSION_WINDOW_ID);
  const weekly = window(CLAUDE_WEEKLY_WINDOW_ID);
  if (!session && !weekly) return null;
  return { ...(session ? { session } : {}), ...(weekly ? { weekly } : {}), observedAt: observedAtMs };
}

export type ClaudeUsageSource = (() => Promise<AgentUsage | null>) & {
  /** Take a live reading (a chat thread's `rate_limit_event`). Older than what is held: ignored. */
  ingestLive(reading: ClaudeLiveUsage): boolean;
};

export function createClaudeSource(opts: {
  userhome: string;
  now: () => number;
  claudeHome?: string;
  logger?: Pick<Console, "warn">;
  /** Persisted state, under `key` (default: in memory only). */
  state?: { store: ClaudeUsageStateStore; key: string };
}): ClaudeUsageSource {
  const doFetch = fetch;
  const claudeHome = opts.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
  const credsFile = join(claudeHome, ".credentials.json");
  let record: ClaudeUsageRecord = opts.state?.store.get(opts.state.key) ?? {
    lastGood: null,
    lastFetchAt: 0,
    retryAt: 0,
    liveAt: 0,
    failed: false
  };
  const save = (next: ClaudeUsageRecord): void => {
    record = next;
    opts.state?.store.set(opts.state.key, next);
  };

  const source = async (): Promise<AgentUsage | null> => {
    let oauth: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } | undefined;
    try {
      oauth = JSON.parse(await readFile(credsFile, "utf8"))?.claudeAiOauth;
    } catch {
      return null; // no credentials file → genuinely not logged in
    }
    if (!oauth?.accessToken) return null; // genuinely not logged in

    // From here the user IS logged in — never return null (that renders as "not
    // logged in"). Report last-known, or a signed-in "updating" placeholder.
    const creds = { subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier };
    const now = opts.now();
    const expired = typeof oauth.expiresAt === "number" && oauth.expiresAt <= now;
    // Serving last-known numbers: drop any window whose reset has since passed —
    // a frozen pre-reset reading (e.g. weekly 100%) must not outlive its window.
    const serve = (): AgentUsage => {
      const good = record.lastGood;
      if (!good) {
        return { id: "claude", available: true, stale: true, plan: claudePlanLabel(creds), session: null, weekly: null };
      }
      const asOfMs = good.asOf ? Date.parse(good.asOf) : Number.NaN;
      const old = !Number.isFinite(asOfMs) || now - asOfMs > CLAUDE_USAGE_STALE_AFTER_MS;
      return {
        ...good,
        plan: good.plan ?? claudePlanLabel(creds),
        stale: record.failed || expired || old,
        session: currentWindow(good.session, now),
        weekly: currentWindow(good.weekly, now),
        scopedWindows: currentScopedWindows(good.scopedWindows, now)
      };
    };

    // Asked recently, backing off, fed live a moment ago, or the token is
    // expired until Claude Code refreshes it: serve what is held.
    // The interval holds with nothing to show too: asking again inside it is only a 429.
    // A stamp in the future (the clock moved back) is not believed.
    const sinceFetch = now - record.lastFetchAt;
    const sinceLive = now - record.liveAt;
    if (sinceFetch >= 0 && sinceFetch < CLAUDE_USAGE_MIN_INTERVAL_MS) return serve();
    if (record.lastGood && sinceLive >= 0 && sinceLive < CLAUDE_LIVE_FRESH_MS) return serve();
    if (now < record.retryAt && record.retryAt - now <= CLAUDE_MAX_RETRY_AFTER_MS) return serve();
    if (expired) return serve();

    record = { ...record, lastFetchAt: now };
    try {
      const res = await doFetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
          Accept: "application/json"
        },
        // A hung request must not hold up every other account's reading.
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 429) {
        // Floor at the endpoint's own window, persisted: a restart must not re-ask.
        const wait = Math.min(retryAfterMs(res, CLAUDE_USAGE_MIN_INTERVAL_MS), CLAUDE_MAX_RETRY_AFTER_MS);
        save({ ...record, retryAt: now + wait, failed: true });
        opts.logger?.warn?.("usage: claude usage endpoint rate-limited (429); backing off");
        return serve();
      }
      if (!res.ok) {
        save({ ...record, retryAt: now + 60_000, failed: true }); // brief backoff on 5xx/other
        return serve();
      }
      const agent = parseClaudeUsage(await res.json(), creds, now);
      if (agent.available) {
        save({ ...record, lastGood: { ...agent, asOf: new Date(now).toISOString() }, retryAt: 0, failed: false });
        return serve();
      }
      save(record);
      return serve(); // 200 but unparseable → still signed in, no number yet
    } catch (err) {
      opts.logger?.warn?.(`usage: claude fetch failed: ${String(err)}`);
      save({ ...record, retryAt: now + 60_000, failed: true });
      return serve();
    }
  };

  const ingestLive = (reading: ClaudeLiveUsage): boolean => {
    const good = record.lastGood;
    const asOfMs = good?.asOf ? Date.parse(good.asOf) : Number.NaN;
    if (Number.isFinite(asOfMs) && reading.observedAt <= asOfMs) return false;
    if (reading.session === undefined && reading.weekly === undefined) return false;
    const session = reading.session !== undefined ? reading.session : (good?.session ?? null);
    const weekly = reading.weekly !== undefined ? reading.weekly : (good?.weekly ?? null);
    save({
      ...record,
      lastGood: {
        id: "claude",
        ...(good ?? {}),
        available: true,
        stale: false,
        session,
        weekly,
        asOf: new Date(reading.observedAt).toISOString()
      },
      liveAt: reading.observedAt,
      failed: false
    });
    return true;
  };

  return Object.assign(source, { ingestLive });
}

interface GrokCredential {
  token: string;
  userId: string | null;
  /** Display label (email) when the credential file carries one. */
  email: string | null;
  /** ms epoch, or null when the file carries no parseable expiry. */
  expiresAtMs: number | null;
}

async function fromGrokAuthJson(file: string): Promise<GrokCredential | null> {
  try {
    const auth = JSON.parse(await readFile(file, "utf8"));
    if (typeof auth !== "object" || auth === null) return null;
    // Keyed by issuer::client-id; prefer the auth.x.ai (SuperGrok) entry.
    const entries = Object.entries(auth as Record<string, any>).filter(
      ([, v]) => typeof v === "object" && v !== null && typeof v.key === "string" && v.key
    );
    const [, acct] = entries.find(([k]) => k.includes("auth.x.ai")) ?? entries[0] ?? [];
    if (!acct) return null;
    const exp = typeof acct.expires_at === "string" ? Date.parse(acct.expires_at) : NaN;
    const idn = parseGrokIdentity(auth);
    return {
      token: acct.key,
      userId: idn.userId ?? (typeof acct.user_id === "string" && acct.user_id ? acct.user_id : null),
      email: idn.email,
      expiresAtMs: Number.isFinite(exp) ? exp : null
    };
  } catch {
    return null;
  }
}

/** Attach a single labeled account row so the usage panel matches Claude/Codex. */
function withGrokAccountLabel(agent: AgentUsage, email: string | null): AgentUsage {
  if (!email) return agent;
  return {
    ...agent,
    accounts: [
      {
        id: "grok",
        label: email,
        available: agent.available,
        stale: agent.stale,
        plan: agent.plan,
        session: agent.session,
        weekly: agent.weekly,
        asOf: agent.asOf
      }
    ]
  };
}

/**
 * Grok Build subscription usage via the first-party billing endpoint (the one
 * behind the grok CLI's /usage command). Undocumented and reverse-engineered —
 * an accepted risk — so every failure path degrades to signed-in/stale rather
 * than breaking the widget.
 */
export function createGrokSource(opts: {
  /** The grok CLI home (`GROK_HOME` || `~/.grok`). */
  grokHome: string;
  /** When set, ONLY this managed-home `auth.json` is used (per-account poll). */
  authFile?: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = fetch;
  let lastGood: AgentUsage | null = null;
  let backoffUntil = 0;
  // userId resolved from GET /user when the credential file lacks one; keyed by
  // token prefix so a rotated credential re-resolves.
  let resolvedUser: { tokenKey: string; userId: string } | null = null;

  const grokHeaders = (cred: GrokCredential, userId: string | null): Record<string, string> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": GROK_CLIENT_VERSION,
      "x-grok-client-identifier": "grok-shell",
      "User-Agent": "xai-grok-cli",
      Accept: "application/json"
    };
    if (userId) headers["x-userid"] = userId;
    return headers;
  };

  return async () => {
    const cred = await fromGrokAuthJson(opts.authFile || join(opts.grokHome, "auth.json"));
    if (!cred) return null; // genuinely not linked/logged in

    const signedIn = (): AgentUsage =>
      lastGood
        ? { ...lastGood, stale: true, session: null, weekly: currentWindow(lastGood.weekly, opts.now()) }
        : withGrokAccountLabel({ id: "grok", available: true, stale: true, session: null, weekly: null }, cred.email);

    const now = opts.now();
    if (now < backoffUntil) return signedIn();
    // Expired token: the accounts refresher (or the CLI) refreshes it, never us —
    // skip the fetch, a 401 with a stale bearer would just churn.
    if (cred.expiresAtMs !== null && cred.expiresAtMs <= now) return signedIn();

    try {
      let userId = cred.userId;
      const tokenKey = cred.token.slice(0, 24);
      if (!userId) {
        if (resolvedUser?.tokenKey === tokenKey) {
          userId = resolvedUser.userId;
        } else {
          const ures = await doFetch(GROK_USER_URL, { headers: grokHeaders(cred, null) });
          if (ures.ok) {
            const u = (await ures.json()) as { userId?: unknown };
            if (typeof u?.userId === "string" && u.userId) {
              userId = u.userId;
              resolvedUser = { tokenKey, userId };
            }
          }
        }
      }
      const res = await doFetch(GROK_BILLING_URL, { headers: grokHeaders(cred, userId) });
      if (res.status === 429) {
        backoffUntil = now + retryAfterMs(res, 5 * 60_000);
        opts.logger?.warn?.("usage: grok billing endpoint rate-limited (429); backing off");
        return signedIn();
      }
      if (!res.ok) {
        backoffUntil = now + 60_000;
        return signedIn();
      }
      const agent = parseGrokBilling(await res.json(), now);
      if (agent.available) {
        lastGood = withGrokAccountLabel(agent, cred.email);
        return lastGood;
      }
      return signedIn(); // 200 but unparseable → still linked, no number yet
    } catch (err) {
      opts.logger?.warn?.(`usage: grok fetch failed: ${String(err)}`);
      backoffUntil = now + 60_000;
      return signedIn();
    }
  };
}

/** Rollout log paths under a Codex sessions dir, newest (by mtime) first. */
async function rolloutsNewestFirst(sessionsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return []; // no sessions dir yet
  }
  const files: { full: string; mtime: number }[] = [];
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl") || !rel.includes("rollout-")) continue;
    const full = join(sessionsDir, rel);
    try {
      const s = await stat(full);
      files.push({ full, mtime: s.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.full);
}

/** Fallback usage reader: scrape the newest Codex rollout log for a token_count. */
function createCodexLogScrapeSource(opts: {
  codexHome: string;
  now: () => number;
}): () => Promise<AgentUsage | null> {
  const { codexHome } = opts;
  return async () => {
    let signedIn = false;
    try {
      const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
      if (auth?.OPENAI_API_KEY || auth?.auth_mode === "apikey") return null; // no subscription quota
      signedIn = !!auth; // chatgpt / oauth login
    } catch {
      /* no auth.json — fall through and try the logs */
    }
    // A brand-new session writes its rollout file BEFORE the first token_count
    // event, so the newest-by-mtime file may carry no usage yet. Scan recent files
    // newest-first and use the first that has a real reading.
    const files = await rolloutsNewestFirst(join(codexHome, "sessions"));
    for (const file of files.slice(0, 8)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const rateLimits = findLastCodexTokenCount(text.split("\n"));
      if (!rateLimits) continue;
      const agent = parseCodexUsage(rateLimits, opts.now());
      if (agent.available) return { ...agent, asOf: new Date(opts.now()).toISOString() };
    }
    // Signed in but no usable reading yet → present + updating (not "not logged in").
    return signedIn ? { id: "codex", available: true, stale: true, session: null, weekly: null } : null;
  };
}

/**
 * Should the System (daemon-HOME) reading be hidden from the usage panel when
 * managed accounts exist? Two cases make the row pure noise:
 *  - expired system credentials: nothing in the daemon refreshes the system
 *    login (only the user's own CLI does), so the row is a permanent "—";
 *  - the system login IS one of the managed accounts (typical after importing
 *    the system auth.json), so the row duplicates that account's numbers.
 * Identity comparison is Codex/Grok (email / account_id); Claude credentials
 * carry no identity, so Claude only gets the expiry rule. Missing/unreadable
 * credentials never hide — the source already reports null.
 */
export async function shouldHideSystemUsage(
  agent: "claude" | "codex" | "grok",
  opts: {
    userhome: string;
    now: number;
    claudeHome?: string;
    codexHome?: string;
    grokHome?: string;
    managedHomes?: string[];
  }
): Promise<boolean> {
  if (agent === "claude") {
    const home = opts.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
    let oauth: { expiresAt?: unknown } | undefined;
    try {
      oauth = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"))?.claudeAiOauth;
    } catch {
      return false;
    }
    return typeof oauth?.expiresAt === "number" && oauth.expiresAt <= opts.now;
  }

  if (agent === "grok") {
    // System for Grok is the CLI login only (managed homes are polled separately).
    const sys = await fromGrokAuthJson(join(opts.grokHome || process.env.GROK_HOME || join(opts.userhome, ".grok"), "auth.json"));
    if (!sys) return true; // nothing to show on System
    if (sys.expiresAtMs !== null && sys.expiresAtMs <= opts.now) return true;
    if (!sys.email && !sys.userId) return false;
    for (const managedHome of opts.managedHomes ?? []) {
      const managed = await fromGrokAuthJson(join(managedHome, "auth.json"));
      if (!managed) continue;
      if ((sys.email && managed.email && sys.email === managed.email) || (sys.userId && managed.userId && sys.userId === managed.userId)) {
        return true;
      }
    }
    return false;
  }

  const home = opts.codexHome || process.env.CODEX_HOME || join(opts.userhome, ".codex");
  let auth: { tokens?: { access_token?: unknown } } | undefined;
  try {
    auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  } catch {
    return false;
  }
  const exp = typeof auth?.tokens?.access_token === "string" ? decodeJwtPayload(auth.tokens.access_token)?.exp : undefined;
  if (typeof exp === "number" && exp * 1000 <= opts.now) return true;

  const sys = parseCodexIdentity(auth);
  if (!sys.accountId && !sys.email) return false;
  for (const managedHome of opts.managedHomes ?? []) {
    let managed: unknown;
    try {
      managed = JSON.parse(await readFile(join(managedHome, "auth.json"), "utf8"));
    } catch {
      continue;
    }
    const idn = parseCodexIdentity(managed);
    if ((sys.accountId && idn.accountId === sys.accountId) || (sys.email && idn.email === sys.email)) return true;
  }
  return false;
}

export function createCodexSource(opts: {
  userhome: string;
  now: () => number;
  codexHome?: string;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = fetch;
  const codexHome = opts.codexHome || process.env.CODEX_HOME || join(opts.userhome, ".codex");
  const authFile = join(codexHome, "auth.json");
  let lastGood: AgentUsage | null = null;
  let backoffUntil = 0;
  const scrapeFallback = createCodexLogScrapeSource({ codexHome, now: opts.now });

  return async () => {
    let tokens: { access_token?: string; account_id?: string } | undefined;
    try {
      tokens = JSON.parse(await readFile(authFile, "utf8"))?.tokens;
    } catch {
      // auth.json missing/unreadable → still try the rollout logs (a session may
      // have logged token_count events even without a usable oauth token here).
      return scrapeFallback();
    }
    if (!tokens?.access_token) return scrapeFallback();

    const signedIn = (): AgentUsage =>
      lastGood ? { ...lastGood, stale: true } : { id: "codex", available: true, stale: true, session: null, weekly: null };
    const now = opts.now();
    if (now < backoffUntil) return (await scrapeFallback()) ?? signedIn();

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokens.access_token}`,
        "User-Agent": "codex-cli",
        "OpenAI-Beta": "codex-1",
        originator: "Codex Desktop",
        Accept: "application/json"
      };
      if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
      const res = await doFetch(CODEX_USAGE_URL, { headers });
      if (res.status === 429) {
        backoffUntil = now + retryAfterMs(res, 5 * 60_000);
        opts.logger?.warn?.("usage: codex usage endpoint rate-limited (429); backing off");
        return (await scrapeFallback()) ?? signedIn();
      }
      if (!res.ok) {
        backoffUntil = now + 60_000;
        return (await scrapeFallback()) ?? signedIn();
      }
      const agent = parseCodexWhamUsage(await res.json(), now);
      if (agent.available) {
        lastGood = agent;
        return lastGood;
      }
      return (await scrapeFallback()) ?? signedIn();
    } catch (err) {
      opts.logger?.warn?.(`usage: codex fetch failed: ${String(err)}`);
      backoffUntil = now + 60_000;
      return (await scrapeFallback()) ?? signedIn();
    }
  };
}
