// Fills tsx's transform cache for a module graph without running any of it.
//
//   node --import tsx deploy/lib/warm-release.mjs <entry.ts>...
//
// Run it with the same node binary, user, TMPDIR and cwd as the process it warms for
// (warm-release.sh does that for the daemon and the agent host). tsx (4.x) keys a cache entry on
// sha1(source, esbuild options, esbuild version, cache version), and the options carry the
// file's absolute path, `node<version>` as the target and the tsconfig found from cwd — so the
// cache only serves the same file path, node version and tsconfig it was written for.
//
// How it avoids side effects: the entry this imports lists a module that throws as its FIRST
// import, then the real entries. ES modules are loaded and linked as a whole graph before any
// of them is evaluated (that is when tsx transforms each file and writes its cache entry), and
// evaluation then starts at the first import — which throws, so no module body ever runs.
// CommonJS dependencies are only executed at evaluation too. Exits 1 if the graph fails to load.

import { readdirSync } from "node:fs";
import module from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STOP = "orquester-warm-release-stop";
const TRANSFORMED = /\.(?:[cm]?ts|tsx)$/;

const entries = process.argv.slice(2);
if (entries.length === 0) {
  console.error("usage: node --import tsx warm-release.mjs <entry.ts>...");
  process.exit(2);
}

// tsx's own cache dir (dist/temporary-directory): $TMPDIR/tsx-<euid>.
const cacheDir = join(tmpdir(), `tsx-${process.geteuid ? process.geteuid() : userInfo().username}`);
const countCacheFiles = () => {
  try {
    return readdirSync(cacheDir).length;
  } catch {
    return 0;
  }
};

// Count the TypeScript modules the graph reaches. Hooks registered after tsx's run before it,
// so `next` is tsx's loader; the result is passed through untouched. Without in-thread hooks
// (older Node) the count is skipped — tsx still warms the cache through its own hooks.
const transformed = new Set();
if (typeof module.registerHooks === "function") {
  module.registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith("file:") && TRANSFORMED.test(new URL(url).pathname)) transformed.add(url);
      return result;
    }
  });
}

const started = process.hrtime.bigint();
const before = countCacheFiles();
const source = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
const stop = source(`throw Object.assign(new Error("stop"), { code: ${JSON.stringify(STOP)} });`);
const graph = source(
  [stop, ...entries.map((entry) => pathToFileURL(resolve(entry)).href)]
    .map((url) => `import ${JSON.stringify(url)};`)
    .join("\n")
);

try {
  await import(graph);
  console.error("[warm-release] the graph evaluated past the stop module; aborting");
  process.exit(1);
} catch (error) {
  if (error?.code !== STOP) {
    console.error("[warm-release] loading the module graph failed:", error);
    process.exit(1);
  }
}

// tsx writes cache files asynchronously; `beforeExit` fires once they have all settled.
process.once("beforeExit", () => {
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const modules = typeof module.registerHooks === "function" ? `${transformed.size} modules` : "the module graph";
  const added = countCacheFiles() - before;
  console.log(`[warm-release] warmed ${modules} in ${seconds.toFixed(1)}s (${added} new cache entries in ${cacheDir})`);
});
