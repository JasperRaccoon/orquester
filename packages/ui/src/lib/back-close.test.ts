/**
 * The Back stack: each open overlay holds one history entry, Back closes the
 * newest one, and an overlay closed any other way gives an entry back — so the
 * next Back neither does nothing nor closes two. Driven against a fake
 * history whose `go` lands only when the test says so (it is asynchronous in a
 * browser).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBackCloseStack, type BackCloseHost } from "./back-close.ts";

function fakeHistory(initial: unknown[] = [null]) {
  const entries: unknown[] = [...initial];
  let index = entries.length - 1;
  let listener: (() => void) | null = null;
  const travels: number[] = [];
  const pops = (): void => listener?.();
  const host: BackCloseHost = {
    history: {
      get state() {
        return entries[index];
      },
      pushState(state: unknown) {
        entries.splice(index + 1);
        entries.push(state);
        index += 1;
      },
      go(delta?: number) {
        travels.push(delta ?? 0);
      }
    },
    addEventListener: (_type, next) => {
      listener = next;
    }
  };
  return {
    host,
    /** Entries above the page's own. */
    depth: () => index,
    length: () => entries.length,
    /** `go` calls not landed yet. */
    travels,
    /** The pending `go` lands (one `popstate`). */
    land(): void {
      const delta = travels.shift();
      assert.ok(delta !== undefined, "no traversal pending");
      index = Math.max(0, Math.min(entries.length - 1, index + delta));
      pops();
    },
    /** The user presses Back. */
    back(): void {
      assert.ok(index > 0, "Back would leave the app");
      index -= 1;
      pops();
    },
    forward(): void {
      index += 1;
      pops();
    }
  };
}

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

function overlay(stack: ReturnType<typeof createBackCloseStack>, log: string[], name: string) {
  let release: (() => void) | null = null;
  const state = {
    open: true,
    release: () => release?.()
  };
  release = stack.push(() => {
    state.open = false;
    log.push(name);
  });
  return state;
}

describe("the Back stack", () => {
  it("an open overlay holds one entry, and Back closes it", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const sheet = overlay(stack, log, "sheet");
    await tick();
    assert.equal(history.depth(), 1);
    history.back();
    assert.deepEqual(log, ["sheet"]);
    assert.equal(sheet.open, false);
    sheet.release(); // the overlay's own cleanup after Back: nothing more moves
    await tick();
    assert.deepEqual(history.travels, []);
    assert.equal(history.depth(), 0);
  });

  it("nested overlays close one at a time, newest first", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    overlay(stack, log, "drawer");
    await tick();
    overlay(stack, log, "sheet");
    await tick();
    assert.equal(history.depth(), 2);
    history.back();
    assert.deepEqual(log, ["sheet"]);
    history.back();
    assert.deepEqual(log, ["sheet", "drawer"]);
    assert.equal(history.depth(), 0);
  });

  it("an overlay closed through the UI takes its entry back off", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    overlay(stack, log, "drawer");
    await tick();
    const modal = overlay(stack, log, "modal");
    await tick();
    modal.release();
    await tick();
    assert.deepEqual(history.travels, [-1]);
    history.land();
    assert.deepEqual(log, [], "our own traversal closes nothing");
    assert.equal(history.depth(), 1);
    history.back();
    assert.deepEqual(log, ["drawer"], "the next Back closes the drawer, not nothing");
  });

  it("an outer overlay closed under an inner one leaves no dead Back behind", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const outer = overlay(stack, log, "outer");
    await tick();
    overlay(stack, log, "inner");
    await tick();
    outer.release();
    await tick();
    history.land();
    assert.equal(history.depth(), 1);
    history.back();
    assert.deepEqual(log, ["inner"]);
    assert.equal(history.depth(), 0, "the page's own entry is next: Back leaves no dead press");
  });

  it("closing several at once moves history once", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const a = overlay(stack, log, "a");
    const b = overlay(stack, log, "b");
    await tick();
    assert.equal(history.depth(), 2);
    a.release();
    b.release();
    await tick();
    assert.deepEqual(history.travels, [-2]);
    history.land();
    assert.equal(history.depth(), 0);
  });

  it("one overlay closing as another opens moves nothing", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const more = overlay(stack, log, "more");
    await tick();
    more.release();
    overlay(stack, log, "section");
    await tick();
    assert.deepEqual(history.travels, []);
    assert.equal(history.length(), 2);
    history.back();
    assert.deepEqual(log, ["section"]);
  });

  it("an overlay opened while a traversal of ours travels gets its entry once it lands", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const first = overlay(stack, log, "first");
    await tick();
    first.release();
    await tick();
    assert.deepEqual(history.travels, [-1]);
    overlay(stack, log, "second");
    await tick();
    assert.equal(history.depth(), 1, "nothing pushed before the traversal lands");
    history.land();
    assert.equal(history.depth(), 1, "pushed after it");
    history.back();
    assert.deepEqual(log, ["second"]);
  });

  it("an overlay that refuses the close and registers again holds a fresh entry", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    let asked = 0;
    const register = (): void => {
      stack.push(() => {
        asked += 1;
        register(); // still open ("Discard changes?")
      });
    };
    register();
    await tick();
    history.back();
    await tick();
    assert.equal(asked, 1);
    assert.equal(history.depth(), 1);
    history.back();
    assert.equal(asked, 2);
  });

  it("a Forward onto an entry no overlay holds backs off it", async () => {
    const history = fakeHistory();
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    const sheet = overlay(stack, log, "sheet");
    await tick();
    sheet.release();
    await tick();
    history.land();
    history.forward();
    assert.deepEqual(log, []);
    assert.deepEqual(history.travels, [-1]);
    history.land();
    assert.equal(history.depth(), 0);
  });

  it("reuses the entries a reload left behind", async () => {
    // Reloaded with a sheet open: the page starts on an entry of depth 1.
    const history = fakeHistory([null, { orqBackClose: 1 }]);
    const stack = createBackCloseStack(history.host);
    const log: string[] = [];
    overlay(stack, log, "sheet");
    await tick();
    assert.equal(history.length(), 2, "the left-over entry is the sheet's");
    assert.deepEqual(history.travels, []);
    history.back();
    assert.deepEqual(log, ["sheet"]);
  });

  it("keeps the page's own history state on its entries", async () => {
    const history = fakeHistory([{ app: "x" }]);
    const stack = createBackCloseStack(history.host);
    overlay(stack, [], "sheet");
    await tick();
    assert.deepEqual(history.host.history.state, { app: "x", orqBackClose: 1 });
  });
});
