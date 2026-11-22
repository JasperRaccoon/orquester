import assert from "node:assert/strict";
import test from "node:test";

import { agentSshKeyComment } from "@orquester/api";

import { agentKeyTagOfLine, authorizedKeyLine, rewriteAuthorizedKeys } from "./authorized-keys.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBzD8W4yHq2Jf2n4oTz3kYv1v7Q5r9qkJm8b6n1x0aBc";
const OTHER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK9mQ2b7x1n0aBcD8W4yHq2Jf2n4oTz3kYv1v7Q5r9qk";
const tag = (threadId: string | null, boxId: string) => agentSshKeyComment({ threadId, boxId });

const OWNER = [
  "# my laptop",
  `${OTHER} me@laptop`,
  "",
  `from="10.0.0.0/8",command="echo \\"hi there\\"" ${OTHER} restricted key`,
  `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== orquester chat=someone-elses-format`
].join("\n");

test("adding a chat's key appends one tagged line with its expiry and leaves every other line as it was", () => {
  const deadline = Date.UTC(2026, 10, 22, 10, 30);
  const line = authorizedKeyLine(KEY, tag("t-1", "box-1"), deadline);
  // 14 hours past the deadline in UTC: sshd reads the timespec in the box's own zone.
  assert.equal(line, `expiry-time="202611230030" ${KEY} orquester chat=t-1 box=box-1`);
  const next = rewriteAuthorizedKeys(`${OWNER}\n`, () => false, [line]);
  assert.equal(next, `${OWNER}\n${line}\n`);
  // Adding it again replaces it rather than doubling it.
  const again = rewriteAuthorizedKeys(next, () => false, [authorizedKeyLine(KEY, tag("t-1", "box-1"), null)]);
  assert.equal(again, `${OWNER}\n${KEY} orquester chat=t-1 box=box-1\n`);
});

test("removal by tag drops exactly the matching Orquester lines, options and quoted spaces included", () => {
  const mine = authorizedKeyLine(KEY, tag("t-1", "box-1"), Date.UTC(2026, 0, 1));
  const machine = authorizedKeyLine(OTHER, tag(null, "box-1"), null);
  const otherBox = `no-pty,command="a b" ${KEY} ${tag("t-1", "box-2")}`;
  const content = `${OWNER}\n${mine}\n${otherBox}\n${machine}`;
  assert.equal(agentKeyTagOfLine(otherBox)?.boxId, "box-2");
  const next = rewriteAuthorizedKeys(content, (found) => found.boxId === "box-1" && found.threadId === "t-1");
  assert.equal(next, `${OWNER}\n${otherBox}\n${machine}\n`);
  // Nothing to drop: the file is returned byte for byte (no newline added).
  assert.equal(rewriteAuthorizedKeys(OWNER, () => true), OWNER);
});
