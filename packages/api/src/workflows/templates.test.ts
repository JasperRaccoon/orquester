import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { createWorkflowFromRequest, findWorkflowNode } from "./patch.ts";
import { buildTemplate, WORKFLOW_TEMPLATES } from "./templates.ts";
import { sequentialIds } from "./testing.ts";
import { validateWorkflow } from "./validate.ts";

const opts = { projectPath: "/w/ws/app", timezone: "Europe/Madrid" };
const env = () => ({ mintId: sequentialIds(), now: new Date("2026-09-28T10:00:00Z") });

describe("workflow templates", () => {
  it("every template builds, is disabled, and validates with zero errors", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = createWorkflowFromRequest(buildTemplate(template.id, opts), env());
      assert.equal(workflow.enabled, false, template.id);
      assert.equal(workflow.settings.timezone, "Europe/Madrid");
      assert.deepEqual(workflow.project, { kind: "existing", projectPath: "/w/ws/app" });
      const { problems } = validateWorkflow(workflow, {
        secretNames: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN"],
        savedPromptIds: [],
        knownWorkflowIds: [workflow.id]
      });
      assert.deepEqual(problems, [], template.id);
    }
  });
});

describe("the Jira template's code runs", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function load(source: string): Promise<(args: Record<string, unknown>) => Promise<unknown>> {
    const dir = await mkdtemp(join(tmpdir(), "wf-template-"));
    dirs.push(dir);
    const file = join(dir, "block.mjs");
    await writeFile(file, source);
    const module = (await import(pathToFileURL(file).href)) as { default: (args: Record<string, unknown>) => Promise<unknown> };
    return module.default;
  }

  function source(name: string): string {
    const workflow = createWorkflowFromRequest(buildTemplate("jira-fixer", opts), env());
    const node = findWorkflowNode(workflow, name)!;
    assert.equal(node.type, "code");
    return node.type === "code" ? node.config.source : "";
  }

  const secrets = { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "me@acme.test", JIRA_TOKEN: "tok" };

  it("FetchTickets searches, flattens descriptions, and stops when there is nothing", async () => {
    const run = await load(source("FetchTickets"));
    const calls: { url: string; init: RequestInit }[] = [];
    let issues: unknown[] = [
      {
        key: "PROJ-1",
        fields: {
          summary: "Crash",
          issuetype: { name: "Bug" },
          priority: { name: "High" },
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "It breaks" }] }] }
        }
      }
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ issues }), { status: 200 });
    }) as typeof fetch;
    try {
      const stopped = Symbol("stopped");
      const result = await run({ secrets, log: () => {}, stop: () => stopped });
      assert.deepEqual(result, {
        tickets: [
          { key: "PROJ-1", url: "https://acme.atlassian.net/browse/PROJ-1", summary: "Crash", type: "Bug", priority: "High", description: "It breaks" }
        ]
      });
      assert.equal(calls[0]!.url, "https://acme.atlassian.net/rest/api/3/search/jql");
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("me@acme.test:tok").toString("base64")}`);
      issues = [];
      assert.equal(await run({ secrets, log: () => {}, stop: () => stopped }), stopped);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("MarkDone transitions what the agent fixed", async () => {
    const run = await load(source("MarkDone"));
    const posted: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(`${url} ${String(init.body)}`);
        return new Response(null, { status: 204 });
      }
      const transitions = url.includes("PROJ-2") ? [{ id: "1", name: "In Progress" }] : [{ id: "31", name: "Done" }];
      return new Response(JSON.stringify({ transitions }), { status: 200 });
    }) as typeof fetch;
    try {
      const text = 'Here you go:\n{"fixed": ["PROJ-1", "PROJ-2"], "skipped": [{"key": "PROJ-3", "reason": "unclear"}]}';
      const result = await run({ nodes: { FixTickets: { output: { text } } }, secrets, log: () => {} });
      const outcome = result as { moved: string[]; failed: { key: string }[]; skipped: { key: string; reason: string }[] };
      assert.deepEqual(outcome.moved, ["PROJ-1"]);
      assert.deepEqual(outcome.failed.map((entry) => entry.key), ["PROJ-2"]);
      assert.deepEqual(outcome.skipped, [{ key: "PROJ-3", reason: "unclear" }]);
      assert.deepEqual(posted, ['https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions {"transition":{"id":"31"}}']);
      await assert.rejects(run({ nodes: { FixTickets: { output: { text: "no json" } } }, secrets, log: () => {} }), /no JSON object/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
