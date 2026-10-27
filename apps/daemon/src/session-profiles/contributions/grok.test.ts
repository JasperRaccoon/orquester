import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grokProfileLaunchContribution } from "./grok.ts";

const profile = { preparedDir: "/appdir/daemon/session-profiles/prepared/p1/grok/shared/v-1" };

describe("Grok launch contribution", () => {
  it("points GROK_HOME (and the thread's home) at the prepared dir and GROK_AUTH_PATH at the account's auth.json", () => {
    const accountHome = "/appdir/daemon/agent-accounts/grok/a1/home";
    assert.deepEqual(grokProfileLaunchContribution({ profile, accountHome }), {
      env: {
        GROK_HOME: profile.preparedDir,
        GROK_AUTH_PATH: `${accountHome}/auth.json`,
        GROK_CLAUDE_RULES_ENABLED: "false",
        GROK_CLAUDE_AGENTS_ENABLED: "false",
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CLAUDE_HOOKS_ENABLED: "false",
        GROK_CURSOR_RULES_ENABLED: "false",
        GROK_CURSOR_AGENTS_ENABLED: "false",
        GROK_CURSOR_MCPS_ENABLED: "false",
        GROK_CURSOR_HOOKS_ENABLED: "false",
        GROK_CURSOR_SKILLS_ENABLED: "false"
      },
      homePath: profile.preparedDir
    });
  });

  it("refuses an unknown account home, or one inside the profile", () => {
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: null }), /not known/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: "relative/home" }), /not known/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: profile.preparedDir }), /inside the prepared profile/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: `${profile.preparedDir}/x` }), /inside the prepared profile/);
  });
});
