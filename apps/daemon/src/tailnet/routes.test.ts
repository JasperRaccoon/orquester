import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import { tailnetRoutes, type TailnetPreviewShare } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi, withPrincipal } from "../mcp/daemon-api.ts";
import { registerPrincipalHook } from "../mcp/principal.ts";
import { registerTailnetRoutes } from "./routes.ts";
import { TailnetError, type SharePreviewInput, type TailnetService } from "./service.ts";

const share = (port: number, threadId: string | null): TailnetPreviewShare => ({ port, url: `https://pc.tail1.ts.net:${port}`, threadId, createdAt: "2026-11-22T10:00:00.000Z" });

test("an agent shares and lists only its own chat's previews, from its principal; the owner settings refuse it", async (t) => {
  const shared: SharePreviewInput[] = [];
  const stopped: { port: number; threadId?: string }[] = [];
  const disabled: boolean[] = [];
  const service = {
    previews: (threadId?: string) => [share(5173, "c1"), share(6000, null)].filter((entry) => threadId === undefined || entry.threadId === threadId),
    sharePreview: async (input: SharePreviewInput) => {
      shared.push(input);
      if (input.port === 3000) {
        throw new TailnetError(409, "TAILNET_PROBLEM", "pc.tail1.ts.net:3000 already serves http://127.0.0.1:3000.", { code: "serve-port-taken", message: "taken", fix: "use another port" });
      }
      return share(input.port, input.threadId);
    },
    stopPreview: async (port: number, options: { threadId?: string } = {}) => {
      stopped.push({ port, ...options });
      return [];
    },
    enableHttps: async () => assert.fail("an agent must not change the tailnet address"),
    disableHttps: async (options: { confirm?: boolean } = {}) => {
      disabled.push(options.confirm === true);
      return { available: true, url: null, operatorOk: true, serveState: "off", port: 10000, checkedAt: null };
    }
  } as unknown as TailnetService;
  const app = Fastify();
  t.after(() => app.close());
  registerPrincipalHook(app);
  registerTailnetRoutes(app, { service });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/w", workspacesDir: "/w" });
  const agent: CallerPrincipal = { kind: "agent", threadId: "c1", projectPath: "/w/acme/api" };
  const asAgent = withPrincipal(api, agent);

  const created = await asAgent.request("POST", tailnetRoutes.previews, { body: { port: 5173, threadId: "someone-else" } });
  assert.equal(created.status, 200);
  assert.deepEqual(shared[0], { port: 5173, threadId: "c1", projectPath: "/w/acme/api" });
  assert.deepEqual(((await asAgent.request("GET", tailnetRoutes.previews)).body as { previews: TailnetPreviewShare[] }).previews.map((entry) => entry.port), [5173]);
  await asAgent.request("DELETE", tailnetRoutes.preview(6000));
  assert.deepEqual(stopped[0], { port: 6000, threadId: "c1" });

  const taken = await asAgent.request("POST", tailnetRoutes.previews, { body: { port: 3000 } });
  assert.equal(taken.status, 409);
  assert.equal((taken.body as { problem: { code: string } }).problem.code, "serve-port-taken");

  assert.equal((await asAgent.request("POST", tailnetRoutes.https)).status, 403);
  assert.equal((await asAgent.request("POST", tailnetRoutes.operator)).status, 403);

  // The owner confirms turning the address off with the query flag only.
  await api.request("DELETE", tailnetRoutes.https);
  await api.request("DELETE", tailnetRoutes.https, { query: { confirm: "true" } });
  assert.deepEqual(disabled, [false, true]);

  // The owner names a chat or none, and lists every share.
  await api.request("POST", tailnetRoutes.previews, { body: { port: 8080 } });
  assert.deepEqual(shared[2], { port: 8080, threadId: null });
  assert.equal(((await api.request("GET", tailnetRoutes.previews)).body as { previews: unknown[] }).previews.length, 2);
});
