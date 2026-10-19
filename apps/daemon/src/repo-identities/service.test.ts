import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { REPO_ICON_MAX_BYTES, REPO_IDENTITIES_CHANNEL, REPO_IDENTITY_CHANGED, type RepoIdentityChangedPayload } from "@orquester/api";
import { RepoIdentitiesService, RepoIdentityError, publishRepoIdentityEvents } from "./service.ts";

const quiet = { warn: () => {}, error: () => {} };
const KEY = "github.com/acme/site";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 9, 9]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');

async function scratch(t: TestContext): Promise<{
  root: string;
  file: string;
  iconsDir: string;
  service: () => RepoIdentitiesService;
  onDisk: () => Promise<Record<string, unknown>>;
  icons: () => Promise<string[]>;
}> {
  const root = await mkdtemp(join(tmpdir(), "orquester-repo-identities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "daemon", "repo-identities.json");
  const iconsDir = join(root, "daemon", "repo-icons");
  await mkdir(join(root, "daemon"), { recursive: true });
  return {
    root,
    file,
    iconsDir,
    service: () => new RepoIdentitiesService({ file, iconsDir, logger: quiet }),
    onDisk: async () => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>,
    icons: async () => (await readdir(iconsDir).catch(() => [] as string[])).sort()
  };
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof RepoIdentityError && error.code === code);
}

test("a missing file is an empty store, and nothing is written until a change", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  assert.deepEqual(service.list(), []);
  await assert.rejects(readFile(s.file), { code: "ENOENT" });
});

test("label: set, trimmed, persisted 0600; clearing the last field removes the record", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  const events: RepoIdentityChangedPayload[] = [];
  service.lifecycle.on("changed", (payload) => events.push(payload));

  const set = await service.setLabel(KEY, "  Acme site ");
  assert.equal(set?.label, "Acme site");
  assert.equal(set?.repoKey, KEY);
  assert.equal((await stat(s.file)).mode & 0o777, 0o600);
  assert.deepEqual((await s.onDisk()).identities, [{ repoKey: KEY, label: "Acme site", updatedAt: set?.updatedAt }]);

  // The same label again changes nothing: no write, no event.
  assert.deepEqual(await service.setLabel(KEY, "Acme site"), set);
  assert.equal(events.length, 1);

  assert.equal(await service.setLabel(KEY, "   "), null);
  assert.deepEqual(service.list(), []);
  assert.deepEqual((await s.onDisk()).identities, []);
  assert.deepEqual(events, [{ identity: set }, { repoKey: KEY, deleted: true }]);
  // Clearing what is not there: nothing happens.
  assert.equal(await service.setLabel(KEY, null), null);
  assert.equal(events.length, 2);
});

test("label, emoji and repo key validation", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  await rejects(service.setLabel(KEY, "x".repeat(81)), "INVALID_LABEL");
  await rejects(service.setLabel(KEY, "a\u0007b"), "INVALID_LABEL");
  await rejects(service.setLabel(KEY, 5), "INVALID_LABEL");
  for (const bad of ["", "ab", "🦷🦷", "a🦷", 7, null]) await rejects(service.setEmoji(KEY, bad), "INVALID_EMOJI");
  for (const key of ["", "/etc/passwd", "github.com/../x", "GitHub.com/a/b", "github.com/a", 5, undefined]) {
    await rejects(service.setLabel(key, "x"), "INVALID_REPO_KEY");
    await rejects(service.setEmoji(key, "🦷"), "INVALID_REPO_KEY");
    await rejects(service.setImage(key, PNG, "image/png"), "INVALID_REPO_KEY");
    await rejects(service.clearIcon(key), "INVALID_REPO_KEY");
    await rejects(service.readIcon(key), "INVALID_REPO_KEY");
  }
  assert.deepEqual(service.list(), []);
});

test("emoji is trimmed and replaces an image icon, whose file goes once the write landed", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  const withImage = await service.setImage(KEY, PNG, "image/png");
  assert.equal(withImage?.icon?.kind, "image");
  const [file] = await s.icons();
  assert.match(file ?? "", /^[a-f0-9-]+\.png$/);
  assert.equal((await stat(s.iconsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(s.iconsDir, file!))).mode & 0o777, 0o600);

  const emoji = await service.setEmoji(KEY, " 👨‍👩‍👧 ");
  assert.deepEqual(emoji?.icon, { kind: "emoji", value: "👨‍👩‍👧" });
  assert.deepEqual(await s.icons(), []);
  assert.equal(await service.readIcon(KEY), null);
});

