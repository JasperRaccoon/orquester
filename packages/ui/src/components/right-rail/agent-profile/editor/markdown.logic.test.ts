import assert from "node:assert/strict";
import { test } from "node:test";

import {
  frontmatterDraft,
  initialMarkdownForm,
  markdownDraftFromForm,
  markdownEditorModel,
  markdownFormFromDocument,
  markdownNameError,
  markdownNameHint,
  validateMarkdownForm
} from "./markdown.logic";

test("a skill's name field is the name input, never a second field", () => {
  const model = markdownEditorModel("claude", "skill");
  assert.equal(model.fields.some((field) => field.key === "name"), false);
  assert.equal(model.fields[0]!.key, "description");
  assert.deepEqual(model.keptKeys, []);
});

test("a new skill's switches start at the CLI's defaults and send nothing until changed", () => {
  const model = markdownEditorModel("claude", "skill");
  const form = initialMarkdownForm(model, "review-pr", "Body");
  assert.equal(form.values["user-invocable"], true);
  assert.equal(form.values["disable-model-invocation"], false);
  form.values.description = "  Reviews a PR.  ";
  assert.deepEqual(frontmatterDraft("skill", model, form), { name: "review-pr", description: "Reviews a PR." });
  form.values["user-invocable"] = false;
  form.values["disable-model-invocation"] = true;
  assert.deepEqual(frontmatterDraft("skill", model, form), {
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
  const form = markdownFormFromDocument(model, "review-pr", document);
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
  const form = markdownFormFromDocument(model, "git/review", document);
  form.values.subtask = true;
  assert.deepEqual(frontmatterDraft("command", model, form), { description: "Review", subtask: true });
});

test("names: skills are hyphenated lowercase words, commands may have one folder", () => {
  assert.equal(markdownNameError("skill", "my-skill"), undefined);
  assert.ok(markdownNameError("skill", "My Skill"));
  assert.ok(markdownNameError("skill", "a--b"));
  assert.ok(markdownNameError("skill", "x".repeat(65)));
  assert.ok(markdownNameError("skill", ""));
  assert.equal(markdownNameError("command", "git/pr"), undefined);
  assert.ok(markdownNameError("command", "a/b/c"));
  assert.ok(markdownNameError("skill", "git/pr"));
});

test("names: Grok's commands are flat files — a folder is refused before the daemon does", () => {
  const grok = markdownEditorModel("grok", "command");
  assert.equal(grok.flatCommands, true);
  assert.equal(markdownEditorModel("claude", "command").flatCommands, false);
  assert.match(markdownNameError("command", "git/pr", { flatCommands: true }) ?? "", /No folder/);
  assert.equal(markdownNameError("command", "git-pr", { flatCommands: true }), undefined);
  const form = initialMarkdownForm(grok, "git/pr", "Body");
  assert.match(validateMarkdownForm("command", grok, form).errors.name ?? "", /No folder/);
  assert.equal(validateMarkdownForm("command", markdownEditorModel("opencode", "command"), form).errors.name, undefined);
  assert.match(markdownNameHint("command", grok), /no folder/);
  assert.match(markdownNameHint("command", markdownEditorModel("claude", "command")), /git\/pr/);
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
