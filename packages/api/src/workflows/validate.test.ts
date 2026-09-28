import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testEdge, testNode, testWorkflow, T0 } from "./testing.ts";
import type { WorkflowProblem } from "./types.ts";
import { WORKFLOW_LIMITS } from "./types.ts";
import { hasWorkflowErrors, utf8ByteLength, validateWorkflow, WORKFLOW_PROBLEM_CODES, type ValidateWorkflowOptions } from "./validate.ts";

function codes(problems: WorkflowProblem[]): string[] {
  return problems.map((problem) => problem.code);
}

function problemsOf(input: unknown, opts?: ValidateWorkflowOptions): WorkflowProblem[] {
  return validateWorkflow(input, opts).problems;
}

function only(problems: WorkflowProblem[], code: string): WorkflowProblem[] {
  return problems.filter((problem) => problem.code === code);
}

const manual = () => testNode("t", "trigger.manual", {}, { name: "Manual" });

function agent(id: string, prompt: string, extra: Record<string, unknown> = {}) {
  return testNode(id, "agent", { prompt: { kind: "text", text: prompt }, ...extra }, { name: id });
}

describe("a valid workflow", () => {
  it("has no problems and parses", () => {
    const wf = testWorkflow(
      [manual(), agent("Review", "Review {branch}: {{ trigger.input | json }}"), testNode("Post", "http", { url: "https://x.test/{{ nodes.Review.output.text }}" })],
      [testEdge("t", "Review"), testEdge("Review", "Post")]
    );
    const result = validateWorkflow(wf, { secretNames: [] });
    assert.deepEqual(result.problems, []);
    assert.equal(result.workflow?.id, "wf-1");
    assert.equal(hasWorkflowErrors(result.problems), false);
  });

  it("every emitted code is declared", () => {
    const declared = new Set<string>(WORKFLOW_PROBLEM_CODES);
    const messy = {
      ...testWorkflow([]),
      nodes: [{ id: "a", type: "nope" }, agent("A", "")],
      edges: [{ id: "e", source: "a", target: "zzz", sourceHandle: "bad handle" }]
    };
    for (const problem of problemsOf(messy)) assert.ok(declared.has(problem.code), problem.code);
  });
});

describe("schema", () => {
  it("rejects a non-object and non-JSON", () => {
    assert.deepEqual(codes(problemsOf(null)), ["schema"]);
    assert.deepEqual(codes(problemsOf([])), ["schema"]);
    const cyclic: Record<string, unknown> = { ...testWorkflow([]) };
    cyclic.self = cyclic;
    assert.deepEqual(codes(problemsOf(cyclic)), ["not_json"]);
  });

  it("maps record issues to fields, and still checks the blocks", () => {
    const wf = { ...testWorkflow([manual(), agent("A", "")], [testEdge("t", "A")]), name: "", createdAt: "yesterday" };
    const result = validateWorkflow(wf);
    assert.equal(result.workflow, null);
    const schema = only(result.problems, "schema");
    assert.deepEqual(schema.map((problem) => problem.field).sort(), ["createdAt", "name"]);
    assert.equal(only(result.problems, "empty_prompt").length, 1, "the block is still checked");
  });

  it("a broken block reports its own problem with its id; the others are still checked", () => {
    const wf = testWorkflow([manual(), agent("Good", "{{ nodes.Nope.output }}")], [testEdge("t", "Good")]);
    const raw = { ...wf, nodes: [...wf.nodes, { id: "bad", name: "Bad", type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "text", text: "x" }, chain: [] } }] };
    const result = validateWorkflow(raw);
    assert.equal(result.workflow, null);
    const schema = only(result.problems, "schema");
    assert.equal(schema.length, 1);
    assert.equal(schema[0]!.nodeId, "bad");
    assert.equal(schema[0]!.field, "config.chain");
    assert.match(schema[0]!.message, /^Block Bad: config\.chain:/);
    assert.equal(only(result.problems, "unknown_reference").length, 1);
  });

  it("unknown block types and bad edges are schema problems", () => {
    const wf = testWorkflow([manual()]);
    const raw = { ...wf, nodes: [...wf.nodes, { id: "x", name: "X", type: "teleport", position: { x: 0, y: 0 }, config: {} }], edges: [{ id: "e1", source: "t" }] };
    const problems = problemsOf(raw);
    assert.ok(only(problems, "schema").some((problem) => problem.nodeId === "x"));
    assert.ok(only(problems, "schema").some((problem) => problem.edgeId === "e1"));
  });

  it("nodes and edges must be lists", () => {
    const problems = problemsOf({ ...testWorkflow([]), nodes: {}, edges: 3 });
    assert.ok(problems.some((problem) => problem.field === "nodes"));
    assert.ok(problems.some((problem) => problem.field === "edges"));
  });
});

