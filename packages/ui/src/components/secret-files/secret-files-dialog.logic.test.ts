import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SecretFileCandidate, SecretFilesClone, SecretVaultDetail } from "@orquester/api";

import {
  buildAddRequest,
  buildSetupRequest,
  canCompare,
  canMerge,
  canPush,
  canReset,
  cloneName,
  defaultMergePrimary,
  defaultSourceChoice,
  defaultTicked,
  isTicked,
  keyTable,
  listText,
  mergeCandidate,
  mergePrimaryOptions,
  needsSourceChoice,
  newestVariant,
  pushImpact,
  pushableFiles,
  resettableFiles,
  secretFilesErrorText,
  sourceFor,
  stateLabel,
  stateTone,
  variantSizeText
} from "./secret-files-dialog.logic.ts";

const WS = "jaspersito";
const KEY = "github.com/jasperraccoon/matssmile";
const A = "/ws/jaspersito/MatsSmile";
const B = "/ws/jaspersito/MatsSmile2";
const C = "/ws/jaspersito/MatsSmile3";

function candidate(overrides: Partial<SecretFileCandidate> = {}): SecretFileCandidate {
  return {
    path: "MatsSmileBack/.env",
    conventional: true,
    managed: false,
    excluded: false,
    format: "env",
    variants: [
      { variantId: "old", projectPaths: [B, C], modifiedAt: "2026-10-01T10:00:00.000Z", keyCount: 3 },
      { variantId: "new", projectPaths: [A], modifiedAt: "2026-10-18T10:00:00.000Z", keyCount: 2 }
    ],
    defaultVariantId: "new",
    keys: [
      { key: "DATABASE_URL", byVariant: { old: 4, new: 4 } },
      { key: "API_KEY", byVariant: { old: 7, new: 2 } },
      { key: "PRIVATEPROXY_API_KEY", byVariant: { old: 1, new: null } }
    ],
    refused: [],
    ...overrides
  };
}

const single = (overrides: Partial<SecretFileCandidate> = {}) =>
  candidate({
    path: "MatsSmileFront/.env",
    variants: [{ variantId: "only", projectPaths: [B, A], modifiedAt: "2026-10-02T10:00:00.000Z", keyCount: 1 }],
    defaultVariantId: "only",
    keys: [{ key: "X", byVariant: { only: 0 } }],
    ...overrides
  });

describe("sources", () => {
  it("pre-selects the daemon's newest copy, else the latest modifiedAt", () => {
    assert.equal(newestVariant(candidate())?.variantId, "new");
    assert.equal(newestVariant(candidate({ defaultVariantId: null }))?.variantId, "new");
    assert.equal(newestVariant(candidate({ defaultVariantId: "gone" }))?.variantId, "new");
    assert.deepEqual(defaultSourceChoice(candidate()), { kind: "variant", variantId: "new" });
    assert.equal(newestVariant(candidate({ variants: [] })), null);
    assert.equal(defaultSourceChoice(candidate({ variants: [] })), null);
  });

  it("asks for a source only when copies differ; merges only env files", () => {
    assert.equal(needsSourceChoice(candidate()), true);
    assert.equal(needsSourceChoice(single()), false);
    assert.equal(canMerge(candidate()), true);
    assert.equal(canMerge(candidate({ format: "lines" })), false);
    assert.equal(canMerge(single()), false);
  });

  it("merge's primary defaults to the newest copy's first clone, and may be any holder", () => {
    assert.equal(defaultMergePrimary(candidate()), A);
    assert.deepEqual(mergePrimaryOptions(candidate()), [B, C, A]);
  });

  it("maps a choice to the wire source", () => {
    assert.deepEqual(sourceFor(candidate(), null), { projectPath: A });
    assert.deepEqual(sourceFor(candidate(), { kind: "variant", variantId: "old" }), { projectPath: B });
    assert.deepEqual(sourceFor(candidate(), { kind: "merge", primary: C }), { merge: true, primary: C });
    assert.equal(sourceFor(candidate(), { kind: "variant", variantId: "nope" }), null);
    assert.equal(sourceFor(candidate(), { kind: "merge", primary: "/elsewhere" }), null);
    assert.equal(sourceFor(candidate({ format: "lines" }), { kind: "merge", primary: A }), null);
    assert.equal(sourceFor(candidate({ variants: [] }), null), null);
  });

  it("a single copy always comes from its first clone, whatever was chosen", () => {
    assert.deepEqual(sourceFor(single(), null), { projectPath: B });
    assert.deepEqual(sourceFor(single(), { kind: "merge", primary: A }), { projectPath: B });
  });
});

