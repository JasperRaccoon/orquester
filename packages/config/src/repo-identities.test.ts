import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRepoIconFileName,
  parseRepoIdentitiesConfig,
  repoIconFileOfEntry,
  repoIconsDir,
  repoIdentitiesPath
} from "./index.ts";

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  repoKey: "github.com/acme/site",
  label: "Acme site",
  icon: { kind: "emoji", value: "🦷" },
  updatedAt: "2026-10-18T10:00:00.000Z",
  ...overrides
});

const image = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "image",
  file: "0b7c1e2a-55aa-4f00-9e51-0c1d2e3f4a5b.png",
  contentType: "image/png",
  version: "abc123",
  ...overrides
});

test("the store and its icons live beside the other daemon-owned indexes", () => {
  assert.equal(repoIdentitiesPath("/srv/orq"), "/srv/orq/daemon/repo-identities.json");
  assert.equal(repoIconsDir("/srv/orq"), "/srv/orq/daemon/repo-icons");
});

test("a well-formed store round-trips unchanged", () => {
  const file = {
    version: 1,
    identities: [
      record(),
      record({ repoKey: "github.com/acme/api", label: undefined, icon: image() }),
      record({
        repoKey: "bitbucket.org/acme/web",
        icon: image({ file: "f00d.ico", contentType: "image/x-icon", source: { kind: "favicon", domain: "acme.com" } })
      }),
      record({ repoKey: "gitlab.com/acme/docs", icon: undefined })
    ].map((entry) => JSON.parse(JSON.stringify(entry)))
  };
  assert.deepEqual(parseRepoIdentitiesConfig(file), { ...file, rejected: [], extra: {} });
});

test("unknown fields survive, at every level", () => {
  const entry = record({
    pinnedColor: "teal",
    icon: image({ dominant: "#fff", source: { kind: "favicon", domain: "acme.com", fetchedAt: "x" } })
  });
  const parsed = parseRepoIdentitiesConfig({ version: 1, identities: [entry], later: { a: 1 } });
  assert.deepEqual(parsed.identities, [entry]);
  assert.deepEqual(parsed.extra, { later: { a: 1 } });
});

test("bad entries are set aside one by one, verbatim; the rest loads", () => {
  const bad = [
    record({ repoKey: "" }),
    record({ repoKey: 5 }),
    record({ updatedAt: "soon" }),
    record({ label: "" }),
    record({ icon: { kind: "lucide", name: "git-branch" } }),
    record({ icon: { kind: "emoji", value: "" } }),
    record({ icon: image({ file: "../keys/id_ed25519" }) }),
    record({ icon: image({ file: "a/b.png" }) }),
    record({ icon: image({ file: "..png" }) }),
    record({ icon: image({ file: "Icon.PNG" }) }),
    record({ icon: image({ file: "abc.gif" }) }),
    record({ icon: image({ contentType: "text/html" }) }),
    record({ icon: image({ version: "" }) }),
    record({ icon: image({ source: { kind: "url", href: "https://x" } }) }),
    42,
    null,
    "github.com/acme/site"
  ];
  const keep = record({ repoKey: "github.com/acme/keep" });
  const parsed = parseRepoIdentitiesConfig({ version: 1, identities: [keep, ...bad] });
  assert.deepEqual(parsed.identities, [keep]);
  assert.deepEqual(parsed.rejected, bad);
});

test("a repeated repoKey: the first record is the identity, the later one is kept aside", () => {
  const first = record();
  const second = record({ label: "Other" });
  const parsed = parseRepoIdentitiesConfig({ version: 1, identities: [first, second] });
  assert.deepEqual(parsed.identities, [first]);
  assert.deepEqual(parsed.rejected, [second]);
});

test("a missing list or version reads as an empty version-1 store", () => {
  assert.deepEqual(parseRepoIdentitiesConfig({}), { version: 1, identities: [], rejected: [], extra: {} });
});

test("a broken outer shape throws, so the daemon moves the file aside", () => {
  for (const raw of [null, 42, "x", [], { version: 2, identities: [] }, { version: 1, identities: {} }]) {
    assert.throws(() => parseRepoIdentitiesConfig(raw), /repo identities file/, JSON.stringify(raw));
  }
});

test("icon file names are generated ids only", () => {
  for (const ok of ["abc.png", "0b7c1e2a-55aa.jpg", "x.webp", "y.svg", "z.ico"]) assert.equal(isRepoIconFileName(ok), true, ok);
  for (const bad of ["", ".png", "..", "a.PNG", "a.jpeg", "a/b.png", "a\\b.png", "a.png.tmp", " a.png", "a..png", "a".repeat(200) + ".png", 5]) {
    assert.equal(isRepoIconFileName(bad), false, String(bad));
  }
});

test("repoIconFileOfEntry reads a well-formed file name off any entry, rejected ones included", () => {
  assert.equal(repoIconFileOfEntry(record({ icon: { kind: "future", file: "abc.png" } })), "abc.png");
  assert.equal(repoIconFileOfEntry(record({ icon: { kind: "image", file: "../x.png" } })), null);
  assert.equal(repoIconFileOfEntry(record()), null);
  assert.equal(repoIconFileOfEntry(null), null);
  assert.equal(repoIconFileOfEntry("x"), null);
});
