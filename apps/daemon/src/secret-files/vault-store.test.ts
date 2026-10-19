import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_FILE_HISTORY_MAX, SECRET_FILE_MAX_BYTES } from "@orquester/api";
import {
  SecretVaultStore,
  SecretVaultStoreError,
  type VaultFileVersion,
  type VaultRecord,
  type VaultTransaction
} from "./vault-store.ts";

const WS = "acme";
const RK = "github.com/acme/site";
const SECRET = "API_KEY=sk_test_FAKE_DO_NOT_USE_123";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (text: string): string => createHash("sha256").update(bytes(text)).digest("hex");
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

interface Harness {
  dir: string;
  store: SecretVaultStore;
  logs: string[];
  index: string;
  blobs: string;
  open: () => Promise<SecretVaultStore>;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "orq-vault-store-"));
  const dir = join(root, "daemon", "secret-files");
  const logs: string[] = [];
  let clock = Date.parse("2026-10-19T10:00:00.000Z");
  const open = async (): Promise<SecretVaultStore> => {
    const store = new SecretVaultStore({
      dir,
      now: () => new Date((clock += 1000)),
      logger: {
        warn: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
        error: (...args: unknown[]) => void logs.push(args.map(String).join(" "))
      }
    });
    await store.load();
    return store;
  };
  return {
    dir,
    store: await open(),
    logs,
    index: join(dir, "vaults.json"),
    blobs: join(dir, "blobs"),
    open,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

function empty(): VaultRecord {
  return { workspace: WS, repoKey: RK, files: [], excluded: [], clones: {}, createdAt: "", updatedAt: "" };
}

/** `current` with `version` as `path`'s newest version. */
function withVersion(current: VaultRecord | undefined, path: string, version: VaultFileVersion): VaultRecord {
  const base = current ?? empty();
  const existing = base.files.find((file) => file.path === path);
  return {
    ...base,
    files: [...base.files.filter((file) => file.path !== path), { path, versions: [version, ...(existing?.versions ?? [])] }]
  };
}

async function put(store: SecretVaultStore, path: string, text: string): Promise<VaultRecord> {
  const result = await store.update(WS, RK, async (current, tx) =>
    withVersion(current, path, await tx.putContent(bytes(text), { kind: "user", projectName: "site" }))
  );
  assert.ok(result, "the update returned a record");
  return result;
}

async function rejectsWith(promise: Promise<unknown>, code: SecretVaultStoreError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof SecretVaultStoreError && error.code === code);
}

async function blobNames(h: Harness): Promise<string[]> {
  return (await readdir(h.blobs)).sort();
}

test("create, update and delete a vault; modes are 0700 / 0600", async () => {
  const h = await harness();
  try {
    assert.equal(h.store.writable, true);
    assert.equal(await mode(h.dir), 0o700);
    assert.equal(await mode(h.blobs), 0o700);
    assert.deepEqual(h.store.list(), []);

    const created = await put(h.store, ".env", SECRET);
    assert.equal(created.files.length, 1);
    const [version] = created.files[0]!.versions;
    assert.match(version!.id, /^v_[A-Za-z0-9_-]{8,64}$/);
    assert.equal(version!.sha256, sha(SECRET));
    assert.deepEqual(version!.updatedBy, { kind: "user", projectName: "site" });
    assert.equal(created.createdAt, created.updatedAt);
    assert.equal(await mode(h.index), 0o600);
    assert.equal(await mode(join(h.blobs, sha(SECRET))), 0o600);
    assert.deepEqual(h.store.get(WS, RK), created);

    const updated = await h.store.update(WS, RK, (current) => ({ ...current!, excluded: [".env.test"] }));
    assert.deepEqual(updated!.excluded, [".env.test"]);
    assert.equal(updated!.createdAt, created.createdAt);
    assert.ok(updated!.updatedAt > created.updatedAt, "updatedAt advanced");

    // Persisted: a fresh store reads the same record.
    const reopened = await h.open();
    assert.deepEqual(reopened.list(), [updated]);
    assert.deepEqual(Buffer.from(await reopened.readContent(sha(SECRET))).toString(), SECRET);

    assert.equal(await h.store.update(WS, RK, () => null), null);
    assert.equal(h.store.get(WS, RK), undefined);
    assert.deepEqual(await blobNames(h), [], "the deleted vault's content is swept");
    assert.deepEqual(JSON.parse(await readFile(h.index, "utf8")), { version: 1, vaults: [] });
    // Deleting a vault that does not exist writes nothing and answers null.
    assert.equal(await h.store.update(WS, RK, () => null), null);
  } finally {
    await h.cleanup();
  }
});