describe("setup selection", () => {
  it("ticks conventional candidates by default; excluded, hand-added and unusable ones start unticked", () => {
    assert.equal(defaultTicked(candidate()), true);
    assert.equal(defaultTicked(candidate({ excluded: true })), false);
    assert.equal(defaultTicked(candidate({ conventional: false })), false);
    assert.equal(defaultTicked(candidate({ variants: [] })), false);
    const none = { ticked: {}, sources: {} };
    assert.equal(isTicked(candidate(), none), true);
    assert.equal(isTicked(candidate(), { ticked: { "MatsSmileBack/.env": false }, sources: {} }), false);
    assert.equal(isTicked(candidate({ excluded: true }), { ticked: { "MatsSmileBack/.env": true }, sources: {} }), true);
    assert.equal(isTicked(candidate({ variants: [] }), { ticked: { "MatsSmileBack/.env": true }, sources: {} }), false);
  });

  it("sends ticked files with their sources and excludes unticked conventional ones", () => {
    const local = candidate({ path: "MatsSmileBack/.env.local", variants: single().variants, defaultVariantId: "only" });
    const added = single({ path: "deploy/targets.conf", conventional: false, format: "lines", keys: undefined });
    const plan = buildSetupRequest(WS, KEY, [candidate(), single(), local, added], {
      ticked: { "MatsSmileBack/.env.local": false, "deploy/targets.conf": true },
      sources: { "MatsSmileBack/.env": { kind: "merge", primary: B } }
    });
    assert.deepEqual(plan, {
      ok: true,
      request: {
        workspace: WS,
        repoKey: KEY,
        files: [
          { path: "MatsSmileBack/.env", source: { merge: true, primary: B } },
          { path: "MatsSmileFront/.env", source: { projectPath: B } },
          { path: "deploy/targets.conf", source: { projectPath: B } }
        ],
        excluded: ["MatsSmileBack/.env.local"]
      }
    });
  });

  it("an unticked hand-added file is simply not sent; an excluded one stays excluded", () => {
    const added = single({ path: "deploy/targets.conf", conventional: false });
    const plan = buildSetupRequest(WS, KEY, [single(), added, candidate({ excluded: true })], { ticked: {}, sources: {} });
    assert.ok(plan.ok);
    assert.deepEqual(plan.request.files.map((file) => file.path), ["MatsSmileFront/.env"]);
    assert.deepEqual(plan.request.excluded, ["MatsSmileBack/.env"]);
  });

  it("does not exclude a conventional candidate nobody could tick (no clone holds a usable copy)", () => {
    const unusable = candidate({ path: "api/.env", variants: [], defaultVariantId: null, refused: [{ projectPath: A, refusal: "tracked" }] });
    const managed = candidate({ path: "web/.env", managed: true, variants: single().variants, defaultVariantId: "only" });
    const plan = buildSetupRequest(WS, KEY, [single(), unusable, managed], {
      ticked: { "web/.env": false },
      sources: {}
    });
    assert.ok(plan.ok);
    assert.deepEqual(plan.request.files.map((file) => file.path), ["MatsSmileFront/.env"]);
    assert.deepEqual(plan.request.excluded, []);
  });

  it("refuses an empty selection, an invalid source and too many files", () => {
    assert.deepEqual(buildSetupRequest(WS, KEY, [candidate()], { ticked: { "MatsSmileBack/.env": false }, sources: {} }), {
      ok: false,
      problem: "Select at least one file to keep in the vault."
    });
    const bad = buildSetupRequest(WS, KEY, [candidate()], {
      ticked: {},
      sources: { "MatsSmileBack/.env": { kind: "variant", variantId: "nope" } }
    });
    assert.equal(bad.ok, false);
    const many = Array.from({ length: 51 }, (_, i) => single({ path: `f${i}/.env` }));
    const tooMany = buildSetupRequest(WS, KEY, many, { ticked: {}, sources: {} });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.ok ? "" : tooMany.problem, /at most 50/);
  });

  it("builds an add request, refusing a candidate no clone holds", () => {
    assert.deepEqual(buildAddRequest(WS, KEY, candidate(), { kind: "variant", variantId: "old" }), {
      ok: true,
      request: { workspace: WS, repoKey: KEY, add: [{ path: "MatsSmileBack/.env", source: { projectPath: B } }] }
    });
    const none = buildAddRequest(WS, KEY, candidate({ variants: [] }), null);
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.problem, /No clone has a usable/);
  });

  it("a hand-typed path's scan replaces the same path or is appended", () => {
    const list = [candidate(), single()];
    const replaced = mergeCandidate(list, single({ conventional: false }));
    assert.equal(replaced.length, 2);
    assert.equal(replaced[1].conventional, false);
    assert.equal(mergeCandidate(list, single({ path: "x.conf" })).length, 3);
  });
});

