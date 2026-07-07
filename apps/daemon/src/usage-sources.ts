import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentUsage } from "@orquester/api";
import { type UsagePrefs, parseAppConfig } from "@orquester/config";
import { findLastCodexTokenCount, parseClaudeUsage, parseCodexUsage } from "./usage-parse";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function readUsagePrefs(appConfigFile: string): Promise<UsagePrefs> {
  try {
    return parseAppConfig(JSON.parse(await readFile(appConfigFile, "utf8"))).usage;
  } catch {
    // ENOENT / corrupt → defaults (enabled).
    return { enabled: true, claude: true, codex: true, chip: "busiest" };
  }
}

export function createClaudeSource(opts: {
  userhome: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}): () => Promise<AgentUsage | null> {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(opts.userhome, ".claude");
  const credsFile = join(claudeHome, ".credentials.json");
  let lastGood: AgentUsage | null = null;

  // When the token is expired/401 but we have a prior good reading, show it greyed
  // (stale). With nothing cached yet, return null so the widget stays hidden rather
  // than rendering a misleading "0% • 0%".
  const staleClaude = (): AgentUsage | null =>
    lastGood
      ? { id: "claude", available: true, stale: true, plan: lastGood.plan, session: lastGood.session, weekly: lastGood.weekly }
      : null;

  return async () => {
    let oauth: any;
    try {
      oauth = JSON.parse(await readFile(credsFile, "utf8"))?.claudeAiOauth;
    } catch {
      return null; // not logged in
    }
    if (!oauth?.accessToken) return null;
    const creds = { subscriptionType: oauth.subscriptionType, rateLimitTier: oauth.rateLimitTier };
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= opts.now()) return staleClaude();
    try {
      const res = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
          Accept: "application/json"
        }
      });
      if (res.status === 401) return staleClaude();
      if (!res.ok) return lastGood; // transient; keep last-known
      const agent = parseClaudeUsage(await res.json(), creds, opts.now());
      if (agent.available) lastGood = agent;
      return agent;
    } catch (err) {
      opts.logger?.warn?.(`usage: claude fetch failed: ${String(err)}`);
      return lastGood;
    }
  };
}

async function newestRollout(sessionsDir: string): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true } as { recursive: true });
  } catch {
    return null; // no sessions dir yet
  }
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl") || !rel.includes("rollout-")) continue;
    const full = join(sessionsDir, rel);
    try {
      const s = await stat(full);
      if (!best || s.mtimeMs > best.mtime) best = { path: full, mtime: s.mtimeMs };
    } catch {
      /* ignore */
    }
  }
  return best?.path ?? null;
}

export function createCodexSource(opts: {
  userhome: string;
  now: () => number;
}): () => Promise<AgentUsage | null> {
  const codexHome = process.env.CODEX_HOME || join(opts.userhome, ".codex");
  return async () => {
    try {
      const auth = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
      if (auth?.OPENAI_API_KEY || auth?.auth_mode === "apikey") return null; // no subscription quota
    } catch {
      /* no auth.json — still try the logs */
    }
    const file = await newestRollout(join(codexHome, "sessions"));
    if (!file) return null;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    const rateLimits = findLastCodexTokenCount(text.split("\n"));
    if (!rateLimits) return null;
    const agent = parseCodexUsage(rateLimits, opts.now());
    return agent.available ? agent : null;
  };
}
