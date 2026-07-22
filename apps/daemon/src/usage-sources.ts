import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage } from "@orquester/api";
import { type UsagePrefs, parseAppConfig } from "@orquester/config";
import { claudePlanLabel, findLastCodexTokenCount, parseClaudeUsage, parseCodexUsage, parseCodexWhamUsage } from "./usage-parse";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export async function readUsagePrefs(appConfigFile: string): Promise<UsagePrefs> {
  try {
    return parseAppConfig(JSON.parse(await readFile(appConfigFile, "utf8"))).usage;
  } catch {
    // ENOENT / corrupt → defaults (enabled).
    return { enabled: true, agents: {}, chip: "busiest", view: "aggregate" };
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
    const signedIn = (): AgentUsage =>
      lastGood
        ? { ...lastGood, stale: true }
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
