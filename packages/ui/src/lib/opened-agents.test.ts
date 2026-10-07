import test from "node:test";
import assert from "node:assert/strict";

import { matchesSidebarQuery } from "./opened-agents.ts";

test("the sidebar search matches any field, ignoring case and outer spaces", () => {
  assert.equal(matchesSidebarQuery("", "anything"), true);
  assert.equal(matchesSidebarQuery("  ", undefined), true);
  assert.equal(matchesSidebarQuery(" Orq ", "fix the bug", "orquester-4"), true);
  assert.equal(matchesSidebarQuery("mats", "fix the bug", null, "orquester"), false);
});
