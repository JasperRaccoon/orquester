import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { RepoIcon, RepoIdentitiesResponse, RepoIdentity } from "@orquester/api";

import { ensureRepoIconImage, getRepoIconImage } from "./icon-images.ts";
import { applyRepoIdentityEvent, loadRepoIdentities, resetRepoIdentities, type RepoIdentitiesApi } from "./store.ts";

const KEY = "github.com/jasperraccoon/jasperengine";

const imageIcon = (version: string, contentType: "image/png" | "image/svg+xml" = "image/png"): RepoIcon => ({
  kind: "image",
  contentType,
  version
});

const identity = (icon: RepoIcon, minute: number): RepoIdentity => ({
  repoKey: KEY,
  icon,
  updatedAt: `2026-10-18T10:${String(minute).padStart(2, "0")}:00.000Z`
});

const set = (icon: RepoIcon, minute: number) =>
  applyRepoIdentityEvent({ type: "repoIdentity.changed", payload: { identity: identity(icon, minute) } });

interface Read {
  version: string;
  signal: AbortSignal | undefined;
  resolve: (bytes: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

function fakeReader() {
  const reads: Read[] = [];
  const api = {
    readRepoIcon(_repoKey: string, version: string, signal?: AbortSignal) {
      return new Promise<ArrayBuffer>((resolve, reject) => reads.push({ version, signal, resolve, reject }));
    }
  };
  return { api, reads };
}

const created: string[] = [];
const revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const blobs = new Map<string, Blob>();

beforeEach(() => {
  resetRepoIdentities();
  created.length = 0;
  revoked.length = 0;
  blobs.clear();
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test/${created.length}`;
    created.push(url);
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("the icon image cache", () => {
  it("fetches once per version and shares one typed blob URL", async () => {
    const { api, reads } = fakeReader();
    const icon = imageIcon("v1", "image/svg+xml");
    set(icon, 1);
    const fetched = ensureRepoIconImage(api, KEY, icon);
    await ensureRepoIconImage(api, KEY, icon);
    assert.equal(reads.length, 1);
    assert.equal(getRepoIconImage(KEY)?.status, "loading");
    reads[0].resolve(new ArrayBuffer(4));
    await fetched;
    const image = getRepoIconImage(KEY);
    assert.equal(image?.status, "ready");
    assert.equal(image?.url, "blob:test/0");
    assert.equal(blobs.get("blob:test/0")?.type, "image/svg+xml");
    ensureRepoIconImage(api, KEY, icon);
    assert.equal(reads.length, 1);
  });

  it("revokes the URL when the version changes or the identity goes away", async () => {
    const { api, reads } = fakeReader();
    set(imageIcon("v1"), 1);
    const first = ensureRepoIconImage(api, KEY, imageIcon("v1"));
    reads[0].resolve(new ArrayBuffer(1));
    await first;
    set(imageIcon("v2"), 2);
    assert.deepEqual(revoked, ["blob:test/0"]);
    assert.equal(getRepoIconImage(KEY), undefined);
    const second = ensureRepoIconImage(api, KEY, imageIcon("v2"));
    reads[1].resolve(new ArrayBuffer(1));
    await second;
    applyRepoIdentityEvent({ type: "repoIdentity.changed", payload: { repoKey: KEY, deleted: true } });
    assert.deepEqual(revoked, ["blob:test/0", "blob:test/1"]);
  });

  it("aborts a fetch overtaken by a new version and never publishes it", async () => {
    const { api, reads } = fakeReader();
    set(imageIcon("v1"), 1);
    const overtaken = ensureRepoIconImage(api, KEY, imageIcon("v1"));
    set(imageIcon("v2"), 2);
    assert.equal(reads[0].signal?.aborted, true);
    reads[0].resolve(new ArrayBuffer(1));
    await overtaken;
    assert.equal(created.length, 0);
  });

  it("does not fetch a version that is not the repo's current icon", () => {
    const { api, reads } = fakeReader();
    set(imageIcon("v2"), 2);
    ensureRepoIconImage(api, KEY, imageIcon("v1"));
    ensureRepoIconImage(api, KEY, { kind: "emoji", value: "🦝" });
    assert.equal(reads.length, 0);
  });

  it("remembers a failure per version, and retries after the next load", async () => {
    const { api, reads } = fakeReader();
    set(imageIcon("v1"), 1);
    const failing = ensureRepoIconImage(api, KEY, imageIcon("v1"));
    reads[0].reject(new Error("offline"));
    await failing;
    assert.equal(getRepoIconImage(KEY)?.status, "failed");
    ensureRepoIconImage(api, KEY, imageIcon("v1"));
    assert.equal(reads.length, 1);

    let answer!: (value: RepoIdentitiesResponse) => void;
    const loader = {
      listRepoIdentities: () => new Promise<RepoIdentitiesResponse>((resolve) => (answer = resolve))
    } as unknown as RepoIdentitiesApi;
    const load = loadRepoIdentities(loader);
    answer({ identities: [identity(imageIcon("v1"), 1)] });
    await load;
    assert.equal(getRepoIconImage(KEY), undefined);
    ensureRepoIconImage(api, KEY, imageIcon("v1"));
    assert.equal(reads.length, 2);
  });

  it("a connection reset revokes everything", async () => {
    const { api, reads } = fakeReader();
    set(imageIcon("v1"), 1);
    const first = ensureRepoIconImage(api, KEY, imageIcon("v1"));
    reads[0].resolve(new ArrayBuffer(1));
    await first;
    resetRepoIdentities();
    assert.deepEqual(revoked, ["blob:test/0"]);
    assert.equal(getRepoIconImage(KEY), undefined);
  });
});
