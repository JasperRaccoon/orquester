import assert from "node:assert/strict";
import test from "node:test";

import { buildThreadMessage } from "@orquester/api/agent-chat";

import { SESSION_MENTION_HINT, sessionMentionHint } from "./mention-hint.ts";

test("a user turn that refers to another chat gets the hint; ordinary words for a chat or session do not", () => {
  for (const text of [
    "In another session I'm porting one of my Unity games, and that session said this:",
    "the other chat already fixed the auth bug, continue from there",
    "what did that thread decide about the schema?",
    "en otra sesión estaba portando el juego, mira lo que dijo"
  ]) {
    assert.equal(sessionMentionHint(text), SESSION_MENTION_HINT, text);
  }
  for (const text of ["Shorten the session cookie TTL to 15 minutes", "Fix the chat composer's send button", "Add a chart of p50 latency"]) {
    assert.equal(sessionMentionHint(text), undefined, text);
  }
});

test("a message another chat sent already names its chat: no hint, whatever it says", () => {
  const relayed = buildThreadMessage({ origin: "sent", fromTitle: "Port", fromSessionId: "sess-2040", fromProject: "acme/game", text: "In another session I found three gaps." });
  assert.equal(sessionMentionHint(relayed), undefined);
});
