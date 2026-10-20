// Session tooling contributions per execution target: the host keeps exactly
// the single-preload behaviour the shell, workflow and desktop builders rely
// on, and a box's contributions never reach host sessions (or another box's).

import assert from "node:assert/strict";
import { test } from "node:test";

import { TS_RUST_PLUGIN_ID } from "@orquester/api";
import { appendNodeRequireOption } from "@orquester/config";

import {
  clearBoxToolingContributions,
  sessionNodeOptions,
  sessionNodePreload,
  sessionToolingContributions,
  setSessionNodePreload,
  setSessionToolingContribution
} from "./session-env.ts";

const HOST_PRELOAD = "/appdir/daemon/plugins/ts-rust/preload.cjs";
const BOX_PRELOAD = "C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs";

test("the host: no preload leaves NODE_OPTIONS as it is; one is appended once, after the existing value", () => {
  setSessionNodePreload(null);
  assert.equal(sessionNodePreload(), null);
  assert.equal(sessionNodeOptions(undefined), undefined);
  assert.equal(sessionNodeOptions(" --no-warnings "), " --no-warnings ", "untouched, not even trimmed");

  setSessionNodePreload(HOST_PRELOAD);
  try {
    assert.equal(sessionNodePreload(), HOST_PRELOAD);
    assert.equal(sessionNodeOptions(undefined), appendNodeRequireOption(undefined, HOST_PRELOAD));
    assert.equal(sessionNodeOptions("--no-warnings"), appendNodeRequireOption("--no-warnings", HOST_PRELOAD));
    assert.deepEqual(sessionToolingContributions("host"), [{ pathPrepend: [], env: {}, nodeRequire: [HOST_PRELOAD] }]);
  } finally {
    setSessionNodePreload(null);
  }
  assert.deepEqual(sessionToolingContributions("host"), []);
});

test("a box's contribution stays with that box", () => {
  setSessionNodePreload(HOST_PRELOAD);
  setSessionToolingContribution({ boxId: "win" }, TS_RUST_PLUGIN_ID, { pathPrepend: [], env: {}, nodeRequire: [BOX_PRELOAD] });
  try {
    assert.equal(sessionNodeOptions(undefined), appendNodeRequireOption(undefined, HOST_PRELOAD), "host sessions never see a box path");
    assert.deepEqual(sessionToolingContributions({ boxId: "win" }), [{ pathPrepend: [], env: {}, nodeRequire: [BOX_PRELOAD] }]);
    assert.deepEqual(sessionToolingContributions({ boxId: "other" }), []);

    setSessionNodePreload(null);
    assert.equal(sessionNodePreload(), null);
    assert.equal(sessionToolingContributions({ boxId: "win" }).length, 1, "turning the host's off leaves the box's");

    clearBoxToolingContributions("win");
    assert.deepEqual(sessionToolingContributions({ boxId: "win" }), []);
  } finally {
    setSessionNodePreload(null);
    clearBoxToolingContributions("win");
  }
});

test("a stored contribution is a copy: later changes to the caller's object do not leak in", () => {
  const contribution = { pathPrepend: ["/opt/x"], env: { A: "1" }, nodeRequire: ["/x.cjs"] };
  setSessionToolingContribution({ boxId: "b" }, "p", contribution);
  try {
    contribution.pathPrepend.push("/evil");
    contribution.env.A = "2";
    assert.deepEqual(sessionToolingContributions({ boxId: "b" }), [{ pathPrepend: ["/opt/x"], env: { A: "1" }, nodeRequire: ["/x.cjs"] }]);
    setSessionToolingContribution({ boxId: "b" }, "p", null);
    assert.deepEqual(sessionToolingContributions({ boxId: "b" }), []);
  } finally {
    clearBoxToolingContributions("b");
  }
});
