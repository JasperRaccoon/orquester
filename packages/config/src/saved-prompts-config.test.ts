import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSavedPromptsConfig, savedPromptsPath } from "./index.ts";

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "p-1",
  title: "Review",
  description: "One line",
  body: "Review {diff}",
  tags: ["Review"],
  projectPath: "/ws/acme/site",
  pinned: true,
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:05:00.000Z",
  lastUsedAt: "2026-09-27T11:00:00.000Z",
  useCount: 3,
  ...overrides
});

test("savedPromptsPath lives beside the other daemon-owned indexes", () => {
  assert.equal(savedPromptsPath("/srv/orq"), "/srv/orq/daemon/saved-prompts.json");
});

test("a well-formed library round-trips unchanged", () => {
  const file = { version: 1, prompts: [record(), record({ id: "p-2", projectPath: null, lastUsedAt: null })] };
  assert.deepEqual(parseSavedPromptsConfig(file), { ...file, rejected: [], extra: {} });
});

test("bad entries are set aside one by one, verbatim; the rest of the library loads", () => {
  const bad = [
    record({ id: "" }),
    record({ id: "no-body", body: undefined }),
    record({ id: "bad-tags", tags: [{ name: "Review", color: "teal" }] }),
    record({ id: "bad-count", useCount: -1 }),
    record({ id: "bad-stamp", updatedAt: "soon" }),
    record({ id: "bad-scope", projectPath: "" }),
    42,
    null
  ];
  const parsed = parseSavedPromptsConfig({ version: 1, prompts: [record({ id: "keep" }), ...bad] });
  assert.deepEqual(parsed.prompts.map((p) => p.id), ["keep"]);
  assert.equal(parsed.rejected.length, bad.length);
  bad.forEach((entry, i) => assert.equal(parsed.rejected[i], entry, `entry ${i} is the very value found`));
});

test("a repeated id keeps its first record; the others are set aside, not dropped", () => {
  const first = record({ id: "same", title: "First" });
  const second = record({ id: "same", title: "Second" });
  const parsed = parseSavedPromptsConfig({ version: 1, prompts: [first, record({ id: "other" }), second] });
  assert.deepEqual(parsed.prompts.map((p) => [p.id, p.title]), [["same", "First"], ["other", "Review"]]);
  assert.equal(parsed.rejected[0], second);
});

test("unknown top-level keys are kept, exactly as found", () => {
  const parsed = parseSavedPromptsConfig(
    JSON.parse('{"version":1,"order":["b","a"],"prompts":[],"__proto__":{"polluted":true},"layout":{"width":320}}')
  );
  assert.deepEqual(Object.keys(parsed.extra), ["order", "__proto__", "layout"], "an own key, even __proto__");
  assert.equal(
    JSON.stringify(parsed.extra),
    '{"order":["b","a"],"__proto__":{"polluted":true},"layout":{"width":320}}'
  );
  assert.equal(Object.getPrototypeOf(parsed.extra), Object.prototype, "and never a prototype");
});

test("optional fields default, limits are NOT re-applied, and unknown fields pass through", () => {
  const [minimal, long] = parseSavedPromptsConfig({
    version: 1,
    prompts: [
      { id: "m", title: "M", body: "b", createdAt: "2026-09-27T10:00:00.000Z", updatedAt: "2026-09-27T10:00:00.000Z" },
      record({ id: "long", title: "t".repeat(1_000), tags: Array.from({ length: 20 }, (_, i) => `t${i}`), color: "teal" })
    ]
  }).prompts;
  assert.deepEqual(minimal, {
    id: "m",
    title: "M",
    description: "",
    body: "b",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    lastUsedAt: null,
    useCount: 0
  });
  assert.equal(long.title.length, 1_000, "another build's limits must not drop a stored prompt");
  assert.equal(long.tags.length, 20);
  assert.equal((long as Record<string, unknown>).color, "teal", "a newer build's field survives a rewrite");
});

test("the outer shape still throws — an unknown version included — so the file is not rewritten", () => {
  for (const raw of [{ version: 2, prompts: [] }, { version: 1, prompts: {} }, [], null, "text", 7]) {
    assert.throws(() => parseSavedPromptsConfig(raw), /Not a version-1 saved prompts file/, JSON.stringify(raw));
  }
  // Absent fields default like the other indexes: an empty object is an empty library.
  assert.deepEqual(parseSavedPromptsConfig({}), { version: 1, prompts: [], rejected: [], extra: {} });
});
