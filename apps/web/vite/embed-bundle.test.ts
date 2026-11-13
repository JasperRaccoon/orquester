import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { embedPreloadErrorEvent, forbiddenEmbedModules } from "./embed-bundle";

const UI = "/repo/packages/ui";

describe("forbiddenEmbedModules", () => {
  it("finds every app-only module, whatever its extension, query or virtual marker", () => {
    const ids = [
      `${UI}/src/store/app.ts`,
      `${UI}/src/context/orquester-context.tsx`,
      `${UI}/src/lib/agent-chat/store.ts?v=1`,
      `\0${UI}/src/lib/session-profiles/store.ts`,
      `${UI}/src/lib/agent-tools/store.ts`,
      `${UI}/src/components/agent-chat/composer/question-composer-bridge.ts`,
      `${UI}/src/components/agent-chat/composer/deep/Popover.tsx`
    ];
    assert.deepEqual(forbiddenEmbedModules(ids, `${UI}/`), [
      "src/components/agent-chat/composer/deep/Popover.tsx",
      "src/components/agent-chat/composer/question-composer-bridge.ts",
      "src/context/orquester-context.tsx",
      "src/lib/agent-chat/store.ts",
      "src/lib/agent-tools/store.ts",
      "src/lib/session-profiles/store.ts",
      "src/store/app.ts"
    ]);
  });

  it("passes the chat's own modules and look-alike names", () => {
    const ids = [
      `${UI}/src/store/apps.ts`,
      `${UI}/src/lib/agent-chat/composer.logic.ts`,
      `${UI}/src/lib/agent-chat/reducer.logic.ts`,
      `${UI}/src/lib/agent-chat/stores.ts`,
      `${UI}/src/components/agent-chat/composer-chrome.ts`,
      `${UI}/src/components/agent-chat/timeline/ChatTimeline.tsx`,
      "/repo/node_modules/.pnpm/x@1/node_modules/x/src/store/app.js",
      "/elsewhere/packages/ui/src/store/app.ts",
      "\0vite/preload-helper.js"
    ];
    assert.deepEqual(forbiddenEmbedModules(ids, UI), []);
  });
});

describe("embedPreloadErrorEvent", () => {
  const plugin = embedPreloadErrorEvent({ eventName: "orquester-embed:preloadError" });
  const HELPER = "\0vite/preload-helper.js";

  /** The plugin's `renderChunk` on `code`, as Rollup calls it; `this.error` throws, as Rollup's does. */
  function render(code: string, moduleIds: string[]): string | null {
    const hook = plugin.renderChunk as (this: unknown, code: string, chunk: unknown) => { code: string } | null;
    const context = {
      error(message: string): never {
        throw new Error(message);
      }
    };
    return hook.call(context, code, { fileName: "agent-chat.js", moduleIds })?.code ?? null;
  }

  it("renames the event the preload helper dispatches, whatever the quotes", () => {
    const helper =
      'function s(l){const u=new Event("vite:preloadError",{cancelable:!0});u.payload=l,window.dispatchEvent(u)}' +
      "const t=new Event('vite:preloadError');";
    const code = render(helper, [HELPER, "/repo/apps/web/src/embed/index.ts"]);
    assert.ok(code !== null);
    assert.ok(!code.includes("vite:preloadError"));
    assert.equal(code.match(/"orquester-embed:preloadError"/g)?.length, 2);
  });

  it("fails the build when the helper no longer names vite:preloadError", () => {
    assert.throws(() => render('const u=new Event("vite:chunkError",{cancelable:!0});', [HELPER]), /preload helper/);
  });

  it("leaves a chunk with neither the helper nor the name untouched", () => {
    assert.equal(render("export const a = 1;", ["/repo/apps/web/src/embed/index.ts"]), null);
  });
});
