import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeClusterLabelsPath } from "./index.ts";
import { readKnowledgeClusterLabelsFile, serializeKnowledgeClusterLabelsFile } from "./knowledge-cluster-labels.ts";

test("the cluster labels file sits in the plugin dir", () => {
  assert.equal(knowledgeClusterLabelsPath("/app"), "/app/daemon/plugins/knowledge-graph/cluster-labels.json");
});

test("records read tolerantly; unreadable ones, unknown fields and keys survive a rewrite", () => {
  const raw = {
    version: 1,
    labels: [
      { key: "k1", members: ["ke_a", "ke_b", "ke_c"], label: "App Store review", labeledAt: "t", extra: true },
      { key: "k1", members: ["ke_x"], label: "Duplicate key" },
      { key: "k2", members: [], label: "No members" },
      { key: "k3", members: ["ke_d"], label: "Paywall pricing", labeledAt: 5 }
    ],
    future: [1]
  };
  const file = readKnowledgeClusterLabelsFile(raw);
  assert.deepEqual(
    file.labels.map((l) => [l.key, l.label, l.labeledAt]),
    [
      ["k1", "App Store review", "t"],
      ["k3", "Paywall pricing", ""]
    ]
  );
  assert.equal((file.labels[0] as Record<string, unknown>).extra, true);
  assert.equal(file.unreadable.length, 2);
  assert.equal(file.readOnly, false);
  const written = JSON.parse(serializeKnowledgeClusterLabelsFile(file)) as Record<string, unknown>;
  assert.equal((written.labels as unknown[]).length, 4);
  assert.deepEqual(written.future, [1]);
});

test("a newer version is read-only; anything but an object is empty", () => {
  assert.equal(readKnowledgeClusterLabelsFile({ version: 2, labels: [] }).readOnly, true);
  assert.deepEqual(readKnowledgeClusterLabelsFile([]).labels, []);
  assert.deepEqual(readKnowledgeClusterLabelsFile("x").labels, []);
  assert.deepEqual(readKnowledgeClusterLabelsFile({ version: 1 }).labels, []);
});
