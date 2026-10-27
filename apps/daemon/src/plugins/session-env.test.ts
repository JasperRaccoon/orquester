import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sessionNodeOptions,
  sessionNodePreload,
  setSessionNodePreload
} from "./session-env.ts";

const HOST_PRELOAD = "/appdir/daemon/plugins/ts-rust/preload.cjs";

test("the host: no preload leaves NODE_OPTIONS as it is; one is appended once, after the existing value", () => {
  setSessionNodePreload(null);
  assert.equal(sessionNodePreload(), null);
  assert.equal(sessionNodeOptions(undefined), undefined);
  assert.equal(sessionNodeOptions(" --no-warnings "), " --no-warnings ", "untouched, not even trimmed");

  setSessionNodePreload(HOST_PRELOAD);
  try {
    assert.equal(sessionNodePreload(), HOST_PRELOAD);
    assert.equal(sessionNodeOptions(undefined), '--require "/appdir/daemon/plugins/ts-rust/preload.cjs"');
    assert.equal(sessionNodeOptions("--no-warnings"), '--no-warnings --require "/appdir/daemon/plugins/ts-rust/preload.cjs"');
  } finally {
    setSessionNodePreload(null);
  }
});