test("image: stored with a version, served back; the wire never names the file", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  const identity = await service.setImage(KEY, SVG, "image/svg+xml");
  assert.equal(identity?.icon?.kind, "image");
  assert.ok(identity?.icon?.kind === "image" && identity.icon.version.length > 0);
  assert.equal(JSON.stringify(identity).includes("file"), false);
  assert.equal(JSON.stringify(service.list()).includes(".svg"), false);
  const icon = await service.readIcon(KEY);
  assert.deepEqual(icon?.bytes, SVG);
  assert.equal(icon?.contentType, "image/svg+xml");

  // Replacing: a new file and version, the old file gone.
  const before = await s.icons();
  const replaced = await service.setImage(KEY, JPEG, "image/jpeg", { kind: "favicon", domain: "acme.com" });
  const after = await s.icons();
  assert.equal(after.length, 1);
  assert.notDeepEqual(after, before);
  assert.match(after[0]!, /\.jpg$/);
  assert.deepEqual(replaced?.icon, {
    kind: "image",
    contentType: "image/jpeg",
    version: (replaced?.icon as { version: string }).version,
    source: { kind: "favicon", domain: "acme.com" }
  });
  assert.notEqual((replaced?.icon as { version: string }).version, (identity?.icon as { version: string }).version);
});

test("image refusals: wrong magic, declared ≠ sniffed, empty, over the cap, unknown type", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  await rejects(service.setImage(KEY, Buffer.from("hello"), "image/png"), "INVALID_ICON");
  await rejects(service.setImage(KEY, PNG, "image/jpeg"), "INVALID_ICON");
  await rejects(service.setImage(KEY, Buffer.from("<svg><g>"), "image/svg+xml"), "INVALID_ICON");
  await rejects(service.setImage(KEY, Buffer.alloc(0), "image/png"), "INVALID_ICON");
  await rejects(service.setImage(KEY, PNG, "image/gif"), "INVALID_ICON");
  const big = Buffer.concat([PNG, Buffer.alloc(REPO_ICON_MAX_BYTES)]);
  await rejects(service.setImage(KEY, big, "image/png"), "ICON_TOO_LARGE");
  assert.deepEqual(service.list(), []);
  assert.deepEqual(await s.icons(), []);
  // ICO is a stored type (favicons); the routes keep it out of uploads.
  assert.equal((await service.setImage(KEY, ICO, "image/x-icon"))?.icon?.kind, "image");
});

test("clearIcon: back to the label alone, or the record removed with its file", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  assert.equal(await service.clearIcon(KEY), null, "nothing to clear");
  await service.setLabel(KEY, "Site");
  await service.setImage(KEY, PNG, "image/png");
  const labelOnly = await service.clearIcon(KEY);
  assert.deepEqual(Object.keys(labelOnly ?? {}).sort(), ["label", "repoKey", "updatedAt"]);
  assert.deepEqual(await s.icons(), []);

  await service.setLabel(KEY, null);
  await service.setImage(KEY, PNG, "image/png");
  await service.setLabel(KEY, "Site");
  await service.setLabel(KEY, null);
  assert.equal(service.list()[0]?.icon?.kind, "image", "an icon alone keeps the record");
  assert.equal(await service.clearIcon(KEY), null);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(await s.icons(), []);
});

test("reload: unknown fields and rejected records survive a rewrite; orphan icons are swept", async (t) => {
  const s = await scratch(t);
  const keptIcon = "aaaa-1111.png";
  const rejectedIcon = "bbbb-2222.webp";
  const orphan = "cccc-3333.svg";
  await mkdir(s.iconsDir, { recursive: true });
  for (const name of [keptIcon, rejectedIcon, orphan, "notes.txt"]) await writeFile(join(s.iconsDir, name), PNG);
  const known = {
    repoKey: KEY,
    label: "Site",
    icon: { kind: "image", file: keptIcon, contentType: "image/png", version: "v1", tint: "red" },
    updatedAt: "2026-10-18T10:00:00.000Z",
    color: "teal"
  };
  const rejected = [
    { repoKey: "github.com/acme/new", icon: { kind: "lucide", name: "x", file: rejectedIcon }, updatedAt: "2026-10-18T10:00:00.000Z" },
    { repoKey: KEY, label: "duplicate", updatedAt: "2026-10-18T10:00:00.000Z" },
    "garbage"
  ];
  await writeFile(s.file, JSON.stringify({ version: 1, identities: [known, ...rejected], future: { on: true } }));

  const service = s.service();
  await service.load();
  assert.deepEqual(service.list(), [
    { repoKey: KEY, label: "Site", icon: { kind: "image", contentType: "image/png", version: "v1" }, updatedAt: known.updatedAt }
  ]);
  assert.deepEqual(await s.icons(), [keptIcon, rejectedIcon, "notes.txt"].sort(), "only an unreferenced generated name is swept");

  const other = await service.setLabel("github.com/acme/other", "Other");
  await service.setLabel(KEY, "Renamed");
  const disk = await s.onDisk();
  assert.deepEqual(disk.future, { on: true });
  const identities = disk.identities as unknown[];
  assert.deepEqual(identities.slice(2), rejected, "rejected records are written back verbatim");
  assert.deepEqual(identities[0], { ...known, label: "Renamed", updatedAt: (identities[0] as { updatedAt: string }).updatedAt });
  assert.deepEqual(identities[1], { repoKey: "github.com/acme/other", label: "Other", updatedAt: other?.updatedAt });
});

