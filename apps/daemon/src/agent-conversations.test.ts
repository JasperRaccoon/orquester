import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAgentConversations } from "./agent-conversations.ts";

/**
 * The listers read the daemon user's REAL history dirs by default, so every
 * test pins the three system homes at empty scratch dirs first. (Kimi's index
 * is not relocatable, but it is keyed by workDir and these project paths are
 * unique temp dirs, so it can never match.)
 */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orquester-conversations-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "system-claude");
  process.env.CODEX_HOME = join(root, "system-codex");
  process.env.GROK_HOME = join(root, "system-grok");
  return root;
}

/** A minimal claude transcript: one user line is all `claudeTitle` needs. */
async function writeClaudeTranscript(home: string, projectPath: string, id: string, text: string): Promise<void> {
  const dir = join(home, "projects", projectPath.replace(/[/\\]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: text }
    })}\n`,
    "utf8"
  );
}

test("every conversation is attributed to the home it was read from", async () => {
  const root = await scratch();
  const daemonDir = join(root, "daemon");
  const projectPath = join(root, "workspaces", "acme", "site");
  await mkdir(projectPath, { recursive: true });

  await writeClaudeTranscript(process.env.CLAUDE_CONFIG_DIR as string, projectPath, "sys-1", "from the system home");
  await writeClaudeTranscript(
    join(daemonDir, "agent-accounts", "claude", "acc1f2e3", "home"),
    projectPath,
    "acct-1",
    "from a managed account"
  );
  await writeClaudeTranscript(
    join(daemonDir, "cliproxy", "claude-home-claudemix"),
    projectPath,
    "proxy-1",
    "from a proxy launcher"
  );

  const rows = await listAgentConversations(projectPath, { daemonDir });
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(new Set(byId.keys()), new Set(["sys-1", "acct-1", "proxy-1"]));

  // The daemon's own HOME: nothing to relaunch under, so no account/proxy id.
  assert.deepEqual(
    { home: byId.get("sys-1")?.home, accountId: byId.get("sys-1")?.accountId, proxyRefId: byId.get("sys-1")?.proxyRefId },
    { home: "system", accountId: undefined, proxyRefId: undefined }
  );
  // A managed agent-account home carries the account id a relaunch needs.
  assert.deepEqual(
    { home: byId.get("acct-1")?.home, accountId: byId.get("acct-1")?.accountId },
    { home: "account", accountId: "acc1f2e3" }
  );
  // A cliproxy home carries the launcher entry id (`claude-home-<entryId>`).
  assert.deepEqual(
    { home: byId.get("proxy-1")?.home, accountId: byId.get("proxy-1")?.accountId, proxyRefId: byId.get("proxy-1")?.proxyRefId },
    { home: "cliproxy", accountId: undefined, proxyRefId: "claudemix" }
  );

  await rm(root, { recursive: true, force: true });
});

test("a codex account home is attributed, and unrelated projects are ignored", async () => {
  const root = await scratch();
  const daemonDir = join(root, "daemon");
  const projectPath = join(root, "workspaces", "acme", "api");
  const otherPath = join(root, "workspaces", "acme", "other");

  const home = join(daemonDir, "agent-accounts", "codex", "accbeef", "home");
  const day = join(home, "sessions", "2026", "01", "02");
  await mkdir(day, { recursive: true });
  const meta = (cwd: string, id: string) =>
    `${JSON.stringify({ type: "session_meta", payload: { cwd, session_id: id } })}\n`;
  await writeFile(join(day, "rollout-2026-01-02T03-04-05-mine.jsonl"), meta(projectPath, "codex-mine"), "utf8");
  await writeFile(join(day, "rollout-2026-01-02T03-04-06-other.jsonl"), meta(otherPath, "codex-other"), "utf8");

  const rows = await listAgentConversations(projectPath, { daemonDir });
  assert.deepEqual(
    rows.map((row) => [row.id, row.agentRefId, row.home, row.accountId]),
    [["codex-mine", "codex", "account", "accbeef"]]
  );

  await rm(root, { recursive: true, force: true });
});

test("without a daemonDir only the system homes are scanned", async () => {
  const root = await scratch();
  const daemonDir = join(root, "daemon");
  const projectPath = join(root, "workspaces", "acme", "solo");

  await writeClaudeTranscript(process.env.CLAUDE_CONFIG_DIR as string, projectPath, "sys-only", "hello");
  await writeClaudeTranscript(
    join(daemonDir, "agent-accounts", "claude", "acchidden", "home"),
    projectPath,
    "acct-hidden",
    "hello"
  );

  const rows = await listAgentConversations(projectPath);
  assert.deepEqual(rows.map((row) => row.id), ["sys-only"]);
  assert.equal(rows[0]?.home, "system");

  await rm(root, { recursive: true, force: true });
});
