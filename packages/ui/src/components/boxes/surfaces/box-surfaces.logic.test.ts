/**
 * What the box surfaces say (Ephemeral AI VMs spec §8.8, §8.10, §8.11, §9.3,
 * §13.3, §8.3): badge text and countdowns, the destroyed wording, the project
 * menu, the chat's composer gate, the "+" menu and account rules, temporary-box
 * cards and config-change cards.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SYSTEM_ACCOUNT_ID,
  type BoxConfigChangeSet,
  type BoxSummary,
  type ProjectBoxInfo
} from "@orquester/api";

import {
  agentCardBoxBadge,
  archivedBoxNote,
  boxAccountOptions,
  boxChatChip,
  boxChatGate,
  boxCostSoFar,
  boxDestroyedMessage,
  boxProjectMenu,
  boxShellChoices,
  boxShellRefId,
  boxTerminalTitle,
  chatPendingConfigChanges,
  chatTemporaryBoxes,
  configChangeCard,
  configChangeDecisionFailure,
  configChangeFileRow,
  configChangesIndicator,
  currentSetupStep,
  setupStepText,
  formatBoxCountdown,
  formatHourly,
  formatUsd,
  launchAccountFor,
  newTabMenuGates,
  nextShownChangeIds,
  projectBoxBadge,
  projectPendingConfigChanges,
  temporaryBoxCard,
  vmDesktopNote
} from "./box-surfaces.logic";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const info = (patch: Partial<ProjectBoxInfo> = {}): ProjectBoxInfo => ({
  boxId: "box-1",
  kind: "linux",
  provider: "hetzner",
  providerLabel: "Hetzner",
  state: "ready",
  stateReason: null,
  destroyedReason: null,
  hourlyUsd: 0.34,
  deadlineAt: null,
  ...patch
});

const box = (patch: Partial<BoxSummary> = {}): BoxSummary => ({
  id: "tmp-1",
  purpose: "temporary",
  kind: "macos",
  provider: "blacksmith",
  providerLabel: "Blacksmith",
  region: "us-east",
  regionLabel: "US East",
  size: "m4",
  sizeLabel: "M4 Pro",
  image: null,
  os: "darwin",
  arch: "arm64",
  state: "ready",
  stateReason: null,
  destroyedReason: null,
  hourlyUsd: 1.2,
  estimatedCostUsd: 0.5,
  createdAt: at(-HOUR),
  readyAt: at(-50 * MIN),
  deadlineAt: at(HOUR + 30 * MIN),
  destroyedAt: null,
  connected: true,
  lastSeenAt: at(0),
  project: null,
  threadId: "thread-1",
  purposeNote: "build the engine on macOS",
  setup: [],
  ...patch
});

const change = (patch: Partial<BoxConfigChangeSet> = {}): BoxConfigChangeSet => ({
  id: "cc-1",
  boxId: "box-1",
  threadId: "thread-1",
  createdAt: at(0),
  decidedAt: null,
  state: "pending",
  files: [
    { path: "/home/a/.claude/settings.json", change: "modified", executable: false, diff: "@@ -1 +1 @@\n-a\n+b", truncated: false, binary: false },
    { path: "/home/a/.claude/hooks/pre.sh", change: "added", executable: true, diff: "+#!/bin/sh", truncated: true, binary: false }
  ],
  ...patch
});

describe("money and the countdown", () => {
  it("formats dollars and hourly prices", () => {
    assert.equal(formatUsd(1.234), "$1.23");
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatHourly(0.34), "$0.34/h");
    assert.equal(formatHourly(0.045), "$0.045/h");
    assert.equal(formatHourly(0), "$0.00/h");
  });

  it("counts down in days and hours, then hours and minutes, then under an hour", () => {
    assert.deepEqual(formatBoxCountdown(at(4 * DAY + 6 * HOUR + 59 * MIN), NOW), { text: "4d 6h left", urgency: "normal" });
    assert.deepEqual(formatBoxCountdown(at(DAY), NOW), { text: "1d 0h left", urgency: "normal" });
    assert.deepEqual(formatBoxCountdown(at(DAY - MIN), NOW), { text: "23h 59m left", urgency: "normal" });
    assert.deepEqual(formatBoxCountdown(at(HOUR), NOW), { text: "1h 0m left", urgency: "normal" });
    assert.deepEqual(formatBoxCountdown(at(HOUR - 1), NOW), { text: "<1 h left", urgency: "soon" });
    assert.deepEqual(formatBoxCountdown(at(0), NOW), { text: "time limit reached", urgency: "over" });
    assert.equal(formatBoxCountdown(null, NOW), null);
    assert.equal(formatBoxCountdown("not a date", NOW), null);
  });

  it("moves the cost on with the clock while the box is up", () => {
    assert.equal(boxCostSoFar(box({ estimatedCostUsd: 0.5 }), NOW), 1.2);
    assert.equal(boxCostSoFar(box({ estimatedCostUsd: 2 }), NOW), 2, "never below the daemon's estimate");
    assert.equal(boxCostSoFar(box({ state: "destroyed", estimatedCostUsd: 0.5 }), NOW), 0.5);
    assert.equal(boxCostSoFar(box({ hourlyUsd: null, estimatedCostUsd: 0 }), NOW), 0);
  });
});

describe("project row badges", () => {
  it("names the provider and price of a running box", () => {
    const badge = projectBoxBadge(info(), NOW);
    assert.equal(badge.text, "Hetzner · $0.34/h");
    assert.equal(badge.tone, "neutral");
    assert.equal(badge.strike, false);
    assert.match(badge.title, /Linux VM on Hetzner · \$0\.34\/h/);
    assert.equal(projectBoxBadge(info({ hourlyUsd: null }), NOW).text, "Hetzner");
  });

  it("counts a macOS box down in the warning colour, under an hour in the destructive one", () => {
    const mac = info({ kind: "macos", providerLabel: "Blacksmith", deadlineAt: at(4 * DAY + 6 * HOUR) });
    assert.deepEqual(
      [projectBoxBadge(mac, NOW).text, projectBoxBadge(mac, NOW).tone],
      ["macOS · 4d 6h left", "warn"]
    );
    const soon = projectBoxBadge({ ...mac, deadlineAt: at(20 * MIN) }, NOW);
    assert.deepEqual([soon.text, soon.tone], ["macOS · <1 h left", "danger"]);
  });

  it("says Provisioning with the setup step, Unreachable, Destroyed", () => {
    const provisioning = projectBoxBadge(info({ state: "provisioning" }), NOW, "Cloning the repository");
    assert.deepEqual([provisioning.text, provisioning.detail, provisioning.tone], ["Provisioning…", "Cloning the repository", "info"]);
    assert.match(provisioning.title, /Setting up: Cloning the repository/);

    const unreachable = projectBoxBadge(info({ state: "unreachable" }), NOW);
    assert.deepEqual([unreachable.text, unreachable.tone], ["Unreachable", "warn"]);
    assert.match(unreachable.title, /Reconnecting to the VM…/);
    assert.match(projectBoxBadge(info({ state: "unreachable", stateReason: "No heartbeat for 2 min" }), NOW).title, /No heartbeat/);

    const destroyed = projectBoxBadge(info({ state: "destroyed", destroyedReason: "provider-gone" }), NOW);
    assert.deepEqual([destroyed.text, destroyed.tone, destroyed.strike], ["Destroyed", "danger", true]);
    assert.match(destroyed.title, /gone in the Hetzner dashboard/);

    const failed = projectBoxBadge(info({ state: "destroy-failed", stateReason: "Hetzner answered 500" }), NOW);
    assert.deepEqual([failed.text, failed.tone], ["Destroy failed", "danger"]);
    assert.match(failed.title, /Hetzner answered 500[\s\S]*Retry destroy/);
  });

  it("gives Opened agents cards the short form", () => {
    assert.equal(agentCardBoxBadge(info(), NOW).text, "VM");
    assert.equal(agentCardBoxBadge(info({ kind: "macos", deadlineAt: at(2 * DAY + HOUR) }), NOW).text, "2d 1h left");
    assert.equal(agentCardBoxBadge(info({ state: "destroyed" }), NOW).text, "VM destroyed");
    assert.equal(agentCardBoxBadge(info({ state: "provisioning" }), NOW).text, "VM setting up");
    assert.equal(agentCardBoxBadge(info({ state: "unreachable" }), NOW).text, "VM unreachable");
  });

  it("notes an archived box project still bills, until its box is gone", () => {
    assert.equal(archivedBoxNote(info()), "still billing");
    assert.equal(archivedBoxNote(info({ state: "unreachable" })), "still billing");
    assert.equal(archivedBoxNote(info({ state: "destroyed" })), null);
    assert.equal(archivedBoxNote(undefined), null);
  });

  it("picks the step setup is on", () => {
    const step = (id: "create" | "connect" | "clone", state: "pending" | "running" | "done" | "failed") => ({
      id,
      label: id,
      state,
      startedAt: null,
      finishedAt: null,
      message: null
    });
    assert.equal(currentSetupStep([step("create", "done"), step("connect", "running"), step("clone", "pending")])?.id, "connect");
    assert.equal(currentSetupStep([step("create", "done"), step("connect", "failed"), step("clone", "pending")])?.id, "connect");
    assert.equal(currentSetupStep([step("create", "done"), step("connect", "pending")])?.id, "connect");
    assert.equal(currentSetupStep([step("create", "done")]), null);
  });

  it("shows a running step's progress next to its label, and only a running step's", () => {
    const base = { id: "config" as const, label: "Sync agent configuration", startedAt: null, finishedAt: null };
    assert.equal(
      setupStepText({ ...base, state: "running", message: "Claude account 2 of 5 · 1,240 of 2,000 files" }),
      "Sync agent configuration (Claude account 2 of 5 · 1,240 of 2,000 files)"
    );
    assert.equal(setupStepText({ ...base, state: "running", message: null }), "Sync agent configuration");
    assert.equal(setupStepText({ ...base, state: "failed", message: "Could not sync" }), "Sync agent configuration");
    assert.equal(setupStepText(null), null);
    assert.match(projectBoxBadge(info({ state: "provisioning" }), 0, setupStepText({ ...base, state: "running", message: "Codex account 1 of 1 · comparing files" })).title, /Setting up: Sync agent configuration \(Codex account 1 of 1 · comparing files\)/);
  });
});

describe("destroyed wording", () => {
  it("says outside Orquester for the dashboard, a provider error and the time limit", () => {
    assert.equal(
      boxDestroyedMessage(info({ destroyedReason: "provider-gone", stateReason: "gone in the Vultr dashboard" })),
      "The VM was destroyed outside Orquester (gone in the Vultr dashboard). The transcript stays readable; you can't send new messages. Unpushed changes are lost."
    );
    assert.match(boxDestroyedMessage(info({ destroyedReason: "time-limit", kind: "macos" })), /^The VM was destroyed outside Orquester \(macOS time limit reached\)\./);
    assert.match(boxDestroyedMessage(info({ destroyedReason: "provider-error" })), /outside Orquester \(Hetzner reported an error\)/);
  });

  it("says by Orquester otherwise, and names a failed setup", () => {
    assert.match(boxDestroyedMessage(info({ destroyedReason: "agent" })), /^The VM was destroyed by Orquester \(the agent destroyed it\)\./);
    assert.match(boxDestroyedMessage(info({ destroyedReason: "chat-closed" })), /by Orquester \(its chat was closed\)/);
    assert.match(boxDestroyedMessage(info({ destroyedReason: "provisioning-failed", stateReason: "clone failed" })), /^The VM's setup failed and it was torn down \(clone failed\)\./);
    assert.match(boxDestroyedMessage(info({ destroyedReason: null })), /^The VM was destroyed\. The transcript stays readable/);
  });
});

describe("the project menu", () => {
  it("offers Retry destroy only after a failed destroy, and Delete always", () => {
    assert.equal(boxProjectMenu(info({ state: "destroy-failed" })).retryDestroy, true);
    assert.equal(boxProjectMenu(info({ state: "destroyed" })).retryDestroy, false);
    assert.equal(boxProjectMenu(info()).retryDestroy, false);
    assert.deepEqual(boxProjectMenu(undefined), { retryDestroy: false, deleteNote: null });
  });

  it("says in the Delete confirmation what happens to the VM", () => {
    assert.match(boxProjectMenu(info())?.deleteNote ?? "", /destroys its VM at Hetzner/);
    assert.match(boxProjectMenu(info({ state: "destroyed" })).deleteNote ?? "", /already gone/);
  });
});

describe("the chat's composer gate", () => {
  it("lets a running box chat send with no notice", () => {
    assert.deepEqual(boxChatGate(info()), { blockedReason: null, notice: null });
    assert.deepEqual(boxChatGate(null), { blockedReason: null, notice: null });
  });

  it("keeps sending through a reconnect, with a non-blocking notice", () => {
    const gate = boxChatGate(info({ state: "unreachable" }));
    assert.equal(gate.blockedReason, null);
    assert.equal(gate.notice?.title, "Reconnecting to the VM…");
    assert.equal(gate.notice?.tone, "warn");
  });

  it("holds sends while setup runs, naming the step", () => {
    const gate = boxChatGate(info({ state: "provisioning" }), "Installing the toolchain");
    assert.ok(gate.blockedReason);
    assert.equal(gate.notice?.title, "Setting up the VM — Installing the toolchain");
    assert.equal(boxChatGate(info({ state: "provisioning" })).notice?.title, "Setting up the VM");
  });

  it("makes a destroyed box's chat read-only with the destroyed banner", () => {
    const gate = boxChatGate(info({ state: "destroyed", destroyedReason: "provider-gone" }));
    assert.match(gate.blockedReason ?? "", /read-only/);
    assert.equal(gate.notice?.tone, "danger");
    assert.match(gate.notice?.text ?? "", /outside Orquester[\s\S]*Unpushed changes are lost\./);
  });

  it("holds sends while the box is being destroyed or its destroy failed", () => {
    assert.ok(boxChatGate(info({ state: "destroying" })).blockedReason);
    const failed = boxChatGate(info({ state: "destroy-failed" }));
    assert.ok(failed.blockedReason);
    assert.match(failed.notice?.text ?? "", /may still be billing/);
  });

  it("names the box in the header chip", () => {
    assert.equal(boxChatChip(info(), NOW).text, "Linux VM · Hetzner · $0.34/h");
    const mac = boxChatChip(info({ kind: "macos", providerLabel: "Blacksmith", hourlyUsd: null, deadlineAt: at(3 * HOUR) }), NOW);
    assert.deepEqual([mac.text, mac.tone], ["macOS · Blacksmith · 3h 0m left", "warn"]);
    assert.equal(boxChatChip(info({ state: "destroyed" }), NOW).text, "Linux VM · Hetzner");
    assert.equal(boxChatChip(info({ state: "destroyed" }), NOW).tone, "danger");
  });
});

describe("the + menu and accounts", () => {
  it("offers desktops in a Linux VM (they run inside it); a macOS or Windows VM, or a gone one, says why not", () => {
    assert.deepEqual(newTabMenuGates(null), { showDesktops: true, desktopsInVm: false, desktopsUnavailable: null });
    assert.deepEqual(newTabMenuGates(info()), { showDesktops: true, desktopsInVm: true, desktopsUnavailable: null });
    assert.deepEqual(newTabMenuGates(info({ kind: "linux-gpu" })), { showDesktops: true, desktopsInVm: true, desktopsUnavailable: null });
    const mac = newTabMenuGates(info({ kind: "macos" }));
    assert.equal(mac.showDesktops, false);
    assert.match(mac.desktopsUnavailable ?? "", /macOS VM \(Linux VMs only\)/);
    assert.match(newTabMenuGates(info({ kind: "windows-gpu" })).desktopsUnavailable ?? "", /Windows VM/);
    assert.deepEqual(newTabMenuGates(info({ state: "destroyed" })), {
      showDesktops: false,
      desktopsInVm: false,
      desktopsUnavailable: "Desktops — not available: the VM is gone"
    });
  });

  it("says what opening a VM desktop does when its packages are missing", () => {
    const status = { available: false, installHint: "Orquester installs the desktop packages when a desktop opens.", warnings: [] };
    assert.equal(vmDesktopNote(null), null);
    assert.equal(vmDesktopNote({ ...status, available: true, installHint: null }), null);
    assert.equal(vmDesktopNote(status), status.installHint);
    // Usable, but optional packages missing (sound, compositor…): the first desktop installs them too.
    assert.equal(vmDesktopNote({ ...status, available: true }), status.installHint);
    assert.match(vmDesktopNote({ ...status, available: true, audioAvailable: false, installHint: null }) ?? "", /without sound/);
    assert.equal(vmDesktopNote({ ...status, installHint: null, warnings: ["No sudo in this VM."] }), "No sudo in this VM.");
    assert.match(vmDesktopNote({ ...status, installHint: null }) ?? "", /first open/);
    assert.match(vmDesktopNote("error") ?? "", /Could not check/);
  });

  it("offers the shells of the box's OS family, else all", () => {
    const shells = [{ id: "bash" }, { id: "zsh" }, { id: "pwsh" }];
    assert.deepEqual(boxShellChoices(shells, "linux").map((s) => s.id), ["bash", "zsh"]);
    assert.deepEqual(boxShellChoices(shells, "windows-gpu").map((s) => s.id), ["pwsh"]);
    assert.deepEqual(boxShellChoices([{ id: "bash" }], "windows").map((s) => s.id), ["bash"], "the daemon decides");
    assert.equal(boxShellChoices(shells, null), shells);
    assert.equal(boxShellRefId(box({ os: "win32", kind: "windows" })), "pwsh");
    assert.equal(boxShellRefId(box()), "bash");
  });

  it("drops the System account in a box", () => {
    const options = [{ id: SYSTEM_ACCOUNT_ID }, { id: "acc-1" }];
    assert.deepEqual(boxAccountOptions(options, true).map((o) => o.id), ["acc-1"]);
    assert.deepEqual(boxAccountOptions(options, false).map((o) => o.id), [SYSTEM_ACCOUNT_ID, "acc-1"]);
  });

  it("launches a box chat with a managed account, or not at all", () => {
    assert.equal(launchAccountFor([{ id: "acc-1" }, { id: "acc-2" }], "acc-2", true), "acc-2");
    assert.equal(launchAccountFor([{ id: "acc-1" }], SYSTEM_ACCOUNT_ID, true), "acc-1");
    assert.equal(launchAccountFor([], SYSTEM_ACCOUNT_ID, true), null);
    assert.equal(launchAccountFor([{ id: SYSTEM_ACCOUNT_ID }], "gone", false), SYSTEM_ACCOUNT_ID);
  });
});

describe("temporary boxes", () => {
  it("shows kind and purpose, provider, cost so far, countdown and what can be done", () => {
    const card = temporaryBoxCard(box(), NOW);
    assert.equal(card.title, "macOS — build the engine on macOS");
    assert.equal(card.subtitle, "Blacksmith · M4 Pro · US East");
    assert.equal(card.stateText, "Running");
    assert.equal(card.cost, "$1.20 so far · $1.20/h");
    assert.deepEqual(card.countdown, { text: "1h 30m left", urgency: "normal" });
    assert.equal(card.canWatch, true);
    assert.equal(card.canDestroy, true);
  });

  it("offers Watch only while the box is up and connected, and nothing once destroyed", () => {
    assert.equal(temporaryBoxCard(box({ connected: false }), NOW).canWatch, false);
    assert.equal(temporaryBoxCard(box({ state: "provisioning", connected: false }), NOW).canWatch, false);
    const gone = temporaryBoxCard(box({ state: "destroyed", stateReason: "time limit reached" }), NOW);
    assert.deepEqual([gone.canWatch, gone.canDestroy, gone.countdown, gone.stateText], [false, false, null, "Destroyed — time limit reached"]);
    assert.equal(gone.cost, "$0.50 so far");
    assert.equal(temporaryBoxCard(box({ state: "destroying" }), NOW).canDestroy, false);
  });

  it("sanitises the agent's purpose", () => {
    assert.equal(temporaryBoxCard(box({ purposeNote: "a‮b\nc" }), NOW).title, "macOS — ab c");
    assert.equal(boxTerminalTitle(box({ purposeNote: null })), "VM · macOS");
    assert.equal(boxTerminalTitle(box()), "VM · build the engine on macOS");
  });

  it("lists the chat's own temporary boxes, live first, newest first", () => {
    const list = chatTemporaryBoxes(
      [
        box({ id: "old", createdAt: at(-2 * HOUR) }),
        box({ id: "gone", state: "destroyed", createdAt: at(-MIN) }),
        box({ id: "new", createdAt: at(-MIN) }),
        box({ id: "other", threadId: "thread-2" }),
        box({ id: "project", purpose: "project", threadId: "thread-1" })
      ],
      "thread-1"
    );
    assert.deepEqual(list.map((b) => b.id), ["new", "old", "gone"]);
  });
});

describe("config change cards", () => {
  it("picks a chat's pending sets, and the project row's no-turn sets of its box", () => {
    const sets = [
      change(),
      change({ id: "cc-2", state: "approved" }),
      change({ id: "cc-3", threadId: null }),
      change({ id: "cc-4", threadId: null, boxId: "box-2" })
    ];
    assert.deepEqual(chatPendingConfigChanges(sets, "thread-1").map((c) => c.id), ["cc-1"]);
    assert.deepEqual(projectPendingConfigChanges(sets, "box-1").map((c) => c.id), ["cc-3"]);
    assert.deepEqual(projectPendingConfigChanges(sets, undefined), []);
    assert.equal(configChangesIndicator(1), "1 config change needs approval");
    assert.equal(configChangesIndicator(3), "3 config changes need approval");
    assert.equal(configChangesIndicator(0), null);
  });

  it("lists every file with its change, flags executables and notes truncation", () => {
    const model = configChangeCard(change(), false);
    assert.equal(model.summary, "2 files · 1 executable");
    assert.equal(model.executableCount, 1);
    assert.deepEqual(
      model.rows.map((row) => [row.changeLabel, row.executable, row.note]),
      [
        ["Modified", false, null],
        ["Added", true, "The diff is truncated; the rest is not shown."]
      ]
    );
    assert.equal(model.canDecide, true);
    assert.equal(model.outcome, null);
  });

  it("never counts a deleted file as executable, even one an older daemon flagged", () => {
    const set = change();
    set.files.push({ path: "/home/a/.claude/hooks/old.sh", change: "deleted", executable: true, diff: "-#!/bin/sh", truncated: false, binary: false });
    const model = configChangeCard(set, false);
    assert.equal(model.executableCount, 1);
    assert.equal(model.summary, "3 files · 1 executable");
    assert.equal(model.rows[2]!.executable, false);
  });

  it("shows no diff for a binary or empty file, and makes hidden characters visible", () => {
    const base = { path: "/p", change: "modified" as const, executable: false, truncated: false };
    assert.deepEqual(
      [configChangeFileRow({ ...base, diff: "", binary: true }).diff, configChangeFileRow({ ...base, diff: "", binary: true }).note],
      [null, "Binary file — no diff to show."]
    );
    assert.equal(configChangeFileRow({ ...base, diff: "", binary: false }).note, "No textual changes.");
    assert.notEqual(configChangeFileRow({ ...base, diff: "+a‮b", binary: false }).diff, "+a‮b");
    assert.equal(configChangeFileRow({ ...base, path: "/p\nq", diff: "", binary: false }).path, "/p q");
  });

  it("closes the buttons while an answer is in flight and once decided", () => {
    assert.equal(configChangeCard(change(), true).canDecide, false);
    const approved = configChangeCard(change({ state: "approved" }), false);
    assert.equal(approved.canDecide, false);
    assert.match(approved.outcome ?? "", /^Approved/);
    assert.match(configChangeCard(change({ state: "denied" }), false).outcome ?? "", /^Denied/);
    assert.match(configChangeCard(change({ state: "stale" }), false).outcome ?? "", /^Stale/);
  });

  it("keeps a decided set on screen until dismissed, and drops one the daemon no longer has", () => {
    const known = new Set(["a", "b", "c"]);
    const none = new Set<string>();
    assert.deepEqual(nextShownChangeIds([], ["a", "b"], known, none), ["a", "b"]);
    const shown = ["a", "b"];
    assert.equal(nextShownChangeIds(shown, ["b"], known, none), shown, "a decided set stays; nothing changed");
    assert.deepEqual(nextShownChangeIds(shown, ["b", "c"], known, none), ["a", "b", "c"]);
    assert.deepEqual(nextShownChangeIds(shown, ["b"], known, new Set(["a"])), ["b"]);
    assert.deepEqual(nextShownChangeIds(shown, ["a"], new Set(["a"]), none), ["a"]);
    assert.deepEqual(nextShownChangeIds([], ["a"], known, new Set(["a"])), [], "a dismissed set never comes back");
  });

  it("says why a decision was refused", () => {
    assert.match(configChangeDecisionFailure(404), /decided elsewhere/);
    assert.match(configChangeDecisionFailure(409), /already decided/);
    assert.match(configChangeDecisionFailure(null), /Could not reach/);
    assert.match(configChangeDecisionFailure(500), /\(500\)/);
  });
});
