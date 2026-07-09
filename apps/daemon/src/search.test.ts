import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsSearchResponse } from "@orquester/api";
import { onPath } from "./archive.ts";
import { searchProjectFiles, listProjectFiles, FsSearchError } from "./search.ts";

// The whole fixture tree lives under `fsRoot`; the searched root is `fsRoot` itself
// (except the symlink-escape test, which searches a subdir). `outside` holds a file
// the in-tree symlink points at to prove the sandbox never leaks it.
let fsRoot = "";
let outsideDir = "";
let outsideFile = "";

const rgAvailable = onPath("rg");
const isWin = process.platform === "win32";

async function write(rel: string, content: string): Promise<void> {
  const abs = join(fsRoot, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

before(async () => {
  fsRoot = await mkdtemp(join(tmpdir(), "orq-search-"));
  outsideDir = await mkdtemp(join(tmpdir(), "orq-outside-"));
  outsideFile = join(outsideDir, "secret.txt");
  await writeFile(outsideFile, "cat secret cat\n");

  // ascii multi-match file: several `cat` hits, some as whole words, some not.
  await write("src/ascii.txt", "cat category scatter\nmy_cat and cat again\nno match here\n");
  // unicode: İstanbul (İ lowercases to two UTF-16 units), straße/STRASSE, CJK line.
  await write("src/unicode.txt", "prefix İstanbul city\nstraße lane\nSTRASSE road\n日本語 cat\n");
  // İ alone: `İ` folds to "i̇" (i + combining dot), so a folded needle "i" ends INSIDE
  // the expansion — the fold end-boundary map must snap the end to the code point end.
  await write("uni/istanbul.txt", "İstanbul\n");
  // CRLF file: matcher must strip the trailing \r from the reported line text.
  await write("src/crlf.txt", "alpha cat\r\nbeta cat\r\n");
  // long line (>300 chars) with the match near the very end.
  await write("src/long.txt", `${"x".repeat(320)}NEEDLE tail\n`);
  // binary file: an embedded NUL in the first 8 KiB must skip the whole file.
  await write("bin/binary.bin", "cat\x00cat\x00cat");
  // file just over 1 MiB: skipped by the size cap even though it contains the query.
  await write("big/huge.txt", `${"a".repeat(1024 * 1024 + 16)}\ncat here\n`);
  // vendored trees that must never be searched.
  await write("node_modules/dep/index.js", "cat in node_modules\n");
  await write(".git/config", "cat in git\n");
  // mixed-case sibling names in one dir: byte order (Banana < Zebra < apple < cherry)
  // differs from localeCompare order (apple < Banana < cherry < Zebra), so a small cap
  // picks a DIFFERENT member set unless both engines walk in the same (byte) order.
  await write("mixed/apple.txt", "cat one\n");
  await write("mixed/Banana.txt", "cat two\n");
  await write("mixed/cherry.txt", "cat three\n");
  await write("mixed/Zebra.txt", "cat four\n");
  // glob-filtering fixtures.
  await write("keep.ts", "cat typescript\n");
  await write("keep.js", "cat javascript\n");
  await write("keep.md", "cat markdown\n");
  await write("dist/generated.ts", "cat generated\n");

  // symlink inside the tree pointing OUT of the sandbox root.
  if (!isWin) {
    await symlink(outsideFile, join(fsRoot, "src", "escape.txt"));
  }
});

after(async () => {
  await rm(fsRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

type Opts = Parameters<typeof searchProjectFiles>[2];

/** Search the whole fixture with the node engine (always available). */
function node(query: string, extra: Partial<Opts> = {}): Promise<FsSearchResponse> {
  return searchProjectFiles(fsRoot, fsRoot, { query, engine: "node", ...extra });
}

/** Search the whole fixture with ripgrep (callers must gate on rgAvailable). */
function rg(query: string, extra: Partial<Opts> = {}): Promise<FsSearchResponse> {
  return searchProjectFiles(fsRoot, fsRoot, { query, engine: "rg", ...extra });
}

/** Find one file's result by relative path. */
function fileOf(res: FsSearchResponse, path: string) {
  return res.files.find((f) => f.path === path);
}

// --- literal offsets, column vs windowed start ---------------------------------

test("node: literal match reports full-line column and matchLength", async () => {
  const res = await node("category");
  const file = fileOf(res, "src/ascii.txt");
  assert.ok(file, "ascii.txt has a match");
  const m = file!.matches[0];
  assert.equal(m.line, 1);
  assert.equal(m.column, 4); // "cat " is 4 chars, then "category"
  assert.equal(m.matchLength, 8);
  assert.equal(m.start, 4); // short line → window start equals column
});

test("node: long line windows start/end but keeps true column", async () => {
  const res = await node("NEEDLE");
  const file = fileOf(res, "src/long.txt");
  assert.ok(file);
  const m = file!.matches[0];
  assert.equal(m.column, 320); // true offset in the full line
  assert.equal(m.matchLength, 6);
  assert.ok(m.start < m.column, "windowed start diverges below the true column on a long line");
  assert.ok(m.text.includes("NEEDLE"));
});

// --- unicode case-fold offset correctness --------------------------------------

test("node: İ case-fold maps hits back to original offsets", async () => {
  // İ lowercases to two UTF-16 units; a match after it must still report the ORIGINAL
  // column, not the folded one.
  const res = await node("city", { caseSensitive: false });
  const file = fileOf(res, "src/unicode.txt");
  assert.ok(file);
  const m = file!.matches[0];
  const line = "prefix İstanbul city";
  assert.equal(m.column, line.indexOf("city"));
  assert.equal(m.matchLength, 4);
  assert.equal(m.text.slice(m.start, m.start + m.matchLength), "city");
});

test("node: İstanbul folds to itself and reports its true length", async () => {
  // `İ` lowercases to `i̇` (two units), so it does NOT fold to plain ASCII `i` — the
  // uppercase form folds identically and matches. matchLength must be the ORIGINAL
  // "İstanbul" length (8), proving the fold offset map is inverted correctly.
  const res = await node("İSTANBUL", { caseSensitive: false });
  const file = fileOf(res, "src/unicode.txt");
  assert.ok(file);
  const m = file!.matches[0];
  const line = "prefix İstanbul city";
  assert.equal(m.column, line.indexOf("İstanbul"));
  assert.equal(m.matchLength, "İstanbul".length);
  assert.equal(m.text.slice(m.start, m.start + m.matchLength), "İstanbul");
});

test("node: case-insensitive 'i' against İ yields a non-empty, correctly-sliced match", async () => {
  // Regression (fold end-boundary): `İ` folds to "i̇" (two units); a folded needle "i"
  // ends inside that expansion. Mapping the END through the code-point-end table must
  // report length 1 sliced back to the original "İ", not a zero-length highlight.
  const res = await node("i", { caseSensitive: false });
  const file = fileOf(res, "uni/istanbul.txt");
  assert.ok(file, "istanbul.txt matched");
  const m = file!.matches.find((x) => x.column === 0);
  assert.ok(m, "a match anchored at the İ (column 0)");
  assert.ok(m!.matchLength >= 1, "match is non-empty");
  assert.equal(m!.text.slice(m!.start, m!.start + m!.matchLength), "İ");
});

test("node: case-insensitive folds ASCII case", async () => {
  const res = await node("STRASSE", { caseSensitive: false });
  const file = fileOf(res, "src/unicode.txt");
  assert.ok(file);
  // "STRASSE" query folds to "strasse"; matches the STRASSE line (line 3).
  assert.ok(file!.matches.some((m) => m.line === 3));
});

// --- CRLF handling -------------------------------------------------------------

test("node: CRLF lines have no trailing carriage return", async () => {
  const res = await node("cat");
  const file = fileOf(res, "src/crlf.txt");
  assert.ok(file);
  for (const m of file!.matches) {
    assert.ok(!m.text.endsWith("\r"), "trailing \\r stripped");
  }
  assert.equal(file!.matches[0].text, "alpha cat");
});

// --- binary + size caps --------------------------------------------------------

test("node: binary file with a NUL is skipped", async () => {
  const res = await node("cat");
  assert.equal(fileOf(res, "bin/binary.bin"), undefined);
});

test("node: file over 1 MiB is skipped", async () => {
  const res = await node("cat");
  assert.equal(fileOf(res, "big/huge.txt"), undefined);
});

test("node: node_modules and .git are never searched", async () => {
  const res = await node("cat");
  assert.equal(fileOf(res, "node_modules/dep/index.js"), undefined);
  assert.equal(fileOf(res, ".git/config"), undefined);
});

// --- sandbox: symlinks are skipped ---------------------------------------------

test("node: a symlink (here one escaping the root) is skipped entirely", { skip: isWin }, async () => {
  // Symlinks are never followed (parity with ripgrep's default), which also enforces
  // the sandbox: `src/escape.txt -> <outside>/secret.txt` is skipped as a symlink, so
  // its out-of-root target never surfaces regardless of realpath.
  const res = await node("secret");
  assert.equal(res.files.length, 0);
  for (const f of res.files) assert.ok(!f.path.includes("escape"));
});

// --- whole-word boundaries -----------------------------------------------------

test("node: whole-word excludes category/scatter but keeps cat and my_cat-adjacent", async () => {
  const res = await node("cat", { wholeWord: true });
  const file = fileOf(res, "src/ascii.txt");
  assert.ok(file);
  // Line 1 "cat category scatter": only the leading standalone "cat" is a whole word.
  const line1 = file!.matches.filter((m) => m.line === 1);
  assert.equal(line1.length, 1);
  assert.equal(line1[0].column, 0);
});

test("node: underscore counts as a word char (my_cat is not a whole-word cat)", async () => {
  const res = await node("cat", { wholeWord: true });
  const file = fileOf(res, "src/ascii.txt");
  assert.ok(file);
  // Line 2 "my_cat and cat again": my_cat is excluded; the standalone cat matches.
  const line2 = file!.matches.filter((m) => m.line === 2);
  assert.equal(line2.length, 1);
  assert.equal(line2[0].column, "my_cat and ".length);
});

test("node: without whole-word every occurrence matches", async () => {
  const res = await node("cat", { wholeWord: false });
  const file = fileOf(res, "src/ascii.txt");
  assert.ok(file);
  // cat, category, scatter, my_cat, cat = 5 hits across lines 1-2.
  assert.equal(file!.matches.filter((m) => m.line <= 2).length, 5);
});

test("node: whole-word respects unicode boundaries (CJK adjacency)", async () => {
  // "日本語 cat" — the CJK run is separated by a space, so cat is a whole word.
  const res = await node("cat", { wholeWord: true });
  const file = fileOf(res, "src/unicode.txt");
  assert.ok(file);
  assert.ok(file!.matches.some((m) => m.line === 4));
});

// --- include / exclude globs ---------------------------------------------------

test("node: include limits the searched files", async () => {
  const res = await node("cat", { include: "*.ts" });
  const paths = res.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["dist/generated.ts", "keep.ts"]);
});

test("node: exclude removes matched files", async () => {
  const res = await node("cat", { include: "*.ts", exclude: "dist" });
  assert.deepEqual(res.files.map((f) => f.path), ["keep.ts"]);
});

test("node: brace expansion in include", async () => {
  const res = await node("cat", { include: "keep.{ts,js}" });
  assert.deepEqual(res.files.map((f) => f.path).sort(), ["keep.js", "keep.ts"]);
});

test("node: folder-shorthand include", async () => {
  const res = await node("cat", { include: "src" });
  assert.ok(res.files.every((f) => f.path.startsWith("src/")));
  assert.ok(res.files.length > 0);
});

test("node: anchored include only matches at the root", async () => {
  const res = await node("cat", { include: "/keep.ts" });
  assert.deepEqual(res.files.map((f) => f.path), ["keep.ts"]);
});

test("node: ! inside an include field acts as an exclude", async () => {
  const res = await node("cat", { include: "*.ts, !dist" });
  assert.deepEqual(res.files.map((f) => f.path), ["keep.ts"]);
});

test("node: unbalanced brace is INVALID_GLOB on the include field", async () => {
  await assert.rejects(
    () => node("cat", { include: "*.{ts,tsx" }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_GLOB");
      assert.equal(err.field, "include");
      return true;
    }
  );
});

test("node: over-cap term count is INVALID_GLOB on the exclude field", async () => {
  const raw = Array.from({ length: 65 }, (_, i) => `f${i}.ts`).join(",");
  await assert.rejects(
    () => node("cat", { exclude: raw }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.code, "INVALID_GLOB");
      assert.equal(err.field, "exclude");
      return true;
    }
  );
});

// --- regex mode ----------------------------------------------------------------

test("node: regex mode is refused without ripgrep", async () => {
  await assert.rejects(
    () => node("c.t", { regex: true }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.code, "REGEX_UNSUPPORTED");
      assert.equal(err.field, "query");
      return true;
    }
  );
});

// --- abort ---------------------------------------------------------------------

test("node: a pre-aborted signal rejects with REQUEST_ABORTED", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => node("cat", { signal: controller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.status, 499);
      assert.equal(err.code, "REQUEST_ABORTED");
      return true;
    }
  );
});