test("mutate gets a deep copy, and callers get copies", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    await h.store.update(WS, RK, (current) => {
      current!.files[0]!.versions[0]!.updatedBy.kind = "agent";
      current!.excluded.push("x");
      current!.clones["/p"] = { baselines: {} };
      throw new Error("changed my mind");
    }).catch(() => undefined);
    const stored = h.store.get(WS, RK)!;
    assert.equal(stored.files[0]!.versions[0]!.updatedBy.kind, "user");
    assert.deepEqual(stored.excluded, []);
    assert.deepEqual({ ...stored.clones }, {});

    stored.files.length = 0;
    h.store.list()[0]!.excluded.push("y");
    assert.equal(h.store.get(WS, RK)!.files.length, 1);
    assert.deepEqual(h.store.get(WS, RK)!.excluded, []);

    // Returning the mutated copy after the fact cannot reach the store either.
    let leaked: VaultRecord | undefined;
    await h.store.update(WS, RK, (current) => (leaked = { ...current!, excluded: ["a"] }));
    leaked!.excluded.push("b");
    assert.deepEqual(h.store.get(WS, RK)!.excluded, ["a"]);
  } finally {
    await h.cleanup();
  }
});

test("history is trimmed to SECRET_FILE_HISTORY_MAX and the dropped content is swept", async () => {
  const h = await harness();
  try {
    const total = SECRET_FILE_HISTORY_MAX + 2;
    for (let i = 0; i < total; i++) await put(h.store, ".env", `${SECRET}_${i}`);
    const versions = h.store.get(WS, RK)!.files[0]!.versions;
    assert.equal(versions.length, SECRET_FILE_HISTORY_MAX);
    assert.equal(versions[0]!.sha256, sha(`${SECRET}_${total - 1}`), "newest first");
    const kept = Array.from({ length: SECRET_FILE_HISTORY_MAX }, (_, i) => sha(`${SECRET}_${i + 2}`)).sort();
    assert.deepEqual(await blobNames(h), kept);
  } finally {
    await h.cleanup();
  }
});

test("the same content is stored once; every put still mints its own version", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    const record = await put(h.store, "apps/web/.env", SECRET);
    const a = record.files.find((f) => f.path === ".env")!.versions[0]!;
    const b = record.files.find((f) => f.path === "apps/web/.env")!.versions[0]!;
    assert.equal(a.sha256, b.sha256);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(await blobNames(h), [sha(SECRET)]);
  } finally {
    await h.cleanup();
  }
});

