import assert from "node:assert/strict";
import test from "node:test";
import { assertJsoncObject, insertJsoncArrayItem, setJsonc } from "./jsonc.ts";

test("a member whose comma follows a comment, or a leading-comma layout, is removed cleanly", () => {
  assert.equal(setJsonc('{\n  "a": 1 /* note */,\n  "b": 2\n}\n', ["a"], undefined), '{\n  "b": 2\n}\n');
  assert.equal(setJsonc('{ "a": 1 /* note */, "b": 2 }', ["a"], undefined), '{ "b": 2 }');
  assert.equal(setJsonc('{\n  "a": 1\n  , "b": 2\n}\n', ["a"], undefined), '{\n  "b": 2\n}\n');
  assert.equal(setJsonc('{\n  "a": 1 /* c */,\n  "b": 2\n}\n', ["b"], undefined), '{\n  "a": 1 /* c */\n}\n');
  assert.equal(
    setJsonc('{\n  "plugin": [\n    "a" /* first */,\n    "b"\n  ]\n}\n', ["plugin", 0], undefined),
    '{\n  "plugin": [\n    "b"\n  ]\n}\n'
  );
  assert.deepEqual(assertJsoncObject(setJsonc('{\n  "x": 0\n  , "a": 1\n  , "b": 2\n}\n', ["a"], undefined)), { x: 0, b: 2 });
});

const BASE = `{
  "$schema": "https://opencode.ai/config.json",
  // first comment
  "a": 1,
  "b": {
    "x": 1, // x note
    "y": [1, 2],
  },
  /* block */
  "c": "last" // c note
}
`;

test("appending a member keeps the last member's same-line comment on its line", () => {
  assert.equal(
    setJsonc(BASE, ["d"], { k: "v" }),
    BASE.replace('"c": "last" // c note\n', '"c": "last", // c note\n  "d": {\n    "k": "v"\n  }\n')
  );
  assert.equal(
    setJsonc(BASE, ["b", "z"], true),
    BASE.replace('    "y": [1, 2],\n', '    "y": [1, 2],\n    "z": true,\n'),
    "a trailing comma layout keeps its trailing comma"
  );
});

test("removing a member takes only its own line, whatever its position", () => {
  assert.equal(setJsonc(BASE, ["a"], undefined), BASE.replace('  "a": 1,\n', ""));
  assert.equal(setJsonc(BASE, ["b", "x"], undefined), BASE.replace('    "x": 1, // x note\n', ""));
  assert.equal(
    setJsonc(BASE, ["c"], undefined),
    BASE.replace('  },\n  /* block */\n  "c": "last" // c note\n', "  }\n  /* block */\n"),
    "the last member hands back the previous comma"
  );
  assert.equal(setJsonc(BASE, ["nope"], undefined), BASE);
});

test("removing the only member before a trailing comma leaves a valid empty object", () => {
  const text = '{\n  "mcp": {\n    // an override\n    "shared": { "enabled": false },\n  },\n}\n';
  const out = setJsonc(text, ["mcp", "shared"], undefined);
  assert.equal(out, '{\n  "mcp": {\n    // an override\n  },\n}\n');
  assert.deepEqual(assertJsoncObject(out), { mcp: {} });
});

test("inline objects and arrays are edited inline", () => {
  const text = '{ "a": { "x": 1, "y": 2 }, "p": ["one", "two"] }';
  assert.equal(setJsonc(text, ["a", "x"], undefined), '{ "a": { "y": 2 }, "p": ["one", "two"] }');
  assert.equal(setJsonc(text, ["a", "y"], undefined), '{ "a": { "x": 1 }, "p": ["one", "two"] }');
  assert.equal(setJsonc(text, ["a", "z"], 3), '{ "a": { "x": 1, "y": 2, "z": 3 }, "p": ["one", "two"] }');
  assert.equal(setJsonc(text, ["p", 1], undefined), '{ "a": { "x": 1, "y": 2 }, "p": ["one"] }');
  assert.equal(insertJsoncArrayItem(text, ["p"], 1, "mid"), '{ "a": { "x": 1, "y": 2 }, "p": ["one", "mid", "two"] }');
  assert.equal(insertJsoncArrayItem(text, ["p"], 2, "end"), '{ "a": { "x": 1, "y": 2 }, "p": ["one", "two", "end"] }');
});

test("multi-line arrays: insert and remove elements on their own lines", () => {
  const text = '{\n  "plugin": [\n    "a", // first\n    ["b", { "o": 1 }],\n  ],\n}\n';
  assert.equal(
    insertJsoncArrayItem(text, ["plugin"], 1, "mid"),
    '{\n  "plugin": [\n    "a", // first\n    "mid",\n    ["b", { "o": 1 }],\n  ],\n}\n'
  );
  assert.equal(
    insertJsoncArrayItem(text, ["plugin"], 2, "end"),
    '{\n  "plugin": [\n    "a", // first\n    ["b", { "o": 1 }],\n    "end",\n  ],\n}\n'
  );
  assert.equal(setJsonc(text, ["plugin", 0], undefined), '{\n  "plugin": [\n    ["b", { "o": 1 }],\n  ],\n}\n');
  assert.deepEqual(assertJsoncObject(insertJsoncArrayItem('{ "plugin": [] }', ["plugin"], 0, "x")), { plugin: ["x"] });
  assert.deepEqual(assertJsoncObject(insertJsoncArrayItem("{}", ["plugin"], 0, "x")), { plugin: ["x"] });
});

test("CRLF files keep CRLF", () => {
  const text = '{\r\n  "a": 1\r\n}\r\n';
  assert.equal(setJsonc(text, ["b"], { c: 1 }), '{\r\n  "a": 1,\r\n  "b": {\r\n    "c": 1\r\n  }\r\n}\r\n');
  assert.equal(setJsonc('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n', ["a"], undefined), '{\r\n  "b": 2\r\n}\r\n');
});
