import assert from "node:assert/strict";
import test from "node:test";

import {
  StderrCapture,
  classifyStderrLine,
  redactStderr
} from "./stderr.ts";

test("stripAnsi removes colour, cursor and OSC sequences", () => {
  assert.equal(classifyStderrLine("\u001b[31mred\u001b[0m").text, "red");
  assert.equal(classifyStderrLine("\u001b[2K\u001b[1Gline").text, "line");
  assert.equal(classifyStderrLine("\u001b]0;title\u0007body").text, "body");
  assert.equal(classifyStderrLine("plain").text, "plain");
});

test("redaction collapses home paths, longest first", () => {
  const out = redactStderr("read /var/lib/orq/home/agent-accounts/x/home/creds", {
    homeDirs: ["/var/lib/orq/home", "/var/lib/orq/home/agent-accounts/x/home"]
  });
  assert.equal(out, "read ~/creds");
});

test("redaction collapses a percent-encoded home too, in either hex case", () => {
  // Grok keys its session dirs by the URL-encoded cwd, and its task snapshots
  // name files there (the Grok fixtures README, redaction).
  const out = redactStderr(
    "tail /var/lib/orq/.grok/sessions/%2Fvar%2Flib%2Forq%2Fwork/a.log and %2fvar%2flib%2forq%2fwork",
    { homeDirs: ["/var/lib/orq"] }
  );
  assert.equal(out, "tail ~/.grok/sessions/~%2Fwork/a.log and ~%2fwork");
  // A dir that encodes to itself adds no second pass, and regex characters in
  // a home are literal.
  assert.equal(redactStderr("x %2Fa.b%2Fc", { homeDirs: ["/a.b"] }), "x ~%2Fc");
  assert.equal(redactStderr("x %2FaXb%2Fc", { homeDirs: ["/a.b"] }), "x %2FaXb%2Fc");
  // The compiled pattern is kept per dir (the redactor runs on every string
  // of every raw frame): a second call, a longer value, a match at its end.
  for (const value of ["y %2Fa.b", "a much longer line that ends %2Fa.b", "y %2Fa.b"]) {
    assert.equal(redactStderr(value, { homeDirs: ["/a.b"] }), value.replace("%2Fa.b", "~"));
  }
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
  const capture = new StderrCapture({ homeDirs: ["/home/agent"] });
  capture.push("opening /home/agent/creds with sk-abcdefghijklmnop\n");
  assert.equal(capture.excerpt(), "opening ~/creds with [redacted]\n");
  for (let i = 0; i < 400; i += 1) {
    capture.push(`padding line number ${i}\n`);
  }
  const excerpt = capture.excerpt();
  assert.ok(Buffer.byteLength(excerpt) <= 4096, "tail stays inside its budget");
  assert.ok(excerpt.includes("padding line number 399"), "keeps the newest lines");
});

test("capture tolerates a single line longer than the whole tail budget", () => {
  const capture = new StderrCapture();
  capture.push(`${"x".repeat(5000)}\n`);
  assert.ok(Buffer.byteLength(capture.excerpt()) <= 4096);
});