describe("variable table", () => {
  it("relabels value classes A, B… per row in copy order and marks disagreement", () => {
    assert.deepEqual(keyTable(candidate()), [
      {
        key: "DATABASE_URL",
        cells: [
          { variantId: "old", present: true, letter: "A" },
          { variantId: "new", present: true, letter: "A" }
        ],
        agree: true
      },
      {
        key: "API_KEY",
        cells: [
          { variantId: "old", present: true, letter: "A" },
          { variantId: "new", present: true, letter: "B" }
        ],
        agree: false
      },
      {
        key: "PRIVATEPROXY_API_KEY",
        cells: [
          { variantId: "old", present: true, letter: "A" },
          { variantId: "new", present: false, letter: null }
        ],
        agree: false
      }
    ]);
  });

  it("has no rows for a file without keys", () => {
    assert.deepEqual(keyTable(candidate({ format: "lines", keys: undefined })), []);
  });

  it("describes each copy's size", () => {
    const env = candidate();
    assert.equal(variantSizeText(env, env.variants[0]), "3 variables");
    const lines = candidate({ format: "lines" });
    assert.equal(variantSizeText(lines, { ...lines.variants[0], lineCount: 1 }), "1 line");
    assert.equal(variantSizeText(lines, lines.variants[0]), "");
  });
});

describe("states", () => {
  it("labels every state in words", () => {
    assert.equal(stateLabel("synced"), "Synced");
    assert.equal(stateLabel("missing"), "Missing, copying");
    assert.equal(stateLabel("missing-dir"), "Missing folder");
    assert.equal(stateLabel("outdated"), "Out of date");
    assert.equal(stateLabel("modified"), "Changed");
    assert.equal(stateLabel("deleted"), "Deleted");
    assert.equal(stateLabel("refused", "tracked"), "Not synced: tracked by git");
    assert.equal(stateLabel("refused", "symlink"), "Not synced: symlink");
    assert.equal(stateLabel("refused", "outside"), "Not synced: outside the project");
    assert.equal(stateLabel("refused", "too-large"), "Not synced: too large");
    assert.equal(stateLabel("refused", "unreadable"), "Not synced: unreadable");
    assert.equal(stateLabel("refused"), "Not synced: can't be synced");
  });

  it("tones: synced ok, attention states flagged, the rest pending", () => {
    assert.equal(stateTone("synced"), "ok");
    assert.equal(stateTone("modified"), "attention");
    assert.equal(stateTone("refused"), "attention");
    assert.equal(stateTone("missing"), "pending");
    assert.equal(stateTone("outdated"), "pending");
  });
});

