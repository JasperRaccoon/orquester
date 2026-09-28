import assert from "node:assert/strict";
import test from "node:test";
import { AgentProfileError } from "../../errors.ts";
import {
  assertJsoncObject,
  insertJsoncArrayItem,
  insertJsoncMember,
  jsoncValueText,
  parseJsoncObject,
  replaceJsoncObject,
  setJsonc
} from "./jsonc.ts";

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

test("an edit through a key that is set twice is refused: OpenCode reads the last one", () => {
  const text = '{\n  "mcp": { "x": { "enabled": true } },\n  "lsp": {},\n  "mcp": { "x": { "enabled": true } }\n}\n';
  assert.throws(
    () => setJsonc(text, ["mcp", "x", "enabled"], false),
    (error: unknown) => error instanceof AgentProfileError && error.code === "CONFIG_UNREADABLE" && /"mcp" is set 2 times/.test(error.message)
  );
  assert.equal(setJsonc(text, ["lsp", "a"], 1).includes('"a": 1'), true, "other keys still edit");
});

test("a byte-order mark is read past", () => {
  assert.deepEqual(parseJsoncObject('﻿{ "a": 1 }'), { ok: true, value: { a: 1 } });
});

test("members and elements go back at a position with their own text", () => {
  const text = '{\n  "command": {\n    // first\n    "b": { "template": "x" }\n  }\n}\n';
  const raw = '{ "template": "y" } /* kept? */';
  assert.equal(
    insertJsoncMember(text, ["command"], "a", 0, { template: "y" }, '{ "template": "y" }'),
    '{\n  "command": {\n    // first\n    "a": { "template": "y" },\n    "b": { "template": "x" }\n  }\n}\n'
  );
  assert.ok(!insertJsoncMember(text, ["command"], "a", 0, { template: "z" }, raw).includes("kept?"), "stale text is not reused");
  assert.equal(jsoncValueText(text, ["command", "b"]), '{ "template": "x" }');
  assert.equal(
    insertJsoncArrayItem('{ "p": ["a", "c"] }', ["p"], 1, ["b", { o: 1 }], '["b", {"o": 1}]'),
    '{ "p": ["a", ["b", {"o": 1}], "c"] }'
  );
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

test("parse accepts comments and trailing commas and reports where it fails", () => {
  assert.deepEqual(parseJsoncObject(BASE), {
    ok: true,
    value: { $schema: "https://opencode.ai/config.json", a: 1, b: { x: 1, y: [1, 2] }, c: "last" }
  });
  assert.deepEqual(parseJsoncObject(""), { ok: true, value: {} });
  const bad = parseJsoncObject('{\n  "a": \n}');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /ValueExpected at line 3/);
  assert.equal(parseJsoncObject("[1]").ok, false);
  assert.throws(() => assertJsoncObject("{"), /CloseBraceExpected|ValueExpected|PropertyNameExpected/);
});

test("replacing a value touches only that value", () => {
  assert.equal(setJsonc(BASE, ["a"], 2), BASE.replace('"a": 1,', '"a": 2,'));
  assert.equal(setJsonc(BASE, ["b", "x"], false), BASE.replace('"x": 1, // x note', '"x": false, // x note'));
});

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

test("a missing parent is created as one member", () => {
  assert.equal(
    setJsonc(BASE, ["permission", "skill", "pdf"], "deny"),
    BASE.replace(
      '"c": "last" // c note\n',
      '"c": "last", // c note\n  "permission": {\n    "skill": {\n      "pdf": "deny"\n    }\n  }\n'
    )
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

test("replaceJsoncObject edits only the keys that changed", () => {
  const text = `{
  "mcp": {
    "s": {
      "type": "local",
      "command": ["node", "a.js"],
      "environment": {
        "A": "1", // keep me
        "B": "2",
      },
      "enabled": true,
    },
  },
}
`;
  const before = (assertJsoncObject(text).mcp as Record<string, unknown>).s;
  const out = replaceJsoncObject(text, ["mcp", "s"], before, {
    type: "local",
    command: ["node", "a.js"],
    environment: { A: "1", C: "3" },
    enabled: true,
    timeout: 5
  });
  assert.equal(
    out,
    `{
  "mcp": {
    "s": {
      "type": "local",
      "command": ["node", "a.js"],
      "environment": {
        "A": "1", // keep me
        "C": "3",
      },
      "enabled": true,
      "timeout": 5,
    },
  },
}
`
  );
});
