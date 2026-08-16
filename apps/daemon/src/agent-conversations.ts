/**
 * Past conversations of every installed coding agent, scoped to one project.
 *
 * Each CLI persists its own history in its own home dir in its own format, so
 * there is one lister per agent and a common `AgentConversationSummary` shape
 * out. Everything here reads OTHER tools' private files: every lister is
 * best-effort and independently try/caught to `[]`, so a missing dir, a
 * half-written JSON line or a permission error can only shrink the result —
 * never fail the request.
 *
 * SQLite-backed agents (opencode, cline, antigravity) are stubbed: Node 20 has
 * no `node:sqlite` and the daemon deliberately ships no native deps.
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentConversationHome, AgentConversationSummary } from "@orquester/api";
import { cliproxyDir } from "@orquester/config";

/** Max chars of any title/preview we hand back. */
const MAX_TITLE = 80;

/** Lines of a claude transcript scanned for a title before giving up. */
const CLAUDE_TITLE_LINES = 40;

/** Transcripts opened per agent, newest first. Bounds a long-lived host. */
const CLAUDE_MAX_FILES = 500;

/**
 * Codex organizes transcripts by DATE, not project, so listing one project
 * means opening every file's first line. Bounded to the most recent N files
 * (newest date dirs first) to keep the endpoint fast on a long-lived host.
 */
const CODEX_MAX_FILES = 500;

/** Lines of a matched codex transcript scanned for the first human message. */
const CODEX_TITLE_LINES = 400;

/** Session dirs read per grok project dir, newest first. */
const GROK_MAX_SESSIONS = 500;

/** Backstop against a pathologically large kimi index. */
const KIMI_MAX_LINES = 20_000;

/** Matching kimi sessions kept (the newest ones — see `listKimi`). */
const KIMI_MAX_SESSIONS = 500;

/** Files opened at once while scanning transcripts. */
const READ_CONCURRENCY = 16;

export interface AgentConversationOptions {
  /**
   * `<appdir>/daemon`. Supplying it lets the scan see MANAGED agent homes as
   * well as the daemon's own HOME — see `agentHomeRoots`.
   */
  daemonDir?: string;
}

/**
 * Every agent's conversations for `projectPath` (an absolute path), newest
 * first. Listers run concurrently; a failing one contributes nothing.
 */
export async function listAgentConversations(
  projectPath: string,
  opts: AgentConversationOptions = {}
): Promise<AgentConversationSummary[]> {
  const roots = await agentHomeRoots(opts.daemonDir);
  const listers: Array<() => Promise<AgentConversationSummary[]>> = [
    () => listClaude(projectPath, roots.claude),
    () => listCodex(projectPath, roots.codex),
    () => listGrok(projectPath, roots.grok),
    () => listKimi(projectPath),
    () => listOpencode(projectPath),
    () => listCline(projectPath),
    () => listAntigravity(projectPath)
  ];
  const results = await Promise.all(listers.map((run) => safely(run)));
  const sorted = results
    .flat()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return dedupe(sorted);
}

async function safely(run: () => Promise<AgentConversationSummary[]>): Promise<AgentConversationSummary[]> {
  try {
    return await run();
  } catch {
    return [];
  }
}

/**
 * The same conversation id can surface under two roots (a managed home seeded
 * from the system one, an account home re-imported under a new id). Keep the
 * first occurrence — the list is already newest-first.
 */
