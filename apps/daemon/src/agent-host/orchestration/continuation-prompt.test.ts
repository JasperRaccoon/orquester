/**
 * The continue prompts the host sends on its own (spec 2026-11-01 R8), through
 * the builder's export: what each variant tells the agent, the cap on the
 * stopped list, and the recogniser old logs and new texts both pass (R10).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { USAGE_LIMIT_CONTINUE_MESSAGE } from "@orquester/api/agent-chat";

import { CONTINUATION_PROMPT } from "../host-protocol.ts";
import { continuationPrompt, isContinuationPrompt } from "./continuation-prompt.ts";
import { isHostRestartPrompt, wakePrompt } from "./pending-wake.ts";

const subagent = (name: string) => ({ name, kind: "subagent" as const });
const background = (name: string) => ({ name, kind: "background" as const });

describe("continuation prompts (spec 2026-11-01 R8)", () => {
  it("a cut turn: names what the restart stopped and asks to relaunch what is still needed", () => {
    const text = continuationPrompt({
      cause: "restart",
      stopped: [subagent("S34: shrink shipped player size"), background("Wait for F check completion")]
    });
    assert.equal(
      text,
      'Orquester restarted while you were working, so your last turn was cut short. Continue where you left off. The restart stopped these subagents and background commands: "S34: shrink shipped player size" (subagent), "Wait for F check completion" (background command). Relaunch the subagents whose results you still need, with the same instructions, and restart the background commands you still need. Do not wait for the old ones: they will not report back. A command or action that was in progress may or may not have taken effect: check before repeating anything that changes state.'
    );
  });

  it("names at most 12 items and counts the rest, the unrecorded ones included", () => {
    const stopped = Array.from({ length: 15 }, (_, index) => subagent(`agent ${index + 1}`));
    const text = continuationPrompt({ cause: "restart", stopped, moreStopped: 2 });
    assert.match(text, /"agent 12" \(subagent\), and 5 more\./);
    assert.doesNotMatch(text, /agent 13/);
  });

  it("a revival says no turn was cut, but the subagents were running", () => {
    const text = continuationPrompt({ cause: "restart", revival: true, stopped: [subagent("Review")] });
    assert.ok(text.startsWith("Orquester restarted while your subagents were still running. Continue where you left off."));
    assert.doesNotMatch(text, /cut short/);
  });

  it("a crash says the host stopped unexpectedly", () => {
    assert.ok(continuationPrompt({ cause: "crash", stopped: [] }).startsWith("Orquester stopped unexpectedly while you were working"));
    assert.ok(
      continuationPrompt({ cause: "crash", revival: true, stopped: [background("dev server")] }).startsWith(
        "Orquester stopped unexpectedly while your background commands were still running."
      )
    );
  });

  it("nothing stopped: the short generic line, no list", () => {
    const text = continuationPrompt({ cause: "restart", stopped: [] });
    assert.match(text, /If you had subagents running, relaunch any whose results you still need\./);
    assert.doesNotMatch(text, /The restart stopped these/);
  });

  it("a cancelled request adds the sentence that says to ask again", () => {
    const text = continuationPrompt({ cause: "restart", stopped: [], requestCancelled: true });
    assert.match(text, /was cancelled by the restart: ask again if the action is still needed\./);
    assert.doesNotMatch(continuationPrompt({ cause: "restart", stopped: [] }), /cancelled/);
  });

  it("a wake's part starts at the continuation sentence: the wake prompt says what finished", () => {
    const text = continuationPrompt({ cause: "wake", stopped: [background("tests")] });
    assert.ok(text.startsWith(`${CONTINUATION_PROMPT} The restart stopped these background commands: "tests"`));
  });
});

describe("recognising the host's own prompts (R10)", () => {
  it("every built prompt, and the literal older hosts sent", () => {
    assert.equal(isContinuationPrompt(CONTINUATION_PROMPT), true, "old logs hold the bare literal");
    for (const text of [
      continuationPrompt({ cause: "restart", stopped: [] }),
      continuationPrompt({ cause: "crash", stopped: [subagent("a")], requestCancelled: true }),
      continuationPrompt({ cause: "restart", revival: true, stopped: [background("b")] })
    ]) {
      assert.equal(isContinuationPrompt(`\n${text}  `), true, text);
      assert.equal(isHostRestartPrompt(text), true, text);
    }
  });

  it("a wake prompt of this build and of an older one, and the daemon's usage-limit continue", () => {
    const wake = { since: "x", tasks: [{ taskId: "t1", status: "completed", completedAt: "x" }] };
    assert.equal(isHostRestartPrompt(wakePrompt(wake, [])), true);
    const olderWake = `${wakePrompt(wake, []).split("\n\n")[0]}\n\n${CONTINUATION_PROMPT}`;
    assert.equal(isHostRestartPrompt(olderWake), true);
    assert.equal(isHostRestartPrompt(USAGE_LIMIT_CONTINUE_MESSAGE), true);
  });

  it("never a message the user wrote around it", () => {
    const built = continuationPrompt({ cause: "restart", stopped: [] });
    assert.equal(isContinuationPrompt(`${CONTINUATION_PROMPT} Then push.`), false);
    assert.equal(isContinuationPrompt(`Please. ${built}`), false);
    assert.equal(isHostRestartPrompt("Orquester restarted while you were working, so check the logs."), false);
  });
});