test("content is durable before the index names it; a failed index write leaves the old record", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    const next = `${SECRET}_next`;

    await h.store.update(WS, RK, async (current, tx) => {
      const version = await tx.putContent(bytes(next), { kind: "agent", threadId: "t-1" });
      // The blob is on disk; the index on disk does not point at it yet.
      assert.equal((await readFile(join(h.blobs, version.sha256))).toString(), next);
      assert.equal((await readFile(h.index, "utf8")).includes(version.id), false);
      return withVersion(current, ".env", version);
    });
    assert.equal(h.store.get(WS, RK)!.files[0]!.versions.length, 2);

    // Make the index unwritable: a directory where the file goes (rename onto it fails).
    const saved = `${h.index}.saved`;
    const before = h.store.get(WS, RK)!;
    await rename(h.index, saved);
    await mkdir(h.index);
    const lost = `${SECRET}_lost`;
    await rejectsWith(put(h.store, ".env", lost), "SECRET_FILES_ERROR");
    assert.deepEqual(h.store.get(WS, RK), before, "memory keeps the old record");
    assert.equal(h.store.writable, true);

    await rmdir(h.index);
    await rename(saved, h.index);
    const reopened = await h.open();
    assert.deepEqual(reopened.get(WS, RK), before, "the file keeps the old record");
    assert.deepEqual(await blobNames(h), [sha(SECRET), sha(next)].sort(), "the orphaned content is swept at the next load");
  } finally {
    await h.cleanup();
  }
});

test("a version must point at stored content", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    const forged: VaultFileVersion = {
      id: "v_forged0000",
      sha256: sha("never stored"),
      updatedAt: "2026-10-19T10:00:00.000Z",
      updatedBy: { kind: "user" }
    };
    await rejectsWith(
      h.store.update(WS, RK, (current) => withVersion(current, ".env", forged)),
      "SECRET_FILES_ERROR"
    );
    assert.equal(h.store.get(WS, RK)!.files[0]!.versions.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("updates are serialized across the whole store", async () => {
  const h = await harness();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const first = h.store.update(WS, RK, async (current, tx) => {
      order.push("first:start");
      await gate;
      const version = await tx.putContent(bytes(SECRET), { kind: "user" });
      order.push("first:end");
      return withVersion(current, ".env", version);
    });
    const second = h.store.update(WS, RK, async (current, tx) => {
      order.push(`second:start:${current?.files.map((f) => f.path).join(",") ?? "none"}`);
      return withVersion(current, ".env.local", await tx.putContent(bytes(`${SECRET}_2`), { kind: "user" }));
    });
    const other = h.store.update("other", RK, async (current) => {
      order.push("other");
      return current ?? { ...empty(), workspace: "other" };
    });
    release();
    await Promise.all([first, second, other]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start:.env", "other"]);
    assert.deepEqual(
      h.store.get(WS, RK)!.files.map((f) => f.path),
      [".env", ".env.local"]
    );
    assert.equal(h.store.list().length, 2);
  } finally {
    await h.cleanup();
  }
});

test("a no-op result writes nothing", async () => {
  const h = await harness();
  try {
    const record = await put(h.store, ".env", SECRET);
    const text = await readFile(h.index, "utf8");
    // Same content, keys in another order.
    const result = await h.store.update(WS, RK, (current) => {
      const { files, ...rest } = current!;
      return { files, ...rest };
    });
    assert.deepEqual(result, record);
    assert.equal(await readFile(h.index, "utf8"), text);
  } finally {
    await h.cleanup();
  }
});

test("invalid results are refused and nothing is written", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    const text = await readFile(h.index, "utf8");
    const attempts: Array<(current: VaultRecord | undefined) => VaultRecord> = [
      (current) => ({ ...current!, workspace: "elsewhere" }),
      (current) => ({ ...current!, repoKey: "github.com/acme/other" }),
      (current) => ({ ...current!, files: [{ ...current!.files[0]!, path: "../.env" }] }),
      (current) => ({ ...current!, excluded: ["/etc/passwd"] }),
      (current) => ({ ...current!, clones: { "/p": { baselines: { ".env": "not-a-version" } } } }),
      (current) => ({ ...current!, files: [...current!.files, ...current!.files] })
    ];
    for (const mutate of attempts) await rejectsWith(h.store.update(WS, RK, mutate), "SECRET_FILES_ERROR");
    await rejectsWith(h.store.update(".hidden", RK, () => null), "SECRET_FILES_ERROR");
    await rejectsWith(h.store.update(WS, "/srv/acme/site", () => null), "SECRET_FILES_ERROR");
    await rejectsWith(
      h.store.update(WS, RK, async (current, tx: VaultTransaction) =>
        withVersion(current, ".env", await tx.putContent(new Uint8Array(SECRET_FILE_MAX_BYTES + 1), { kind: "user" }))
      ),
      "SECRET_FILES_ERROR"
    );
    assert.equal(await readFile(h.index, "utf8"), text);
  } finally {
    await h.cleanup();
  }
});

