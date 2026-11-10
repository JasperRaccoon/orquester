/**
 * The GPT Image service through its one operation and its settings: account choice, the login
 * path, upstream answers (the spike's redacted fixtures, `./fixtures/README.md`), the request it
 * builds, and the settings routes. The network is a fake `fetch`; logins are a fake accounts port.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import Fastify from "fastify";
import { GPT_IMAGE_PLUGIN_ID, gptImageRoutes, type AgentAccount, type GptImageSettingsResponse } from "@orquester/api";

import type { AccountRefreshOutcome } from "../agent-accounts.ts";
import type { CodexLogin } from "./accounts.ts";
import { GptImageError } from "./errors.ts";
import { registerGptImageRoutes } from "./routes.ts";
import { GptImageService } from "./service.ts";
import type { GptImageToolInput } from "./tool-port.ts";
import { CHATGPT_IMAGES_URL, MAX_ATTEMPTS } from "./upstream.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 60 * 60_000;

function fixture(name: string): { status: number; headers: Record<string, string>; body: unknown } {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
}

function respond(answer: { status: number; headers?: Record<string, string>; body: unknown }): Response {
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", ...answer.headers } });
}

const OK = fixture("generations-200.json");
const usageLimit = (resetsAt: number) => ({ status: 429, body: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: resetsAt } } });

interface AccountSpec {
  id: string;
  plan?: string | null;
  needsReauth?: boolean;
  /** Token life left, ms. */
  life?: number;
}

