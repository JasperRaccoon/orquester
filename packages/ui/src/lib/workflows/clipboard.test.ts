import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseWorkflowClipboard,
  pasteWorkflowClipboard,
  serializeWorkflowSelection
} from "./clipboard.ts";
import { edge, node, sequentialIds, workflow } from "./testing.ts";

const source = () =>
  workflow(
    [
      node("t", "trigger.manual", {}, { name: "Start", position: { x: 0, y: 0 } }),
      node("a", "agent", { prompt: { kind: "text", text: "Fix {{ nodes.Start.output.input }}" } }, { name: "Review", position: { x: 320, y: 0 } }),
      node(
        "h",
        "http",
        { url: "https://x.test/{{ nodes.Review.output.text }}" },
        { name: "Post", position: { x: 640, y: 16 } }
      ),
      node(
        "c",
        "agent",
        { session: { kind: "continue", fromNode: "Review" } },
        { name: "Followup", position: { x: 640, y: 160 } }
      )
    ],
    [edge("t", "a"), edge("a", "h"), edge("a", "c", "error")]
  );

describe("clipboard: copy", () => {
  it("carries the selected blocks and only the edges between them, under the marker", () => {
    const text = serializeWorkflowSelection(source(), ["a", "h"]);
    const clip = JSON.parse(text!);
    assert.equal(clip["orquester.workflow-clipboard"], 1);
    assert.deepEqual(clip.nodes.map((n: { id: string }) => n.id), ["a", "h"]);
    assert.deepEqual(clip.edges.map((e: { id: string }) => e.id), ["a-success-h"]);
    assert.equal(serializeWorkflowSelection(source(), []), null);
  });

  it("is not fooled by other text, or by a payload whose blocks do not parse", () => {
    assert.equal(parseWorkflowClipboard("hello"), null);
    const unsupported = JSON.parse(serializeWorkflowSelection(source(), ["a"])!);
    unsupported["orquester.workflow-clipboard"] = 2;
    assert.equal(parseWorkflowClipboard(JSON.stringify(unsupported)), null);
    assert.equal(parseWorkflowClipboard(`{"orquester.workflow-clipboard": 1, "nodes": [{"id": "x"}]}`), null);
    assert.equal(parseWorkflowClipboard(null), null);
  });
});

describe("clipboard: paste", () => {
  it("re-mints ids and names and keeps inner edges and references", () => {
    const base = source();
    const clip = parseWorkflowClipboard(serializeWorkflowSelection(base, ["a", "h", "c"]))!;
    const { workflow: pasted, nodeIds } = pasteWorkflowClipboard(base, clip, { mintId: sequentialIds("new") });
    assert.equal(nodeIds.length, 3);
    const added = pasted.nodes.filter((n) => nodeIds.includes(n.id));
    assert.deepEqual(added.map((n) => n.name), ["Review2", "Post2", "Followup2"]);
    assert.ok(added.every((n) => !["a", "h", "c"].includes(n.id)));
    const post = added.find((n) => n.name === "Post2");
    assert.equal(post?.type === "http" ? post.config.url : null, "https://x.test/{{ nodes.Review2.output.text }}");
    const followup = added.find((n) => n.name === "Followup2");
    assert.equal(followup?.type === "agent" && followup.config.session.kind === "continue" ? followup.config.session.fromNode : null, "Review2");
    const review = added.find((n) => n.name === "Review2");
    // A reference to a block that was not copied keeps pointing at the original.
    assert.equal(review?.type === "agent" && review.config.prompt.kind === "text" ? review.config.prompt.text : null, "Fix {{ nodes.Start.output.input }}");
    const newEdges = pasted.edges.slice(base.edges.length);
    assert.equal(newEdges.length, 2);
    assert.ok(newEdges.every((e) => nodeIds.includes(e.source) && nodeIds.includes(e.target)));
    assert.equal(pasted.nodes.length, 7);
  });

  it("keeps a name that is free in the target workflow (a paste across workflows)", () => {
    const clip = parseWorkflowClipboard(serializeWorkflowSelection(source(), ["h"]))!;
    const other = workflow([node("z", "trigger.manual", {}, { name: "Go" })]);
    const { workflow: pasted } = pasteWorkflowClipboard(other, clip, { mintId: sequentialIds(), at: { x: 101, y: 203 } });
    const post = pasted.nodes.find((n) => n.name === "Post");
    assert.ok(post, "the name survives");
  });

  it("does not turn A→B, B→C renames into A→C", () => {
    const base = workflow([
      node("x", "http", { url: "{{ nodes.Post.output }} {{ nodes.Post2.output }}" }, { name: "Post" }),
      node("y", "http", {}, { name: "Post2" })
    ]);
    const clip = parseWorkflowClipboard(serializeWorkflowSelection(base, ["x", "y"]))!;
    const { workflow: pasted, nodeIds } = pasteWorkflowClipboard(base, clip, { mintId: sequentialIds() });
    const x = pasted.nodes.find((n) => n.id === nodeIds[0]);
    assert.equal(x?.name, "Post3");
    assert.equal(x?.type === "http" ? x.config.url : null, "{{ nodes.Post3.output }} {{ nodes.Post4.output }}");
  });
});
