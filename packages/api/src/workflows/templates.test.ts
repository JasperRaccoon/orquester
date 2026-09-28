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
    assert.deepEqual(
      WORKFLOW_TEMPLATES.map((template) => template.id),
      ["nightly-agent", "jira-fixer", "release-reviewer"]
    );
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

  it("the Jira fixer's shape", () => {
    const workflow = createWorkflowFromRequest(buildTemplate("jira-fixer", opts), env());
    const failed = findWorkflowNode(workflow, "Failed")!;
    const errorEdges = workflow.edges.filter((edge) => edge.target === failed.id);
    assert.equal(errorEdges.length, 3);
    assert.ok(errorEdges.every((edge) => edge.sourceHandle === "error"));
    const fix = findWorkflowNode(workflow, "FixTickets")!;
    assert.ok(fix.type === "agent" && fix.config.prompt.kind === "text" && fix.config.prompt.text.includes("{{ nodes.FetchTickets.output.tickets | json }}"));
    assert.equal(fix.type === "agent" && fix.config.chain[0]!.accounts.strategy, "least-used");
    assert.equal(fix.type === "agent" && fix.config.chain[0]!.agent, "claude");
  });

  it("the release reviewer watches v* tags with Codex", () => {
    const workflow = createWorkflowFromRequest(buildTemplate("release-reviewer", opts), env());
    const trigger = findWorkflowNode(workflow, "ReleaseTag")!;
    assert.deepEqual(trigger.type === "trigger.git" && trigger.config.event, { kind: "tag", pattern: "v*" });
    const review = findWorkflowNode(workflow, "ReviewRelease")!;
    assert.equal(review.type === "agent" && review.config.chain[0]!.agent, "codex");
  });

  it("an unknown template throws", () => {
    assert.throws(() => buildTemplate("nope" as never, opts), /Unknown workflow template/);
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
      const logs: string[] = [];
      const result = await run({ secrets, log: (line: string) => logs.push(line), stop: (reason: string) => ({ stopped: reason }) });
      assert.deepEqual(result, {
        tickets: [
          { key: "PROJ-1", url: "https://acme.atlassian.net/browse/PROJ-1", summary: "Crash", type: "Bug", priority: "High", description: "It breaks" }
        ]
      });
      assert.equal(calls[0]!.url, "https://acme.atlassian.net/rest/api/3/search/jql");
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("me@acme.test:tok").toString("base64")}`);
      assert.deepEqual(logs, ["1 ticket(s): PROJ-1"]);
      issues = [];
      assert.deepEqual(await run({ secrets, log: () => {}, stop: (reason: string) => ({ stopped: reason }) }), { stopped: "No new Jira tickets" });
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
      assert.deepEqual(result, {
        moved: ["PROJ-1"],
        failed: [{ key: "PROJ-2", error: "no transition to Done" }],
        skipped: [{ key: "PROJ-3", reason: "unclear" }]
      });
      assert.deepEqual(posted, ['https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions {"transition":{"id":"31"}}']);
      await assert.rejects(run({ nodes: { FixTickets: { output: { text: "no json" } } }, secrets, log: () => {} }), /no JSON object/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