function harness(specs: AccountSpec[], options: { enabled?: boolean; settings?: unknown; refresh?: AccountRefreshOutcome } = {}) {
  const records = new Map(specs.map((spec) => [spec.id, { ...spec, version: 1 }]));
  const accounts: AgentAccount[] = specs.map((spec) => ({
    id: spec.id,
    agent: "codex",
    label: `${spec.id}@example.invalid`,
    email: `${spec.id}@example.invalid`,
    plan: null,
    needsReauth: spec.needsReauth === true,
    createdAt: "",
    importedAt: ""
  }));
  const refreshCalls: { agent: string; id: string; allowHeld?: boolean }[] = [];
  const flagged: string[] = [];
  const accountEvents = new EventEmitter();
  const port = {
    events: accountEvents,
    list: () => ({ accounts }),
    async codexLogin(id: string): Promise<CodexLogin | null> {
      const record = records.get(id);
      if (!record) return null;
      return { accessToken: `token-${id}-v${record.version}`, chatgptAccountId: `workspace-${id}`, expiresAt: NOW + (record.life ?? 6 * HOUR), plan: record.plan === undefined ? "plus" : record.plan };
    },
    async refreshNow(agent: "codex", id: string, opts: { allowHeld?: boolean }): Promise<AccountRefreshOutcome> {
      refreshCalls.push({ agent, id, allowHeld: opts.allowHeld });
      const outcome = options.refresh ?? "refreshed";
      const record = records.get(id)!;
      if (outcome === "refreshed") {
        record.version += 1;
        record.life = 6 * HOUR;
      }
      return outcome;
    },
    async markNeedsReauth(id: string, value: boolean) {
      if (value) flagged.push(id);
      const account = accounts.find((entry) => entry.id === id);
      if (account) account.needsReauth = value;
    }
  };
  let settings: Record<string, unknown> = (options.settings as Record<string, unknown>) ?? {};
  let enabled = options.enabled ?? true;
  const pluginEvents = new EventEmitter();
  const plugins = {
    events: pluginEvents,
    isEnabled: (id: string) => id === GPT_IMAGE_PLUGIN_ID && enabled,
    pluginSettings: () => settings,
    async updatePluginSettings(_id: string, patch: Record<string, unknown>) {
      settings = { ...settings, ...patch };
      return settings;
    }
  };
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let answer: (request: { url: string; token: string; attempt: number }) => Response = () => respond(OK);
  const fetchFake = (async (url: string | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    return answer({ url: String(url), token: headers.Authorization.replace(/^Bearer /, ""), attempt: requests.length });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const service = new GptImageService({
    plugins,
    accounts: port,
    fsRoot: () => "/nonexistent",
    fetch: fetchFake,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  return {
    service,
    requests,
    refreshCalls,
    flagged,
    sleeps,
    accountEvents,
    pluginEvents,
    answer(fn: typeof answer) {
      answer = fn;
    },
    setEnabled(value: boolean) {
      enabled = value;
      pluginEvents.emit("changed");
    },
    accounts
  };
}

const input = (over: Partial<GptImageToolInput> = {}): GptImageToolInput => ({ prompt: "a red apple", images: [], transparent: false, projectPath: "", inBox: false, ...over });
const signal = () => new AbortController().signal;

async function refusal(promise: Promise<unknown>): Promise<GptImageError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GptImageError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

test("auto uses the first account in Settings order that is signed in and not on Free", async () => {
  const h = harness([{ id: "a", needsReauth: true }, { id: "b", plan: "free" }, { id: "c", plan: "plus" }, { id: "d", plan: "pro" }]);
  await h.service.start();
  const made = await h.service.generate(input(), signal());
  assert.equal(made.account, "c@example.invalid");
  assert.deepEqual(h.requests.map((request) => request.headers.Authorization), ["Bearer token-c-v1"]);
  assert.equal(h.requests[0]!.headers["ChatGPT-Account-Id"], "workspace-c");
  assert.equal(JSON.stringify(made).includes("token-c"), false, "the result never carries the token");
});

test("auto fails over once on a used-up limit; a pinned account never does, and says when it resets", async () => {
  const resetsAt = Math.floor(NOW / 1000) + 3600;
  const h = harness([{ id: "a" }, { id: "b" }, { id: "c" }]);
  await h.service.start();
  h.answer(({ token }) => respond(token.startsWith("token-a") ? usageLimit(resetsAt) : OK));
  assert.equal((await h.service.generate(input(), signal())).account, "b@example.invalid");

  h.requests.length = 0;
  h.answer(({ token }) => respond(token.startsWith("token-c") ? OK : usageLimit(resetsAt)));
  const twice = await refusal(h.service.generate(input(), signal()));
  assert.equal(twice.code, "GPT_IMAGE_QUOTA");
  assert.deepEqual(h.requests.map((request) => request.headers.Authorization), ["Bearer token-a-v1", "Bearer token-b-v1"], "one failover only");

  const pinned = harness([{ id: "a" }, { id: "b" }], { settings: { account: "a" } });
  await pinned.service.start();
  pinned.answer(() => respond(usageLimit(resetsAt)));
  const error = await refusal(pinned.service.generate(input(), signal()));
  assert.equal(error.code, "GPT_IMAGE_QUOTA");
  assert.match(error.message, new RegExp(new Date(resetsAt * 1000).toISOString().slice(0, 16)));
  assert.equal(pinned.requests.length, 1, "a pinned account is never swapped");
});

test("no eligible account, or a pinned one that needs signing in or is on Free: refused before any request", async () => {
  const none = harness([{ id: "a", needsReauth: true }]);
  await none.service.start();
  assert.equal(none.service.toolsAvailable(), false);
  assert.equal((await refusal(none.service.generate(input(), signal()))).code, "GPT_IMAGE_NO_ACCOUNT");
  const free = harness([{ id: "a", plan: "free" }]);
  await free.service.start();
  assert.equal((await refusal(free.service.generate(input(), signal()))).code, "GPT_IMAGE_FREE_PLAN");
  const pinned = harness([{ id: "a", needsReauth: true }, { id: "b" }], { settings: { account: "a" } });
  await pinned.service.start();
  const error = await refusal(pinned.service.generate(input(), signal()));
  assert.equal(error.code, "GPT_IMAGE_NEEDS_SIGN_IN");
  assert.match(error.message, /a@example\.invalid needs signing in again/);
  const off = harness([{ id: "a" }], { enabled: false });
  await off.service.start();
  assert.equal((await refusal(off.service.generate(input(), signal()))).code, "GPT_IMAGE_DISABLED");
  for (const h of [none, free, pinned, off]) assert.equal(h.requests.length, 0);
});

test("a token near expiry is renewed through refreshNow only; nothing but the image endpoint is called", async () => {
  const h = harness([{ id: "a", life: 5 * 60_000 }]);
  await h.service.start();
  await h.service.generate(input(), signal());
  assert.deepEqual(h.refreshCalls, [{ agent: "codex", id: "a", allowHeld: true }]);
  assert.deepEqual(h.requests.map((request) => request.headers.Authorization), ["Bearer token-a-v2"]);
  for (const request of h.requests) assert.ok(request.url.startsWith(`${CHATGPT_IMAGES_URL}/`), request.url);
  for (const request of h.requests) assert.equal(JSON.stringify(request.body).includes("refresh"), false);
});

test("a refused token is renewed once; refused again, the account is flagged as needing sign-in (spike 401 fixture)", async () => {
  const h = harness([{ id: "a" }]);
  await h.service.start();
  h.answer(() => respond(fixture("error-401-invalid-token.json")));
  const error = await refusal(h.service.generate(input(), signal()));
  assert.equal(error.code, "GPT_IMAGE_NEEDS_SIGN_IN");
  assert.deepEqual(h.requests.map((request) => request.headers.Authorization), ["Bearer token-a-v1", "Bearer token-a-v2"]);
  assert.equal(h.refreshCalls.length, 1);
  assert.deepEqual(h.flagged, ["a"]);
  assert.equal(h.service.toolsAvailable(), false, "the flagged account no longer counts");

  // A renewal the sign-in service refuses: flagged, nothing more sent.
  const gone = harness([{ id: "a", life: 60_000 }], { refresh: "invalid-grant" });
  await gone.service.start();
  assert.equal((await refusal(gone.service.generate(input(), signal()))).code, "GPT_IMAGE_NEEDS_SIGN_IN");
  assert.equal(gone.requests.length, 0);
});

test("a renewal a live chat holds, or one with nothing to renew now, never flags the account: its token while it works, else try again", async () => {
  for (const refresh of ["held", "unavailable"] as const) {
    // Due for renewal but still good: the current token is used.
    const due = harness([{ id: "a", life: 5 * 60_000 }], { refresh });
    await due.service.start();
    await due.service.generate(input(), signal());
    assert.deepEqual(due.requests.map((request) => request.headers.Authorization), ["Bearer token-a-v1"], refresh);

    // About to expire, or refused by the endpoint: a passing refusal, nothing sent with it.
    const expiring = harness([{ id: "a", life: 60_000 }], { refresh });
    await expiring.service.start();
    assert.equal((await refusal(expiring.service.generate(input(), signal()))).code, "GPT_IMAGE_UNAVAILABLE", refresh);
    assert.equal(expiring.requests.length, 0);
    const refused = harness([{ id: "a" }], { refresh });
    await refused.service.start();
    refused.answer(() => respond(fixture("error-401-invalid-token.json")));
    assert.equal((await refusal(refused.service.generate(input(), signal()))).code, "GPT_IMAGE_UNAVAILABLE", refresh);

    for (const h of [due, expiring, refused]) {
      assert.deepEqual(h.flagged, [], refresh);
      assert.equal(h.service.toolsAvailable(), true, refresh);
    }
  }
});

test("upstream refusals map to plain errors; only passing failures are retried", async () => {
  const h = harness([{ id: "a" }]);
  await h.service.start();
  h.answer(() => respond(fixture("error-400-invalid-image.json")));
  const invalid = await refusal(h.service.generate(input(), signal()));
  assert.equal(invalid.code, "GPT_IMAGE_INVALID");
  assert.match(invalid.message, /Invalid image data/);
  assert.equal(h.requests.length, 1);

  h.requests.length = 0;
  h.answer(() => respond({ status: 400, body: { error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } } }));
  const safety = await refusal(h.service.generate(input(), signal()));
  assert.equal(safety.code, "GPT_IMAGE_REFUSED");
  assert.match(safety.message, /safety system/);
  assert.equal(h.requests.length, 1, "a safety refusal is not retried");

  h.requests.length = 0;
  h.answer(() => respond({ status: 429, body: { error: { type: "usage_not_included" } } }));
  assert.equal((await refusal(h.service.generate(input(), signal()))).code, "GPT_IMAGE_FREE_PLAN");

  const busy = harness([{ id: "a" }]);
  await busy.service.start();
  busy.answer(({ attempt }) => (attempt === 1 ? respond({ status: 429, headers: { "retry-after": "2" }, body: { error: { type: "rate_limit" } } }) : respond({ status: 503, body: {} })));
  const down = await refusal(busy.service.generate(input(), signal()));
  assert.equal(down.code, "GPT_IMAGE_UNAVAILABLE");
  assert.equal(busy.requests.length, MAX_ATTEMPTS);
  assert.equal(busy.sleeps[0], 2_000, "Retry-After is honored");

  const odd = harness([{ id: "a" }]);
  await odd.service.start();
  odd.answer(() => respond({ status: 200, body: { data: [] } }));
  assert.equal((await refusal(odd.service.generate(input(), signal()))).code, "GPT_IMAGE_UNEXPECTED");
});

test("requests: no reference → generations; references → edits with data URLs; transparent asks for alpha", async () => {
  const h = harness([{ id: "a" }]);
  await h.service.start();
  const plain = await h.service.generate(input(), signal());
  assert.equal(h.requests[0]!.url, `${CHATGPT_IMAGES_URL}/generations`);
  assert.deepEqual(h.requests[0]!.body, { prompt: "a red apple", model: "gpt-image-2", background: "opaque", quality: "auto", size: "auto" });
  assert.deepEqual([plain.mimeType, plain.width, plain.height, plain.transparent, plain.name], ["image/png", 2, 2, false, "a-red-apple.png"]);

  h.answer(() => respond(fixture("generations-transparent-200.json")));
  const reference = Buffer.from("reference-bytes");
  const edited = await h.service.generate(input({ prompt: "make it glass", transparent: true, images: [{ bytes: reference, mimeType: "image/webp" }] }), signal());
  assert.equal(h.requests[1]!.url, `${CHATGPT_IMAGES_URL}/edits`);
  assert.deepEqual(h.requests[1]!.body.images, [{ image_url: `data:image/webp;base64,${reference.toString("base64")}` }]);
  assert.equal(h.requests[1]!.body.background, "transparent");
  assert.equal(edited.transparent, true);
});

test("availability follows the plugin switch and the accounts", async () => {
  const h = harness([{ id: "a" }], { enabled: false });
  await h.service.start();
  assert.equal(h.service.toolsAvailable(), false);
  let flips = 0;
  h.service.onToolsChange(() => (flips += 1));
  h.setEnabled(true);
  assert.equal(h.service.toolsAvailable(), true);
  const changed = new Promise<void>((resolve) => h.service.onToolsChange(resolve));
  h.accounts[0]!.needsReauth = true;
  h.accountEvents.emit("changed");
  await changed;
  assert.equal(h.service.toolsAvailable(), false);
  assert.equal(flips, 2);
});

test("settings routes: GET lists accounts without tokens; PUT takes auto or a Codex account and a safe folder", async (t) => {
  const h = harness([{ id: "a", plan: "pro" }, { id: "b", needsReauth: true }]);
  await h.service.start();
  const app = Fastify();
  registerGptImageRoutes(app, { service: h.service, logger: { error: () => undefined } });
  t.after(() => app.close());
  const get = await app.inject({ method: "GET", url: gptImageRoutes.settings });
  const read = get.json() as GptImageSettingsResponse;
  assert.deepEqual(read.settings, { account: "auto", saveTo: { kind: "chat" } });
  assert.deepEqual(read.accounts.map((account) => [account.id, account.plan, account.blocked]), [["a", "pro", undefined], ["b", "plus", "needs-reauth"]]);
  assert.equal(read.activeAccountId, "a");
  assert.equal(get.body.includes("token-"), false);

  const put = await app.inject({ method: "PUT", url: gptImageRoutes.settings, payload: { account: "a", saveTo: { kind: "project", folder: "public/img/" } } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual((put.json() as GptImageSettingsResponse).settings, { account: "a", saveTo: { kind: "project", folder: "public/img" } });
  for (const payload of [{ account: "claude-1" }, { account: "" }, { saveTo: { kind: "project", folder: "../out" } }, { saveTo: { kind: "project", folder: "/etc" } }, { saveTo: { kind: "disk" } }, []]) {
    const refused = await app.inject({ method: "PUT", url: gptImageRoutes.settings, payload });
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.match((refused.json() as { code: string }).code, /^GPT_IMAGE_(INVALID|UNKNOWN_ACCOUNT)$/);
  }
  assert.deepEqual(h.service.settings(), { account: "a", saveTo: { kind: "project", folder: "public/img" } }, "a refused PUT changes nothing");
});
