import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  SecretFileCandidatesResponse,
  SecretVaultDetail,
  SecretVaultResponse,
  SecretVaultsResponse
} from "@orquester/api";

import {
  applySecretFilesEvent,
  applySecretVault,
  deleteSecretVault,
  fetchSecretVault,
  getSecretVault,
  loadSecretVaults,
  pushSecretFiles,
  resetCloneSecretFiles,
  resetSecretFiles,
  sanitizeSecretFileCandidates,
  sanitizeSecretVault,
  scanSecretFileCandidates,
  secretFilesStore,
  setupSecretVault,
  updateSecretFiles,
  vaultKey,
  type SecretFilesAdminApi
} from "./store.ts";

const WS = "jaspersito";
const KEY = "github.com/jasperraccoon/matssmile";
const OTHER = "github.com/jasperraccoon/orquester";
const at = (minute: number) => `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

function vault(overrides: Partial<SecretVaultDetail> = {}): SecretVaultDetail {
  return {
    workspace: WS,
    repoKey: KEY,
    fileCount: 1,
    clonesNeedingAttention: 0,
    newCandidates: 0,
    updatedAt: at(0),
    files: [{ path: "MatsSmileBack/.env", version: "v1", updatedAt: at(0), updatedBy: { kind: "user" } }],
    excluded: [],
    candidates: [],
    clones: [
      {
        projectPath: "/ws/jaspersito/MatsSmile",
        projectName: "MatsSmile",
        files: [{ path: "MatsSmileBack/.env", state: "synced" }],
        needsAttention: false
      }
    ],
    ...overrides
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const notFound = () => Object.assign(new Error("not found"), { status: 404, body: { code: "VAULT_NOT_FOUND" } });

/** A fake client: every call waits on a deferred the test settles. */
function fakeApi(connectionId = "c1") {
  const lists: Array<Deferred<SecretVaultsResponse>> = [];
  const details: Array<{ args: unknown[]; answer: Deferred<SecretVaultResponse> }> = [];
  const mutations: Array<{ name: string; args: unknown[]; answer: Deferred<unknown> }> = [];
  const mutation = (name: string) => (...args: unknown[]) => {
    const answer = deferred<unknown>();
    mutations.push({ name, args, answer });
    return answer.promise as Promise<never>;
  };
  const api: SecretFilesAdminApi = {
    connection: { id: connectionId },
    listSecretVaults: () => {
      const answer = deferred<SecretVaultsResponse>();
      lists.push(answer);
      return answer.promise;
    },
    getSecretVault: (...args: unknown[]) => {
      const answer = deferred<SecretVaultResponse>();
      details.push({ args, answer });
      return answer.promise;
    },
    pushSecretFiles: mutation("push"),
    resetSecretFiles: mutation("reset"),
    setupSecretVault: mutation("setup"),
    updateSecretFiles: mutation("update"),
    deleteSecretVault: mutation("delete"),
    scanSecretFileCandidates: mutation("scan")
  };
  return { api, lists, details, mutations };
}

/** Let queued promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const event = (payload: unknown, type = "secretFiles.changed") => ({ type, payload });
const held = () => secretFilesStore.getState().vaults;

beforeEach(() => resetSecretFiles());

describe("wire validation", () => {
  it("keeps a well-formed vault as it is", () => {
    assert.deepEqual(sanitizeSecretVault(vault()), vault());
  });

  it("refuses a vault without a usable identity", () => {
    assert.equal(sanitizeSecretVault(null), null);
    assert.equal(sanitizeSecretVault({ ...vault(), workspace: "../etc" }), null);
    assert.equal(sanitizeSecretVault({ ...vault(), workspace: "" }), null);
    assert.equal(sanitizeSecretVault({ ...vault(), repoKey: "not a key" }), null);
    assert.equal(sanitizeSecretVault({ ...vault(), updatedAt: 5 }), null);
  });

  it("repairs bad fields one by one", () => {
    const raw = {
      workspace: WS,
      repoKey: KEY,
      updatedAt: at(1),
      fileCount: -1,
      clonesNeedingAttention: "two",
      files: [
        { path: "../escape", version: "v1", updatedAt: at(1), updatedBy: { kind: "user" } },
        { path: "a/.env", version: "", updatedAt: at(1), updatedBy: { kind: "user" } },
        { path: "b/.env", version: "v2", updatedAt: at(1), updatedBy: { kind: "robot", threadId: 3, projectName: "B" } },
        { path: "b/.env", version: "v3", updatedAt: at(1), updatedBy: { kind: "user" } },
        "junk"
      ],
      excluded: [".env.local", "/abs", 7, ".env.local"],
      candidates: [".env.staging", ".git/config"],
      clones: [
        {
          projectPath: "/ws/jaspersito/B",
          files: [
            { path: "b/.env", state: "modified", refusal: "tracked" },
            { path: "c/.env", state: "exploded" },
            { path: "d/.env", state: "refused", refusal: "weird" },
            { path: "e/.env", state: "refused", refusal: "symlink" }
          ]
        },
        { projectName: "no path" }
      ]
    };
    assert.deepEqual(sanitizeSecretVault(raw), {
      workspace: WS,
      repoKey: KEY,
      fileCount: 1,
      clonesNeedingAttention: 1,
      newCandidates: 1,
      updatedAt: at(1),
      files: [{ path: "b/.env", version: "v2", updatedAt: at(1), updatedBy: { kind: "user", projectName: "B" } }],
      excluded: [".env.local"],
      candidates: [".env.staging"],
      clones: [
        {
          projectPath: "/ws/jaspersito/B",
          projectName: "B",
          files: [
            { path: "b/.env", state: "modified" },
            { path: "d/.env", state: "refused" },
            { path: "e/.env", state: "refused", refusal: "symlink" }
          ],
          needsAttention: true
        }
      ]
    });
  });

  it("validates a setup scan, dropping malformed candidates and variants", () => {
    const scan = sanitizeSecretFileCandidates({
      workspace: WS,
      repoKey: KEY,
      clones: [{ projectPath: "/ws/a", projectName: "a" }, { projectPath: "/ws/b" }, { nope: true }],
      candidates: [
        {
          path: "x/.env",
          conventional: true,
          managed: false,
          excluded: false,
          format: "env",
          variants: [
            { variantId: "v1", projectPaths: ["/ws/a"], modifiedAt: at(1), keyCount: 2 },
            { variantId: "v2", projectPaths: [], modifiedAt: at(2) },
            { variantId: "v3", projectPaths: ["/ws/b"], modifiedAt: at(3), keyCount: -2 }
          ],
          defaultVariantId: "v2",
          keys: [{ key: "A", byVariant: { v1: 0, v3: "x" } }, { key: "A", byVariant: {} }, { byVariant: {} }],
          refused: [{ projectPath: "/ws/c", refusal: "tracked" }, { projectPath: "/ws/d", refusal: "bogus" }]
        },
        { path: "../bad", variants: [] }
      ]
    });
    assert.deepEqual(scan, {
      workspace: WS,
      repoKey: KEY,
      clones: [
        { projectPath: "/ws/a", projectName: "a" },
        { projectPath: "/ws/b", projectName: "b" }
      ],
      candidates: [
        {
          path: "x/.env",
          conventional: true,
          managed: false,
          excluded: false,
          format: "env",
          variants: [
            { variantId: "v1", projectPaths: ["/ws/a"], modifiedAt: at(1), keyCount: 2 },
            { variantId: "v3", projectPaths: ["/ws/b"], modifiedAt: at(3) }
          ],
          defaultVariantId: null,
          keys: [{ key: "A", byVariant: { v1: 0, v3: null } }],
          refused: [{ projectPath: "/ws/c", refusal: "tracked" }]
        }
      ]
    });
    assert.throws(() => sanitizeSecretFileCandidates({ clones: [] }), /unexpected shape/);
  });
});

describe("applying vaults and events", () => {
  it("applies a vault, ignores one for another repo or a malformed one", () => {
    applySecretVault(WS, KEY, vault());
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0));
    applySecretVault(WS, OTHER, vault({ updatedAt: at(5) }));
    assert.equal(getSecretVault(WS, OTHER), undefined);
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0));
    applySecretVault(WS, KEY, { ...vault({ updatedAt: at(5) }), repoKey: "bad" });
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0));
  });

  it("never goes backwards, but takes a same-time change", () => {
    applySecretVault(WS, KEY, vault({ updatedAt: at(5) }));
    applySecretVault(WS, KEY, vault({ updatedAt: at(4), fileCount: 9 }));
    assert.equal(getSecretVault(WS, KEY)?.fileCount, 1);
    applySecretVault(WS, KEY, vault({ updatedAt: at(5), clonesNeedingAttention: 1 }));
    assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 1);
  });

  it("keeps the same map when the same vault arrives again", () => {
    applySecretVault(WS, KEY, vault());
    const before = held();
    applySecretVault(WS, KEY, vault());
    assert.equal(held(), before);
  });

  it("routes changed and deleted events, ignoring malformed or foreign ones", () => {
    applySecretFilesEvent(event({ vault: vault() }));
    assert.ok(getSecretVault(WS, KEY));
    applySecretFilesEvent(event({ vault: vault({ updatedAt: at(9) }) }, "secretFiles.other"));
    applySecretFilesEvent(event("junk"));
    applySecretFilesEvent(event({ vault: { workspace: WS } }));
    applySecretFilesEvent(event({ workspace: WS, repoKey: KEY, deleted: "yes" }));
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0));
    applySecretFilesEvent(event({ workspace: WS, repoKey: KEY, deleted: true }));
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("a deleted vault is not brought back by an answer no newer than it", () => {
    applySecretVault(WS, KEY, vault({ updatedAt: at(5) }));
    applySecretFilesEvent(event({ workspace: WS, repoKey: KEY, deleted: true }));
    applySecretFilesEvent(event({ vault: vault({ updatedAt: at(5) }) }));
    assert.equal(getSecretVault(WS, KEY), undefined);
    applySecretFilesEvent(event({ vault: vault({ updatedAt: at(6) }) }));
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(6));
  });

  it("keys vaults per workspace", () => {
    applySecretVault(WS, KEY, vault());
    applySecretVault("other", KEY, vault({ workspace: "other" }));
    assert.equal(held().size, 2);
    assert.ok(held().has(vaultKey("other", KEY)));
  });
});

describe("loading", () => {
  it("replaces the map with every vault's detail", async () => {
    applySecretVault(WS, OTHER, vault({ repoKey: OTHER }));
    const { api, lists, details } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never, { workspace: "../x", repoKey: KEY } as never] });
    await flush();
    assert.equal(details.length, 1);
    assert.deepEqual(details[0].args.slice(0, 2), [WS, KEY]);
    details[0].answer.resolve({ vault: vault() });
    await load;
    assert.deepEqual([...held().keys()], [vaultKey(WS, KEY)]);
  });

  it("leaves out a vault deleted between list and detail; keeps one whose detail failed otherwise", async () => {
    applySecretVault(WS, OTHER, vault({ repoKey: OTHER }));
    applySecretVault(WS, KEY, vault());
    const { api, lists, details } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({
      vaults: [{ workspace: WS, repoKey: KEY } as never, { workspace: WS, repoKey: OTHER } as never]
    });
    await flush();
    details[0].answer.reject(notFound());
    details[1].answer.reject(Object.assign(new Error("boom"), { status: 500 }));
    await load;
    assert.equal(getSecretVault(WS, KEY), undefined);
    assert.ok(getSecretVault(WS, OTHER));
  });

  it("rejects an answer in another shape and changes nothing", async () => {
    applySecretVault(WS, KEY, vault());
    const { api, lists } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({ nope: true } as never);
    await assert.rejects(load, /unexpected shape/);
    assert.ok(getSecretVault(WS, KEY));
  });

  it("a load's answer does not undo a mutation that landed while it was in flight", async () => {
    applySecretVault(WS, KEY, vault({ updatedAt: at(1) }));
    const { api, lists, details, mutations } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never] });
    await flush();
    const push = pushSecretFiles(api, { workspace: WS, repoKey: KEY, projectPath: "/ws/jaspersito/MatsSmile" });
    mutations[0].answer.resolve({ vault: vault({ updatedAt: at(3), fileCount: 3 }) });
    await push;
    details[0].answer.resolve({ vault: vault({ updatedAt: at(2), fileCount: 2 }) });
    await load;
    assert.equal(getSecretVault(WS, KEY)?.fileCount, 3);
  });

  it("a load's answer does not bring back a vault deleted while it was in flight", async () => {
    const { api, lists, details } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never] });
    await flush();
    applySecretFilesEvent(event({ workspace: WS, repoKey: KEY, deleted: true }));
    details[0].answer.resolve({ vault: vault() });
    await load;
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("an older load's late answer is dropped", async () => {
    const { api, lists, details } = fakeApi();
    const first = loadSecretVaults(api);
    const second = loadSecretVaults(api);
    lists[1].resolve({ vaults: [] });
    await second;
    lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never] });
    await first;
    assert.equal(details.length, 0);
    assert.equal(held().size, 0);
  });

  it("a load through another connection's client resets first, and the old answer is dropped", async () => {
    const one = fakeApi("c1");
    const two = fakeApi("c2");
    const stale = loadSecretVaults(one.api);
    applySecretVault(WS, KEY, vault());
    const fresh = loadSecretVaults(two.api);
    assert.equal(held().size, 0);
    one.lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never] });
    await stale;
    assert.equal(one.details.length, 0);
    two.lists[0].resolve({ vaults: [] });
    await fresh;
    assert.equal(held().size, 0);
  });

  it("a reset drops answers still in flight", async () => {
    const { api, lists, details } = fakeApi();
    const load = loadSecretVaults(api);
    lists[0].resolve({ vaults: [{ workspace: WS, repoKey: KEY } as never] });
    await flush();
    resetSecretFiles();
    details[0].answer.resolve({ vault: vault() });
    await load;
    assert.equal(held().size, 0);
  });

  it("fetching one vault applies it, and a 404 removes it", async () => {
    const { api, details } = fakeApi();
    const first = fetchSecretVault(api, WS, KEY);
    details[0].answer.resolve({ vault: vault() });
    assert.equal((await first)?.updatedAt, at(0));
    const second = fetchSecretVault(api, WS, KEY);
    details[1].answer.reject(notFound());
    assert.equal(await second, null);
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("a fetch's 404 does not remove a vault set up while it was in flight", async () => {
    const { api, details, mutations } = fakeApi();
    const fetching = fetchSecretVault(api, WS, KEY);
    const setup = setupSecretVault(api, { workspace: WS, repoKey: KEY, files: [], excluded: [] });
    mutations[0].answer.resolve({ vault: vault({ updatedAt: at(4) }) });
    await setup;
    details[0].answer.reject(notFound());
    assert.equal((await fetching)?.updatedAt, at(4));
  });

  it("a fetch's answer does not bring back a vault deleted while it was in flight", async () => {
    const { api, details } = fakeApi();
    const fetching = fetchSecretVault(api, WS, KEY);
    applySecretFilesEvent(event({ workspace: WS, repoKey: KEY, deleted: true }));
    details[0].answer.resolve({ vault: vault() });
    assert.equal(await fetching, null);
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("a fetch's other failure rejects", async () => {
    const { api, details } = fakeApi();
    const fetching = fetchSecretVault(api, WS, KEY);
    details[0].answer.reject(Object.assign(new Error("boom"), { status: 503 }));
    await assert.rejects(fetching, /boom/);
  });
});

describe("mutations", () => {
  it("push and reset apply the answered vault and return it", async () => {
    const { api, mutations } = fakeApi();
    const req = { workspace: WS, repoKey: KEY, projectPath: "/ws/jaspersito/MatsSmile", files: ["MatsSmileBack/.env"] };
    const push = pushSecretFiles(api, req);
    assert.deepEqual(mutations[0].args, [req]);
    mutations[0].answer.resolve({ vault: vault({ updatedAt: at(2) }) });
    assert.equal((await push).updatedAt, at(2));
    const reset = resetCloneSecretFiles(api, req);
    assert.equal(mutations[1].name, "reset");
    mutations[1].answer.resolve({ vault: vault({ updatedAt: at(3) }) });
    await reset;
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(3));
  });

  it("setup and update apply their answers; delete removes", async () => {
    const { api, mutations } = fakeApi();
    const setup = setupSecretVault(api, {
      workspace: WS,
      repoKey: KEY,
      files: [{ path: "MatsSmileBack/.env", source: { projectPath: "/ws/jaspersito/MatsSmile" } }],
      excluded: [".env.local"]
    });
    mutations[0].answer.resolve({ vault: vault() });
    await setup;
    const update = updateSecretFiles(api, { workspace: WS, repoKey: KEY, exclude: ["MatsSmileBack/.env"] });
    mutations[1].answer.resolve({ vault: vault({ updatedAt: at(1), files: [], excluded: ["MatsSmileBack/.env"] }) });
    await update;
    assert.deepEqual(getSecretVault(WS, KEY)?.excluded, ["MatsSmileBack/.env"]);
    const removal = deleteSecretVault(api, WS, KEY);
    assert.deepEqual(mutations[2].args, [WS, KEY]);
    mutations[2].answer.resolve(undefined);
    await removal;
    assert.equal(getSecretVault(WS, KEY), undefined);
  });

  it("rejects with the daemon's error and changes nothing", async () => {
    applySecretVault(WS, KEY, vault());
    const { api, mutations } = fakeApi();
    const push = pushSecretFiles(api, { workspace: WS, repoKey: KEY, projectPath: "/p" });
    const failure = Object.assign(new Error("nothing"), { status: 409, body: { code: "NOTHING_TO_PUSH" } });
    mutations[0].answer.reject(failure);
    await assert.rejects(push, (error) => error === failure);
    assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0));
  });

  it("an answer that does not parse reloads, and resolves with what is held", async () => {
    applySecretVault(WS, KEY, vault());
    const { api, mutations, lists } = fakeApi();
    const push = pushSecretFiles(api, { workspace: WS, repoKey: KEY, projectPath: "/p" });
    mutations[0].answer.resolve({ vault: { ...vault({ updatedAt: at(9) }), repoKey: OTHER } });
    assert.equal((await push).updatedAt, at(0));
    assert.equal(lists.length, 1);
    const orphan = setupSecretVault(api, { workspace: WS, repoKey: OTHER, files: [], excluded: [] });
    mutations[1].answer.resolve({ junk: true });
    await assert.rejects(orphan, /unexpected shape/);
  });

  it("an answer that a connection switch overtook is not applied", async () => {
    const { api, mutations } = fakeApi();
    const push = pushSecretFiles(api, { workspace: WS, repoKey: KEY, projectPath: "/p" });
    resetSecretFiles();
    mutations[0].answer.resolve({ vault: vault() });
    await push;
    assert.equal(held().size, 0);
  });

  it("the scan is validated before it is returned", async () => {
    const { api, mutations } = fakeApi();
    const scan = scanSecretFileCandidates(api, WS, KEY, "deploy/targets.conf");
    assert.deepEqual(mutations[0].args.slice(0, 3), [WS, KEY, "deploy/targets.conf"]);
    const answer: SecretFileCandidatesResponse = { workspace: WS, repoKey: KEY, clones: [], candidates: [] };
    mutations[0].answer.resolve({ ...answer, candidates: [{ path: "/abs" }] });
    assert.deepEqual(await scan, answer);
  });
});
