import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSecretBlobSha256,
  parseSecretVaultsConfig,
  secretBlobsDir,
  secretFilesDir,
  secretVaultIndexPath,
  secretVaultRecordSchema,
  serializeSecretVaultsFile
} from "./index.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "0123456789abcdef".repeat(4);

const version = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "v_AbCdEf12_-",
  sha256: SHA_A,
  updatedAt: "2026-10-19T10:00:00.000Z",
  updatedBy: { kind: "user", projectName: "site" },
  ...overrides
});

const vault = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspace: "acme",
  repoKey: "github.com/acme/site",
  files: [
    {
      path: ".env",
      versions: [version(), version({ id: "v_12345678", sha256: SHA_B, updatedBy: { kind: "agent", threadId: "t-1" } })]
    },
    { path: "apps/web/.env.local", versions: [version({ id: "v_web000000" })] }
  ],
  excluded: [".env.test"],
  clones: { "/srv/ws/acme/site": { baselines: { ".env": "v_AbCdEf12_-" } } },
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  ...overrides
});

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("the vault index and its blobs live under daemon/secret-files", () => {
  assert.equal(secretFilesDir("/srv/orq"), "/srv/orq/daemon/secret-files");
  assert.equal(secretVaultIndexPath("/srv/orq"), "/srv/orq/daemon/secret-files/vaults.json");
  assert.equal(secretBlobsDir("/srv/orq"), "/srv/orq/daemon/secret-files/blobs");
});

test("an empty or default file parses to no vaults; missing excluded/clones default", () => {
  assert.deepEqual(parseSecretVaultsConfig({}), { version: 1, vaults: [], rejected: [], extra: {} });
  const { excluded: _excluded, clones: _clones, ...bare } = vault();
  const parsed = parseSecretVaultsConfig({ version: 1, vaults: [bare] });
  assert.equal(parsed.vaults.length, 1);
  assert.deepEqual(parsed.vaults[0]!.excluded, []);
  assert.deepEqual({ ...parsed.vaults[0]!.clones }, {});
});

test("unknown fields survive at every level, and unknown top-level keys are kept", () => {
  const entry = vault({
    colour: "teal",
    files: [{ path: ".env", pinned: true, versions: [version({ note: "x", updatedBy: { kind: "user", device: "laptop" } })] }],
    clones: { "/p": { baselines: {}, lastSeen: "yesterday" } }
  });
  const raw = { version: 1, vaults: [entry], later: { a: 1 } };
  const parsed = parseSecretVaultsConfig(plain(raw));
  assert.deepEqual(plain(parsed.vaults), [entry]);
  assert.deepEqual(parsed.extra, { later: { a: 1 } });
  assert.deepEqual(plain(serializeSecretVaultsFile(parsed)), raw);
});

test("bad records are set aside one by one, verbatim, and written back after the good ones", () => {
  const bad = [
    vault({ workspace: ".hidden" }),
    vault({ workspace: "a/b" }),
    vault({ repoKey: "GitHub.com/acme/site" }),
    vault({ repoKey: "/srv/acme/site" }),
    vault({ repoKey: "github.com/../x" }),
    vault({ files: [{ path: "../.env", versions: [version()] }] }),
    vault({ files: [{ path: "/etc/passwd", versions: [version()] }] }),
    vault({ files: [{ path: ".git/config", versions: [version()] }] }),
    vault({ files: [{ path: "vendor/lib/.git/config", versions: [version()] }] }),
    vault({ files: [{ path: ".GIT/config", versions: [version()] }] }),
    vault({ excluded: ["sub/.Git/x"] }),
    vault({ retired: [{ path: "a/.git/x", versions: [version()] }] }),
    vault({ retired: [{ path: ".env", versions: [] }] }),
    vault({ retired: [{ path: ".env", versions: [version()] }, { path: ".env", versions: [version()] }] }),
    vault({ retired: {} }),
    vault({ clones: { "/p": { baselines: {}, unlistedAt: "last week" } } }),
    vault({ files: [{ path: "a\\b", versions: [version()] }] }),
    vault({ files: [{ path: ".env", versions: [] }] }),
    vault({ files: [{ path: ".env", versions: [version({ id: "nope" })] }] }),
    vault({ files: [{ path: ".env", versions: [version({ id: "v_1234567" })] }] }),
    vault({ files: [{ path: ".env", versions: [version({ id: `v_${"a".repeat(65)}` })] }] }),
    vault({ files: [{ path: ".env", versions: [version({ id: "v_1234/678" })] }] }),
    vault({ files: [{ path: ".env", versions: [version({ sha256: "../../etc/passwd" })] }] }),
    vault({ files: [{ path: ".env", versions: [version({ sha256: SHA_A.toUpperCase() })] }] }),
    vault({ files: [{ path: ".env", versions: [version(), version()] }] }),
    vault({ files: [{ path: ".env", versions: [version()] }, { path: ".env", versions: [version()] }] }),
    vault({ files: [{ path: ".env", versions: [version({ updatedBy: { kind: "robot" } })] }] }),
    vault({ excluded: ["../x"] }),
    vault({ clones: { "/p": { baselines: { "../.env": "v_AbCdEf12_-" } } } }),
    vault({ clones: { "/p": { baselines: { ".env": "sha" } } } }),
    vault({ clones: { "": { baselines: {} } } }),
    vault({ clones: [] }),
    vault({ createdAt: "yesterday" }),
    "not an object",
    null
  ];
  const good = vault({ workspace: "good" });
  const raw = plain({ version: 1, vaults: [...bad, good] }) as { vaults: unknown[] };
  const parsed = parseSecretVaultsConfig(raw);
  assert.deepEqual(
    parsed.vaults.map((v) => v.workspace),
    ["good"]
  );
  assert.deepEqual(parsed.rejected, raw.vaults.slice(0, bad.length));
  assert.deepEqual(plain(serializeSecretVaultsFile(parsed).vaults), [good, ...raw.vaults.slice(0, bad.length)].map(plain));
});

