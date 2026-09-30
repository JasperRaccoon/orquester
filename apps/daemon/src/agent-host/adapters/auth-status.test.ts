/**
 * One rule, four adapters: **`unknown` is not `unauthenticated`** (spec §7.7).
 *
 * T3's Claude driver emits `auth: {status:"unknown"}` on every failure and
 * ambiguity path — disabled, version probe failed, timed out, capabilities
 * missing, no credentials found, pending — and `"authenticated"` only when the
 * initialization result positively yields credentials
 * (`apps/server/src/provider/Layers/ClaudeProvider.ts:452,478,496,520,552,582-587,617,632`).
 * `unauthenticated` is reserved for a driver that can PROVE it:
 * `CodexProvider.ts:553` (the credential answer says an OpenAI login is
 * required) and `GrokProvider.ts:491` (the CLI printed that it is not logged
 * in).
 *
 * The rule is load-bearing rather than cosmetic: the client turns
 * `unauthenticated` into "needs signing in again", and a Claude probe reading
 * its own silence as a verdict toasted exactly that at a host whose managed
 * accounts were all valid.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildClaudeSnapshot, type ClaudeProbeResult } from "./claude/probe.ts";
import { probeCodex } from "./codex/probe.ts";
import type { CodexPeer } from "./codex/protocol.ts";
import { buildSnapshot } from "./opencode/snapshot.ts";

const CHECKED_AT = "2026-09-21T10:00:00.000Z";
const claudeSnapshot = (probe: ClaudeProbeResult | undefined) => buildClaudeSnapshot({
  checkedAt: CHECKED_AT, binaryPath: "/bin/claude", version: "2.1.210", probe
}).snapshot;

async function codexSnapshot(account: unknown) {
  // Raw RPC evidence only: authentication is computed by the real probe.
  const peer = {
    request: async (method: string) => {
      if (method === "account/read" && account !== undefined) return account;
      throw new Error("RPC unavailable");
    }
  } as unknown as CodexPeer;
  return await probeCodex({
    peer,
    initialize: { userAgent: "codex/0.154.0", codexHome: "/account", platformFamily: "unix", platformOs: "linux" },
    nowIso: CHECKED_AT
  });
}

describe("claude — an init result that merely lacks account info is an AMBIGUITY", () => {
  it("is `unknown` when the probe itself failed", () => {
    assert.equal(claudeSnapshot(undefined).auth.status, "unknown");
  });

  it("is `unknown` — never `unauthenticated` — when the init carried no account", () => {
    const { auth } = claudeSnapshot({ slashCommands: [], models: [] });
    assert.equal(
      auth.status,
      "unknown",
      "claude initialises fine under API-key/Bedrock envs and under logins whose account block it does not return"
    );
  });

  it("keeps the api provider on the ambiguous verdict, for the card to label", () => {
    const { auth } = claudeSnapshot({ slashCommands: [], models: [], apiProvider: "bedrock" });
    assert.equal(auth.status, "unknown");
    assert.equal(auth.type, "bedrock");
  });

  it("is `authenticated` only once the init POSITIVELY yields credentials", () => {
    const { auth: byEmail } = claudeSnapshot({ slashCommands: [], models: [], email: "a@b.c" });
    assert.equal(byEmail.status, "authenticated");
    assert.equal(byEmail.email, "a@b.c");

    const { auth: byPlan } = claudeSnapshot({ slashCommands: [], models: [], subscriptionType: "max" });
    assert.equal(byPlan.status, "authenticated");
    assert.equal(byPlan.label, "max");
  });
});

describe("codex — the credential answer is the proof", () => {
  it("is `unknown` when `account/read` could not be read at all", async () => {
    assert.equal((await codexSnapshot(undefined)).auth.status, "unknown");
  });

  it("is `unauthenticated` ONLY when the CLI says an OpenAI login is required", async () => {
    assert.equal(
      (await codexSnapshot({ account: null, requiresOpenaiAuth: true })).auth.status,
      "unauthenticated"
    );
    assert.equal(
      (await codexSnapshot({ account: null, requiresOpenaiAuth: false })).auth.status,
      "unknown",
      "no account and no requirement is not a logged-out verdict"
    );
  });

  it("is `authenticated` for every account shape it recognises", async () => {
    assert.equal(
      (await codexSnapshot({
        account: { type: "chatgpt", planType: "pro", email: "a@b.c" },
        requiresOpenaiAuth: false
      })).auth.status,
      "authenticated"
    );
    assert.equal(
      (await codexSnapshot({ account: { type: "apiKey" }, requiresOpenaiAuth: false })).auth.status,
      "authenticated"
    );
  });
});

describe("opencode — no connected provider is an ambiguity, not a verdict", () => {
  it("is `unknown` with nothing connected — there is no `opencode auth list` to ask", () => {
    const snapshot = buildSnapshot({
      version: "1.18.31",
      checkedAt: CHECKED_AT,
      inventory: { providers: { all: [], connected: [], default: {} }, commands: [], skills: [], agents: [] }
    });
    assert.equal(snapshot.auth.status, "unknown");
  });
});