// --- caps / ordering -----------------------------------------------------------

test("node: maxResults caps total matches and flags limitHit", async () => {
  const res = await node("cat", { maxResults: 2 });
  assert.equal(res.totalMatches, 2);
  assert.equal(res.limitHit, true);
});

test("node: files are returned in stable path order despite concurrency", async () => {
  const res = await node("cat");
  const paths = res.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)));
});

test("node: an abort fired mid-search never returns a success payload", async () => {
  // The signal is aborted AFTER the search has launched (parked on the first readdir),
  // exercising the in-walk / post-scan / post-allSettled abort re-checks — a request
  // cancelled mid-flight must reject with 499, never resolve with partial results.
  const controller = new AbortController();
  const promise = node("cat", { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof FsSearchError);
    assert.equal(err.status, 499);
    assert.equal(err.code, "REQUEST_ABORTED");
    return true;
  });
});

test("node: totalMatches never exceeds maxResults under concurrency", async () => {
  // Concurrent scans each read a per-file budget from a stale total; the central clamp
  // must keep the aggregate within the cap and consistent with the emitted matches.
  for (const cap of [1, 2, 3, 5]) {
    const res = await node("cat", { maxResults: cap });
    assert.ok(res.totalMatches <= cap, `totalMatches ${res.totalMatches} <= ${cap}`);
    const summed = res.files.reduce((n, f) => n + f.matches.length, 0);
    assert.equal(summed, res.totalMatches, "summed per-file matches equal totalMatches");
  }
});