test("a corrupt index is moved aside; no content is swept while it exists", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    await writeFile(h.index, "{ not json");
    const corrupt = await h.open();
    assert.equal(corrupt.writable, true);
    assert.deepEqual(corrupt.list(), []);
    const aside = (await readdir(h.dir)).filter((name) => name.startsWith("vaults.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(join(h.dir, aside[0]!), "utf8"), "{ not json");
    assert.deepEqual(await blobNames(h), [sha(SECRET)], "kept at load");

    // New writes still never sweep while the moved-aside index exists.
    await put(corrupt, ".env", `${SECRET}_new`);
    await corrupt.update(WS, RK, () => null);
    assert.deepEqual(await blobNames(h), [sha(SECRET), sha(`${SECRET}_new`)].sort());

    // A wrong outer shape is moved aside too (a second one beside the first).
    await writeFile(h.index, JSON.stringify({ version: 2, vaults: [] }));
    await h.open();
    assert.equal((await readdir(h.dir)).filter((name) => name.startsWith("vaults.json.corrupt-")).length, 2);

    // Once the moved-aside files are gone, the next write cleans up.
    for (const name of await readdir(h.dir)) if (name.startsWith("vaults.json.corrupt-")) await rm(join(h.dir, name));
    const fresh = await h.open();
    assert.deepEqual(await blobNames(h), []);
    await put(fresh, ".env", SECRET);
    assert.deepEqual(await blobNames(h), [sha(SECRET)]);
    assert.ok(h.logs.some((line) => line.includes("moved it to")), "the move-aside is logged");
  } finally {
    await h.cleanup();
  }
});

test("an unreadable index makes the store read-only and leaves it alone", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    const saved = `${h.index}.saved`;
    await rename(h.index, saved);
    await mkdir(h.index); // readFile → EISDIR
    const blocked = await h.open();
    assert.equal(blocked.writable, false);
    assert.deepEqual(blocked.list(), []);
    await rejectsWith(put(blocked, ".env", SECRET), "SECRET_FILES_UNAVAILABLE");
    await rejectsWith(blocked.update(WS, RK, () => null), "SECRET_FILES_UNAVAILABLE");
    assert.equal((await stat(h.index)).isDirectory(), true);
    assert.deepEqual(await blobNames(h), [sha(SECRET)], "nothing swept");
    assert.equal((await readdir(h.dir)).some((name) => name.startsWith("vaults.json.corrupt-")), false);
  } finally {
    await h.cleanup();
  }
});

test("updating before load is refused", async () => {
  const h = await harness();
  try {
    const unloaded = new SecretVaultStore({ dir: h.dir });
    assert.equal(unloaded.writable, false);
    await rejectsWith(put(unloaded, ".env", SECRET), "SECRET_FILES_UNAVAILABLE");
  } finally {
    await h.cleanup();
  }
});