describe("limits", () => {
  it("counts blocks, connections, name length and size", () => {
    const many = Array.from({ length: WORKFLOW_LIMITS.maxNodes + 1 }, (_, index) => testNode(`n${index}`, "note", {}, { name: `N${index}` }));
    assert.ok(codes(problemsOf(testWorkflow(many))).includes("too_many_nodes"));
    const wf = testWorkflow([manual(), testNode("c", "code", {}, { name: "C" })]);
    const edges = Array.from({ length: WORKFLOW_LIMITS.maxEdges + 1 }, (_, index) => testEdge("t", "c", "success", `e${index}`));
    assert.ok(codes(problemsOf({ ...wf, edges })).includes("too_many_edges"));
    assert.ok(codes(problemsOf({ ...wf, name: "x".repeat(121) })).includes("name_too_long"));
    const huge = testNode("big", "note", { text: "x".repeat(WORKFLOW_LIMITS.maxDefinitionBytes) }, { name: "Big" });
    assert.ok(codes(problemsOf(testWorkflow([manual(), huge]))).includes("definition_too_large"));
  });

  it("utf8ByteLength", () => {
    assert.equal(utf8ByteLength("abc"), 3);
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength("€"), 3);
    assert.equal(utf8ByteLength("😀"), 4);
    assert.equal(utf8ByteLength("\ud800"), 3);
  });
});

describe("identity", () => {
  it("unique ids and names, valid names", () => {
    const wf = testWorkflow([manual()]);
    const nodes = [
      ...wf.nodes,
      testNode("a", "code", {}, { name: "Same" }),
      testNode("a", "code", {}, { name: "Other" }),
      testNode("b", "code", {}, { name: "Same" }),
      testNode("c", "code", {}, { name: "has space" }),
      testNode("d", "code", {}, { name: "9lives" })
    ];
    const problems = problemsOf({ ...wf, nodes });
    assert.equal(only(problems, "duplicate_node_id").length, 1);
    assert.equal(only(problems, "duplicate_node_name").length, 1);
    assert.deepEqual(only(problems, "invalid_node_name").map((problem) => problem.nodeId), ["c", "d"]);
  });
});

