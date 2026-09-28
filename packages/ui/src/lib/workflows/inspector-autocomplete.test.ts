import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { completionScopeFor, templateCompletions, type CompletionScope } from "./inspector-autocomplete.ts";
import { edge, node, workflow } from "./testing.ts";

const def = workflow(
  [
    node("t", "trigger.git", {}, { name: "OnTag" }),
    node("f", "code", {}, { name: "Fetch" }),
    node("r", "agent", {}, { name: "Review" }),
    node("p", "http", {}, { name: "Post" }),
    node("x", "shell", {}, { name: "Later" })
  ],
  [edge("t", "f"), edge("f", "r"), edge("r", "p"), edge("p", "x")]
);

const scope = (options: { prompt?: boolean } = {}): CompletionScope =>
  completionScopeFor(def, "p", { secretNames: ["API_TOKEN", "SLACK_PATH"], promptVariables: options.prompt ?? false });

const labels = (text: string, s = scope(), pos = text.length) => templateCompletions(text, pos, s)?.options.map((option) => option.label) ?? null;

describe("the completion scope", () => {
  it("lists only the blocks upstream, the triggers, and the direct input's fields", () => {
    const s = scope();
    assert.deepEqual(s.upstream.map((n) => n.name), ["OnTag", "Fetch", "Review"]);
    assert.deepEqual(s.triggerTypes, ["trigger.git"]);
    assert.deepEqual(s.inputFields, ["text", "sessionId", "agent", "model", "accountId", "durationMs", "hops"]);
  });
});

describe("templateCompletions", () => {
  it("offers the roots right after {{", () => {
    assert.deepEqual(labels("Hi {{ "), ["nodes", "input", "trigger", "run", "project", "secrets", "workflow"]);
    assert.deepEqual(labels("{{no"), ["nodes"]);
  });

  it("walks nodes → a block → output → its known fields, from the caret back", () => {
    assert.deepEqual(labels("{{ nodes."), ["OnTag", "Fetch", "Review"]);
    assert.deepEqual(labels("{{ nodes.Re"), ["Review"]);
    assert.deepEqual(labels("{{ nodes.Review."), ["output", "status", "error"]);
    assert.deepEqual(labels("{{ nodes.Review.output.t"), ["text"]);
    assert.deepEqual(labels("{{ nodes.OnTag.output.pr."), ["number", "title", "body", "url", "author", "head", "base", "action", "headSha"]);
    assert.deepEqual(labels("{{ nodes.Review.error."), ["kind", "message"]);
    const answer = templateCompletions("x {{ nodes.Re", 13, scope());
    assert.deepEqual([answer?.from, answer?.to], [11, 13], "replaces just the typed part");
  });

  it("knows the trigger's fields, the run, the project, the secrets and the input", () => {
    assert.ok(labels("{{ trigger.")?.includes("tag"));
    assert.deepEqual(labels("{{ trigger.release."), ["id", "name", "tag", "body", "url", "prerelease"]);
    assert.deepEqual(labels("{{ run."), ["id", "startedAt", "workflowId", "workflowName", "attempt"]);
    assert.deepEqual(labels("{{ project.b"), ["branch"]);
    assert.deepEqual(labels("{{ secrets."), ["API_TOKEN", "SLACK_PATH"]);
    assert.deepEqual(labels("{{ input.te"), ["text"]);
  });

  it("offers filters after a pipe, with arguments filled in", () => {
    const answer = templateCompletions("{{ input.text | de", 18, scope());
    assert.deepEqual(answer?.options.map((o) => [o.label, o.apply]), [["default", 'default("")']]);
    assert.ok(labels("{{ input.text | ")?.includes("json"));
  });

  it("says nothing outside an expression, after one closed, or after an escape", () => {
    assert.equal(labels("plain text"), null);
    assert.equal(labels("{{ input }} and "), null);
    assert.equal(labels("\\{{ nodes."), null);
  });

  it("offers {variables} in a prompt only, and never inside {{", () => {
    const prompt = scope({ prompt: true });
    const answer = templateCompletions("On {br", 6, prompt);
    assert.deepEqual(answer?.options.map((o) => [o.label, o.apply]), [["branch", "branch}"]]);
    assert.equal(labels("On {br", scope()), null);
    assert.ok(labels("On {", prompt)?.includes("diff"));
  });
});
