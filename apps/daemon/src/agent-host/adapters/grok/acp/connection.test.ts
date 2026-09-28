/**
 * The ACP handshake's auth-method choice (R4 #2).
 *
 * The rule is a security one: on a home with no `auth.json` the agent
 * advertises ONLY `grok.com` ("Sign in with Grok") and names no default, so
 * "the first advertised method" was a rule for starting an interactive browser
 * login on a headless stdio session nobody can see.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { InitializeResponse } from "./_generated/schema.ts";
import { AcpConnection } from "./connection.ts";

function initialize(input: {
  authMethods?: Array<{ id: string; name: string; description?: string }>;
  defaultAuthMethodId?: string | null;
}): InitializeResponse {
  return {
    protocolVersion: 1,
    ...(input.authMethods === undefined ? {} : { authMethods: input.authMethods }),
    _meta: { defaultAuthMethodId: input.defaultAuthMethodId ?? null }
  } as unknown as InitializeResponse;
}

/** A real stdio peer supplies the advertised methods, without selecting one. */
async function sentAuthMethod(response: InitializeResponse): Promise<string | null> {
  const sent: Array<{ method?: string; params?: { methodId?: string } }> = [];
  const connection = AcpConnection.spawn({
    command: process.execPath,
    args: ["--input-type=module", "--eval", `
      import { createInterface } from "node:readline";
      const response = JSON.parse(process.env.GROK_TEST_INITIALIZE);
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: request.method === "initialize" ? response : {}
        }) + "\\n");
      }
    `],
    env: { GROK_TEST_INITIALIZE: JSON.stringify(response) },
    cwd: process.cwd(),
    clientInfo: { name: "auth-regression", version: "1" },
    onRawFrame(direction, frame) {
      if (direction === "send") sent.push(frame as (typeof sent)[number]);
    }
  });
  try {
    await connection.handshake();
    return sent.find((frame) => frame.method === "authenticate")?.params?.methodId ?? null;
  } finally {
    await connection.stop();
  }
}

test("a bound logged-in home uses the advertised default", async () => {
  // Verbatim from `01-initialize.ndjson`.
  assert.equal(
    await sentAuthMethod(
      initialize({
        authMethods: [
          { id: "cached_token", name: "cached_token", description: "Cached token from ~/.grok/auth.json" },
          { id: "grok.com", name: "Grok", description: "Sign in with Grok" }
        ],
        defaultAuthMethodId: "cached_token"
      })
    ),
    "cached_token"
  );
});

test("an UNAUTHENTICATED home never auto-selects the interactive sign-in", async () => {
  // README observation 2: the list collapses to grok.com and the default is
  // null. The old fallback picked exactly this.
  assert.equal(
    await sentAuthMethod(
      initialize({
        authMethods: [{ id: "grok.com", name: "Grok", description: "Sign in with Grok" }],
        defaultAuthMethodId: null
      })
    ),
    null,
    "no `authenticate` is sent; the first model call surfaces the login failure"
  );
});

test("a non-interactive method is preferred when the agent names no default", async () => {
  assert.equal(
    await sentAuthMethod(
      initialize({
        authMethods: [
          { id: "grok.com", name: "Grok", description: "Sign in with Grok" },
          { id: "cached_token", name: "cached_token" }
        ],
        defaultAuthMethodId: null
      })
    ),
    "cached_token"
  );
});

test("a default that IS the sign-in is refused, not obeyed", async () => {
  assert.equal(
    await sentAuthMethod(
      initialize({
        authMethods: [{ id: "grok.com", name: "Grok" }],
        defaultAuthMethodId: "grok.com"
      })
    ),
    null
  );
});

test("no advertised methods at all means no authenticate", async () => {
  assert.equal(await sentAuthMethod(initialize({})), null);
});
