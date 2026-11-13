/**
 * The storage map's layout, hit-testing and labels, without a canvas: what a
 * user would see as "bigger folders take more room", "a folder's contents sit
 * inside it", "the pointer picks the innermost block" and "labels only where
 * they fit".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StorageNode, StorageNodeKind } from "@orquester/api";

import { fitLabel, hitTest, isOpenable, layoutTreemap, tileLabel, type TreemapTile } from "./storage-treemap.logic";

function node(name: string, kind: StorageNodeKind, sizeBytes: number, children?: StorageNode[]): StorageNode {
  return {
    name,
    path: `/${name}`,
    kind,
    sizeBytes,
    apparentBytes: sizeBytes,
    items: children?.length ?? 1,
    hasChildren: kind === "dir",
    ...(children ? { children } : {})
  };
}

const area = (t: TreemapTile) => (t.x1 - t.x0) * (t.y1 - t.y0);
const center = (t: TreemapTile) => ({ x: (t.x0 + t.x1) / 2, y: (t.y0 + t.y1) / 2 });
const tileOf = (tiles: TreemapTile[], name: string) => {
  const tile = tiles.find((t) => t.node.name === name);
  assert.ok(tile, `${name} is drawn`);
  return tile;
};

const tree = node("/", "dir", 1000, [
  node("var", "dir", 600, [node("log", "dir", 400, [node("syslog", "file", 400)]), node("cache", "dir", 200)]),
  node("swap.img", "file", 300),
  node("etc", "dir", 100)
]);

describe("layoutTreemap", () => {
  it("gives bigger entries proportionally more room", () => {
    const { tiles } = layoutTreemap(tree, 800, 500, "dark");
    const varTile = tileOf(tiles, "var");
    const swap = tileOf(tiles, "swap.img");
    const etc = tileOf(tiles, "etc");
    assert.ok(area(varTile) > area(swap) && area(swap) > area(etc));
    // Roughly proportional to size (padding takes a little).
    const ratio = area(varTile) / area(etc);
    assert.ok(ratio > 5 && ratio < 7, `var/etc area ratio ${ratio}`);
  });

  it("nests every level of a folder inside it", () => {
    const { tiles } = layoutTreemap(tree, 800, 500, "dark");
    const inside = (child: TreemapTile, parent: TreemapTile) =>
      child.x0 >= parent.x0 && child.x1 <= parent.x1 && child.y0 >= parent.y0 && child.y1 <= parent.y1;
    const varTile = tileOf(tiles, "var");
    const log = tileOf(tiles, "log");
    const syslog = tileOf(tiles, "syslog");
    assert.ok(inside(log, varTile));
    assert.ok(inside(tileOf(tiles, "cache"), varTile));
    assert.ok(inside(syslog, log));
    assert.ok(area(log) > area(tileOf(tiles, "cache")));
  });

  it("draws nothing for an empty tree or an unmeasured box, and skips zero-byte entries", () => {
    assert.deepEqual(layoutTreemap(node("/", "dir", 0, []), 800, 500, "dark").tiles, []);
    assert.deepEqual(layoutTreemap(tree, 0, 0, "dark").tiles, []);
    assert.deepEqual(layoutTreemap(tree, Number.NaN, 500, "dark").tiles, []);

    const withEmpties = node("/", "dir", 10_000_000_000, [
      node("huge", "file", 10_000_000_000),
      node("empty", "file", 0),
      node("speck", "file", 1),
      node("odd", "file", Number.NaN)
    ]);
    const { tiles } = layoutTreemap(withEmpties, 300, 200, "light");
    assert.deepEqual(
      tiles.map((t) => t.node.name),
      ["huge"]
    );
    for (const t of tiles) assert.ok([t.x0, t.y0, t.x1, t.y1].every(Number.isFinite));
  });
});

describe("hitTest", () => {
  it("picks the innermost block under the pointer", () => {
    const layout = layoutTreemap(tree, 800, 500, "dark");
    const syslog = tileOf(layout.tiles, "syslog");
    assert.equal(hitTest(layout, center(syslog).x, center(syslog).y)?.node.name, "syslog");

    // var's own label strip is var, not one of its children.
    const varTile = tileOf(layout.tiles, "var");
    assert.ok(varTile.header > 0);
    assert.equal(hitTest(layout, varTile.x0 + 4, varTile.y0 + 2)?.node.name, "var");

    assert.equal(hitTest(layout, -5, 10), null);
    assert.equal(hitTest(layout, 900, 10), null);
  });
});

describe("isOpenable", () => {
  it("opens real folders only", () => {
    assert.equal(isOpenable(node("var", "dir", 10)), true);
    assert.equal(isOpenable({ ...node("empty", "dir", 0), hasChildren: false }), false);
    assert.equal(isOpenable(node("a.iso", "file", 10)), false);
    for (const kind of ["smaller", "other", "unaccounted"] as const) {
      assert.equal(isOpenable({ ...node(kind, kind, 10), hasChildren: true }), false, kind);
    }
  });
});

describe("labels", () => {
  const measure = (text: string) => text.length * 6;

  it("cuts a name with an ellipsis to the room it has, or drops it", () => {
    assert.equal(fitLabel("node_modules", 200, measure), "node_modules");
    const cut = fitLabel("node_modules", 40, measure);
    assert.ok(cut && cut.endsWith("…") && measure(cut) <= 40, String(cut));
    assert.equal(fitLabel("node_modules", 8, measure), null);
  });

  it("labels a block only when it is big enough to read", () => {
    const { tiles } = layoutTreemap(tree, 800, 500, "dark");
    const label = tileLabel(tileOf(tiles, "swap.img"), "300 B", measure);
    assert.equal(label?.name, "swap.img");
    assert.equal(label?.size, "300 B");

    const sliver = { ...tileOf(tiles, "swap.img"), x1: tileOf(tiles, "swap.img").x0 + 12 };
    assert.equal(tileLabel(sliver, "300 B", measure), null);
  });
});

describe("colours", () => {
  it("hatches the unaccounted block and unreadable folders, and paints folded entries flat grey", () => {
    const root = node("/", "dir", 1000, [
      node("data", "dir", 400),
      { ...node("srv", "dir", 200), unreadable: true },
      node("Unaccounted", "unaccounted", 200),
      node("12 smaller items", "smaller", 200)
    ]);
    const { tiles } = layoutTreemap(root, 600, 400, "dark");
    assert.equal(tileOf(tiles, "data").colors.hatch, null);
    assert.ok(tileOf(tiles, "srv").colors.hatch);
    assert.ok(tileOf(tiles, "Unaccounted").colors.hatch);
    const folded = tileOf(tiles, "12 smaller items").colors;
    assert.equal(folded.hatch, null);
    const [r, g, b] = [1, 3, 5].map((i) => folded.fill.slice(i, i + 2));
    assert.ok(r === g && g === b, `grey: ${folded.fill}`);
  });

  it("paints a folder's contents in its own hue family, apart from its neighbours", () => {
    const { tiles } = layoutTreemap(
      node("/", "dir", 1000, [
        node("a", "dir", 500, [node("a1", "file", 300), node("a2", "file", 200)]),
        node("b", "dir", 500, [node("b1", "file", 500)])
      ]),
      600,
      400,
      "dark"
    );
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.atan2(Math.sqrt(3) * (g! - b!), 2 * r! - g! - b!);
    };
    const near = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y))) < 0.4;
    const a1 = hue(tileOf(tiles, "a1").colors.fill);
    assert.ok(near(a1, hue(tileOf(tiles, "a2").colors.fill)));
    assert.ok(!near(a1, hue(tileOf(tiles, "b1").colors.fill)));
  });
});