describe("edges", () => {
  const base = () => [
    manual(),
    testNode("if", "if", {}, { name: "Check" }),
    testNode("a", "code", {}, { name: "A" }),
    testNode("stop", "stop", {}, { name: "End" }),
    testNode("note", "note", {}, { name: "Note" })
  ];
  it("each integrity rule", () => {
    const wf = testWorkflow(base());
    const edges = [
      testEdge("t", "if", "success", "ok"),
      testEdge("ghost", "a", "success", "e-src"),
      testEdge("if", "ghost", "true", "e-tgt"),
      testEdge("if", "a", "success", "e-handle"),
      testEdge("a", "t", "success", "e-trigger"),
      testEdge("a", "note", "success", "e-note"),
      testEdge("stop", "a", "success", "e-stop"),
      testEdge("a", "a", "success", "e-self"),
      testEdge("if", "a", "true", "e-1"),
      testEdge("if", "a", "true", "e-dup"),
      testEdge("if", "a", "false", "ok")
    ];
    const problems = problemsOf({ ...wf, edges });
    const byEdge = (code: string) => only(problems, code).map((problem) => problem.edgeId);
    assert.deepEqual(byEdge("edge_unknown_source"), ["e-src"]);
    assert.deepEqual(byEdge("edge_unknown_target"), ["e-tgt"]);
    assert.deepEqual(byEdge("edge_invalid_handle"), ["e-handle", "e-stop"]);
    assert.match(only(problems, "edge_invalid_handle")[0]!.message, /has no "success" output \(it has true, false, error\)/);
    assert.match(only(problems, "edge_invalid_handle")[1]!.message, /End has no outputs/);
    assert.deepEqual(byEdge("edge_target_no_input"), ["e-trigger", "e-note"]);
    assert.deepEqual(byEdge("edge_self_loop"), ["e-self"]);
    assert.deepEqual(byEdge("duplicate_edge"), ["e-dup"]);
    assert.deepEqual(byEdge("duplicate_edge_id"), ["ok"]);
  });

  it("switch handles follow its cases", () => {
    const sw = testNode("sw", "switch", {
      cases: [{ label: "A", combine: "all", rules: [{ left: "{{ input }}", op: "exists" }] }],
      fallback: false
    }, { name: "Route" });
    const wf = testWorkflow([manual(), sw, testNode("a", "code", {}, { name: "A" })], [
      testEdge("t", "sw"),
      testEdge("sw", "a", "case:0", "good"),
      testEdge("sw", "a", "case:1", "bad"),
      testEdge("sw", "a", "default", "nofallback")
    ]);
    assert.deepEqual(only(problemsOf(wf), "edge_invalid_handle").map((problem) => problem.edgeId), ["bad", "nofallback"]);
  });

  it("cycles", () => {
    const wf = testWorkflow(
      [manual(), testNode("a", "code", {}, { name: "A" }), testNode("b", "code", {}, { name: "B" })],
      [testEdge("t", "a"), testEdge("a", "b"), testEdge("b", "a")]
    );
    const cycle = only(problemsOf(wf), "cycle");
    assert.equal(cycle.length, 1);
    assert.match(cycle[0]!.message, /A → B → A|B → A → B/);
  });
});

