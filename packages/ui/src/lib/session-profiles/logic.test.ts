import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionProfileItem, SessionProfilePrepareStatus, SessionProfileSummary } from "@orquester/api";

import {
  blockProfileChoices,
  blockProfileLabel,
  countsLine,
  enabledLine,
  filterProfiles,
  itemSaveRevision,
  itemUnchanged,
  profileChangeSummary,
  profileChipEntries,
  profileChipLabel,
  profileStatusPill,
  profileUnavailableReason,
  scopeLabel
} from "./logic.ts";

const zero = { total: 0, enabled: 0 };

function profile(id: string, name: string, preparation: Partial<Record<string, SessionProfilePrepareStatus["state"]>> = {}, reason?: string): SessionProfileSummary {
  return {
    id,
    name,
    description: `${name} work`,
    revision: "1",
    createdAt: "t",
    updatedAt: "t",
    counts: { mcp: { total: 2, enabled: 2 }, skill: { total: 1, enabled: 1 }, plugin: zero, hook: zero, command: zero },
    hasInstructions: false,
    preparation: (["claude", "codex", "grok", "opencode"] as const).map((agent) => ({
      agent,
      state: preparation[agent] ?? "ready",
      updatedAt: "t",
      ...(reason !== undefined && preparation[agent] === "failed" ? { reason } : {})
    }))
  };
}

describe("agent profile presentation", () => {
  it("names the agent scope", () => {
    assert.equal(scopeLabel("all"), "all agents");
    assert.equal(scopeLabel(["claude"]), "Claude only");
    assert.equal(scopeLabel(["codex", "claude"]), "Claude, Codex");
    assert.equal(scopeLabel(["claude", "codex", "grok", "opencode"]), "all agents");
  });

  it("counts what is on, and what a card lists", () => {
    const item = (enabled: boolean) => ({ id: "x", kind: "skill" as const, name: "x", enabled, agents: "all" as const });
    assert.equal(enabledLine([item(true), item(false), item(true)]), "2 of 3 on");
    assert.equal(countsLine(profile("p", "Dev")), "1 skill · 2 MCPs");
  });

  it("a card's pill says what is preparing, else what failed", () => {
    assert.equal(profileStatusPill(profile("p", "Dev")), null);
    assert.deepEqual(profileStatusPill(profile("p", "Dev", { codex: "preparing", grok: "failed" }))?.text, "Preparing Codex…");
    const failed = profileStatusPill(profile("p", "Dev", { grok: "failed" }, "grok inspect failed"));
    assert.equal(failed?.tone, "danger");
    assert.equal(failed?.text, "Grok failed");
    assert.match(failed?.title ?? "", /grok inspect failed/);
  });

  it("the chip disables a profile not ready for the chat's agent, with the reason", () => {
    const profiles = [profile("b", "Editor", { codex: "failed" }, "no auth"), profile("a", "Dev", { codex: "preparing" }), profile("c", "Research", { codex: "not-prepared" })];
    const entries = profileChipEntries(profiles, "codex");
    assert.deepEqual(entries.map((entry) => entry.name), ["Dev", "Editor", "Research"]);
    assert.equal(entries[0]?.disabledReason, "Preparing for Codex…");
    assert.equal(entries[1]?.disabledReason, "Not ready for Codex: no auth");
    assert.equal(entries[2]?.disabledReason, null, "not prepared yet is offered: the launch waits for it");
    assert.equal(profileUnavailableReason(profiles[0]!, "claude"), null);
  });

  it("the chip's label: Global, the profile, or a deleted one", () => {
    const profiles = [profile("a", "Dev")];
    assert.equal(profileChipLabel(null, profiles).label, "Global");
    assert.equal(profileChipLabel("a", profiles).label, "Dev");
    assert.deepEqual(profileChipLabel("gone", profiles), { label: "Deleted profile", missing: true });
    assert.equal(profileChipLabel("a", null).label, "Profile");
  });

  it("searches name and description", () => {
    const profiles = [profile("a", "Developer"), profile("b", "Editor")];
    assert.deepEqual(filterProfiles(profiles, "edit").map((p) => p.id), ["b"]);
    assert.deepEqual(filterProfiles(profiles, "  ").map((p) => p.id), ["a", "b"]);
  });
});