test("both engines: no empty file at the cap and totalMatches respects it", async () => {
  // The 500-vs-501 boundary divergence was a zero-match file emitted just past the cap.
  // Neither engine may emit an empty file, and any truncated file must carry matches.
  const engines: Array<(q: string, e?: Partial<Opts>) => Promise<FsSearchResponse>> = rgAvailable
    ? [node, rg]
    : [node];
  for (const cap of [1, 2, 3, 4, 7]) {
    for (const eng of engines) {
      const res = await eng("cat", { maxResults: cap });
      assert.ok(res.totalMatches <= cap, `${res.tool} totalMatches ${res.totalMatches} <= ${cap}`);
      for (const f of res.files) {
        assert.ok(f.matches.length > 0, `${res.tool} emitted an empty file ${f.path}`);
      }
      const summed = res.files.reduce((n, f) => n + f.matches.length, 0);
      assert.equal(summed, res.totalMatches, `${res.tool} summed matches equal totalMatches`);
    }
  }
});

test("node: empty query is rejected", async () => {
  await assert.rejects(
    () => searchProjectFiles(fsRoot, fsRoot, { query: "", engine: "node" }),
    (err: unknown) => err instanceof FsSearchError && err.code === "INVALID_REQUEST"
  );
});

// --- symlink cycles / duplicate traversal --------------------------------------

