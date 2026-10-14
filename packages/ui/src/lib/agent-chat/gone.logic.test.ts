/**
 * A thread the host does not hold vs one still being created: a grid cell
 * mounts a new chat (or fork) the moment `session.created` arrives — before
 * the host has the thread — and its stream answers THREAD_NOT_FOUND. Such a
 * tab must read as starting and reconnect by itself, never as gone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { goneDisplay, initialGoneWatch, nextGoneWatch, type GoneWatch } from "./status.logic";

/** A view's renders: each step is (connection, record) as the store and the tab list say. */
function mount(record: { chatPending?: boolean }) {
  let watch: GoneWatch = initialGoneWatch({ pending: record.chatPending === true, record });
  let retries = 0;
  return {
    render(connection: string, current: { chatPending?: boolean }): "live" | "starting" | "gone" {
      const pending = current.chatPending === true;
      const shown = goneDisplay({ gone: connection === "gone", pending, watch });
      const next = nextGoneWatch(watch, { connection, pending, record: current });
      watch = next.watch;
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