describe("templates", () => {
  it("syntax errors in every template field", () => {
    const bad = "{{ nope }}";
    const nodes = [
      manual(),
      agent("Ag", bad, { session: { kind: "new", title: bad } }),
      testNode("sh", "shell", { env: [{ name: "X", value: bad }] }, { name: "Sh" }),
      testNode("http", "http", {
        url: `https://x.test/${bad}`,
        headers: [{ name: "A", value: bad }],
        query: [{ name: "q", value: bad }],
        body: { kind: "json", value: bad }
      }, { name: "Http" }),
      testNode("form", "http", { url: "https://x.test", body: { kind: "form", fields: [{ name: "f", value: bad }] } }, { name: "Form" }),
      testNode("if", "if", { rules: [{ left: bad, op: "equals", right: bad }] }, { name: "If" }),
      testNode("sw", "switch", { cases: [{ label: "c", combine: "all", rules: [{ left: bad, op: "equals", right: bad }] }] }, { name: "Sw" }),
      testNode("stop", "stop", { value: bad, message: bad }, { name: "Stop" }),
      testNode("wf", "workflow", { workflowId: "other", input: bad }, { name: "Sub" }),
      testNode("saved", "agent", { prompt: { kind: "saved", promptId: "p1", append: bad } }, { name: "Saved" })
    ];
    const edges = nodes.slice(1).map((node) => testEdge("t", node.id));
    const syntax = only(problemsOf(testWorkflow(nodes, edges)), "template_syntax");
    assert.deepEqual(
      syntax.map((problem) => `${problem.nodeId}:${problem.field}`),
      [
        "Ag:config.prompt.text",
        "Ag:config.session.title",
        "sh:config.env.0.value",
        "http:config.url",
        "http:config.headers.0.value",
        "http:config.query.0.value",
        "http:config.body.value",
        "form:config.body.fields.0.value",
        "if:config.rules.0.left",
        "if:config.rules.0.right",
        "sw:config.cases.0.rules.0.left",
        "sw:config.cases.0.rules.0.right",
        "stop:config.value",
        "stop:config.message",
        "wf:config.input",
        "saved:config.prompt.append"
      ]
    );
  });

  it("code source is JavaScript, not a template", () => {
    const code = testNode("c", "code", { source: "export default () => `{{ nope }}`" }, { name: "C" });
    assert.deepEqual(codes(problemsOf(testWorkflow([manual(), code], [testEdge("t", "c")]))), []);
  });

  it("unknown blocks are errors; blocks that do not run first are warnings", () => {
    const wf = testWorkflow(
      [
        manual(),
        agent("First", "go"),
        agent("Second", "{{ nodes.First.output.text }} {{ nodes.Third.output.text }} {{ nodes.Ghost.output }} {{ nodes.Second.status }} {{ nodes[0] }}"),
        agent("Third", "x")
      ],
      [testEdge("t", "First"), testEdge("First", "Second"), testEdge("Second", "Third")]
    );
    const problems = problemsOf(wf);
    const unknown = only(problems, "unknown_reference");
    assert.equal(unknown.length, 2);
    assert.match(unknown[0]!.message, /no block named "Ghost"/);
    assert.match(unknown[1]!.message, /must name a block/);
    const notUpstream = only(problems, "reference_not_upstream");
    assert.deepEqual(notUpstream.map((problem) => problem.message.match(/"(\w+)"/)![1]), ["Third", "Second"]);
    assert.ok(notUpstream.every((problem) => problem.severity === "warning"));
  });

  it("{{ }} in a shell script is refused with the fix", () => {
    const shell = testNode("sh", "shell", { script: 'echo "{{ input.x }}"' }, { name: "Sh" });
    const problems = only(problemsOf(testWorkflow([manual(), shell], [testEdge("t", "sh")])), "shell_template");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.field, "config.script");
    assert.match(problems[0]!.message, /env entry/);
    const docker = testNode("sh", "shell", { script: "docker inspect -f '{{.State.Status}}' app" }, { name: "Sh" });
    assert.deepEqual(codes(problemsOf(testWorkflow([manual(), docker], [testEdge("t", "sh")]))), []);
  });

  it("secrets: unknown names, whole-store reads, and prompts", () => {
    const wf = testWorkflow(
      [
        manual(),
        testNode("h", "http", { url: "https://x.test", headers: [{ name: "Auth", value: "Bearer {{ secrets.TOKEN }} {{ secrets.MISSING }}" }] }, { name: "H" }),
        testNode("h2", "http", { url: "https://x.test/{{ secrets }}" }, { name: "H2" }),
        agent("Ag", "Use {{ secrets.TOKEN }} and {{ secrets.TOKEN }}")
      ],
      [testEdge("t", "h"), testEdge("t", "h2"), testEdge("t", "Ag")]
    );
    const problems = problemsOf(wf, { secretNames: ["TOKEN"] });
    assert.deepEqual(only(problems, "unknown_secret").map((problem) => problem.message), ["H: there is no secret named MISSING"]);
    assert.equal(only(problems, "secret_reference").length, 1);
    assert.equal(only(problems, "secret_in_prompt").length, 1, "once per field");
    assert.equal(only(problems, "secret_in_prompt")[0]!.severity, "warning");
    assert.equal(only(problemsOf(wf), "unknown_secret").length, 0, "without the names, nothing is unknown");
  });

  it("untrusted git text in a prompt warns", () => {
    const pr = testNode("git", "trigger.git", { event: { kind: "pull_request", actions: ["opened"] } }, { name: "PR" });
    const tag = testNode("tag", "trigger.git", { event: { kind: "tag", pattern: "v*" } }, { name: "Tag" });
    const cases: [string, string, boolean][] = [
      ["Title {{ trigger.pr.title }}", "git", true],
      ["{{ trigger.release.body }}", "tag", true],
      ["{{ trigger.pr | json }}", "tag", true],
      ["{{ trigger.pr.number }}", "git", false],
      ["{{ trigger.tag }}", "tag", false],
      ["{{ trigger | json }}", "git", true],
      ["{{ trigger | json }}", "tag", false],
      ["{{ input.pr.body }}", "git", true],
      ["{{ input.pr.body }}", "tag", false],
      ["{{ nodes.PR.output.pr.body }}", "git", true],
      ["{{ nodes.PR.status }}", "git", false]
    ];
    for (const [prompt, from, warns] of cases) {
      const wf = testWorkflow([pr, tag, agent("Ag", prompt)], [testEdge(from, "Ag")]);
      assert.equal(only(problemsOf(wf), "untrusted_prompt_input").length, warns ? 1 : 0, `${prompt} after ${from}`);
    }
    const http = testNode("h", "http", { url: "https://x.test", body: { kind: "json", value: "{{ trigger.pr.body | json }}" } }, { name: "H" });
    assert.equal(only(problemsOf(testWorkflow([pr, http], [testEdge("git", "h")])), "untrusted_prompt_input").length, 0, "data, not a prompt");
  });
});

