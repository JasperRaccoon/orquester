import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionSummary } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.js";
import { parseSessionOwner } from "./owner.ts";
import type { CreateAgentChatRequest } from "./service.ts";

// workflows spec §5.10: `owner` on `POST /api/sessions`. Route-level, with the inject-only harness
// of project-create-routes.test.ts — nothing listens and no host exists: `agentChat.createSession`
// is a fake that records what the route handed it.

type CreateServerArgs = Parameters<typeof createServer>;

const OWNER = { kind: "workflow", workflowId: "wf-1", runId: "run-1", nodeId: "node-1" } as const;

async function harness(): Promise<{
  created: CreateAgentChatRequest[];
  inject: ReturnType<typeof createServer>["inject"];
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-owner-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });
  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];
  const created: CreateAgentChatRequest[] = [];
  const services = {
    sessions: { list: () => [] },
    agentChat: {
      routeDeps: () => undefined,
      protectedPids: () => [],
      createSession: async (req: CreateAgentChatRequest, order: number): Promise<SessionSummary> => {
        created.push(req);
        return {
          id: "c1",
          kind: "agent-chat",
          refId: req.refId,
          title: "Claude",
          projectPath: req.projectPath ?? "",
          cwd: req.cwd ?? "",
          cols: 0,
          rows: 0,
          status: "running",
          order,
          createdAt: "2026-09-28T00:00:00.000Z",
          ...(req.owner ? { owner: req.owner } : {})
        };
      }
    }
  } as unknown as CreateServerArgs[4];
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: false, mode: "local" }
  );
  return {
    created,
    inject: app.inject.bind(app),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("parseSessionOwner accepts the four fields, strips anything else, refuses the rest", () => {
  assert.deepEqual(parseSessionOwner(undefined), { ok: true, owner: undefined });
  assert.deepEqual(parseSessionOwner({ ...OWNER, extra: "dropped" }), { ok: true, owner: OWNER });
  assert.equal(parseSessionOwner({ ...OWNER, workflowId: "w".repeat(200) }).ok, true);
  for (const bad of [
    null,
    "workflow",
    {},
    { ...OWNER, kind: "schedule" },
    { ...OWNER, workflowId: "" },
    { ...OWNER, runId: "  " },
    { ...OWNER, nodeId: 7 },
    { ...OWNER, workflowId: "w".repeat(201) }
  ]) {
    const parsed = parseSessionOwner(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    if (!parsed.ok) assert.equal(parsed.code, "INVALID_OWNER");
  }
});

test("POST /api/sessions hands a valid owner to the chat create and returns it on the summary", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const res = await h.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { kind: "agent-chat", refId: "claude", projectPath: "/w/p", owner: { ...OWNER, stray: 1 } }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().owner, OWNER);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.created[0]!.owner, OWNER, "only the four documented fields reach the service");
});

test("POST /api/sessions refuses a malformed owner with 400 INVALID_OWNER before anything is created", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  for (const owner of [{ ...OWNER, runId: "" }, { ...OWNER, kind: "cron" }, "wf-1", null]) {
    const res = await h.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { kind: "agent-chat", refId: "claude", projectPath: "/w/p", owner }
    });
    assert.equal(res.statusCode, 400, JSON.stringify(owner));
    assert.equal(res.json().code, "INVALID_OWNER");
  }
  assert.equal(h.created.length, 0);
});

test("POST /api/sessions refuses an owner on a terminal tab", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const res = await h.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { kind: "shell", refId: "sh", owner: OWNER }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "INVALID_OWNER");
});
