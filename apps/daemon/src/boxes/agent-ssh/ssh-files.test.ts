import assert from "node:assert/strict";
import test from "node:test";

import { SSH_CONFIG_INCLUDE_LINE } from "@orquester/config";

import { withIncludeLine, withoutIncludeLine } from "./ssh-files.ts";

const OWNER = "# mine\nHost github.com\n  IdentityFile ~/.ssh/work\n\nHost *\n  ServerAliveInterval 60\n";

test("the Include line goes first (before any Host block) and comes out again leaving the owner's bytes", () => {
  const added = withIncludeLine(OWNER);
  assert.equal(added, `${SSH_CONFIG_INCLUDE_LINE}\n${OWNER}`);
  assert.equal(withIncludeLine(added), added);
  assert.equal(withoutIncludeLine(added), OWNER);
  assert.equal(withoutIncludeLine(OWNER), OWNER);
  // One the owner moved under a Host block applies only there: it moves back to the top.
  const lower = `Host a\n  User b\n${SSH_CONFIG_INCLUDE_LINE}\n`;
  assert.equal(withIncludeLine(lower), `${SSH_CONFIG_INCLUDE_LINE}\nHost a\n  User b\n`);
  assert.equal(withIncludeLine(""), `${SSH_CONFIG_INCLUDE_LINE}\n`);
});