test("unknown fields and records this build cannot read survive a rewrite, and so does their content", async () => {
  const h = await harness();
  try {
    const kept = `${SECRET}_newer_build`;
    await put(h.store, ".env", kept); // puts the blob on disk
    const blob = sha(kept);
    const good = {
      workspace: WS,
      repoKey: RK,
      color: "teal",
      files: [
        {
          path: ".env",
          pinned: true,
          versions: [{ id: "v_known00000", sha256: blob, updatedAt: "2026-10-19T09:00:00.000Z", updatedBy: { kind: "user", device: "x" }, note: 1 }]
        }
      ],
      excluded: [],
      clones: { "/srv/ws/acme/site": { baselines: { ".env": "v_known00000" }, seenAt: "x" } },
      createdAt: "2026-10-19T09:00:00.000Z",
      updatedAt: "2026-10-19T09:00:00.000Z"
    };
    const rejectedRecord = {
      workspace: WS,
      repoKey: "github.com/acme/api",
      files: [{ path: ".env", versions: [{ id: "v_newer00000", sha256: blob, updatedAt: "x", updatedBy: { kind: "workflow" } }] }]
    };
    await writeFile(h.index, JSON.stringify({ version: 1, vaults: [good, rejectedRecord], later: { a: 1 } }));
    const store = await h.open();
    assert.equal(store.list().length, 1);

    // The good record no longer references the blob; the rejected one still does.
    const result = await store.update(WS, RK, async (current, tx) => {
      const version = await tx.putContent(bytes(SECRET), { kind: "user" });
      return { ...current!, files: [{ ...current!.files[0]!, versions: [version] }] };
    });
    const file = JSON.parse(await readFile(h.index, "utf8")) as Record<string, unknown> & { vaults: unknown[] };
    assert.deepEqual(file.later, { a: 1 });
    assert.deepEqual(file.vaults[1], rejectedRecord);
    const written = file.vaults[0] as typeof good;
    assert.equal(written.color, "teal");
    assert.equal(written.files[0]!.pinned, true);
    assert.equal((written.clones["/srv/ws/acme/site"] as Record<string, unknown>).seenAt, "x");
    assert.equal(written.createdAt, good.createdAt);
    assert.notEqual(result!.updatedAt, good.updatedAt);
    assert.deepEqual(await blobNames(h), [blob, sha(SECRET)].sort(), "a rejected record's content is not swept");
  } finally {
    await h.cleanup();
  }
});

test("readContent validates the id and verifies the content", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    assert.equal(Buffer.from(await h.store.readContent(sha(SECRET))).toString(), SECRET);
    for (const bad of ["../vaults.json", "", sha(SECRET).toUpperCase(), `${sha(SECRET)}/x`, `../${sha(SECRET).slice(3)}`]) {
      await rejectsWith(h.store.readContent(bad), "SECRET_FILES_ERROR");
    }
    await rejectsWith(h.store.readContent(sha("never stored")), "SECRET_FILES_ERROR");

    await writeFile(join(h.blobs, sha(SECRET)), "tampered");
    await rejectsWith(h.store.readContent(sha(SECRET)), "SECRET_FILES_ERROR");
    // Storing the same content again repairs the damaged blob.
    await put(h.store, ".env.local", SECRET);
    assert.equal(Buffer.from(await h.store.readContent(sha(SECRET))).toString(), SECRET);
    assert.equal(await mode(join(h.blobs, sha(SECRET))), 0o600);
  } finally {
    await h.cleanup();
  }
});

test("existing directories are tightened to 0700, crash leftovers cleared, and nothing logs content", async () => {
  const h = await harness();
  try {
    await put(h.store, ".env", SECRET);
    await chmod(h.dir, 0o755);
    await chmod(h.blobs, 0o755);
    const leftover = join(h.blobs, `.${sha("x")}.00000000-0000-4000-8000-000000000000.tmp`);
    await writeFile(leftover, "partial");
    await writeFile(join(h.blobs, "README"), "not ours");
    await h.open();
    assert.equal(await mode(h.dir), 0o700);
    assert.equal(await mode(h.blobs), 0o700);
    assert.deepEqual(await blobNames(h), ["README", sha(SECRET)].sort(), "only our own temp file is removed");
    assert.equal(h.logs.some((line) => line.includes(SECRET) || line.includes(sha(SECRET))), false);
  } finally {
    await h.cleanup();
  }
});