test("node: a symlink cycle (self -> .) is not followed and terminates fast", { skip: isWin }, async () => {
  // A self-referential directory link would re-walk the root forever (until the file
  // cap) if followed. Skipping all symlinks means the tree is walked exactly once.
  const dir = await mkdtemp(join(tmpdir(), "orq-cycle-"));
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "a.txt"), "needle here\n");
    await symlink(".", join(dir, "self"));

    const list = await listProjectFiles(dir, dir, {});
    assert.deepEqual(list.files.map((f) => f.path), ["docs/a.txt"]); // exactly one entry
    assert.equal(list.truncated, false);

    const res = await searchProjectFiles(dir, dir, { query: "needle", engine: "node" });
    assert.equal(res.totalMatches, 1);
    assert.deepEqual(res.files.map((f) => f.path), ["docs/a.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node: an in-tree dir symlink (docs-link -> docs) does not duplicate matches", { skip: isWin }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-duplink-"));
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "a.txt"), "needle here\n");
    await symlink(join(dir, "docs"), join(dir, "docs-link"));

    const res = await searchProjectFiles(dir, dir, { query: "needle", engine: "node" });
    assert.deepEqual(res.files.map((f) => f.path), ["docs/a.txt"]); // no docs-link/a.txt
    assert.equal(res.totalMatches, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parity: node and rg skip symlinks identically (cycle + dup link)", { skip: !rgAvailable || isWin }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-symparity-"));
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "a.txt"), "needle here\n");
    await symlink(".", join(dir, "self"));
    await symlink(join(dir, "docs"), join(dir, "docs-link"));

    const [n, r] = await Promise.all([
      searchProjectFiles(dir, dir, { query: "needle", engine: "node" }),
      searchProjectFiles(dir, dir, { query: "needle", engine: "rg" })
    ]);
    const paths = (res: FsSearchResponse) => res.files.map((f) => f.path).sort();
    assert.deepEqual(paths(n), ["docs/a.txt"]);
    assert.deepEqual(paths(r), ["docs/a.txt"]); // rg also skips symlinks without -L
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- deterministic near-cap aggregation ----------------------------------------

