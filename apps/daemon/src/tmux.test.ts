import { test } from "node:test";
import assert from "node:assert/strict";
import { captureArgs } from "./tmux.ts";

test("default args: colors + full history (back-compatible)", () => {
  assert.deepEqual(captureArgs("orq-x"), ["capture-pane", "-p", "-e", "-J", "-S", "-", "-t", "orq-x"]);
});

test("escapes:false drops -e (plain text)", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: "all" }),
    ["capture-pane", "-p", "-J", "-S", "-", "-t", "orq-x"]);
});

test("lines:0 → current screen (-S 0); lines:N → -S -N", () => {
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 0 }),
    ["capture-pane", "-p", "-J", "-S", "0", "-t", "orq-x"]);
  assert.deepEqual(captureArgs("orq-x", { escapes: false, lines: 40 }),
    ["capture-pane", "-p", "-J", "-S", "-40", "-t", "orq-x"]);
});
