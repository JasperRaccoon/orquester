import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage } from "@orquester/api";
import { type UsagePrefs, parseAppConfig } from "@orquester/config";
import { claudePlanLabel, currentWindow, findLastCodexTokenCount, parseClaudeUsage, parseCodexUsage, parseCodexWhamUsage, parseGrokBilling } from "./usage-parse";
import { decodeJwtPayload, parseCodexIdentity } from "./agent-account-identity";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
// cli-chat-proxy enforces the first-party client headers (426 without them);
// pinned like CLIProxyAPI pins its own copy — bump alongside grok releases.
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

export function createClaudeSource(opts: {
  userhome: string;
  now: () => number;
  claudeHome?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const claudeHome = opts.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
  const credsFile = join(claudeHome, ".credentials.json");
  let lastGood: AgentUsage | null = null;
  let backoffUntil = 0;

  return async () => {
    let oauth: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } | undefined;
    try {
      oauth = JSON.parse(await readFile(credsFile, "utf8"))?.claudeAiOauth;
    } catch {
      return null; // no credentials file → genuinely not logged in
    }
    if (!oauth?.accessToken) return null; // genuinely not logged in

    // From here the user IS logged in — never return null (that renders as "not
    // logged in"). Report last-known greyed, or a signed-in "updating" placeholder.
    const creds = { subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier };
    // Serving last-known numbers: drop any window whose reset has since passed —
    // a frozen pre-reset reading (e.g. weekly 100%) must not outlive its window.
    const signedIn = (): AgentUsage =>
      lastGood
        ? {
            ...lastGood,
            stale: true,
            session: currentWindow(lastGood.session, opts.now()),
            weekly: currentWindow(lastGood.weekly, opts.now())
          }
        : { id: "claude", available: true, stale: true, plan: claudePlanLabel(creds), session: null, weekly: null };

    const now = opts.now();
    // Backing off from a rate limit, or the token is expired until Claude Code
    // refreshes it: don't hit the endpoint, just report signed-in/stale.
    if (now < backoffUntil) return signedIn();
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return signedIn();

    try {
      const res = await doFetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
          Accept: "application/json"
        }
      });
      if (res.status === 429) {
        // Floor at 5 min so N daemons sharing one account stop hammering the endpoint.
        backoffUntil = now + retryAfterMs(res, 5 * 60_000);
        opts.logger?.warn?.("usage: claude usage endpoint rate-limited (429); backing off");
        return signedIn();
      }
      if (!res.ok) {
        backoffUntil = now + 60_000; // brief backoff on 5xx/other
        return signedIn();
      }
      const agent = parseClaudeUsage(await res.json(), creds, now);
      if (agent.available) {
        lastGood = { ...agent, asOf: new Date(now).toISOString() };
        return lastGood;
      }
      return signedIn(); // 200 but unparseable → still signed in, no number yet
    } catch (err) {
      opts.logger?.warn?.(`usage: claude fetch failed: ${String(err)}`);
      backoffUntil = now + 60_000;
      return signedIn();
    }
  };
}

interface GrokCredential {
  token: string;
  userId: string | null;
  /** ms epoch, or null when the file carries no parseable expiry. */
  expiresAtMs: number | null;
}

/**
 * The Grok OAuth bearer, read-only, from any credential store on this host:
 *  1. the proxy-owned `<cliproxy>/auth/xai-*.json` (CLIProxyAPI refreshes it
 *     with a 5-min lead — freshest file by `expired` wins), else
 *  2. managed grok account homes (`agent-accounts/grok/<id>/home/auth.json`,
 *     freshest by `expires_at` — kept alive by the accounts refresher), else
 *  3. the grok CLI's own `<grokHome>/auth.json` (refreshed whenever the CLI runs).
 * This is the ONE sanctioned reader of xai token material outside the proxy
 * subsystem (see the cliproxy-xai.ts invariant note): the token stays inside
 * this closure and never reaches an AgentUsage payload.
 */