function dedupe(rows: AgentConversationSummary[]): AgentConversationSummary[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.agentRefId}\x00${row.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// home roots
// ---------------------------------------------------------------------------

/**
 * One history home, plus who owns it. Every row a lister emits is stamped with
 * its root's attribution: the same conversation id means nothing outside the
 * home that holds the transcript, so a client offering "resume" has to relaunch
 * under that home (a managed account, a proxy launcher, or the daemon's own).
 */
interface AgentHomeRoot {
  dir: string;
  home: AgentConversationHome;
  /** Managed agent-account id — "account" homes only. */
  accountId?: string;
  /** Launcher entry id (claudex/claudemix) — "cliproxy" homes only. */
  proxyRefId?: string;
}

interface AgentHomeRoots {
  claude: AgentHomeRoot[];
  codex: AgentHomeRoot[];
  grok: AgentHomeRoot[];
}

/** The attribution fields of a root, spreadable into a summary. */
function attribution(root: AgentHomeRoot): Pick<AgentConversationSummary, "home" | "accountId" | "proxyRefId"> {
  return {
    home: root.home,
    ...(root.accountId ? { accountId: root.accountId } : {}),
    ...(root.proxyRefId ? { proxyRefId: root.proxyRefId } : {})
  };
}

/**
 * Every home dir an agent family may have written history into.
 *
 * Scanning only the daemon's own HOME would hide most of it on this fork: a
 * session launched under a MANAGED ACCOUNT runs with a relocated home
 * (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME` →
 * `<daemonDir>/agent-accounts/<family>/<id>/home`, see `agent-accounts.ts`),
 * and the claudex/claudemix launchers run against
 * `<daemonDir>/cliproxy/claude-home-<entryId>` (see `cliproxy-files.ts`) —
 * the same set `agent-hooks.ts` installs hooks into. Best-effort throughout:
 * an unreadable dir simply contributes no roots.
 */
async function agentHomeRoots(daemonDir?: string): Promise<AgentHomeRoots> {
  const home = homedir();
  const roots: AgentHomeRoots = {
    claude: [{ dir: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), home: "system" }],
    codex: [{ dir: process.env.CODEX_HOME || join(home, ".codex"), home: "system" }],
    grok: [{ dir: process.env.GROK_HOME || join(home, ".grok"), home: "system" }]
  };
  if (!daemonDir) {
    return roots;
  }
  const accountsDir = join(daemonDir, "agent-accounts");
  const families = ["claude", "codex", "grok"] as const;
  await Promise.all(
    families.map(async (family) => {
      for (const id of await subdirNames(join(accountsDir, family))) {
        roots[family].push({ dir: join(accountsDir, family, id, "home"), home: "account", accountId: id });
      }
    })
  );
  const proxyDir = cliproxyDir(daemonDir);
  const CLAUDE_HOME_PREFIX = "claude-home-";
  for (const name of await subdirNames(proxyDir)) {
    if (name.startsWith(CLAUDE_HOME_PREFIX)) {
      roots.claude.push({
        dir: join(proxyDir, name),
        home: "cliproxy",
        // `claude-home-<entryId>` (cliproxy-files.ts) — the launcher that owns it.
        proxyRefId: name.slice(CLAUDE_HOME_PREFIX.length)
      });
    }
  }
  for (const family of families) {
    const seen = new Set<string>();
    roots[family] = roots[family].filter((root) => {
      if (seen.has(root.dir)) {
        return false;
      }
      seen.add(root.dir);
      return true;
    });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// claude — <home>/projects/<slug>/<session-uuid>.jsonl
// ---------------------------------------------------------------------------

/**
 * One `.jsonl` transcript per session, in a directory named after the
 * project's absolute path with every separator replaced by `-`. `updatedAt` is
 * the file's mtime: the format has no last-activity field.
 */
async function listClaude(projectPath: string, roots: readonly AgentHomeRoot[]): Promise<AgentConversationSummary[]> {
  const slug = projectPath.replace(/[/\\]/g, "-");
  const files: RootedPath[] = [];
  for (const dir of await distinctDirs(roots.map((root) => ({ path: join(root.dir, "projects", slug), root })))) {
    const entries = await readdir(dir.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name.endsWith(".jsonl")) {
        files.push({ path: join(dir.path, entry.name), root: dir.root });
      }
    }
  }
  // Newest first, then capped: a years-old home can hold thousands of
  // transcripts and each one costs an open + a 40-line parse.
  const newest = await newestFirst(files, CLAUDE_MAX_FILES);
  const rows = await mapBounded(newest, READ_CONCURRENCY, async (file) => {
    // Per file, not per directory: one unreadable transcript must not cost the
    // whole listing.
    const found = await claudeTitle(file.path).catch(() => undefined);
    if (!found) {
      return undefined;
    }
    const summary: AgentConversationSummary = {
      id: basename(file.path).slice(0, -".jsonl".length),
      agentRefId: "claude",
      title: found.title,
      updatedAt: isoStamp(file.mtimeMs, found.createdAt),
      ...attribution(file.root)
    };
    return summary;
  });
  return rows.filter(isDefined);
}

/**
 * Scans the first 40 lines rather than stopping at the first `type:"user"`:
 * Claude Code wraps slash-command output in a `<local-command-caveat>` message
 * ahead of the real first prompt, and its own auto-generated `slug` (a much
 * nicer title) doesn't always land on the first line either. `slug` wins
 * wherever it is found. Returns undefined when the file has no user line at
 * all — an empty transcript is not worth offering as a resume target.
 */
async function claudeTitle(path: string): Promise<{ title: string; createdAt?: string } | undefined> {
  let sawUser = false;
  let createdAt: string | undefined;
  let clean: string | undefined;
  let scanned = 0;
  for await (const line of fileLines(path)) {
    if (++scanned > CLAUDE_TITLE_LINES) {
      break;
    }
    const value = parseJson(line);
    if (!value || value.type !== "user") {
      continue;
    }
    sawUser = true;
    // Earliest timestamp wins, but an untimestamped first user line must not
    // latch a permanent "no timestamp" — keep looking.
    createdAt ??= asString(value.timestamp);
    const slug = asString(value.slug);
    if (slug) {
      return { title: summarize(slug.replace(/-/g, " ")), createdAt };
    }
    if (clean !== undefined) {
      continue;
    }
    const text = claudeMessageText(value.message);
    // An injected wrapper (`<local-command-caveat>`, `<system-reminder>`, a
    // pasted attachment) or a giant paste is not what the human typed.
    if (!text || text.startsWith("<") || text.length > 4000) {
      continue;
    }
    clean = summarize(text);
  }
  if (!sawUser) {
    return undefined;
  }
  return { title: clean ?? "Untitled session", createdAt };
}

function claudeMessageText(message: unknown): string | undefined {
  const content = asRecord(message)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const text = asString(asRecord(block)?.text);
    if (text) {
      return text;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// codex — <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------

/**
 * Organized by date, not by project, so the only way to scope to a project is
 * to read each file's first line (always the `session_meta` record, which
 * carries `payload.cwd`). Bounded by CODEX_MAX_FILES, newest dates first.
 */
async function listCodex(projectPath: string, roots: readonly AgentHomeRoot[]): Promise<AgentConversationSummary[]> {
  const files: RootedPath[] = [];
  for (const dir of await distinctDirs(roots.map((root) => ({ path: join(root.dir, "sessions"), root })))) {
    for (const path of await codexTranscripts(dir.path)) {
      files.push({ path, root: dir.root });
    }
  }
  // A transcript's filename starts with its ISO start time, so sorting by
  // basename merges the per-root walks chronologically without a stat() each.
  files.sort((a, b) => compareDesc(basename(a.path), basename(b.path)));
  const rows = await mapBounded(files.slice(0, CODEX_MAX_FILES), READ_CONCURRENCY, async (file) => {
    const summary = await codexConversation(file.path, projectPath).catch(() => undefined);
    return summary && { ...summary, ...attribution(file.root) };
  });
  return rows.filter(isDefined);
}

/** Transcript paths under YYYY/MM/DD, newest first, capped. */
async function codexTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const year of await subdirsDesc(root)) {
    for (const month of await subdirsDesc(join(root, year))) {
      for (const day of await subdirsDesc(join(root, year, month))) {
        const dir = join(root, year, month, day);
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        // Newest first WITHIN the day as well, so a cap that lands mid-day
        // keeps the newest transcripts rather than readdir's arbitrary order.
        const names = entries
          .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name)
          .sort()
          .reverse();
        for (const name of names) {
          out.push(join(dir, name));
          if (out.length >= CODEX_MAX_FILES) {
            return out;
          }
        }
      }
    }
  }
  return out;
}

