import assert from "node:assert/strict";
import test from "node:test";

import { sshCommandFor } from "./accounts";

const gh = { provider: "github", keyPath: "/k/a" } as never;
const bb = { provider: "bitbucket-cloud", keyPath: "/k/b" } as never;

test("github keeps today's exact core.sshCommand", () => {
  assert.equal(
    sshCommandFor(gh, "/k/known_hosts"),
    'ssh -i "/k/a" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
  );
});

test("bitbucket accounts pin the daemon-owned known_hosts", () => {
  assert.equal(
    sshCommandFor(bb, "/k/known_hosts"),
    'ssh -i "/k/b" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="/k/known_hosts"'
  );
});
