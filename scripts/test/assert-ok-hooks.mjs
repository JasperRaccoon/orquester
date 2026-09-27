// Registered by ./assert-ok.mjs. Serves node:assert and node:assert/strict (and their bare spellings)
// to every module a test process loads: the builtin's own named exports, except that `ok`, `strict`
// and the callable default export are the preload's — so a direct `assert(value)` or
// `strict(value)` gets the preload's message too, not just `assert.ok(value)`.

const BUILTINS = new Map([
  ["assert", "node:assert"],
  ["node:assert", "node:assert"],
  ["assert/strict", "node:assert/strict"],
  ["node:assert/strict", "node:assert/strict"]
]);
const SCHEME = "orq-assert:";
const PRELOAD = new URL("./assert-ok.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const builtin = BUILTINS.get(specifier);
  // The served module's own imports of the builtin must reach the builtin.
  if (builtin !== undefined && !context.parentURL?.startsWith(SCHEME)) {
    return { url: `${SCHEME}${builtin}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith(SCHEME)) return next(url, context);
  const builtin = JSON.stringify(url.slice(SCHEME.length));
  return {
    format: "module",
    shortCircuit: true,
    // A name exported here wins over the builtin's own that `export *` would hand on.
    source:
      `import builtin from ${builtin};\n` +
      `import { callable } from ${JSON.stringify(PRELOAD)};\n` +
      `export * from ${builtin};\n` +
      `export const ok = builtin.ok;\n` +
      `export const strict = callable(builtin.strict);\n` +
      `export default callable(builtin);\n`
  };
}