test("node: near-cap results are deterministic across repeated runs", async () => {
  // ~40 matching files, a cap small enough to truncate mid-set. With completion-order
  // commit, which files land under the cap raced across the concurrency window; the
  // reorder buffer must make the boundary (files + matches) identical every run.
  const dir = await mkdtemp(join(tmpdir(), "orq-determ-"));
  try {
    for (let i = 0; i < 40; i += 1) {
      const rel = join(`d${String(i).padStart(2, "0")}`, `f${i}.txt`);
      const abs = join(dir, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "alpha marker beta\nmarker again\n"); // 2 matches per file
    }
    const cap = 15;
    const first = await searchProjectFiles(dir, dir, { query: "marker", engine: "node", maxResults: cap });
    assert.equal(first.limitHit, true);
    assert.ok(first.totalMatches <= cap, `totalMatches ${first.totalMatches} <= ${cap}`);
    assert.ok(first.totalMatches > 0);
    const snapshot = JSON.stringify(first.files);
    for (let r = 0; r < 5; r += 1) {
      const again = await searchProjectFiles(dir, dir, { query: "marker", engine: "node", maxResults: cap });
      assert.equal(JSON.stringify(again.files), snapshot, `run ${r} identical files+matches`);
      assert.equal(again.totalMatches, first.totalMatches, `run ${r} identical totalMatches`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- ripgrep-specific + engine parity ------------------------------------------

test("rg: regex mode matches", { skip: !rgAvailable }, async () => {
  const res = await rg("c.t", { regex: true });
  assert.ok(res.tool === "rg");
  assert.ok(fileOf(res, "src/ascii.txt"));
});

test("rg: a bad regex is a 400", { skip: !rgAvailable }, async () => {
  await assert.rejects(
    () => rg("(unclosed", { regex: true }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test("rg: whole-word matches the node engine", { skip: !rgAvailable }, async () => {
  const res = await rg("cat", { wholeWord: true });
  const file = fileOf(res, "src/ascii.txt");
  assert.ok(file);
  assert.ok(file!.matches.every((m) => m.text.slice(m.start, m.start + m.matchLength) === "cat"));
});

test("rg: node_modules and .git stay excluded", { skip: !rgAvailable }, async () => {
  const res = await rg("cat");
  assert.equal(fileOf(res, "node_modules/dep/index.js"), undefined);
  assert.equal(fileOf(res, ".git/config"), undefined);
});

test("rg: include glob limits files like the node engine", { skip: !rgAvailable }, async () => {
  const res = await rg("cat", { include: "*.ts" });
  assert.deepEqual(res.files.map((f) => f.path).sort(), ["dist/generated.ts", "keep.ts"]);
});

test("parity: node and rg agree on the file set (modulo tool)", { skip: !rgAvailable }, async () => {
  const [n, r] = await Promise.all([node("cat", { wholeWord: true }), rg("cat", { wholeWord: true })]);
  const paths = (res: FsSearchResponse) => res.files.map((f) => f.path).sort();
  assert.deepEqual(paths(n), paths(r));
});

test("parity: node and rg agree on column offsets for a unicode line", { skip: !rgAvailable }, async () => {
  const [n, r] = await Promise.all([node("city"), rg("city")]);
  const nm = fileOf(n, "src/unicode.txt")!.matches[0];
  const rm = fileOf(r, "src/unicode.txt")!.matches[0];
  assert.equal(nm.column, rm.column);
  assert.equal(nm.matchLength, rm.matchLength);
});

// --- rg cap determinism + node parity (finding #1) -----------------------------

test("rg: a capped search is deterministic and caps the same path-order prefix as node", { skip: !rgAvailable }, async () => {
  // More matches than the cap, spread across many files. Without `--sort path` rg walks
  // in parallel and truncates at the cap in nondeterministic completion order, so the
  // surviving file subset varies run to run (and diverges from node). `--sort path` makes
  // the cap a deterministic path-order prefix — identical every run AND identical to node.
  const dir = await mkdtemp(join(tmpdir(), "orq-rgcap-"));
  try {
    for (let i = 0; i < 40; i += 1) {
      const abs = join(dir, `d${String(i).padStart(2, "0")}`, `f${i}.txt`);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "alpha marker beta\nmarker again\n"); // 2 matches per file
    }
    const cap = 15;
    const search = (engine: "node" | "rg") =>
      searchProjectFiles(dir, dir, { query: "marker", engine, maxResults: cap });

    const first = await search("rg");
    assert.equal(first.limitHit, true);
    assert.ok(first.totalMatches > 0 && first.totalMatches <= cap, `totalMatches ${first.totalMatches}`);
    const shape = (res: FsSearchResponse) => res.files.map((f) => [f.path, f.matches.length]);
    const snapshot = JSON.stringify(shape(first));
    for (let r = 0; r < 3; r += 1) {
      const again = await search("rg");
      assert.equal(JSON.stringify(shape(again)), snapshot, `rg run ${r} identical capped set`);
    }
    // The cap must select the SAME files (and per-file match counts) as the node engine.
    const viaNode = await search("node");
    assert.equal(JSON.stringify(shape(viaNode)), snapshot, "rg and node cap the same prefix");
    assert.equal(first.totalMatches, viaNode.totalMatches);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("both engines: a capped mixed-case dir selects the IDENTICAL byte-order prefix", async () => {
  // apple/Banana/cherry/Zebra each match once. Byte order (Banana < Zebra < apple <
  // cherry) differs from localeCompare (apple < Banana < cherry < Zebra), so at a small
  // cap the two orders would pick a DIFFERENT member set. Both walkers now sort by bytes
  // (matching rg's `--sort path`), so the capped file set must be identical across engines.
  const mixed = join(fsRoot, "mixed");
  const cap = 2;
  const n = await searchProjectFiles(fsRoot, mixed, { query: "cat", engine: "node", maxResults: cap });
  assert.equal(n.limitHit, true);
  assert.deepEqual(
    n.files.map((f) => f.path),
    ["Banana.txt", "Zebra.txt"],
    "node caps the byte-order prefix"
  );
  if (rgAvailable) {
    const r = await searchProjectFiles(fsRoot, mixed, { query: "cat", engine: "rg", maxResults: cap });
    assert.deepEqual(
      r.files.map((f) => f.path).sort((a, b) => a.localeCompare(b)),
      n.files.map((f) => f.path).sort((a, b) => a.localeCompare(b)),
      "rg and node select the identical capped file set"
    );
    assert.equal(r.totalMatches, n.totalMatches);
  }
});

// --- rg abort during the post-runRipgrep size-stat phase (finding #3) -----------

test("rg: an abort during the size-stat phase rejects and never resolves", { skip: !rgAvailable }, async () => {
  // The size-stat loop runs AFTER runRipgrep resolves; finding #3 was that it had no
  // signal checks, so a request cancelled there still resolved a success payload. rg
  // itself resolves in a small fraction of the runtime and the per-file stat loop
  // dominates (~90%), so aborting at ~40% of the measured runtime reliably lands the
  // signal after rg resolved but well before the stat loop finishes — the exact window.
  const dir = await mkdtemp(join(tmpdir(), "orq-rgstat-"));
  try {
    for (let i = 0; i < 1000; i += 1) {
      const abs = join(dir, `d${String(i).padStart(4, "0")}`, "f.txt");
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "cat here\n");
    }
    const q = { query: "cat", engine: "rg" as const, maxResults: 1000 };
    await searchProjectFiles(dir, dir, q); // warm the FS cache so timing is stable
    const t0 = Date.now();
    await searchProjectFiles(dir, dir, q);
    const dur = Date.now() - t0;

    const controller = new AbortController();
    const promise = searchProjectFiles(dir, dir, { ...q, signal: controller.signal });
    setTimeout(() => controller.abort(), Math.max(10, Math.round(dur * 0.4)));
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.status, 499);
      assert.equal(err.code, "REQUEST_ABORTED");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- rg glob parity: literal brackets + field on parse failure (finding #4) -----

test("both engines: a literal [ ] in an include matches a literal filename, not a class", async () => {
  // Our glob grammar has no `[]` classes — `file[1].ts` means the literal filename. rg
  // treats `[1]` as a character class; without escaping it would match `file1.ts` instead.
  const dir = await mkdtemp(join(tmpdir(), "orq-bracket-"));
  try {
    await writeFile(join(dir, "file[1].ts"), "cat literal\n");
    await writeFile(join(dir, "file1.ts"), "cat class-would-match\n");
    await writeFile(join(dir, "fileX.ts"), "cat other\n");
    const engines: Array<"node" | "rg"> = rgAvailable ? ["node", "rg"] : ["node"];
    for (const engine of engines) {
      const res = await searchProjectFiles(dir, dir, { query: "cat", engine, include: "file[1].ts" });
      assert.deepEqual(res.files.map((f) => f.path), ["file[1].ts"], `${engine} matched only the literal`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rg: a glob the node parser accepts but rg rejects is INVALID_GLOB carrying the field", { skip: !rgAvailable }, async () => {
  // A trailing backslash is a literal path char to our grammar but a dangling escape to
  // rg; it slips past the node parser and fails inside rg, exercising the stderr→field
  // mapping. The error must attribute the offending glob back to include vs exclude.
  await assert.rejects(
    () => rg("cat", { include: "foo\\" }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "INVALID_GLOB");
      assert.equal(err.field, "include");
      return true;
    }
  );
  await assert.rejects(
    () => rg("cat", { exclude: "bar\\" }),
    (err: unknown) => {
      assert.ok(err instanceof FsSearchError);
      assert.equal(err.code, "INVALID_GLOB");
      assert.equal(err.field, "exclude");
      return true;
    }
  );
});