describe("clone actions", () => {
  const clone = (projectPath: string, states: Record<string, SecretFilesClone["files"][number]["state"]>): SecretFilesClone => ({
    projectPath,
    projectName: projectPath.split("/").pop()!,
    files: Object.entries(states).map(([path, state]) => ({ path, state })),
    needsAttention: false
  });

  it("push needs a changed file; reset and compare a changed or deleted one", () => {
    const changed = clone(A, { ".env": "modified", "b/.env": "deleted", "c/.env": "synced" });
    assert.deepEqual(pushableFiles(changed), [".env"]);
    assert.deepEqual(resettableFiles(changed), [".env", "b/.env"]);
    assert.equal(canPush(changed), true);
    const deletedOnly = clone(A, { ".env": "deleted" });
    assert.equal(canPush(deletedOnly), false);
    assert.equal(canReset(deletedOnly), true);
    assert.equal(canCompare(deletedOnly), true);
    const fine = clone(A, { ".env": "synced", "b/.env": "outdated", "c/.env": "missing-dir" });
    assert.equal(canPush(fine), false);
    assert.equal(canReset(fine), false);
    assert.equal(canCompare(fine), false);
  });

  it("a push overwrites in-sync clones and leaves changed ones flagged", () => {
    const source = clone(A, { ".env": "modified", "other/.env": "synced" });
    const vault = {
      clones: [
        source,
        clone(B, { ".env": "synced" }),
        clone(C, { ".env": "modified" }),
        clone("/ws/jaspersito/MatsSmile4", { ".env": "outdated" }),
        clone("/ws/jaspersito/MatsSmile5", { "other/.env": "synced", ".env": "missing-dir" })
      ]
    } as SecretVaultDetail;
    const impact = pushImpact(vault, source);
    assert.deepEqual(impact.overwritten.map((entry) => entry.projectName), ["MatsSmile2", "MatsSmile4"]);
    assert.deepEqual(impact.keptFlagged.map((entry) => entry.projectName), ["MatsSmile3"]);
  });

  it("judges a push per file: a clone missing a file receives it, a mixed one is in both lists", () => {
    const source = clone(A, { ".env": "modified", "b/.env": "modified" });
    const vault = {
      clones: [
        source,
        clone(B, { ".env": "modified", "b/.env": "synced" }),
        clone(C, { ".env": "missing", "b/.env": "missing-dir" }),
        clone("/ws/jaspersito/MatsSmile4", { ".env": "deleted" })
      ]
    } as SecretVaultDetail;
    const impact = pushImpact(vault, source);
    assert.deepEqual(impact.overwritten.map((entry) => entry.projectName), ["MatsSmile2", "MatsSmile3"]);
    assert.deepEqual(impact.keptFlagged.map((entry) => entry.projectName), ["MatsSmile2"]);
    // Only the files actually pushed count.
    const onlyFirst = pushImpact(vault, source, [".env"]);
    assert.deepEqual(onlyFirst.overwritten.map((entry) => entry.projectName), ["MatsSmile3"]);
    assert.deepEqual(onlyFirst.keptFlagged.map((entry) => entry.projectName), ["MatsSmile2"]);
  });
});

describe("words", () => {
  it("shows the daemon's message first, then the code's text, then the status", () => {
    assert.equal(secretFilesErrorText({ serverMessage: "Nope.", body: { code: "NOTHING_TO_PUSH" } }), "Nope.");
    assert.match(secretFilesErrorText({ serverMessage: null, body: { code: "NOTHING_TO_PUSH" }, status: 409 }), /Nothing/);
    assert.match(secretFilesErrorText({ status: 404 }), /doesn't support/);
    assert.equal(secretFilesErrorText({ status: 500, body: { code: "ELSE" } }), "The daemon refused the request (500).");
    assert.equal(secretFilesErrorText(new Error("plain")), "plain");
    assert.equal(secretFilesErrorText(undefined), "Something went wrong.");
  });

  it("a CONTENT_CHANGED refusal always asks to review again", () => {
    const text = "This file changed since you looked — review it again.";
    assert.equal(secretFilesErrorText({ serverMessage: "content mismatch", status: 409, body: { code: "CONTENT_CHANGED" } }), text);
    assert.equal(secretFilesErrorText({ status: 409, body: { code: "CONTENT_CHANGED" } }), text);
  });

  it("names clones and lists", () => {
    assert.equal(cloneName([{ projectPath: A, projectName: "Mats" }], A), "Mats");
    assert.equal(cloneName([], B), "MatsSmile2");
    assert.equal(listText([]), "");
    assert.equal(listText(["a"]), "a");
    assert.equal(listText(["a", "b", "c"]), "a, b and c");
  });
});
