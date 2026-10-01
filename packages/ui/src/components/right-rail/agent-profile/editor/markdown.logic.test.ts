import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialMarkdownForm,
  markdownDraftFromForm,
  markdownEditorModel,
  validateMarkdownForm
} from "./markdown.logic";

test("a new skill's switches start at the CLI's defaults and send nothing until changed", () => {
  const model = markdownEditorModel("claude", "skill");
  const form = initialMarkdownForm(model, "review-pr", "Body");
  assert.equal(form.values["user-invocable"], true);
  assert.equal(form.values["disable-model-invocation"], false);
  form.values.description = "  Reviews a PR.  ";
  assert.deepEqual(markdownDraftFromForm("skill", model, form).frontmatter, { name: "review-pr", description: "Reviews a PR." });
  form.values["user-invocable"] = false;
  form.values["disable-model-invocation"] = true;
  assert.deepEqual(markdownDraftFromForm("skill", model, form).frontmatter, {
    name: "review-pr",
    description: "Reviews a PR.",
    "disable-model-invocation": true,
    "user-invocable": false
  });
});

test("editing keeps unknown keys and type-mismatched keys untouched, and removes a cleared key", () => {
  const document = {
    frontmatter: {
      name: "review-pr",
      description: "Old",
      "allowed-tools": ["Read", "Grep"],
      model: "opus",
      metadata: { owner: "me" },
      "disable-model-invocation": false
    },
    body: "Do it."
  };
  const model = markdownEditorModel("claude", "skill", document);
  assert.deepEqual(model.keptKeys, ["allowed-tools", "metadata"]);
  assert.equal(model.fields.some((field) => field.key === "allowed-tools"), false);
  const form = initialMarkdownForm(model, "review-pr", document.body);
  assert.equal(form.values.model, "opus");
  assert.equal(form.body, "Do it.");
  form.values.model = "";
  form.values.description = "New";
  const draft = markdownDraftFromForm("skill", model, form);
  assert.deepEqual(draft, {
    name: "review-pr",
    frontmatter: {
      name: "review-pr",
      description: "New",
      model: null,
      "disable-model-invocation": false
    },
    body: "Do it."
  });
  assert.equal("allowed-tools" in draft.frontmatter, false, "the list on disk is not rewritten");
  assert.equal("metadata" in draft.frontmatter, false);
});

test("a command carries no frontmatter name and keeps a name key found on disk", () => {
  const document = { frontmatter: { name: "legacy", description: "Review" }, body: "Review $ARGUMENTS" };
  const model = markdownEditorModel("opencode", "command", document);
  assert.deepEqual(model.keptKeys, ["name"]);
  const form = initialMarkdownForm(model, "git/review", document.body);
  form.values.subtask = true;
  assert.deepEqual(markdownDraftFromForm("command", model, form).frontmatter, { description: "Review", subtask: true });
});

test("names: Grok's commands are flat files — a folder is refused before the daemon does", () => {
  const grok = markdownEditorModel("grok", "command");
  const form = initialMarkdownForm(grok, "git/pr", "Body");
  assert.equal(validateMarkdownForm("command", grok, form).valid, false);
  assert.equal(validateMarkdownForm("command", markdownEditorModel("opencode", "command"), form).errors.name, undefined);
  form.name = "git-pr";
  assert.equal(validateMarkdownForm("command", grok, form).valid, true);
});

test("validation: a skill needs its description and a body; a command's description is optional", () => {
  const skill = markdownEditorModel("codex", "skill");
  const form = initialMarkdownForm(skill, "x", "");
  let result = validateMarkdownForm("skill", skill, form);
  assert.equal(result.valid, false);
  assert.ok(result.errors.fields.description);
  assert.ok(result.errors.body);
  form.values.description = "d";
  form.body = "b";
  assert.equal(validateMarkdownForm("skill", skill, form).valid, true);
  const command = markdownEditorModel("codex", "command");
  result = validateMarkdownForm("command", command, initialMarkdownForm(command, "review", "Do"));
  assert.equal(result.valid, true);
});
