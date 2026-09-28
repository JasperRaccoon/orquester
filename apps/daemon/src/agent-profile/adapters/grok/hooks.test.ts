import assert from "node:assert/strict";
import test from "node:test";
import { hookId, insertHandler, listHandlers, parseHookFile, removeHandler, replaceHandler } from "./hooks.ts";

const FILE = {
  version: 2,
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "a", env: { X: "1" } }, { type: "command", command: "b" }] },
      { matcher: "", hooks: [{ type: "command", command: "c" }] }
    ],
    Stop: [{ hooks: [{ type: "command", command: "d", timeout: 3 }] }]
  }
};

test("handlers are listed per group with an empty matcher read as none", () => {
  const handlers = listHandlers("x.json", FILE.hooks);
  assert.deepEqual(
    handlers.map((h) => [h.event, h.matcher ?? null, h.handler.command]),
    [
      ["PreToolUse", "Bash", "a"],
      ["PreToolUse", "Bash", "b"],
      ["PreToolUse", null, "c"],
      ["Stop", null, "d"]
    ]
  );
  assert.notEqual(hookId(handlers[0]!), hookId({ ...handlers[0]!, file: "y.json" }));
});

test("removing the last handler drops its group and event, keeping unknown keys", () => {
  const [, , , stop] = listHandlers("x.json", FILE.hooks);
  const next = removeHandler(FILE, stop!);
  assert.deepEqual(next, { version: 2, hooks: { PreToolUse: FILE.hooks.PreToolUse } });
  assert.equal(removeHandler(FILE, { file: "x.json", event: "Stop", handler: { command: "zzz" } }), null);
  const all = listHandlers("x.json", FILE.hooks).reduce<Record<string, unknown>>((data, h) => removeHandler(data, h)!, FILE);
  assert.deepEqual(all, { version: 2, hooks: {} });
});

test("insert joins a group with the same matcher, or starts one; replace keeps position", () => {
  const joined = insertHandler(FILE, { file: "x.json", event: "PreToolUse", matcher: "Bash", handler: { type: "command", command: "e" } });
  assert.deepEqual((joined.hooks as typeof FILE.hooks).PreToolUse[0]?.hooks.map((h) => h.command), ["a", "b", "e"]);
  const fresh = insertHandler({}, { file: "x.json", event: "SessionStart", handler: { type: "command", command: "f" } });
  assert.deepEqual(fresh, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "f" }] }] } });
  const [first] = listHandlers("x.json", FILE.hooks);
  const replaced = replaceHandler(FILE, first!, { ...first!, handler: { ...first!.handler, command: "a2" } });
  assert.deepEqual((replaced!.hooks as typeof FILE.hooks).PreToolUse[0]?.hooks[0], { type: "command", command: "a2", env: { X: "1" } });
  assert.throws(() => parseHookFile("[]"), /JSON object/);
  assert.throws(() => parseHookFile('{"hooks": []}'), /object of events/);
});
