import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const require = createRequire(import.meta.url);

/** A browser reload replaces module memory while preserving tab storage. */
export function isolatedPage() {
  const existing = new Set(Object.keys(require.cache));
  const loader = register({ namespace: randomUUID() });
  return {
    get store(): typeof import("../store") {
      return loader.require("../store.ts", import.meta.url);
    },
    get providers(): typeof import("../providers") {
      return loader.require("../providers.ts", import.meta.url);
    },
    get transport(): typeof import("../transport") {
      return loader.require("../transport.ts", import.meta.url);
    },
    get sends(): typeof import("../../../components/agent-chat/composer/composer-sends") {
      return loader.require("../../../components/agent-chat/composer/composer-sends.ts", import.meta.url);
    },
    get outbox(): typeof import("../../../components/agent-chat/composer/composer-outbox") {
      return loader.require("../../../components/agent-chat/composer/composer-outbox.ts", import.meta.url);
    },
    get bridge(): typeof import("../../../components/agent-chat/composer/composer-bridge") {
      return loader.require("../../../components/agent-chat/composer/composer-bridge.ts", import.meta.url);
    },
    dispose(): void {
      loader.unregister();
      // Unregistering a compiler does not evict modules it loaded. Clear only
      // this page's additions so the next page cannot reuse its singleton state.
      for (const key of Object.keys(require.cache)) {
        if (!existing.has(key)) delete require.cache[key];
      }
    }
  };
}
