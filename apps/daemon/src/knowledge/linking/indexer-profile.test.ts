import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveForAgent } from "../../session-profiles/resolve.ts";
import { SessionProfileService } from "../../session-profiles/service.ts";
import { SessionProfileStore } from "../../session-profiles/store.ts";
import {
  KNOWLEDGE_INDEXER_INSTRUCTIONS,
  KNOWLEDGE_INDEXER_PROFILE_ID,
  KNOWLEDGE_WORKER_NEXT_TOOL,
  KNOWLEDGE_WORKER_SUBMIT_TOOL,
  ensureKnowledgeIndexerProfile
} from "./indexer-profile.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("the Knowledge indexer profile", () => {
  it("is ensured idempotently, hidden from users, empty, and launches Claude without built-in tools", async () => {
    const appdir = await mkdtemp(join(tmpdir(), "orq-indexer-profile-"));
    roots.push(appdir);
    const store = new SessionProfileStore({ appdir });
    await store.init();
    const service = new SessionProfileService({ store });
    const changed: unknown[] = [];
    service.events.on("changed", (payload) => changed.push(payload));
    assert.equal(await ensureKnowledgeIndexerProfile(service), KNOWLEDGE_INDEXER_PROFILE_ID);
    assert.equal(await ensureKnowledgeIndexerProfile(service), KNOWLEDGE_INDEXER_PROFILE_ID);
    assert.equal(changed.length, 1, "prepared once, not on every ensure");
    assert.deepEqual((await service.list()).profiles, [], "never in a user-facing list");

    const source = await store.readSource(KNOWLEDGE_INDEXER_PROFILE_ID);
    assert.deepEqual(source.items, []);
    const claude = resolveForAgent(source, "claude");
    assert.deepEqual(claude.settings, { hideBuiltinSkills: true, claudeWorkflowTool: false, claudeBuiltinTools: false });
    assert.deepEqual([claude.skills, claude.commands, claude.mcpServers, claude.hooks, claude.plugins], [[], [], [], [], []]);
    assert.equal(claude.instructions.trim(), KNOWLEDGE_INDEXER_INSTRUCTIONS.trim());
    for (const agent of ["codex", "grok", "opencode"] as const) assert.equal(resolveForAgent(source, agent).settings.hideBuiltinSkills, true);
  });

  it("tells the chat to work only through the two worker tools and to answer JSON only", () => {
    assert.match(KNOWLEDGE_INDEXER_INSTRUCTIONS, new RegExp(KNOWLEDGE_WORKER_NEXT_TOOL));
    assert.match(KNOWLEDGE_INDEXER_INSTRUCTIONS, new RegExp(KNOWLEDGE_WORKER_SUBMIT_TOOL));
    assert.match(KNOWLEDGE_INDEXER_INSTRUCTIONS, /ONLY the JSON/);
    assert.match(KNOWLEDGE_INDEXER_INSTRUCTIONS, /sameInstructionsAs/);
    assert.match(KNOWLEDGE_INDEXER_INSTRUCTIONS, /Never use any other tool/);
    assert.ok(Buffer.byteLength(KNOWLEDGE_INDEXER_INSTRUCTIONS) < 1200, "short: it rides every worker chat's system prompt");
  });
});
