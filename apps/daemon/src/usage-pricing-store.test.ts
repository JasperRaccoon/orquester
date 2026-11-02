import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { setUsagePricingConfig, usagePricingConfig } from "./usage-pricing.ts";
import { UsagePricingStore, UsagePricingValidationError } from "./usage-pricing-store.ts";

afterEach(() => setUsagePricingConfig({ overrides: {}, aliases: {} }));

async function store(t: { after: (fn: () => Promise<void>) => void }, content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "orq-usage-pricing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "usage-pricing.json");
  if (content !== undefined) await writeFile(path, content);
  const prices = new UsagePricingStore({ path, now: () => 1234 });
  await prices.load();
  return { dir, path, prices };
}

test("loading installs the valid entries, keeps unknown fields, and a corrupt file is moved aside for the defaults", async (t) => {
  const { path, prices } = await store(t, JSON.stringify({
    future: { keep: true },
    overrides: { "house-model": { input: 2, output: 8 }, broken: { input: -1, output: 1 } },
    aliases: { "my-proxy": "claude-opus-5-5", self: "self" }
  }));
  assert.deepEqual(usagePricingConfig(), { overrides: { "house-model": { input: 2, output: 8 } }, aliases: { "my-proxy": "claude-opus-5-5" } });
  await prices.update({ aliases: { "my-proxy": null } });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.future, { keep: true });
  // Entries this version can't use are not the edit's to drop.
  assert.deepEqual(saved.aliases, { self: "self" });
  assert.deepEqual(saved.overrides, { "house-model": { input: 2, output: 8 }, broken: { input: -1, output: 1 } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  setUsagePricingConfig({ overrides: { stale: { input: 1, output: 1 } }, aliases: {} });
  const corrupt = await store(t, "{oops");
  assert.deepEqual(usagePricingConfig(), { overrides: {}, aliases: {} });
  assert.deepEqual(await readdir(corrupt.dir), ["usage-pricing.json.corrupt-1234"]);
});

test("a patch sets and removes entries; a saved override keeps its input and output when a patch omits them", async (t) => {
  const { prices } = await store(t);
  await prices.update({ overrides: { " house-model ": { input: 2, output: 8, cacheRead: 0.5 } }, aliases: { a: "b" } });
  await prices.update({ overrides: { "house-model": { output: 9 } } } as never);
  assert.deepEqual(usagePricingConfig(), { overrides: { "house-model": { input: 2, output: 9 } }, aliases: { a: "b" } });
  await prices.update({ overrides: { "house-model": null }, aliases: { a: null } });
  assert.deepEqual(usagePricingConfig(), { overrides: {}, aliases: {} });
});

test("an invalid patch is refused whole and changes nothing", async (t) => {
  const { path, prices } = await store(t);
  await prices.update({ aliases: { a: "b" } });
  const before = await readFile(path, "utf8");
  const cases: [unknown, RegExp][] = [
    [{ overrides: { m: { input: -1, output: 1 } } }, /input price of m/],
    [{ overrides: { m: { input: 1, output: Number.POSITIVE_INFINITY } } }, /output price of m/],
    [{ overrides: { m: { input: 1 } } }, /needs an input and an output/],
    [{ overrides: { "  ": { input: 1, output: 1 } } }, /Enter a model ID/],
    [{ aliases: { ["x".repeat(201)]: "y" } }, /at most 200/],
    [{ aliases: { c: "c" } }, /different model/],
    [{ overrides: { ok: { input: 1, output: 1 } }, aliases: { b: "a" } }, /cycle/]
  ];
  for (const [patch, message] of cases) {
    await assert.rejects(prices.update(patch as never), (error: unknown) => error instanceof UsagePricingValidationError && message.test(error.message));
  }
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(usagePricingConfig(), { overrides: {}, aliases: { a: "b" } });
});
