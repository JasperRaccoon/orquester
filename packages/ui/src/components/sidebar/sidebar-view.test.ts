import test from "node:test";
import assert from "node:assert/strict";

import { parseSidebarView } from "./sidebar-view.ts";

test("only a known panel id is a sidebar view; anything else is the projects tree", () => {
  assert.equal(parseSidebarView("workflows"), "workflows");
  assert.equal(parseSidebarView("projects"), "projects");
  // The agent profile left the sidebar for Settings → Agent config: a stored pick of it opens the projects tree.
  assert.equal(parseSidebarView("profile"), "projects");
  for (const bad of [null, undefined, "", "Workflows", "prompts", 1, {}]) {
    assert.equal(parseSidebarView(bad), "projects");
  }
});