/**
 * The given history dirs with symlink aliases collapsed (first spelling wins),
 * and unreadable ones dropped. A managed account home seeds itself by
 * SYMLINKING `projects`/`sessions` back at the daemon's own agent home (see
 * `agent-accounts.ts`), so without this the same transcripts get scanned once
 * per account — spending the per-agent cap on duplicates and pushing real
 * history out of the list. The surviving spelling also decides the rows'
 * attribution, and the system home is listed first: transcripts an account home
 * merely symlinks to are reported (correctly) as resumable under the system home.
 */
async function distinctDirs(dirs: readonly RootedPath[]): Promise<RootedPath[]> {
  const seen = new Set<string>();
  const out: RootedPath[] = [];
  for (const dir of dirs) {
    const real = await realpath(dir.path).catch(() => undefined);
    if (real === undefined || seen.has(real)) {
      continue;
    }
    seen.add(real);
    out.push(dir);
  }
  return out;
}

async function subdirsDesc(dir: string): Promise<string[]> {
  return (await subdirNames(dir)).sort().reverse();
}

async function subdirNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function codexConversation(path: string, projectPath: string): Promise<AgentConversationSummary | undefined> {
  let title: string | undefined;
  let id: string | undefined;
  let scanned = 0;
  for await (const line of fileLines(path)) {
    scanned += 1;
    const value = parseJson(line);
    if (scanned === 1) {
      // First line or nothing: a transcript whose head isn't session_meta for
      // this project can be abandoned without reading the rest of the file.
      const payload = value?.type === "session_meta" ? asRecord(value.payload) : undefined;
      if (!payload || payload.cwd !== projectPath) {
        return undefined;
      }
      id = asString(payload.session_id) ?? asString(payload.id);
      if (!id) {
        return undefined;
      }
      continue;
    }
    if (scanned > CODEX_TITLE_LINES) {
      break;
    }
    if (!value || value.type !== "response_item") {
      continue;
    }
    const item = asRecord(value.payload);
    if (!item || item.role !== "user") {
      continue;
    }
    const text = codexInputText(item.content);
    // Codex prepends injected context (AGENTS.md, skills, the plugin banner)
    // as ordinary user turns; size plus a leading `#`/`<` separates those from
    // what the human actually typed. A heuristic, not exact.
    if (!text || text.length > 2000 || text.startsWith("#") || text.startsWith("<")) {
      continue;
    }
    title = summarize(text);
    break;
  }
  if (!id) {
    return undefined;
  }
  return {
    id,
    agentRefId: "codex",
    title: title ?? "Untitled session",
    updatedAt: isoStamp(await mtimeMs(path))
  };
}

function codexInputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "input_text") {
      const text = asString(record.text);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// grok — <home>/sessions/<encoded project path>/<session-uuid>/summary.json
// ---------------------------------------------------------------------------

/**
 * The richest metadata of any agent here (its own generated title, a summary
 * blurb and a real last-activity timestamp), so this is a near-direct field
 * mapping. The directory name is the project's absolute path put through
 * encodeURIComponent.
 */
async function listGrok(projectPath: string, roots: readonly AgentHomeRoot[]): Promise<AgentConversationSummary[]> {
  const encoded = encodeURIComponent(projectPath);
  const dirs: RootedPath[] = [];
  for (const dir of await distinctDirs(roots.map((root) => ({ path: join(root.dir, "sessions", encoded), root })))) {
    for (const name of await subdirNames(dir.path)) {
      dirs.push({ path: join(dir.path, name), root: dir.root });
    }
  }
  const newest = await newestFirst(dirs, GROK_MAX_SESSIONS);
  const rows = await mapBounded(newest, READ_CONCURRENCY, async (entry) => {
    const raw = await readFile(join(entry.path, "summary.json"), "utf8").catch(() => undefined);
    const value = raw === undefined ? undefined : parseJson(raw);
    if (!value) {
      return undefined;
    }
    const id = asString(asRecord(value.info)?.id) ?? basename(entry.path);
    const generated = asString(value.generated_title);
    const blurb = asString(value.session_summary);
    const title = summarize(generated ?? blurb ?? "Untitled session");
    const preview = blurb === undefined ? undefined : summarize(blurb);
    const summary: AgentConversationSummary = {
      id,
      agentRefId: "grok",
      title,
      // Grok often stores the same string in both fields; a preview that just
      // repeats the title is noise.
      ...(preview && preview !== title ? { preview } : {}),
      updatedAt: isoStamp(asString(value.last_active_at), asString(value.updated_at), entry.mtimeMs),
      ...attribution(entry.root)
    };
    return summary;
  });
  return rows.filter(isDefined);
}

// ---------------------------------------------------------------------------
// kimi — ~/.kimi-code/session_index.jsonl + <sessionDir>/state.json
// ---------------------------------------------------------------------------

/**
 * A flat `{sessionId, sessionDir, workDir}` index — the cleanest per-project
 * lookup of any agent here, with no path encoding to reverse. The title and
 * timestamps live in each session's own `state.json`.
 *
 * The index is append-ordered, so the matches worth keeping are the LAST ones:
 * the window drops from the front. The line cap is only a backstop against a
 * pathologically large index.
 */
async function listKimi(projectPath: string): Promise<AgentConversationSummary[]> {
  const indexPath = join(homedir(), ".kimi-code", "session_index.jsonl");
  const matches: Array<{ id: string; sessionDir: string }> = [];
  let scanned = 0;
  for await (const line of fileLines(indexPath)) {
    if (++scanned > KIMI_MAX_LINES) {
      break;
    }
    const entry = parseJson(line);
    if (!entry || entry.workDir !== projectPath) {
      continue;
    }
    const id = asString(entry.sessionId);
    const sessionDir = asString(entry.sessionDir);
    if (!id || !sessionDir) {
      continue;
    }
    matches.push({ id, sessionDir });
    if (matches.length > KIMI_MAX_SESSIONS) {
      matches.shift();
    }
  }
  const rows = await mapBounded(matches, READ_CONCURRENCY, async (match) => {
    const raw = await readFile(join(match.sessionDir, "state.json"), "utf8").catch(() => undefined);
    const state = raw === undefined ? undefined : parseJson(raw);
    if (!state) {
      return undefined;
    }
    const summary: AgentConversationSummary = {
      id: match.id,
      agentRefId: "kimi",
      title: summarize(asString(state.title) ?? "Untitled session"),
      updatedAt: isoStamp(asString(state.updatedAt), await mtimeMs(join(match.sessionDir, "state.json"))),
      // Kimi has no relocatable home here: the index is always the daemon's own.
      home: "system"
    };
    return summary;
  });
  return rows.filter(isDefined);
}

// ---------------------------------------------------------------------------
// SQLite-backed agents — stubs until the daemon can read SQLite without a
// native dependency (Node 20 has no `node:sqlite`).
// ---------------------------------------------------------------------------

/** History lives in `~/.local/share/opencode/opencode.db` (table `session`). */
async function listOpencode(_projectPath: string): Promise<AgentConversationSummary[]> {
  return [];
}

/** History lives in `~/.cline/data/db/sessions.db` (table `sessions`). */
async function listCline(_projectPath: string): Promise<AgentConversationSummary[]> {
  return [];
}

/** History lives in `~/.gemini/antigravity-cli/conversation_summaries.db`. */
async function listAntigravity(_projectPath: string): Promise<AgentConversationSummary[]> {
  return [];
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * A file's lines, read lazily — abandoning the loop stops the read, which is
 * the point: most transcripts are only inspected for their first line.
 */
async function* fileLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Runs `run` over `items` with at most `limit` in flight, preserving order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A path plus the home root it was discovered under (carries attribution). */
interface RootedPath {
  path: string;
  root: AgentHomeRoot;
}

/** Paths newest-first and capped, so a huge history dir stays bounded. */
async function newestFirst<T extends { path: string }>(
  paths: readonly T[],
  cap: number
): Promise<Array<T & { /** 0 when the path could not be stat()ed — sorts last. */ mtimeMs: number }>> {
  const dated = await mapBounded(paths, READ_CONCURRENCY, async (entry) => ({
    ...entry,
    mtimeMs: await mtimeMs(entry.path)
  }));
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dated.slice(0, cap);
}

function parseJson(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Collapse whitespace to single spaces and clip to MAX_TITLE chars. */
function summarize(text: string): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if ([...collapsed].length <= MAX_TITLE) {
    return collapsed;
  }
  return `${[...collapsed].slice(0, MAX_TITLE).join("").trimEnd()}…`;
}

/**
 * One canonical millisecond-precision UTC stamp per row, from the first
 * parsable candidate. Agents disagree on precision — grok writes NANOSECOND
 * ISO stamps, claude/kimi millisecond ones — and mixed-precision ISO text does
 * not compare correctly as a string, so without this the cross-agent sort is
 * lexicographic rather than chronological. Nothing parsable ⇒ "" (sorts last).
 */
function isoStamp(...candidates: Array<string | number | undefined>): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") {
      continue;
    }
    const ms = typeof candidate === "number" ? candidate : Date.parse(candidate);
    if (Number.isFinite(ms) && ms > 0) {
      return new Date(ms).toISOString();
    }
  }
  return "";
}

/** A file's mtime in epoch ms, or 0 when it cannot be read. */
async function mtimeMs(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  return info?.mtimeMs ?? 0;
}
