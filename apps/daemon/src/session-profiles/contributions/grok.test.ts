import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GROK_PROFILE_ENV } from "../../agent-isolation/grok.ts";
import { grokProfileLaunchContribution } from "./grok.ts";

const profile = { preparedDir: "/appdir/daemon/session-profiles/prepared/p1/grok/shared/v-1" };

describe("Grok launch contribution", () => {
  it("points GROK_HOME (and the thread's home) at the prepared dir and GROK_AUTH_PATH at the account's auth.json", () => {
    const accountHome = "/appdir/daemon/agent-accounts/grok/a1/home";
    assert.deepEqual(grokProfileLaunchContribution({ profile, accountHome }), {
      env: { GROK_HOME: profile.preparedDir, GROK_AUTH_PATH: `${accountHome}/auth.json`, ...GROK_PROFILE_ENV },
      homePath: profile.preparedDir
    });
  });

  it("uses the Global home's auth.json for the System identity", () => {
    const result = grokProfileLaunchContribution({ profile, accountHome: "/home/u/.grok" });
    assert.equal(result.env.GROK_AUTH_PATH, "/home/u/.grok/auth.json");
  });

  it("keeps Claude skills compat on and every other compat surface off", () => {
    const { env } = grokProfileLaunchContribution({ profile, accountHome: "/home/u/.grok" });
    assert.equal(env.GROK_CLAUDE_SKILLS_ENABLED, undefined);
    for (const name of ["RULES", "AGENTS", "MCPS", "HOOKS"]) {
      assert.equal(env[`GROK_CLAUDE_${name}_ENABLED`], "false");
      assert.equal(env[`GROK_CURSOR_${name}_ENABLED`], "false");
    }
    assert.equal(env.GROK_CURSOR_SKILLS_ENABLED, "false");
  });

  it("refuses an unknown account home, or one inside the profile", () => {
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: null }), /not known/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: "relative/home" }), /not known/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: profile.preparedDir }), /inside the prepared profile/);
    assert.throws(() => grokProfileLaunchContribution({ profile, accountHome: `${profile.preparedDir}/x` }), /inside the prepared profile/);
  });

});
