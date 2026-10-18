import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpOrquesterApiClient } from "./index.ts";
import { sessionProfileRoutes, sessionProfileScopeIncludes, sessionProfileScopeProblem } from "./session-profiles.ts";

interface Seen {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

function client(): { api: HttpOrquesterApiClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.Authorization
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: new HttpOrquesterApiClient({ baseUrl: "http://d/", password: "tok", fetch: fetchImpl }), seen };
}

describe("Agent Profiles routes", () => {
  it("encodes ids into their paths", () => {
    assert.equal(sessionProfileRoutes.list, "/api/session-profiles");
    assert.equal(sessionProfileRoutes.item("p 1", "a/b"), "/api/session-profiles/p%201/items/a%2Fb");
    assert.equal(sessionProfileRoutes.itemEnabled("p", "i"), "/api/session-profiles/p/items/i/enabled");
    assert.equal(sessionProfileRoutes.prepareStatus("p"), "/api/session-profiles/p/prepare-status");
  });

  it("validates scopes: non-empty, known agents, one agent for plugins and hooks, no OpenCode hooks", () => {
    assert.equal(sessionProfileScopeProblem("skill", "all"), null);
    assert.equal(sessionProfileScopeProblem("mcp", ["claude", "grok"]), null);
    assert.match(sessionProfileScopeProblem("skill", [])!, /non-empty/);
    assert.match(sessionProfileScopeProblem("skill", ["cursor"])!, /unknown agent/);
    assert.match(sessionProfileScopeProblem("skill", ["claude", "claude"])!, /twice/);
    assert.match(sessionProfileScopeProblem("plugin", "all")!, /exactly one agent/);
    assert.match(sessionProfileScopeProblem("hook", ["claude", "codex"])!, /exactly one agent/);
    assert.equal(sessionProfileScopeProblem("plugin", ["opencode"]), null);
    assert.match(sessionProfileScopeProblem("hook", ["opencode"])!, /no hooks/);
    assert.equal(sessionProfileScopeIncludes("all", "grok"), true);
    assert.equal(sessionProfileScopeIncludes(["claude"], "grok"), false);
  });
});

describe("HttpOrquesterApiClient — Agent Profiles", () => {
  it("sends every call to its route with its method, body and bearer", async () => {
    const { api, seen } = client();
    await api.listSessionProfiles();
    await api.getSessionProfile("p1");
    await api.createSessionProfile({ name: "Dev" });
    await api.updateSessionProfile("p1", { revision: "2", name: "D" });
    await api.deleteSessionProfile("p1", "3");
    await api.duplicateSessionProfile("p1");
    await api.getSessionProfileItem("p1", "i1");
    await api.createSessionProfileItem("p1", { revision: "1", draft: { kind: "command", document: { name: "x", frontmatter: {}, body: "" } } });
    await api.updateSessionProfileItem("p1", "i1", { revision: "1", draft: { kind: "hook", agents: ["claude"], hook: { event: "Stop", command: "n" } } });
    await api.deleteSessionProfileItem("p1", "i1", "4");
    await api.setSessionProfileItemEnabled("p1", "i1", "5", false);
    await api.readSessionProfileInstructions("p1");
    await api.writeSessionProfileInstructions("p1", "6", "hi");
    await api.getSessionProfilePrepareStatus("p1");

    assert.deepEqual(
      seen.map((call) => `${call.method} ${call.url.replace("http://d", "")}`),
      [
        "GET /api/session-profiles",
        "GET /api/session-profiles/p1",
        "POST /api/session-profiles",
        "PUT /api/session-profiles/p1",
        "DELETE /api/session-profiles/p1?revision=3",
        "POST /api/session-profiles/p1/duplicate",
        "GET /api/session-profiles/p1/items/i1",
        "POST /api/session-profiles/p1/items",
        "PUT /api/session-profiles/p1/items/i1",
        "DELETE /api/session-profiles/p1/items/i1?revision=4",
        "POST /api/session-profiles/p1/items/i1/enabled",
        "GET /api/session-profiles/p1/instructions",
        "PUT /api/session-profiles/p1/instructions",
        "GET /api/session-profiles/p1/prepare-status"
      ]
    );
    assert.ok(seen.every((call) => call.auth === "Bearer tok"));
    assert.deepEqual(seen[3]!.body, { revision: "2", name: "D" });
    assert.deepEqual(seen[5]!.body, {});
    assert.deepEqual(seen[10]!.body, { revision: "5", enabled: false });
    assert.deepEqual(seen[12]!.body, { revision: "6", text: "hi" });
  });

  it("throws on a refusal (a 409 conflict included)", async () => {
    const api = new HttpOrquesterApiClient({
      baseUrl: "http://d",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "PROFILE_CONFLICT", message: "m" } }), { status: 409, statusText: "Conflict" })) as typeof fetch
    });
    await assert.rejects(api.updateSessionProfile("p1", { revision: "1" }), /409/);
  });
});
