import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forbiddenEmbedModules } from "./embed-bundle";

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
