import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSource } from "./usage-sources.ts";

const NOW = Date.parse("2026-07-21T08:00:00Z");

/** Minimal Response stand-in for the Claude usage fetch (200 OK, JSON body). */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body
  } as unknown as Response;
}

test("createClaudeSource honors an explicit claudeHome for credentials", async (t) => {
  // Ensure the env override can't leak in during construction.
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  });

  const claudeHome = await mkdtemp(join(tmpdir(), "orq-claude-home-"));
  const userhome = await mkdtemp(join(tmpdir(), "orq-userhome-"));
  t.after(async () => {
    await rm(claudeHome, { recursive: true, force: true });
    await rm(userhome, { recursive: true, force: true });
  });

  await writeFile(
    join(claudeHome, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", subscriptionType: "max" } })
  );

  let fetched = false;
  const source = createClaudeSource({
    userhome,
    now: () => NOW,
    claudeHome,
    fetchImpl: (async () => {
      fetched = true;
      return okResponse({ five_hour: { utilization: 12 } });
    }) as unknown as typeof fetch
  });

  const usage = await source();
  assert.ok(fetched, "should read credentials from the explicit claudeHome and fetch usage");
  assert.equal(usage?.available, true);
  assert.equal(usage?.session?.percent, 12);
});

test("createClaudeSource without claudeHome falls back to userhome/.claude", async (t) => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  });

  const userhome = await mkdtemp(join(tmpdir(), "orq-userhome-"));
  t.after(async () => {
    await rm(userhome, { recursive: true, force: true });
  });
  await mkdir(join(userhome, ".claude"), { recursive: true });
  await writeFile(
    join(userhome, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "tok", subscriptionType: "pro" } })
  );

  const source = createClaudeSource({
    userhome,
    now: () => NOW,
    fetchImpl: (async () => okResponse({ five_hour: { utilization: 7 } })) as unknown as typeof fetch
  });

  const usage = await source();
  assert.equal(usage?.available, true);
  assert.equal(usage?.session?.percent, 7);
});
