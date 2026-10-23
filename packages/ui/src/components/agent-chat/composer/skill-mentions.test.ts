import test from "node:test";
import assert from "node:assert/strict";

import { skillMentionsInText } from "./composer-menu.ts";

/**
 * R2-8 — the `$skill` tokeniser. It was lost when W11's
 * `slash-commands.logic.ts` was deleted in the fix-wave arbitration (the
 * finding went from "dead code" to "absent"); it lives in `composer-menu.ts`
 * now, the one slash/skill implementation, and the timeline re-runs it over a
 * sent message so a mention renders as a chip rather than as raw `$name`.
 */

test("R2-8: known $skill mentions are found in order, deduped", () => {
  assert.deepEqual(
    skillMentionsInText("run $review then $deploy and $review again", ["review", "deploy"]),
    ["review", "deploy"]
  );
});

test("R2-8: an UNKNOWN mention stays literal — it is not a chip", () => {
  // The send path leaves `$foo` literal (§4.6.8); the timeline must agree.
  assert.deepEqual(skillMentionsInText("try $nope", ["review"]), []);
});

test("R2-8: a mention must start a token, so an email or a path is not one", () => {
  assert.deepEqual(skillMentionsInText("mail me@$review.com", ["review"]), []);
  assert.deepEqual(skillMentionsInText("$review at the start", ["review"]), ["review"]);
  assert.deepEqual(skillMentionsInText("and\n$review on a new line", ["review"]), ["review"]);
});

test("R2-8: matching is case-insensitive but the text's own spelling is returned", () => {
  assert.deepEqual(skillMentionsInText("$Review it", ["review"]), ["Review"]);
});

test("R2-8: any currency symbol opens a mention, as the composer trigger does", () => {
  assert.deepEqual(skillMentionsInText("run €review", ["review"]), ["review"]);
});

test("R2-8: dots and dashes are part of a skill name", () => {
  assert.deepEqual(skillMentionsInText("$my-skill.v2 now", ["my-skill.v2"]), ["my-skill.v2"]);
});

test("a plugin's `plugin:skill`, dotted plugin names included, is one mention — as the daemon dispatches it", () => {
  const known = ["dot.plug:my-folder", "toolbox:lint", "review"];
  assert.deepEqual(skillMentionsInText("run $toolbox:lint then $dot.plug:my-folder", known), [
    "toolbox:lint",
    "dot.plug:my-folder"
  ]);
  // Never a shorter name inside it: `$review:x` is not `review`.
  assert.deepEqual(skillMentionsInText("$review:x now", known), []);
});

test("`$1.50` and a dot or colon ending a sentence are no mention, as dispatch leaves them literal", () => {
  const known = ["toolbox:lint", "review", "1"];
  assert.deepEqual(skillMentionsInText("costs $1.50 today", known), []);
  assert.deepEqual(skillMentionsInText("use $toolbox:lint.", known), []);
  assert.deepEqual(skillMentionsInText("then $review: done", known), []);
});
