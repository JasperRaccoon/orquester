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

import { buildClaudeAuth } from "./claude/probe.ts";
import { toProviderAuth as codexAuth } from "./codex/probe.ts";
import { parseGrokModelsOutput } from "./grok/probe.ts";
import { inferAuth as openCodeAuth } from "./opencode/snapshot.ts";
import type { OpenCodeInventory } from "./opencode/cli-inventory.ts";

describe("claude — an init result that merely lacks account info is an AMBIGUITY", () => {
  it("is `unknown` when the probe itself failed", () => {
    assert.equal(buildClaudeAuth(undefined).status, "unknown");
  });

  it("is `unknown` — never `unauthenticated` — when the init carried no account", () => {
    const auth = buildClaudeAuth({ slashCommands: [], models: [] });
    assert.equal(
      auth.status,
      "unknown",
      "claude initialises fine under API-key/Bedrock envs and under logins whose account block it does not return"
    );
  });

  it("keeps the api provider on the ambiguous verdict, for the card to label", () => {
    const auth = buildClaudeAuth({ slashCommands: [], models: [], apiProvider: "bedrock" });
    assert.equal(auth.status, "unknown");
    assert.equal(auth.type, "bedrock");
  });

  it("is `authenticated` only once the init POSITIVELY yields credentials", () => {
    const byEmail = buildClaudeAuth({ slashCommands: [], models: [], email: "a@b.c" });
    assert.equal(byEmail.status, "authenticated");
    assert.equal(byEmail.email, "a@b.c");

    const byPlan = buildClaudeAuth({ slashCommands: [], models: [], subscriptionType: "max" });
    assert.equal(byPlan.status, "authenticated");
    assert.equal(byPlan.label, "max");
  });
});

describe("codex — the credential answer is the proof", () => {
  it("is `unknown` when `account/read` could not be read at all", () => {
    assert.equal(codexAuth(undefined).status, "unknown");
  });

  it("is `unauthenticated` ONLY when the CLI says an OpenAI login is required", () => {
    assert.equal(
      codexAuth({ account: null, requiresOpenaiAuth: true } as never).status,
      "unauthenticated"
    );
    assert.equal(
      codexAuth({ account: null, requiresOpenaiAuth: false } as never).status,
      "unknown",
      "no account and no requirement is not a logged-out verdict"
    );
  });

  it("is `authenticated` for every account shape it recognises", () => {
    assert.equal(
      codexAuth({
        account: { type: "chatgpt", planType: "pro", email: "a@b.c" },
        requiresOpenaiAuth: false
      } as never).status,
      "authenticated"
    );
    assert.equal(
      codexAuth({ account: { type: "apiKey" }, requiresOpenaiAuth: false } as never).status,
      "authenticated"
    );
  });
});

describe("grok — the CLI's own not-logged-in line is the proof", () => {
  /**
   * The mapping `probeGrok` applies to `parseGrokModelsOutput`: `true` →
   * authenticated, `false` → unauthenticated, `null` → unknown. A `grok models`
   * invocation that did not exit cleanly is never parsed at all, so a failed
   * read reaches this as `null`.
   */
  const map = (authenticated: boolean | null): string =>
    authenticated === true ? "authenticated" : authenticated === false ? "unauthenticated" : "unknown";

  it("is `unknown` for output that says nothing either way", () => {
    assert.equal(map(parseGrokModelsOutput("").authenticated), "unknown");
  });

  it("is `unauthenticated` when the CLI prints that it is not logged in", () => {
    const parsed = parseGrokModelsOutput("Not logged in. Run `grok login` to authenticate.");
    assert.equal(parsed.authenticated, false);
    assert.equal(map(parsed.authenticated), "unauthenticated");
  });
});

describe("opencode — no connected provider is an ambiguity, not a verdict", () => {
  const inventory = (connected: string[]): OpenCodeInventory =>
    ({ providers: { connected }, commands: [], skills: [], agents: [] }) as unknown as OpenCodeInventory;

  it("is `unknown` with nothing connected — there is no `opencode auth list` to ask", () => {
    assert.equal(openCodeAuth(inventory([])).status, "unknown");
  });

  it("is `authenticated` as soon as one upstream is connected", () => {
    assert.equal(openCodeAuth(inventory(["anthropic"])).status, "authenticated");
  });
});