test("a corrupt file is moved aside byte for byte, its icons kept; the store starts empty", async (t) => {
  const s = await scratch(t);
  await mkdir(s.iconsDir, { recursive: true });
  await writeFile(join(s.iconsDir, "dddd.png"), PNG);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T10:11:12.345Z") });
  for (const [index, text] of ["{ not json", JSON.stringify({ version: 2, identities: [] }), "[]"].entries()) {
    await writeFile(s.file, text);
    const service = s.service();
    await service.load();
    assert.deepEqual(service.list(), []);
    const aside = join(s.root, "daemon", `repo-identities.json.corrupt-2026-10-18T10-1${1 + index}-12-345Z`);
    assert.equal(await readFile(aside, "utf8"), text, "the corrupt file is recoverable, untouched");
    assert.deepEqual(await s.icons(), ["dddd.png"], "the moved-aside file's icons stay restorable");
    // The store works after the move; the next write creates a fresh file.
    await service.setLabel(KEY, "x");
    assert.equal((await s.onDisk()).version, 1);
    await rm(s.file);
    t.mock.timers.tick(60_000);
  }
});

test("an unreadable file makes the store read-only: every mutation 503, nothing written", async (t) => {
  const s = await scratch(t);
  await mkdir(s.file); // a directory where the file should be: the read fails with EISDIR
  const service = s.service();
  await service.load();
  assert.deepEqual(service.list(), []);
  await rejects(service.setLabel(KEY, "x"), "REPO_IDENTITIES_UNAVAILABLE");
  await rejects(service.setEmoji(KEY, "🦷"), "REPO_IDENTITIES_UNAVAILABLE");
  await rejects(service.setImage(KEY, PNG, "image/png"), "REPO_IDENTITIES_UNAVAILABLE");
  await rejects(service.clearIcon(KEY), "REPO_IDENTITIES_UNAVAILABLE");
  assert.deepEqual(await s.icons(), []);
  assert.equal((await stat(s.file)).isDirectory(), true);
});

test("overlapping changes land in order: the last state is on disk", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  await Promise.all([
    service.setLabel(KEY, "one"),
    service.setImage(KEY, PNG, "image/png"),
    service.setLabel(KEY, "two"),
    service.setEmoji("github.com/acme/b", "🚀"),
    service.setImage(KEY, JPEG, "image/jpeg")
  ]);
  const disk = (await s.onDisk()).identities as Array<Record<string, unknown>>;
  assert.deepEqual(disk.map((record) => record.repoKey).sort(), [KEY, "github.com/acme/b"].sort());
  const site = disk.find((record) => record.repoKey === KEY) as { label: string; icon: { file: string; contentType: string } };
  assert.equal(site.label, "two");
  assert.equal(site.icon.contentType, "image/jpeg");
  assert.deepEqual(await s.icons(), [site.icon.file], "every replaced file is gone");
});

test("publishRepoIdentityEvents puts every change on the repo-identities channel", async (t) => {
  const s = await scratch(t);
  const service = s.service();
  await service.load();
  const published: Array<{ channel: string; type: string; payload: unknown }> = [];
  publishRepoIdentityEvents(service, { publish: (channel, type, payload) => void published.push({ channel, type, payload }) });
  const identity = await service.setEmoji(KEY, "🦷");
  await service.clearIcon(KEY);
  assert.deepEqual(published, [
    { channel: REPO_IDENTITIES_CHANNEL, type: REPO_IDENTITY_CHANGED, payload: { identity } },
    { channel: REPO_IDENTITIES_CHANNEL, type: REPO_IDENTITY_CHANGED, payload: { repoKey: KEY, deleted: true } }
  ]);
  assert.equal(REPO_IDENTITIES_CHANNEL, "repo-identities");
  assert.equal(REPO_IDENTITY_CHANGED, "repoIdentity.changed");
});
