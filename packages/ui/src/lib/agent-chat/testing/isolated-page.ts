import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const require = createRequire(import.meta.url);
const freeNamespaces: string[] = [];

/** A browser reload replaces module memory while preserving tab storage. */
export function isolatedPage() {
  // tsx's process-local transform cache includes the namespace in its key.
  // Recycle a disposed page's namespace, but never its module instances, so
  // reloads can reuse compiled code without sharing page state. Live pages
  // always have different namespaces.
  const namespace = freeNamespaces.pop() ?? randomUUID();
  const loader = register({ namespace });
  let disposed = false;
  const load = (path: string) => {
    if (disposed) throw new Error("The isolated page has been disposed");
    return loader.require(path, import.meta.url);
  };
  return {
    get store(): typeof import("../store") {
      return load("../store.ts");
    },
    get providers(): typeof import("../providers") {
      return load("../providers.ts");
    },
    get transport(): typeof import("../transport") {
      return load("../transport.ts");
    },
    get persistentCache(): typeof import("../persistent-cache") {
      return load("../persistent-cache.ts");
    },
    get sends(): typeof import("../../../components/agent-chat/composer/composer-sends") {
      return load("../../../components/agent-chat/composer/composer-sends.ts");
    },
    get outbox(): typeof import("../../../components/agent-chat/composer/composer-outbox") {
      return load("../../../components/agent-chat/composer/composer-outbox.ts");
    },
    get bridge(): typeof import("../../../components/agent-chat/composer/composer-bridge") {
      return load("../../../components/agent-chat/composer/composer-bridge.ts");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loader.unregister();
      // tsx keys JS/TS modules by namespace; JSON and native modules are
      // unnamespaced dependencies. Leave other live pages' modules intact.
      const suffix = `?namespace=${namespace}`;
      for (const key of Object.keys(require.cache)) {
        if (key.endsWith(suffix)) delete require.cache[key];
      }
      freeNamespaces.push(namespace);
    }
  };
}
