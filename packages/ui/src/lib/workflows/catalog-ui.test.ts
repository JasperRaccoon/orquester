import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactExpression, filterPalette, nodeSummary, ruleText } from "./catalog-ui.ts";
import { node } from "./testing.ts";

const agent = (chain: unknown[], extra: Record<string, unknown> = {}) => node("a", "agent", { chain, ...extra });
const entry = (agentId: string, model: string, options?: unknown[]) => ({ agent: agentId, model, accounts: { strategy: "least-used" }, ...(options ? { options } : {}) });

describe("block summary lines", () => {
  it("agents: the first choice with its effort, then the fallback", () => {
    assert.equal(
      nodeSummary(agent([entry("claude", "opus", [{ id: "effort", value: "high" }]), entry("codex", "gpt-5.5")])),
      "Claude Opus · High → Codex fallback"
    );
    assert.equal(nodeSummary(agent([entry("claude", "opus"), entry("claude", "sonnet")])), "Claude Opus → Sonnet fallback");
    assert.equal(nodeSummary(agent([entry("grok", "grok-4"), entry("codex", "x"), entry("claude", "y")])), "Grok grok-4 → 2 fallbacks");
    assert.equal(
      nodeSummary(agent([entry("codex", "gpt-5.5")], { session: { kind: "continue", fromNode: "Review" } })),
      "Continues Review · Codex gpt-5.5"
    );
  });

  it("agents: the editor's own labels win when it has them", () => {
    const text = nodeSummary(agent([entry("claude", "claude-opus-4-1", [{ id: "effort", value: "max" }])]), {
      modelLabel: () => "Opus 4.1",
      optionLabel: () => "Maximum"
    });
    assert.equal(text, "Claude Opus 4.1 · Maximum");
  });

  it("triggers: in words", () => {
    assert.equal(nodeSummary(node("s", "trigger.schedule", { preset: { kind: "minutes", every: 15 }, cron: "*/15 * * * *" })), "Every 15 min");
    assert.equal(
      nodeSummary(node("g", "trigger.git", { event: { kind: "tag", pattern: "v*" } }), { projectName: "Apps-Stats" }),
      "New tag v* · Apps-Stats"
    );
    assert.equal(nodeSummary(node("m", "trigger.manual")), "Run now");
  });

  it("http: the method and a short URL", () => {
    assert.equal(
      nodeSummary(node("h", "http", { method: "POST", url: "https://api.atlassian.com/ex/jira/cloud/rest/api/3/issue" })),
      "POST api.atlassian.com/…/issue"
    );
    assert.equal(nodeSummary(node("h", "http", { url: "https://example.com/v1/items" })), "GET example.com/v1/items");
    assert.equal(nodeSummary(node("h", "http", { url: "" })), "GET · no URL yet");
  });

  it("flow and code blocks", () => {
    assert.equal(
      nodeSummary(node("i", "if", { combine: "all", rules: [{ left: "{{ a }}", op: "equals", right: "x" }, { left: "{{ b }}", op: "isEmpty" }] })),
      "2 rules · all"
    );
    assert.equal(nodeSummary(node("i", "if", { rules: [{ left: "{{ input.items | length }}", op: "gt", right: "0" }] })), "input.items | length > 0");
    assert.equal(nodeSummary(node("w", "switch")), "1 case + default");
    assert.equal(nodeSummary(node("m", "merge", { mode: "first" })), "First branch to arrive");
    assert.equal(nodeSummary(node("w", "wait", { kind: "duration", minutes: 90 })), "Wait 1 h 30 min");
    assert.equal(nodeSummary(node("w", "wait", { kind: "until", time: "09:00" })), "Until 09:00");
    assert.equal(nodeSummary(node("s", "stop", { as: "failure", message: "Nope" })), "Ends the run as failed · Nope");
    assert.equal(nodeSummary(node("c", "code", { source: "// Finds new tickets.\nexport default () => 1" })), "Finds new tickets.");
    assert.equal(nodeSummary(node("c", "code", { source: "export default () => 1\n" })), "JavaScript · 1 line");
    assert.equal(nodeSummary(node("s", "shell", { script: "# comment\n\ngit tag --list 'v*'" })), "$ git tag --list 'v*'");
    assert.equal(nodeSummary(node("s", "workflow")), "Pick a workflow");
    assert.equal(nodeSummary(node("s", "workflow", { workflowId: "w2" }), { workflowName: () => "Deploy" }), "Runs “Deploy”");
  });

  it("rule text", () => {
    assert.equal(ruleText({ left: "{{ input.title }}", op: "contains", right: "bug" }), 'input.title contains "bug"');
    assert.equal(ruleText({ left: "{{ input.ok }}", op: "isTrue" }), "input.ok is true");
    assert.equal(compactExpression("{{ a }} and {{ b }}"), "{{ a }} and {{ b }}");
  });
});

describe("the palette", () => {
  it("groups every block; a search narrows by title, description and keywords", () => {
    assert.deepEqual(filterPalette("").map((g) => g.label), ["Triggers", "Agents", "Code", "Flow", "Integrations"]);
    assert.deepEqual(filterPalette("cron").flatMap((g) => g.types), ["trigger.schedule"]);
    assert.deepEqual(filterPalette("bash").flatMap((g) => g.types), ["shell"]);
    assert.ok(filterPalette("claude").flatMap((g) => g.types).includes("agent"));
  });

  it("from an output it offers no triggers and no notes", () => {
    const types = filterPalette("", { allowTriggers: false, allowNotes: false }).flatMap((g) => g.types);
    assert.ok(!types.some((type) => type.startsWith("trigger.")));
    assert.ok(!types.includes("note"));
  });
});