describe("blocks", () => {
  it("agent: empty prompt, saved prompt, chain length, max minutes", () => {
    const entry = { agent: "codex", model: "gpt-5.5", accounts: {} };
    const wf = testWorkflow(
      [
        manual(),
        agent("Empty", "   "),
        testNode("Saved", "agent", { prompt: { kind: "saved", promptId: "gone" } }, { name: "Saved" }),
        agent("Long", "x", { chain: Array.from({ length: 9 }, () => entry), maxMinutes: 2000 })
      ],
      [testEdge("t", "Empty"), testEdge("t", "Saved"), testEdge("t", "Long")]
    );
    const problems = problemsOf(wf, { savedPromptIds: ["p1"] });
    assert.equal(only(problems, "empty_prompt").length, 1);
    assert.equal(only(problems, "unknown_saved_prompt").length, 1);
    assert.equal(only(problems, "chain_too_long").length, 1);
    assert.equal(only(problems, "timeout_too_long")[0]!.field, "config.maxMinutes");
    assert.equal(only(problemsOf(wf), "unknown_saved_prompt").length, 0);
  });

  it("agent: the chain is checked against the host catalogue when one is given", () => {
    const chain = [
      { agent: "claude", model: "opus", accounts: {} },
      { agent: "nope", model: "x", accounts: {} },
      { agent: "codex", model: "gpt-404", accounts: {} },
      { agent: "opencode", model: "anything", accounts: {} },
      { agent: "grok", model: "grok-4", accounts: {} }
    ];
    const wf = testWorkflow([manual(), agent("A", "x", { chain })], [testEdge("t", "A")]);
    const catalog = {
      agents: [
        { id: "claude", models: ["opus", "sonnet"] },
        { id: "codex", models: ["gpt-5.5"] },
        { id: "opencode", models: null },
        { id: "grok", enabled: false, models: ["grok-4"] }
      ]
    };
    const problems = problemsOf(wf, { catalog });
    const agents = only(problems, "unknown_agent");
    assert.deepEqual(agents.map((p) => [p.severity, p.field]), [["error", "config.chain.1.agent"], ["warning", "config.chain.4.agent"]]);
    const models = only(problems, "unknown_model");
    assert.deepEqual(models.map((p) => [p.severity, p.field]), [["error", "config.chain.2.model"], ["warning", "config.chain.3.model"]]);
    assert.match(models[0]!.message, /codex has no model "gpt-404" \(it has gpt-5\.5\)/);
    assert.equal(only(problemsOf(wf), "unknown_agent").length + only(problemsOf(wf), "unknown_model").length, 0, "no catalogue, no check");
  });

  it("agent: continue must name an upstream agent", () => {
    const code = testNode("c", "code", {}, { name: "Code" });
    const build = (fromNode: string, edges: ReturnType<typeof testEdge>[]) =>
      testWorkflow([manual(), agent("A", "x"), code, agent("B", "y", { session: { kind: "continue", fromNode } }), agent("Later", "z")], edges);
    const chain = [testEdge("t", "A"), testEdge("A", "c"), testEdge("c", "B"), testEdge("B", "Later")];
    assert.deepEqual(only(problemsOf(build("A", chain)), "continue_invalid"), []);
    assert.match(only(problemsOf(build("Nope", chain)), "continue_invalid")[0]!.message, /no block named/);
    assert.match(only(problemsOf(build("Code", chain)), "continue_invalid")[0]!.message, /not an agent/);
    assert.match(only(problemsOf(build("Later", chain)), "continue_invalid")[0]!.message, /does not run before/);
  });

  it("code: size, default export, memory, timeout", () => {
    const big = testNode("big", "code", { source: `export default () => 1;//${"x".repeat(WORKFLOW_LIMITS.maxCodeSourceBytes)}` }, { name: "Big" });
    const noExport = testNode("ne", "code", { source: "module.exports = 1", memoryMb: 100, timeoutMinutes: 2000 }, { name: "NoExport" });
    const problems = problemsOf(testWorkflow([manual(), big, noExport], [testEdge("t", "big"), testEdge("t", "ne")]));
    assert.equal(only(problems, "code_too_large").length, 1);
    assert.equal(only(problems, "code_no_default_export").length, 1);
    assert.equal(only(problems, "memory_out_of_range").length, 1);
    assert.equal(only(problems, "timeout_too_long").length, 1);
  });

  it("http: url and timeout", () => {
    const nodes = [
      manual(),
      testNode("h1", "http", { url: "" }, { name: "H1" }),
      testNode("h2", "http", { url: "ftp://x" }, { name: "H2" }),
      testNode("h3", "http", { url: "{{ input.url }}", timeoutSeconds: 4000 }, { name: "H3" })
    ];
    const problems = problemsOf(testWorkflow(nodes, nodes.slice(1).map((node) => testEdge("t", node.id))));
    assert.deepEqual(codes(problems).sort(), ["http_url_invalid", "http_url_missing", "timeout_too_long"]);
  });

  it("wait, block timeouts", () => {
    const nodes = [
      manual(),
      testNode("w1", "wait", { kind: "duration", minutes: WORKFLOW_LIMITS.waitMaxMinutes + 1 }, { name: "W1" }),
      testNode("w2", "wait", { kind: "until", time: "09:00", timezone: "Atlantis/Nowhere" }, { name: "W2" }),
      testNode("sh", "shell", {}, { name: "Sh", timeoutMinutes: 24 * 60 + 1 })
    ];
    const problems = problemsOf(testWorkflow(nodes, nodes.slice(1).map((node) => testEdge("t", node.id))));
    assert.deepEqual(codes(problems).sort(), ["invalid_timezone", "timeout_too_long", "wait_too_long"]);
  });

  it("schedule: cron and zone, preset drift", () => {
    const ok = testNode("s", "trigger.schedule", { preset: { kind: "minutes", every: 15 }, cron: "*/15 * * * *" }, { name: "S" });
    assert.deepEqual(problemsOf(testWorkflow([ok])), []);
    const drift = testNode("s", "trigger.schedule", { preset: { kind: "minutes", every: 15 }, cron: "*/10 * * * *" }, { name: "S" });
    assert.deepEqual(codes(problemsOf(testWorkflow([drift]))), ["schedule_preset_mismatch"]);
    const bad = testNode("s", "trigger.schedule", { preset: { kind: "cron" }, cron: "every day" }, { name: "S" });
    assert.deepEqual(codes(problemsOf(testWorkflow([bad]))), ["invalid_cron"]);
    const zone = problemsOf(testWorkflow([ok], [], { settings: { timezone: "Moon/Base" } }));
    assert.deepEqual(codes(zone), ["invalid_timezone", "invalid_cron"]);
    assert.equal(zone[0]!.field, "settings.timezone");
  });

  it("schedule: an 'every N' preset must divide the hour/day — an error on a save, a warning on a stored definition", () => {
    const uneven = testNode("s", "trigger.schedule", { preset: { kind: "minutes", every: 45 }, cron: "*/45 * * * *" }, { name: "S" });
    const stored = problemsOf(testWorkflow([uneven]));
    assert.deepEqual(stored.map((p) => [p.code, p.severity]), [["schedule_uneven_interval", "warning"]]);
    const saved = problemsOf(testWorkflow([uneven]), { strictScheduleIntervals: true });
    assert.deepEqual(saved.map((p) => [p.code, p.severity, p.field]), [["schedule_uneven_interval", "error", "config.preset"]]);
    const hours = testNode("s", "trigger.schedule", { preset: { kind: "hours", every: 5, atMinute: 0 }, cron: "0 */5 * * *" }, { name: "S" });
    assert.deepEqual(codes(problemsOf(testWorkflow([hours]), { strictScheduleIntervals: true })), ["schedule_uneven_interval"]);
    const even = testNode("s", "trigger.schedule", { preset: { kind: "hours", every: 6, atMinute: 0 }, cron: "0 */6 * * *" }, { name: "S" });
    assert.deepEqual(problemsOf(testWorkflow([even]), { strictScheduleIntervals: true }), []);
  });

  it("git: releases are GitHub only", () => {
    const release = (url: string) =>
      testNode("g", "trigger.git", { repo: { kind: "url", url }, event: { kind: "release", includePrereleases: false } }, { name: "G" });
    assert.deepEqual(codes(problemsOf(testWorkflow([release("https://bitbucket.org/a/b.git")]))), ["release_github_only"]);
    assert.deepEqual(codes(problemsOf(testWorkflow([release("git@github.com:a/b.git")]))), []);
  });

  it("sub-workflow: unset, self, unknown", () => {
    const sub = (workflowId: string) => testNode("s", "workflow", { workflowId }, { name: "Sub" });
    const run = (workflowId: string, opts?: ValidateWorkflowOptions) =>
      codes(problemsOf(testWorkflow([manual(), sub(workflowId)], [testEdge("t", "s")]), opts));
    assert.deepEqual(run("unset"), ["subworkflow_unset"]);
    assert.deepEqual(run("wf-1"), ["subworkflow_self"]);
    assert.deepEqual(run("other", { knownWorkflowIds: ["wf-1"] }), ["unknown_workflow"]);
    assert.deepEqual(run("other", { knownWorkflowIds: ["other"] }), []);
    assert.deepEqual(run("other"), []);
  });
});

