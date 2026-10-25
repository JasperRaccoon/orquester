/**
 * Where secret-file drift shows (spec §7), as pure rules: the project-row
 * badge, the repo-header count, the project bar's model, message, confirms and
 * dismissal key, and the compare summaries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SecretFileCloneState, SecretFilesClone, SecretVaultDetail } from "@orquester/api";

import {
  addBarDismissal,
  compareSummaryText,
  compareTargets,
  countKeyChanges,
  differingKeys,
  expectedContent,
  findBarDismissal,
  parseBarDismissals,
  projectBarDismissal,
  projectBarMessage,
  projectBarModel,
  projectSecretBadge,
  pushConfirmText,
  repoSecretCount,
  resetConfirmText,
  type BarDismissal
} from "./drift.logic";

const file = (path: string, state: SecretFileCloneState["state"], extra: Partial<SecretFileCloneState> = {}) => ({
  path,
  state,
  ...extra
});

const clone = (projectName: string, files: SecretFileCloneState[]): SecretFilesClone => ({
  projectPath: `/w/ws/${projectName}`,
  projectName,
  files,
  needsAttention: files.some((f) => ["modified", "deleted", "missing-dir", "refused"].includes(f.state))
});

const vault = (clones: SecretFilesClone[], versions: Record<string, string> = {}): SecretVaultDetail => ({
  workspace: "ws",
  repoKey: "github.com/o/r",
  fileCount: Object.keys(versions).length,
  clonesNeedingAttention: clones.filter((c) => c.needsAttention).length,
  newCandidates: 0,
  updatedAt: "2026-10-19T00:00:00Z",
  files: Object.entries(versions).map(([path, version]) => ({
    path,
    version,
    updatedAt: "2026-10-19T00:00:00Z",
    updatedBy: { kind: "user" }
  })),
  excluded: [],
  candidates: [],
  clones
});

describe("projectSecretBadge", () => {
  const flagged = clone("A", [file(".env", "synced"), file("api/.env", "modified"), file("deploy/targets.conf", "refused", { refusal: "symlink" })]);

  it("is hidden while the plugin is off or the project is in no vault", () => {
    assert.equal(projectSecretBadge(false, flagged), null);
    assert.equal(projectSecretBadge(true, undefined), null);
  });

  it("is hidden while every file is synced or being synced", () => {
    assert.equal(projectSecretBadge(true, clone("A", [file(".env", "synced"), file("b/.env", "outdated"), file("c/.env", "missing")])), null);
    assert.equal(projectSecretBadge(true, clone("A", [])), null);
  });

  it("names each file needing attention with its state", () => {
    assert.deepEqual(projectSecretBadge(true, flagged), {
      title: [
        "Secret files need attention:",
        "api/.env — changed here",
        "deploy/targets.conf — can't be synced here: it or a folder above it is a symlink"
      ].join("\n")
    });
    assert.deepEqual(projectSecretBadge(true, clone("A", [file(".env", "deleted")])), {
      title: "A secret file needs attention:\n.env — deleted here"
    });
  });
});

describe("repoSecretCount", () => {
  it("is null while the plugin is off, without a vault, or with nothing to look at", () => {
    assert.equal(repoSecretCount(false, { clonesNeedingAttention: 2, newCandidates: 1 }), null);
    assert.equal(repoSecretCount(true, undefined), null);
    assert.equal(repoSecretCount(true, { clonesNeedingAttention: 0, newCandidates: 0 }), null);
  });

  it("adds clones needing attention and new candidates, and explains both", () => {
    assert.deepEqual(repoSecretCount(true, { clonesNeedingAttention: 2, newCandidates: 0 }), {
      count: 2,
      title: '2 clones have secret files that need attention. Open "Secret files…" to review.'
    });
    assert.deepEqual(repoSecretCount(true, { clonesNeedingAttention: 0, newCandidates: 1 }), {
      count: 1,
      title: '1 new secret file was found and can be added. Open "Secret files…" to review.'
    });
    const both = repoSecretCount(true, { clonesNeedingAttention: 1, newCandidates: 3 });
    assert.equal(both?.count, 4);
    assert.equal(
      both?.title,
      '1 clone has secret files that need attention; 3 new secret files were found and can be added. Open "Secret files…" to review.'
    );
  });
});

describe("compare summaries", () => {
  const keys = [
    { key: "A", change: "added" as const },
    { key: "B", change: "same" as const },
    { key: "C", change: "changed" as const },
    { key: "D", change: "changed" as const },
    { key: "E", change: "removed" as const },
    { key: "F", change: "same" as const }
  ];

  it("counts key changes and keeps only the differing names, in order", () => {
    assert.deepEqual(countKeyChanges(keys), { added: 1, removed: 1, changed: 2, same: 2 });
    assert.deepEqual(
      differingKeys(keys).map((k) => k.key),
      ["A", "C", "D", "E"]
    );
  });

  it("summarizes env, line and missing compares", () => {
    assert.equal(compareSummaryText({ format: "env", keys }), "1 added, 1 removed, 2 changed");
    assert.equal(compareSummaryText({ format: "env", keys: [{ key: "X", change: "changed" }] }), "1 changed");
    assert.equal(compareSummaryText({ format: "env", keys: [{ key: "X", change: "same" }] }), null);
    assert.equal(compareSummaryText({ format: "lines", linesAdded: 3, linesRemoved: 1 }), "3 lines added, 1 removed");
    assert.equal(compareSummaryText({ format: "lines", linesAdded: 1, linesRemoved: 0 }), "1 line added, 0 removed");
    assert.equal(compareSummaryText({ format: "lines", linesAdded: 0, linesRemoved: 0 }), null);
    assert.equal(compareSummaryText({ format: "missing", side: "left" }), "missing in this clone");
    assert.equal(compareSummaryText({ format: "missing", side: "right" }), "missing in the vault");
  });

  it("compares the given path, else every file of the clone that isn't synced", () => {
    const c = clone("A", [file(".env", "synced"), file("a/.env", "modified"), file("b/.env", "outdated")]);
    assert.deepEqual(compareTargets(c, ".env"), [".env"]);
    assert.deepEqual(compareTargets(c, undefined), ["a/.env", "b/.env"]);
    assert.deepEqual(compareTargets(undefined, undefined), []);
  });
});

describe("projectBarModel and projectBarMessage", () => {
  it("has no bar for a project in no vault or with nothing flagged", () => {
    assert.equal(projectBarModel(undefined), null);
    assert.equal(projectBarModel(clone("A", [file(".env", "synced"), file("b/.env", "outdated")])), null);
  });

  it("shows one modified file with its compare summary once loaded", () => {
    const model = projectBarModel(clone("A", [file(".env", "synced"), file("MatsSmileBack/.env", "modified")]));
    assert.deepEqual(model, {
      kind: "drift",
      files: [file("MatsSmileBack/.env", "modified")],
      pushPaths: ["MatsSmileBack/.env"],
      resetPaths: ["MatsSmileBack/.env"],
      comparePath: "MatsSmileBack/.env"
    });
    assert.deepEqual(projectBarMessage(model!), { path: "MatsSmileBack/.env", text: " differs from the vault" });
    assert.deepEqual(projectBarMessage(model!, "1 added, 2 changed"), {
      path: "MatsSmileBack/.env",
      text: " differs from the vault: 1 added, 2 changed"
    });
  });

  it("never pushes a deletion, and says the file was deleted", () => {
    const model = projectBarModel(clone("A", [file(".env", "deleted")]));
    assert.equal(model?.kind, "drift");
    if (model?.kind !== "drift") return;
    assert.deepEqual(model.pushPaths, []);
    assert.deepEqual(model.resetPaths, [".env"]);
    assert.equal(model.comparePath, null);
    assert.deepEqual(projectBarMessage(model), { path: ".env", text: " was deleted in this project; the vault still has it" });
  });

  it("counts several drifted files and skips the compare", () => {
    const model = projectBarModel(
      clone("A", [file("a/.env", "modified"), file("b/.env", "deleted"), file("c/.env", "modified"), file("d/.env", "refused")])
    );
    assert.equal(model?.kind, "drift");
    if (model?.kind !== "drift") return;
    assert.deepEqual(model.pushPaths, ["a/.env", "c/.env"]);
    assert.deepEqual(model.resetPaths, ["a/.env", "b/.env", "c/.env"]);
    assert.equal(model.comparePath, null);
    assert.deepEqual(projectBarMessage(model, "ignored"), { path: null, text: "3 secret files differ from the vault" });
  });

  it("falls back to an informational bar for missing-dir and refused files", () => {
    const one = projectBarModel(clone("A", [file("api/.env", "missing-dir")]));
    assert.deepEqual(one, { kind: "info", files: [file("api/.env", "missing-dir")] });
    assert.deepEqual(projectBarMessage(one!), {
      path: "api/.env",
      text: " can't be copied here: its folder doesn't exist in this project"
    });
    const refused = projectBarModel(clone("A", [file(".env", "refused", { refusal: "tracked" })]));
    assert.deepEqual(projectBarMessage(refused!), { path: ".env", text: " can't be synced here: git tracks it here" });
    const several = projectBarModel(clone("A", [file("a/.env", "refused"), file("b/.env", "missing-dir")]));
    assert.deepEqual(projectBarMessage(several!), { path: null, text: "2 secret files can't be synced to this project" });
  });
});

describe("push and reset confirms", () => {
  const me = clone("Mine", [file(".env", "modified")]);
  const v = vault([
    me,
    clone("Synced", [file(".env", "synced")]),
    clone("Behind", [file(".env", "outdated")]),
    clone("Fresh", [file(".env", "missing")]),
    clone("Diverged", [file(".env", "modified")]),
    clone("NoDir", [file(".env", "missing-dir")])
  ]);

  it("names the clones the push overwrites and the ones that stay flagged", () => {
    assert.equal(
      pushConfirmText(v, me.projectPath, [".env"]),
      "This makes this project's .env the vault's version. It overwrites the copy in Synced, Behind, Fresh. Diverged has its own changes and stays flagged."
    );
  });

  it("says when no other clone is overwritten", () => {
    const alone = vault([me, clone("Other1", [file(".env", "modified")]), clone("Other2", [file(".env", "modified")])]);
    assert.equal(
      pushConfirmText(alone, me.projectPath, [".env", "b/.env"]),
      "This makes this project's 2 changed secret files the vault's version. No other clone is overwritten. Other1, Other2 have their own changes and stay flagged."
    );
  });

  it("judges each pushed file on its own: a clone with mixed states is named in both, a missing copy receives it", () => {
    const mine = clone("Mine", [file(".env", "modified"), file("b/.env", "modified")]);
    const mixed = vault([
      mine,
      clone("Mixed", [file(".env", "modified"), file("b/.env", "synced")]),
      clone("Missing", [file(".env", "missing"), file("b/.env", "missing-dir")]),
      clone("Gone", [file(".env", "deleted")])
    ]);
    assert.equal(
      pushConfirmText(mixed, mine.projectPath, [".env", "b/.env"]),
      "This makes this project's 2 changed secret files the vault's version. It overwrites the copy in Mixed, Missing. Mixed has its own changes and stays flagged."
    );
    assert.equal(
      pushConfirmText(mixed, mine.projectPath, ["b/.env"]),
      "This makes this project's b/.env the vault's version. It overwrites the copy in Mixed."
    );
  });

  it("expects the content tokens shown, null for a copy the clone doesn't have", () => {
    const files = [
      file(".env", "modified", { contentToken: "t1" }),
      file("b/.env", "deleted"),
      file("c/.env", "modified"),
      file("d/.env", "synced", { contentToken: "t4" })
    ];
    assert.deepEqual(expectedContent(files, [".env", "b/.env", "c/.env"]), { ".env": "t1", "b/.env": null });
    assert.deepEqual(expectedContent(files, ["c/.env", "nope"]), undefined);
  });

  it("warns that a reset discards this project's changes", () => {
    assert.equal(
      resetConfirmText([".env"]),
      "This replaces .env in this project with the vault's version. This project's changes to it are discarded."
    );
    assert.equal(
      resetConfirmText([".env", "b/.env"]),
      "This replaces 2 secret files in this project with the vault's version. This project's changes to them are discarded."
    );
  });
});

describe("bar dismissal", () => {
  const v = vault([], { ".env": "v1", "b/.env": "v7" });

  const at = (boot: string) => ({ ...v, revision: { boot, seq: 1 } });
  const dismissed = (stored: BarDismissal, current: BarDismissal) => findBarDismissal([stored], current) !== undefined;

  it("covers the project, each flagged file's path and state, and the vault version", () => {
    const stored = projectBarDismissal("/w/ws/A", [file(".env", "modified")], v);
    assert.ok(dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified")], v)));
    assert.ok(!dismissed(stored, projectBarDismissal("/w/ws/B", [file(".env", "modified")], v)));
    assert.ok(!dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "deleted")], v)));
    assert.ok(!dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified")], vault([], { ".env": "v2" }))));
    assert.ok(
      !dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified"), file("b/.env", "modified")], v))
    );
  });

  it("covers each flagged file's content token within one daemon boot: a further edit brings the bar back", () => {
    const stored = projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t1" })], at("b1"));
    assert.ok(dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t1" })], at("b1"))));
    assert.ok(!dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t2" })], at("b1"))));
    // Without revisions (an older daemon) the tokens still count.
    const plain = projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t1" })], v);
    assert.equal(plain.boot, null);
    assert.ok(!dismissed(plain, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t2" })], v)));
  });

  it("survives a daemon restart: under another boot the (re-keyed) tokens are not compared", () => {
    const stored = projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "t1" })], at("b1"));
    const afterRestart = projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "x9" })], at("b2"));
    assert.ok(dismissed(stored, afterRestart));
    // Everything else still counts across the restart.
    assert.ok(!dismissed(stored, projectBarDismissal("/w/ws/A", [file(".env", "deleted")], at("b2"))));
    assert.ok(
      !dismissed(
        stored,
        projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "x9" })], { ...at("b2"), files: vault([], { ".env": "v2" }).files })
      )
    );
    // Stamped again under the new boot (what the bar does), a further edit brings it back.
    const restamped = addBarDismissal([stored], afterRestart);
    assert.deepEqual(restamped, [afterRestart]);
    assert.equal(
      findBarDismissal(restamped, projectBarDismissal("/w/ws/A", [file(".env", "modified", { contentToken: "x10" })], at("b2"))),
      undefined
    );
    // And it survives storage.
    assert.deepEqual(parseBarDismissals(JSON.stringify(restamped)), restamped);
  });

  it("does not depend on the files' order", () => {
    assert.deepEqual(
      projectBarDismissal("/p", [file(".env", "modified", { contentToken: "a" }), file("b/.env", "deleted")], v),
      projectBarDismissal("/p", [file("b/.env", "deleted"), file(".env", "modified", { contentToken: "a" })], v)
    );
  });

  it("parses stored dismissals tolerantly and refreshes matching entries", () => {
    const d = (key: string): BarDismissal => ({ key, tokens: "", boot: null });
    assert.deepEqual(parseBarDismissals(null), []);
    assert.deepEqual(parseBarDismissals("not json"), []);
    assert.deepEqual(parseBarDismissals('{"a":1}'), []);
    // Plain keys (an older format), and malformed records, are left out; extra fields are dropped.
    assert.deepEqual(
      parseBarDismissals(
        JSON.stringify(["a", 3, { key: "k", tokens: "t", boot: "b1", extra: 1 }, { key: "k2", tokens: 1, boot: null }, { key: "k3", tokens: "", boot: null }])
      ),
      [{ key: "k", tokens: "t", boot: "b1" }, d("k3")]
    );
    assert.deepEqual(addBarDismissal([d("a"), d("b")], { key: "a", tokens: "t", boot: "b1" }), [d("b"), { key: "a", tokens: "t", boot: "b1" }]);
  });
});