test("retired files and unlisted clones round-trip; records without them still parse", () => {
  const entry = vault({
    retired: [{ path: "old/.env", versions: [version({ id: "v_retired00" }), version({ id: "v_retired01", sha256: SHA_B })], note: "x" }],
    clones: { "/srv/ws/acme/site": { baselines: { ".env": "v_AbCdEf12_-" }, unlistedAt: "2026-10-19T11:00:00.000Z" } }
  });
  const raw = { version: 1, vaults: [entry] };
  const parsed = parseSecretVaultsConfig(plain(raw));
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.vaults[0]!.retired?.[0]?.versions.length, 2);
  assert.equal(parsed.vaults[0]!.clones["/srv/ws/acme/site"]?.unlistedAt, "2026-10-19T11:00:00.000Z");
  assert.deepEqual(plain(serializeSecretVaultsFile(parsed)), raw);
  // An older record (no retired, no unlistedAt) parses without gaining either.
  const older = parseSecretVaultsConfig(plain({ version: 1, vaults: [vault()] }));
  assert.equal(older.vaults.length, 1);
  assert.equal("retired" in older.vaults[0]!, false);
  assert.deepEqual(plain(serializeSecretVaultsFile(older)), plain({ version: 1, vaults: [vault()] }));
  // A retired path may also be managed again (a new history).
  assert.equal(secretVaultRecordSchema.safeParse(plain(vault({ retired: [{ path: ".env", versions: [version({ id: "v_retired00" })] }] }))).success, true);
});

test("a repeated (workspace, repoKey) keeps the first and sets the rest aside", () => {
  const first = vault();
  const second = vault({ excluded: [] });
  const parsed = parseSecretVaultsConfig(plain({ version: 1, vaults: [first, second, vault({ workspace: "b" })] }));
  assert.deepEqual(plain(parsed.vaults.map((v) => v.excluded)), [[".env.test"], [".env.test"]]);
  assert.deepEqual(parsed.vaults.map((v) => v.workspace), ["acme", "b"]);
  assert.deepEqual(parsed.rejected, [second]);
});

test("the outer shape throws", () => {
  for (const raw of [null, "x", 42, [], { version: 2, vaults: [] }, { version: 1, vaults: {} }, { vaults: "x" }]) {
    assert.throws(() => parseSecretVaultsConfig(raw), /Not a version-1 secret vaults file/, JSON.stringify(raw));
  }
});

test("a __proto__ key in a stored map stays an own key and pollutes nothing", () => {
  const text = `{"version":1,"vaults":[${JSON.stringify(vault({ clones: {} })).replace(
    '"clones":{}',
    '"clones":{"__proto__":{"baselines":{".env":"v_AbCdEf12_-"}}}'
  )}],"__proto__":{"polluted":true}}`;
  const parsed = parseSecretVaultsConfig(JSON.parse(text));
  const clones = parsed.vaults[0]!.clones;
  assert.equal(Object.getPrototypeOf(clones), null);
  assert.deepEqual(Object.keys(clones), ["__proto__"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(JSON.stringify(serializeSecretVaultsFile(parsed)), text);
});

test("blob ids are lowercase SHA-256 filenames", () => {
  assert.equal(isSecretBlobSha256(SHA_B), true);
  assert.equal(isSecretBlobSha256(`${SHA_B}\n`), false);
  assert.equal(isSecretBlobSha256("../".repeat(21) + "a"), false);
});
