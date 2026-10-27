import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseKnowledgeSimilarityGraphResponse } from "./validate.ts";
import { ApiClient } from "../api-client.ts";
import type { Transporter } from "../transporter.ts";

const node = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  kind: "post",
  author: "Hridoy",
  handle: "hridoyreh",
  savedAt: "2026-10-20T10:00:00.000Z",
  collections: ["kc_seo"],
  cluster: 0,
  degree: 1,
  ...overrides
});

describe("similarity graph wire validation", () => {
  it("reads a well-formed answer as it is", () => {
    const answer = {
      nodes: [node("ke_a"), node("ke_b", { cluster: 1, author: null, handle: null })],
      edges: [{ from: "ke_a", to: "ke_b", similarity: 0.91, tree: true }],
      clusters: [
        { id: 0, size: 1, label: null },
        { id: 1, size: 1, label: "Paywalls" }
      ],
      truncated: true,
      totals: { entries: 9, embedded: 7 }
    };
    assert.deepEqual(parseKnowledgeSimilarityGraphResponse(answer), answer);
  });

  it("repairs fields, drops unreadable nodes and duplicates, and edges whose ends are not in it", () => {
    const parsed = parseKnowledgeSimilarityGraphResponse({
      nodes: [
        node("ke_a", { kind: 3, author: "", collections: ["kc_seo", 4], cluster: -2, degree: "many", future: true }),
        node("ke_a", { title: "Duplicate" }),
        { title: "No id" },
        "ke_c",
        node("ke_b", { cluster: 1.7 })
      ],
      edges: [
        { from: "ke_a", to: "ke_b", similarity: "high", tree: "yes" },
        { from: "ke_b", to: "ke_a", similarity: 0.8, tree: true },
        { from: "ke_a", to: "ke_gone", similarity: 0.9, tree: false },
        { from: "ke_a", to: "ke_a", similarity: 1, tree: false },
        { from: 1, to: "ke_b" }
      ],
      clusters: [{ id: 0, size: 2, label: "  " }, "broken", { label: "Ads" }]
    });
    const counted = parseKnowledgeSimilarityGraphResponse({ nodes: [node("ke_a", { cluster: 1 }), node("ke_b", { cluster: 1 })], edges: [], clusters: [{ size: 0 }, "broken"] });
    assert.deepEqual(counted?.clusters[1], { id: 1, size: 2, label: null }, "an unreadable cluster counts its nodes");
    assert.ok(parsed);
    assert.deepEqual(parsed.nodes[0], {
      id: "ke_a",
      title: "Title ke_a",
      kind: "note",
      author: null,
      handle: "hridoyreh",
      savedAt: "2026-10-20T10:00:00.000Z",
      collections: ["kc_seo"],
      cluster: -1,
      degree: 0
    });
    assert.deepEqual(
      parsed.nodes.map((n) => [n.id, n.cluster]),
      [
        ["ke_a", -1],
        ["ke_b", -1]
      ],
      "an unreadable cluster index names no cluster"
    );
    assert.equal(parsed.edges.length, 1, "one edge per pair, with no self or missing-node edges");
    const [edge] = parsed.edges;
    assert.deepEqual([edge!.from, edge!.to, edge!.tree], ["ke_a", "ke_b", true]);
    assert.ok(Number.isFinite(edge!.similarity) && edge!.similarity >= -1 && edge!.similarity <= 1);
    assert.deepEqual(
      parsed.clusters,
      [
        { id: 0, size: 2, label: null },
        { id: 1, size: 0, label: null },
        { id: 2, size: 0, label: "Ads" }
      ],
      "clusters keep their positions: nodes index into them"
    );
    assert.equal(parsed.truncated, false);
    assert.deepEqual(parsed.totals, { entries: 2, embedded: 2 }, "absent totals: the nodes drawn");
  });

  it("reads absent clusters as none and never fewer entries than embedded ones", () => {
    const parsed = parseKnowledgeSimilarityGraphResponse({ nodes: [], edges: [], totals: { entries: 1, embedded: 3 } });
    assert.deepEqual(parsed, { nodes: [], edges: [], clusters: [], truncated: false, totals: { entries: 3, embedded: 3 } });
  });

  it("refuses a broken envelope", () => {
    assert.equal(parseKnowledgeSimilarityGraphResponse(null), null);
    assert.equal(parseKnowledgeSimilarityGraphResponse([]), null);
    assert.equal(parseKnowledgeSimilarityGraphResponse("<html>proxy error</html>"), null);
    assert.equal(parseKnowledgeSimilarityGraphResponse({ nodes: [] }), null, "no edge list");
    assert.equal(parseKnowledgeSimilarityGraphResponse({ nodes: {}, edges: [] }), null, "nodes not a list");
  });

  it("the client asks the route with its query and validates the answer", async () => {
    let answer: unknown = null;
    const requests: { method: string; path: string; query?: Record<string, unknown> }[] = [];
    const transporter = {
      kind: "fake",
      request: async (req: { method: string; path: string; query?: Record<string, unknown> }) => {
        requests.push(req);
        return { status: 200, ok: true, data: answer };
      },
      openStream: () => ({ close: () => undefined })
    } as unknown as Transporter;
    const client = new ApiClient({ id: "c1" } as never, transporter);

    answer = { nodes: [node("ke_a")], edges: [], clusters: [{ id: 0, size: 1, label: null }], truncated: false, totals: { entries: 1, embedded: 1 } };
    const graph = await client.getKnowledgeSimilarityGraph({ collections: "kc_a,kc_b", k: 4, limit: 500 });
    assert.equal(graph.nodes[0]!.id, "ke_a");
    assert.equal(requests[0]!.method, "GET");
    assert.equal(requests[0]!.path, "/api/knowledge/similarity-graph");
    assert.deepEqual(requests[0]!.query, { collections: "kc_a,kc_b", k: 4, limit: 500 });

    answer = { nodes: "x", edges: [] };
    await assert.rejects(client.getKnowledgeSimilarityGraph());
  });
});
