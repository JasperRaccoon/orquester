/**
 * `revealInFileBrowser`: a chat's changed-file click lands in the project's
 * Files tab with the file to open, reusing the tab rather than stacking more.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ProjectSummary } from "@orquester/api";

import { useAppStore } from "./app.ts";

const P = "/w/acme/app";
const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    currentProject: { path: P, name: "app" } as ProjectSummary,
    fileTabsByProject: {},
    activeTabByProject: {}
  });
});

describe("revealInFileBrowser", () => {
  it("opens a Files tab on the file when the project has none", () => {
    store().revealInFileBrowser(`${P}/src/a.ts`);
    const tabs = store().fileTabsByProject[P];
    assert.equal(tabs.length, 1);
    assert.deepEqual(tabs[0].reveal, { path: `${P}/src/a.ts`, nonce: 1 });
    assert.equal(store().activeTabByProject[P], tabs[0].id);
  });

  it("reuses the first Files tab and bumps the nonce, even for the same file", () => {
    store().openFileBrowser();
    store().openFileBrowser();
    const [first, second] = store().fileTabsByProject[P];
    useAppStore.setState({ activeTabByProject: { [P]: second.id } });

    store().revealInFileBrowser(`${P}/src/a.ts`);
    store().revealInFileBrowser(`${P}/src/a.ts`);

    const tabs = store().fileTabsByProject[P];
    assert.deepEqual(tabs.map((t) => t.id), [first.id, second.id]);
    assert.deepEqual(tabs[0].reveal, { path: `${P}/src/a.ts`, nonce: 2 });
    assert.equal(tabs[1].reveal, undefined);
    assert.equal(store().activeTabByProject[P], first.id);
  });

  it("does nothing without a current project", () => {
    useAppStore.setState({ currentProject: null });
    store().revealInFileBrowser(`${P}/src/a.ts`);
    assert.deepEqual(store().fileTabsByProject, {});
  });
});