describe("the whole graph", () => {
  it("no trigger is information only", () => {
    const problems = problemsOf(testWorkflow([testNode("c", "code", {}, { name: "C" })]));
    assert.deepEqual(problems.map((problem) => [problem.code, problem.severity]), [["no_trigger", "info"]]);
    assert.equal(hasWorkflowErrors(problems), false);
  });

  it("blocks no trigger reaches never run", () => {
    const wf = testWorkflow([manual(), testNode("a", "code", {}, { name: "A" }), testNode("loose", "code", {}, { name: "Loose" }), testNode("n", "note", {}, { name: "N" })], [testEdge("t", "a")]);
    assert.deepEqual(only(problemsOf(wf), "unreachable").map((problem) => problem.nodeId), ["loose"]);
  });

  it("pinned data", () => {
    const wf = testWorkflow([manual()], [], { pinned: { t: { ok: true }, gone: 1 } });
    assert.deepEqual(codes(problemsOf(wf)), ["pinned_unknown_node"]);
    const big = testWorkflow([manual()], [], { pinned: { t: "x".repeat(WORKFLOW_LIMITS.maxPinnedBytes + 1) } });
    assert.deepEqual(codes(problemsOf(big)), ["pinned_too_large"]);
  });

  it("the result carries schema defaults", () => {
    const raw = {
      id: "w",
      name: "Defaults",
      project: { kind: "existing", projectPath: "/w/ws/app" },
      nodes: [{ id: "t", name: "Manual", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} }],
      createdAt: T0,
      updatedAt: T0
    };
    const result = validateWorkflow(raw);
    assert.deepEqual(result.problems, []);
    assert.equal(result.workflow?.settings.overlap, "skip");
    assert.deepEqual(result.workflow?.edges, []);
  });
});
