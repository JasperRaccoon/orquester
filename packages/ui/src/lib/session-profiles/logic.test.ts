import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionProfilePrepareStatus, SessionProfileSummary } from "@orquester/api";

import {
  countsLine,
  enabledLine,
  filterProfiles,
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
