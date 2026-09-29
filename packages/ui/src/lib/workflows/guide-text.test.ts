import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_BLOCK_GUIDES, WORKFLOW_SECRETS_GUIDE, type WorkflowNodeType } from "@orquester/api";

import {
  BLOCK_OUTPUT_GUIDE_TITLES,
  blockGuideSection,
  blockGuideSections,
  blockOutputGuide,
  guideItemText,
  plainGuideText,
  splitGuideText
} from "./guide-text.ts";

describe("splitGuideText", () => {
  it("turns backtick spans into code runs", () => {
    assert.deepEqual(splitGuideText("Read `nodes.X.output` or `input`."), [
      { code: false, text: "Read " },
      { code: true, text: "nodes.X.output" },
      { code: false, text: " or " },
      { code: true, text: "input" },
      { code: false, text: "." }
    ]);
  });

  it("keeps plain text, code at the edges, and never makes empty runs", () => {
    assert.deepEqual(splitGuideText("no code here"), [{ code: false, text: "no code here" }]);
    assert.deepEqual(splitGuideText("`a``b`"), [{ code: true, text: "ab" }]);
    assert.deepEqual(splitGuideText(""), []);
    assert.deepEqual(splitGuideText("``"), []);
  });

  it("leaves an unpaired backtick in the text as written", () => {
    assert.deepEqual(splitGuideText("`a` then ` alone"), [
      { code: true, text: "a" },
      { code: false, text: " then ` alone" }
    ]);
  });

  it("keeps code characters (braces, quotes, pipes) as they are", () => {
    assert.deepEqual(splitGuideText('`{{ input | json }}` and `"$NAME"`'), [
      { code: true, text: "{{ input | json }}" },
      { code: false, text: " and " },
      { code: true, text: '"$NAME"' }
    ]);
    assert.equal(plainGuideText("Use `| json` to embed."), "Use | json to embed.");
  });
});

describe("the guide sections the inspector shows", () => {
  it("names only sections the shared guide has", () => {
    for (const [type, titles] of Object.entries(BLOCK_OUTPUT_GUIDE_TITLES) as [WorkflowNodeType, readonly string[]][]) {
      const guide = WORKFLOW_BLOCK_GUIDES[type].map((section) => section.title);
      for (const title of titles) assert.ok(guide.includes(title), `${type} has a "${title}" section`);
      assert.equal(blockOutputGuide(type).length, titles.length, `${type}: every output section is found`);
    }
    assert.deepEqual(blockOutputGuide("note"), []);
  });

  it("finds every section and fact the block forms read by title or term", () => {
    // ProcessSettings.tsx, FlowSettings.tsx, AgentSettings.tsx pick these out of the shared guide.
    const sections: [WorkflowNodeType, string][] = [
      ["code", "Runtime"],
      ["code", "Result"],
      ["code", "Limits"],
      ["shell", "Script"],
      ["shell", "Result"],
      ["shell", "Limits"],
      ["http", "Request"],
      ["http", "Response"],
      ["http", "Limits"],
      ["merge", "Joining"],
      ["stop", "Ending"],
      ["workflow", "Child run"]
    ];
    for (const [type, title] of sections) assert.ok(blockGuideSection(type, title), `${type} has a "${title}" section`);
    assert.equal(blockGuideSections("code", "Runtime", "Nope", "Limits").length, 2);

    const terms: [WorkflowNodeType, string, string][] = [
      ["http", "Request", "body"],
      ["merge", "Joining", "all"],
      ["merge", "Joining", "first"],
      ["stop", "Ending", "value"],
      ["stop", "Ending", "message"],
      ["workflow", "Child run", "input"]
    ];
    for (const [type, title, term] of terms) {
      assert.ok(guideItemText(blockGuideSection(type, title)!.items, term), `${type} ${title} explains "${term}"`);
    }
    assert.ok(guideItemText(WORKFLOW_SECRETS_GUIDE, "agent prompts"));
    assert.equal(guideItemText(WORKFLOW_SECRETS_GUIDE, "nope"), undefined);
  });
});
