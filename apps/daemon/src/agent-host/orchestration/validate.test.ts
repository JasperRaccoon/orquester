import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_TURN_FILE_BYTES, MAX_TURN_IMAGE_BYTES } from "@orquester/api/agent-chat";

import { isAgentChatCommandError } from "./errors.ts";
import {
  parseAttachments,
  parseTargetTurnCount,
  parseTurnInput,
  requireCommandId
} from "./validate.ts";
import { isHostNativeCompact, isSlashInvocation, providerInputFor } from "./slash.ts";
import { checkMinimumVersion, compareVersions } from "./version-gate.ts";
import { isUsableConversationId, resumeCursorFor } from "./resume.ts";

const rejects = (fn: () => unknown, match?: RegExp): void => {
  try {
    fn();
  } catch (error) {
    assert.ok(isAgentChatCommandError(error));
    if (match) assert.match((error as Error).message, match);
    return;
  }
  assert.fail("expected a rejection");
};

describe("command validation (§4.1 bounds)", () => {
  it("requires a commandId", () => {
    rejects(() => requireCommandId({}), /commandId/);
    assert.equal(requireCommandId({ commandId: "abc" }), "abc");
  });

  it("trims input and enforces the character cap", () => {
    assert.equal(parseTurnInput("  hi  "), "hi");
    rejects(() => parseTurnInput("x".repeat(120_001)), /120000/);
    rejects(() => parseTurnInput(42));
  });

  it("caps the attachment count", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      type: "file",
      id: `a${index}`,
      name: "f.txt",
      sizeBytes: 1
    }));
    rejects(() => parseAttachments(many), /8 entries/);
  });

  it("refuses the whole set if any member fails", () => {
    rejects(
      () =>
        parseAttachments([
          { type: "file", id: "a", name: "ok.txt", sizeBytes: 1 },
          { type: "image", id: "b", name: "big.png", mimeType: "image/png", sizeBytes: MAX_TURN_IMAGE_BYTES + 1 }
        ]),
      /image limit/
    );
  });

  it("lowercases the mime before judging it and accepts only the four image types", () => {
    const [attachment] = parseAttachments([
      { type: "image", id: "a", name: "x.PNG", mimeType: "IMAGE/PNG", sizeBytes: 10 }
    ]);
    assert.equal(attachment?.mimeType, "image/png");
    rejects(
      () =>
        parseAttachments([
          { type: "image", id: "a", name: "x.bmp", mimeType: "image/bmp", sizeBytes: 10 }
        ]),
      /image\/gif/
    );
  });

  it("keeps the unknown arm as a forward-compat catch-all, still bounded", () => {
    const [attachment] = parseAttachments([{ type: "future", id: "a", name: "x" }]);
    assert.equal(attachment?.type, "unknown");
    rejects(
      () =>
        parseAttachments([
          { type: "future", id: "a", name: "x", sizeBytes: MAX_TURN_FILE_BYTES + 1 }
        ]),
      /file limit/
    );
  });

  it("strips a client-supplied path: a command's ref is a reference and nothing else (§6.3)", () => {
    const [file] = parseAttachments([
      { type: "file", id: "a", name: "q3.xlsx", sizeBytes: 10, path: "/etc/passwd" }
    ]);
    assert.deepEqual(file, { type: "file", id: "a", name: "q3.xlsx", sizeBytes: 10 });
    const [image] = parseAttachments([
      { type: "image", id: "b", name: "x.png", mimeType: "image/png", sizeBytes: 10, path: "/x" }
    ]);
    assert.deepEqual(image, { type: "image", id: "b", name: "x.png", mimeType: "image/png", sizeBytes: 10 });
  });

  it("targetTurnCount must be a non-negative integer", () => {
    assert.equal(parseTargetTurnCount(0), 0);
    rejects(() => parseTargetTurnCount(-1));
    rejects(() => parseTargetTurnCount(1.5));
    rejects(() => parseTargetTurnCount("2"));
  });
});

describe("host-native slash commands (§4.6.5, §4.6.9)", () => {
  it("recognises exactly /compact with no attachments", () => {
    assert.equal(isHostNativeCompact({ text: "/compact" }), true);
    assert.equal(isHostNativeCompact({ text: "  /COMPACT  " }), true);
    assert.equal(isHostNativeCompact({ text: "/compact now" }), false);
    assert.equal(
      isHostNativeCompact({
        text: "/compact",
        attachments: [{ type: "file", id: "a", name: "x", sizeBytes: 1 }]
      }),
      false
    );
  });

  it("never rewrites a turn that starts with a slash", () => {
    assert.equal(isSlashInvocation("/review src"), true);
    assert.equal(isSlashInvocation("not /review"), false);
    assert.equal(providerInputFor("/review src"), "/review src");
  });
});

describe("minimum CLI version gate (§3.2)", () => {
  it("compares dotted versions", () => {
    assert.equal(compareVersions("1.14.19", "1.14.19"), 0);
    assert.equal(compareVersions("1.14.18", "1.14.19"), -1);
    assert.equal(compareVersions("1.15.0", "1.14.19"), 1);
    assert.equal(compareVersions("v2.0.0-beta.1", "1.9.9"), 1);
  });

  it("refuses an out-of-range OpenCode with the required version in the message", () => {
    const result = checkMinimumVersion({ adapter: "opencode", version: "1.14.18" });
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /1\.14\.19/);
  });

  it("never refuses on an unknown version", () => {
    assert.equal(checkMinimumVersion({ adapter: "opencode", version: null }).ok, true);
    assert.equal(checkMinimumVersion({ adapter: "claude", version: "0.0.1" }).ok, true);
  });
});

describe("create-time resume (§6.1)", () => {
  it("refuses a traversal-shaped or flag-shaped id", () => {
    assert.equal(isUsableConversationId("abc-123"), true);
    assert.equal(isUsableConversationId("a/b/c"), true);
    assert.equal(isUsableConversationId("../etc/passwd"), false);
    assert.equal(isUsableConversationId("-rf"), false);
    assert.equal(isUsableConversationId(""), false);
    assert.equal(isUsableConversationId("a b"), false);
  });

  it("builds the documented cursor shape per adapter", () => {
    assert.deepEqual(resumeCursorFor("codex", "t1", "c1"), { threadId: "c1" });
    assert.deepEqual(resumeCursorFor("opencode", "t1", "c1"), { schemaVersion: 1, sessionId: "c1" });
    assert.deepEqual(resumeCursorFor("grok", "t1", "c1"), { schemaVersion: 1, sessionId: "c1" });
    assert.deepEqual(resumeCursorFor("claude", "t1", "c1"), { threadId: "t1", resume: "c1" });
  });
});
