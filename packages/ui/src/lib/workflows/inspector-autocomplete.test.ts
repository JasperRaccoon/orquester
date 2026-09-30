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

describe("templateCompletions", () => {
  it("offers the roots right after {{", () => {
    assert.deepEqual(labels("Hi {{ ")?.sort(), ["input", "nodes", "project", "run", "secrets", "trigger", "workflow"]);
    assert.deepEqual(labels("{{no"), ["nodes"]);
  });

  it("walks nodes → a block → output → its known fields, from the caret back", () => {
    assert.deepEqual(labels("{{ nodes.")?.sort(), ["Fetch", "OnTag", "Review"]);
    assert.deepEqual(labels("{{ nodes.Re"), ["Review"]);
    assert.deepEqual(labels("{{ nodes.Review.")?.sort(), ["error", "output", "status"]);
    assert.deepEqual(labels("{{ nodes.Review.output.t"), ["text"]);
    assert.deepEqual(labels("{{ nodes.OnTag.output.pr.")?.sort(), ["action", "author", "base", "body", "head", "headSha", "number", "title", "url"]);
    assert.deepEqual(labels("{{ nodes.Review.error.")?.sort(), ["kind", "message"]);
    const answer = templateCompletions("x {{ nodes.Re", 13, scope());
    assert.deepEqual([answer?.from, answer?.to], [11, 13], "replaces just the typed part");
  });

  it("knows the trigger's fields, the run, the project, the secrets and the input", () => {
    assert.ok(labels("{{ trigger.")?.includes("tag"));
    assert.deepEqual(labels("{{ trigger.release.")?.sort(), ["body", "id", "name", "prerelease", "tag", "url"]);
    assert.deepEqual(labels("{{ run.")?.sort(), ["attempt", "id", "startedAt", "workflowId", "workflowName"]);
    assert.deepEqual(labels("{{ project.b"), ["branch"]);
    assert.deepEqual(labels("{{ secrets.")?.sort(), ["API_TOKEN", "SLACK_PATH"]);
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
