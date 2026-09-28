import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  escapePromptVariables,
  promptVariablesUsed,
  renderPromptTemplate
} from "./saved-prompts.ts";

describe("prompt variables", () => {
  it("lists the known variables a body uses, once each, in first-use order", () => {
    assert.deepEqual(
      promptVariablesUsed("Review {branch} in {project}; {branch} again, {issue}, {{diff}}"),
      ["branch", "project"]
    );
    assert.deepEqual(promptVariablesUsed("no variables here"), []);
  });

  it("renders known variables and leaves everything else as written", () => {
    const text = renderPromptTemplate(
      "On {branch} of {project}: {issue} ${x} { a: 1 } {model}",
      { branch: "main", project: "orquester" }
    );
    // `{issue}` is unknown, `{model}` has no value supplied, code braces are code.
    assert.equal(text, "On main of orquester: {issue} ${x} { a: 1 } {model}");
  });

  it("renders an escaped known name as its literal text", () => {
    assert.equal(renderPromptTemplate("Write {{branch}} here", { branch: "main" }), "Write {branch} here");
    // An escaped unknown name is not an escape at all.
    assert.equal(renderPromptTemplate("{{issue}}", {}), "{{issue}}");
  });

  it("substitutes a value verbatim, even one that looks like a variable", () => {
    assert.equal(renderPromptTemplate("{diff}", { diff: "+{project}\n" }), "+{project}\n");
  });

  it("substitutes an empty value", () => {
    assert.equal(renderPromptTemplate("[{changedFiles}]", { changedFiles: "" }), "[]");
  });
});

describe("escapePromptVariables", () => {
  it("keeps a sent prompt literal through a save and a render", () => {
    const sent = "On {date}, check {branch} and {{diff}}; ${x} { a: 1 } {issue}";
    const saved = escapePromptVariables(sent);
    assert.equal(saved, "On {{date}}, check {{branch}} and {{{diff}}}; ${x} { a: 1 } {issue}");
    assert.equal(promptVariablesUsed(saved).length, 0, "nothing in it is a live variable");
    assert.equal(renderPromptTemplate(saved, { date: "2026-09-27", branch: "main", diff: "x" }), sent);
  });

  it("leaves text without known variables alone", () => {
    assert.equal(escapePromptVariables("plain {foo} text"), "plain {foo} text");
  });
});