describe("the workflow agent block's Agent Profile picker (§5.5)", () => {
  const profiles = [{ id: "p1", name: "Developer" }, { id: "p2", name: "Editor" }];
  it("offers Global first, then every profile; a deleted one stays selected and says so", () => {
    assert.deepEqual(blockProfileChoices(profiles, undefined), [
      { value: "", label: "Global (the agent's own setup)" },
      { value: "p1", label: "Developer" },
      { value: "p2", label: "Editor" }
    ]);
    assert.deepEqual(blockProfileChoices(profiles, "gone").at(-1), { value: "gone", label: "A deleted profile — pick another" });
    assert.deepEqual(blockProfileChoices(null, "p1").at(-1), { value: "p1", label: "p1" }, "not loaded yet: the id stands in");
    assert.equal(blockProfileChoices(profiles, "p1").length, 3, "a known one is not repeated");
  });
  it("labels the block's profile for the section summary", () => {
    assert.equal(blockProfileLabel(profiles, undefined), "Global");
    assert.equal(blockProfileLabel(profiles, "p2"), "Editor");
    assert.equal(blockProfileLabel(profiles, "gone"), "a deleted Agent Profile");
    assert.equal(blockProfileLabel(null, "p1"), "an Agent Profile");
  });

  it("an item save carries the profile's current revision unless the item itself changed", () => {
    const item = { id: "i1", kind: "skill" as const, name: "review", enabled: true, agents: "all" as const, updatedAt: "t1" };
    const other = { id: "i2", kind: "skill" as const, name: "other", enabled: true, agents: "all" as const, updatedAt: "t1" };
    const held = (revision: string, items: SessionProfileItem[]) => ({ revision, items });
    // Create: whatever the store holds now.
    assert.equal(itemSaveRevision(held("5", [item]), null), "5");
    assert.equal(itemSaveRevision(null, null), null);
    // Edit: another item moved the revision — the draft still applies.
    const base = { revision: "3", item };
    assert.equal(itemSaveRevision(held("4", [item, { ...other, enabled: false, updatedAt: "t2" }]), base), "4");
    assert.equal(itemUnchanged(held("4", [item, other]), base), true);
    // Edit: this item changed (or is gone) — the revision it was read at, so the daemon refuses.
    assert.equal(itemSaveRevision(held("4", [{ ...item, name: "renamed", updatedAt: "t2" }]), base), "3");
    assert.equal(itemUnchanged(held("4", [{ ...item, updatedAt: "t2" }]), base), false);
    assert.equal(itemSaveRevision(held("4", [other]), base), "3");
    assert.equal(itemSaveRevision(null, base), "3");
    // No timestamps: the whole row is compared.
    const bare = { id: "i1", kind: "skill" as const, name: "review", enabled: true, agents: "all" as const };
    assert.equal(itemSaveRevision(held("4", [bare]), { revision: "3", item: bare }), "4");
    assert.equal(itemSaveRevision(held("4", [{ ...bare, enabled: false }]), { revision: "3", item: bare }), "3");
  });

  it("names the profile a chat switched to, resolved now (Global, a deleted one, the list still loading)", () => {
    const profiles = [profile("p-dev", "Developer")];
    assert.equal(profileChangeSummary({ profileId: "p-dev" }, profiles), 'Switched to Agent Profile "Developer"');
    assert.equal(profileChangeSummary({ profileId: null }, profiles), "Switched to Global");
    assert.equal(profileChangeSummary({ profileId: null }, null), "Switched to Global");
    assert.equal(profileChangeSummary({ profileId: "p-gone" }, profiles), "Switched to a deleted Agent Profile");
    assert.equal(profileChangeSummary({ profileId: "p-dev" }, null), "Switched Agent Profile");
  });
});
