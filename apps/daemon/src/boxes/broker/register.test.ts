import assert from "node:assert/strict";
import { test } from "node:test";

import Fastify from "fastify";

import { boxRoutes } from "@orquester/api";

import type { AgentTokenBroker, BoxRequestContext, BoxRequestHandler } from "../contracts.ts";
import { AgentTokenError, parseTokenRequest } from "./broker.ts";
import { registerTokenBroker, registerTokenBrokerRoutes } from "./register.ts";
import { storedBox } from "./testing.ts";

function recordingBroker(answer: (request: unknown) => Promise<unknown>) {
  const seen: Array<{ request: unknown; signal: AbortSignal }> = [];
  const broker: AgentTokenBroker = {
    getToken: async (request, signal) => {
      seen.push({ request, signal });
      return (await answer(request)) as never;
    }
  };
  return { broker, seen };
}

test("token.get: the box id is the authenticated link's, never a request field", async () => {
  let handler: BoxRequestHandler<"token.get"> | undefined;
  const hub = {
    handle: (method: string, h: unknown) => {
      assert.equal(method, "token.get");
      handler = h as BoxRequestHandler<"token.get">;
    }
  };
  const { broker, seen } = recordingBroker(async (request) => {
    parseTokenRequest(request);
    return { accessToken: "a", expiresAt: null };
  });
  registerTokenBroker(hub as never, broker);
  const context: BoxRequestContext = { boxId: "box-linked", record: storedBox({ id: "box-linked" }) };
  const params = { agent: "claude", accountId: "acc", boxId: "box-other", rejectedAccessToken: "refused" } as never;
  assert.deepEqual(await handler!(context, params, new AbortController().signal), { accessToken: "a", expiresAt: null });
  assert.equal((seen[0].request as { boxId: string }).boxId, "box-linked");
  assert.equal((seen[0].request as { rejectedAccessToken?: string }).rejectedAccessToken, "refused", "the refused token reaches the broker");

  // The link's own signal still ends the wait.
  const link = new AbortController();
  await handler!(context, params, link.signal);
  link.abort();
  assert.equal(seen[1].signal.aborted, true);
});

test("the socket route answers grants, refusals as { code, message }, and no-store", async () => {
  const app = Fastify();
  const { broker, seen } = recordingBroker(async (request) => {
    const { accountId } = request as { accountId: string };
    if (accountId === "reauth") throw new AgentTokenError(409, "TOKEN_NEEDS_REAUTH", "Sign in again.");
    if (accountId === "boom") throw new Error("ENOENT /appdir/daemon/agent-accounts/claude/x/home/.credentials.json");
    return { accessToken: "tok", expiresAt: 5, extra: { chatgptAccountId: "ws" } };
  });
  registerTokenBrokerRoutes(app, broker);

  const ok = await app.inject({ method: "POST", url: boxRoutes.internalToken, payload: { boxId: "b", agent: "codex", accountId: "a" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { accessToken: "tok", expiresAt: 5, extra: { chatgptAccountId: "ws" } });
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal((seen[0].request as { minValidSeconds: number }).minValidSeconds, 45 * 60, "the default reaches the broker");

  const invalid = await app.inject({ method: "POST", url: boxRoutes.internalToken, payload: { boxId: "b", agent: "opencode", accountId: "a" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "TOKEN_INVALID_REQUEST");
  assert.equal(seen.length, 1, "an invalid body never reaches the broker");

  const reauth = await app.inject({ method: "POST", url: boxRoutes.internalToken, payload: { boxId: "b", agent: "claude", accountId: "reauth" } });
  assert.equal(reauth.statusCode, 409);
  assert.deepEqual(reauth.json(), { code: "TOKEN_NEEDS_REAUTH", message: "Sign in again." });

  const boom = await app.inject({ method: "POST", url: boxRoutes.internalToken, payload: { boxId: "b", agent: "claude", accountId: "boom" } });
  assert.equal(boom.statusCode, 500);
  assert.doesNotMatch(boom.body, /appdir|credentials/, "no file-system detail leaks");
  await app.close();
});
