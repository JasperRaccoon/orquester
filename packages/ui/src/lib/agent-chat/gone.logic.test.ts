/**
 * A thread the host does not hold vs one still being created: a grid cell
 * mounts a new chat (or fork) the moment `session.created` arrives — before
 * the host has the thread — and its stream answers THREAD_NOT_FOUND. Such a
 * tab must read as starting and reconnect by itself, never as gone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GoneWatches, goneDisplay, nextGoneWatch } from "./status.logic";

/**
 * A view's renders over one thread slice: each step is (connection, record) as
 * the store and the tab list say. Views mounted on the same slice share its
 * watch, as `AgentChatView` keeps it.
 */
function mount(record: { chatPending?: boolean }, slice: object = {}, watches = new GoneWatches()) {
  // The view's first render sees the record it mounted with.
  watches.remember(slice, watches.watchFor(slice, { pending: record.chatPending === true, record }));
  let retries = 0;
  return {
    render(connection: string, current: { chatPending?: boolean }): "live" | "starting" | "gone" {
      const pending = current.chatPending === true;
      const watch = watches.watchFor(slice, { pending, record: current });
      const shown = goneDisplay({ gone: connection === "gone", pending, record: current, watch });
      const next = nextGoneWatch(watch, { connection, pending, record: current });
      watches.remember(slice, next.watch);
      if (next.retry) retries += 1;
      return shown;
    },
    retries: () => retries
  };
}

describe("a chat being created, mounted at once (grid view)", () => {
  for (const kind of ["a plain create", "a fork"]) {
    it(`${kind}: THREAD_NOT_FOUND while pending is "starting"; the confirming update reconnects it`, () => {
      const created = { chatPending: true };
      const view = mount(created);
      assert.equal(view.render("connecting", created), "live");
      assert.equal(view.render("gone", created), "starting", "never gone while the host creates it");
      assert.equal(view.retries(), 0, "waits for the record, no reconnect loop");
      const confirmed = { chatPending: false };
      assert.equal(view.render("gone", confirmed), "starting");
      assert.equal(view.retries(), 1, "the update connects it again");
      assert.equal(view.render("connecting", confirmed), "live");
      assert.equal(view.render("synchronized", confirmed), "live");
    });
  }

  it("the host confirmed before the stream met the miss: one retry, no gone notice", () => {
    const created = { chatPending: true };
    const view = mount(created);
    view.render("connecting", created);
    const confirmed = { chatPending: false };
    view.render("connecting", confirmed);
    assert.equal(view.render("gone", confirmed), "starting");
    assert.equal(view.retries(), 1);
  });

  it("a thread that is really gone says so after that one retry", () => {
    const created = { chatPending: true };
    const view = mount(created);
    const confirmed = { chatPending: false };
    view.render("gone", confirmed);
    view.render("connecting", confirmed);
    assert.equal(view.render("gone", confirmed), "gone");
    assert.equal(view.retries(), 1);
  });

  it("an old tab whose thread is gone is gone at once, and retries when its record changes", () => {
    const record = {};
    const view = mount(record);
    view.render("synchronized", record);
    assert.equal(view.render("gone", record), "gone");
    assert.equal(view.retries(), 0);
    view.render("gone", { lineage: "confirmed" } as never);
    assert.equal(view.retries(), 1);
  });
});

describe("a view remounted on a slice that is still gone (within its dispose grace)", () => {
  it("the record stopped being pending while no view watched: starting, and one retry", () => {
    const slice = {};
    const watches = new GoneWatches();
    const created = { chatPending: true };
    const first = mount(created, slice, watches);
    first.render("connecting", created);
    assert.equal(first.render("gone", created), "starting");
    // Unmounted; the daemon confirms the thread meanwhile.
    const confirmed = { chatPending: false };
    const second = mount(confirmed, slice, watches);
    assert.equal(second.render("gone", confirmed), "starting", "never gone before the look");
    assert.equal(second.retries(), 1);
  });

  it("an old tab's record changed while no view watched: starting, and one retry", () => {
    const slice = {};
    const watches = new GoneWatches();
    const record = {};
    const first = mount(record, slice, watches);
    first.render("synchronized", record);
    assert.equal(first.render("gone", record), "gone");
    const changed = { chatPending: false };
    const second = mount(changed, slice, watches);
    assert.equal(second.render("gone", changed), "starting");
    assert.equal(second.retries(), 1);
    second.render("connecting", changed);
    assert.equal(second.render("gone", changed), "gone", "really gone after that look");
    assert.equal(second.retries(), 1);
  });

  it("nothing changed while unmounted: still gone, no retry", () => {
    const slice = {};
    const watches = new GoneWatches();
    const record = {};
    const first = mount(record, slice, watches);
    first.render("synchronized", record);
    first.render("gone", record);
    const second = mount(record, slice, watches);
    assert.equal(second.render("gone", record), "gone");
    assert.equal(second.retries(), 0);
  });
});
