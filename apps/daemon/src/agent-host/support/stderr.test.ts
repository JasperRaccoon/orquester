import assert from "node:assert/strict";
import test from "node:test";

import {
  STDERR_TAIL_BYTES,
  StderrCapture,
  classifyStderrLine,
  redactStderr,
  stripAnsi
} from "./stderr.ts";

test("stripAnsi removes colour, cursor and OSC sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(stripAnsi("\u001b[2K\u001b[1Gline"), "line");
  assert.equal(stripAnsi("\u001b]0;title\u0007body"), "body");
  assert.equal(stripAnsi("plain"), "plain");
});

test("redaction collapses home paths, longest first", () => {
  const out = redactStderr("read /var/lib/orq/home/agent-accounts/x/home/creds", {
    homeDirs: ["/var/lib/orq/home", "/var/lib/orq/home/agent-accounts/x/home"]
  });
  assert.equal(out, "read ~/creds");
});

test("redaction masks auth headers, bearer values and token shapes", () => {
  assert.equal(
    redactStderr("Authorization: Bearer abc.def-ghi"),
    "Authorization: [redacted]"
  );
  assert.equal(redactStderr("x-api-key=supersecretvalue"), "x-api-key=[redacted]");
  assert.equal(
    redactStderr("used sk-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQR"),
    "used [redacted] and [redacted]"
  );
  assert.equal(redactStderr("token xoxb-1234567890ab"), "token [redacted]");
  // A bare prefix in prose is not a credential and must survive.
  assert.equal(redactStderr("the sk- prefix"), "the sk- prefix");
});

test("classification: benign snippets and sub-ERROR levels drop", () => {
  assert.equal(classifyStderrLine("").class, "drop");
  assert.equal(
    classifyStderrLine("WARN state db missing rollout path for thread abc").class,
    "drop"
  );
  assert.equal(classifyStderrLine("2026-09-21 INFO started listener").class, "drop");
  assert.equal(classifyStderrLine("DEBUG handshake ok").class, "drop");
});

test("classification: fatal snippets become errors, everything else a warning", () => {
  assert.equal(classifyStderrLine("codex: command not found").class, "error");
  assert.equal(classifyStderrLine("Error: ENOENT no such file or directory").class, "error");
  assert.equal(classifyStderrLine("You are not logged in").class, "error");
  assert.equal(classifyStderrLine("something unusual happened").class, "warning");
  // An ERROR level alongside a logger name is not downgraded.
  assert.equal(classifyStderrLine("2026-09-21 ERROR provider.stream reset").class, "warning");
});

test("classification redacts before it classifies, so the text is always safe", () => {
  const line = classifyStderrLine("\u001b[31mfatal error: key sk-abcdefghijklmnop\u001b[0m");
  assert.equal(line.class, "error");
  assert.equal(line.text, "fatal error: key [redacted]");
});

test("capture splits lines with a remainder and flushes the tail", () => {
  const capture = new StderrCapture();
  assert.deepEqual(capture.push("one unusual\ntwo unu").map((l) => l.text), ["one unusual"]);
  assert.deepEqual(capture.push("sual\n").map((l) => l.text), ["two unusual"]);
  assert.deepEqual(capture.push("trailing"), []);
  assert.deepEqual(capture.flush().map((l) => l.text), ["trailing"]);
  assert.deepEqual(capture.flush(), []);
});

test("capture keeps a redacted, bounded tail", () => {
  const capture = new StderrCapture({ homeDirs: ["/home/agent"], tailBytes: 64 });
  capture.push("opening /home/agent/creds with sk-abcdefghijklmnop\n");
  for (let i = 0; i < 40; i += 1) {
    capture.push(`padding line number ${i}\n`);
  }
  const excerpt = capture.excerpt();
  assert.ok(Buffer.byteLength(excerpt) <= 64, "tail stays inside its budget");
  assert.ok(!excerpt.includes("/home/agent"), "home path never retained");
  assert.ok(!excerpt.includes("sk-abcdefghijklmnop"), "token never retained");
  assert.ok(excerpt.includes("padding line number 39"), "keeps the newest lines");
});

test("capture tolerates a single line longer than the whole tail budget", () => {
  const capture = new StderrCapture({ tailBytes: 32 });
  capture.push(`${"x".repeat(500)}\n`);
  assert.ok(Buffer.byteLength(capture.excerpt()) <= 32);
});

test("the tail budget is the documented 4 KiB by default", () => {
  assert.equal(STDERR_TAIL_BYTES, 4096);
  const capture = new StderrCapture();
  for (let i = 0; i < 2000; i += 1) {
    capture.push(`unusual line ${i}\n`);
  }
  assert.ok(Buffer.byteLength(capture.excerpt()) <= STDERR_TAIL_BYTES);
});