async function readGrokCredential(
  authDir: string,
  grokHome: string,
  managedAuthFiles: readonly string[] = []
): Promise<GrokCredential | null> {
  let best: { cred: GrokCredential; expired: number } | null = null;
  try {
    for (const name of await readdir(authDir)) {
      if (!name.startsWith("xai-") || !name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(join(authDir, name), "utf8"));
        if (rec?.type !== "xai" || typeof rec.access_token !== "string" || !rec.access_token) continue;
        const expired = typeof rec.expired === "string" ? Date.parse(rec.expired) : NaN;
        const cred: GrokCredential = {
          token: rec.access_token,
          userId: typeof rec.sub === "string" && rec.sub ? rec.sub : null,
          expiresAtMs: Number.isFinite(expired) ? expired : null
        };
        if (!best || (Number.isFinite(expired) && expired > best.expired)) {
          best = { cred, expired: Number.isFinite(expired) ? expired : 0 };
        }
      } catch {
        /* corrupt/foreign file → skip */
      }
    }
  } catch {
    /* no cliproxy auth dir → fall through to the CLI login */
  }
  if (best) return best.cred;

  const fromAuthJson = async (file: string): Promise<GrokCredential | null> => {
    try {
      const auth = JSON.parse(await readFile(file, "utf8"));
      if (typeof auth === "object" && auth !== null) {
        // Keyed by issuer::client-id; prefer the auth.x.ai (SuperGrok) entry.
        const entries = Object.entries(auth as Record<string, any>).filter(
          ([, v]) => typeof v === "object" && v !== null && typeof v.key === "string" && v.key
        );
        const [, acct] = entries.find(([k]) => k.includes("auth.x.ai")) ?? entries[0] ?? [];
        if (acct) {
          const exp = typeof acct.expires_at === "string" ? Date.parse(acct.expires_at) : NaN;
          return {
            token: acct.key,
            userId: typeof acct.user_id === "string" && acct.user_id ? acct.user_id : null,
            expiresAtMs: Number.isFinite(exp) ? exp : null
          };
        }
      }
    } catch {
      /* missing/corrupt → try the next store */
    }
    return null;
  };

  // Managed account homes: freshest credential wins (mirrors the proxy-dir rule).
  let bestManaged: GrokCredential | null = null;
  for (const file of managedAuthFiles) {
    const cred = await fromAuthJson(file);
    if (cred && (!bestManaged || (cred.expiresAtMs ?? 0) > (bestManaged.expiresAtMs ?? 0))) {
      bestManaged = cred;
    }
  }
  if (bestManaged) return bestManaged;

  return fromAuthJson(join(grokHome, "auth.json"));
}

/**
 * Grok Build subscription usage via the first-party billing endpoint (the one
 * behind the grok CLI's /usage command). Undocumented and reverse-engineered —
 * same accepted-risk posture as routing Grok through the proxy — so every
 * failure path degrades to signed-in/stale rather than breaking the widget.
 */
export function createGrokSource(opts: {
  /** `<appdir>/daemon/cliproxy/auth` — the proxy-owned xai credential dir. */
  authDir: string;
  /** The grok CLI home (`GROK_HOME` || `~/.grok`). */
  grokHome: string;
  /** Managed grok account `auth.json` paths (re-evaluated per poll — accounts
   *  come and go without a daemon restart). */
  managedGrokAuthFiles?: () => string[];
  now: () => number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
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
    const cred = await readGrokCredential(opts.authDir, opts.grokHome, opts.managedGrokAuthFiles?.() ?? []);
    if (!cred) return null; // genuinely not linked/logged in

    const signedIn = (): AgentUsage =>
      lastGood
        ? { ...lastGood, stale: true, session: null, weekly: currentWindow(lastGood.weekly, opts.now()) }
        : { id: "grok", available: true, stale: true, session: null, weekly: null };

    const now = opts.now();
    if (now < backoffUntil) return signedIn();
    // Expired token: the proxy (or the CLI) refreshes it, never us — skip the
    // fetch, a 401 with a stale bearer would just churn.
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
        lastGood = agent;
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
    entries = await readdir(sessionsDir, { recursive: true } as { recursive: true });
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
 * Identity comparison is Codex-only (account_id / id_token email); Claude
 * credentials carry no identity, so Claude only gets the expiry rule.
 * Missing/unreadable credentials never hide — the source already reports null.
 */
export async function shouldHideSystemUsage(
  agent: "claude" | "codex",
  opts: { userhome: string; now: number; claudeHome?: string; codexHome?: string; managedHomes?: string[] }
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
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const doFetch = opts.fetchImpl ?? fetch;
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
