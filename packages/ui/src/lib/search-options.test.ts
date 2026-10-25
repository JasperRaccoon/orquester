import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { SEARCH_OPTIONS_DEFAULT, loadSearchOptions, persistSearchOptions } from "./search-options.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const g = globalThis as Record<string, unknown>;
const KEY = "orquester:search-options-by-project";

function install(stored?: unknown): MemoryStorage {
  const storage = new MemoryStorage();
  if (stored !== undefined) storage.setItem(KEY, JSON.stringify(stored));
  g.localStorage = storage;
  return storage;
}

afterEach(() => {
  delete g.localStorage;
});

test("gitignored files are hidden by default", () => {
  install();
  assert.equal(loadSearchOptions("/p").includeIgnored, false);
});

test("a record written before includeIgnored existed loads with it off", () => {
  install({ "/p": { caseSensitive: true, wholeWord: false, regex: false, include: "*.ts", exclude: "", filtersExpanded: true } });
  const options = loadSearchOptions("/p");
  assert.equal(options.includeIgnored, false);
  assert.equal(options.caseSensitive, true);
  assert.equal(options.include, "*.ts");
});

test("includeIgnored persists per project", () => {
  install();
  persistSearchOptions("/a", { ...SEARCH_OPTIONS_DEFAULT, includeIgnored: true });
  assert.equal(loadSearchOptions("/a").includeIgnored, true);
  assert.equal(loadSearchOptions("/b").includeIgnored, false);
});

test("a non-boolean includeIgnored is treated as off", () => {
  install({ "/p": { includeIgnored: "yes" } });
  assert.equal(loadSearchOptions("/p").includeIgnored, false);
});
