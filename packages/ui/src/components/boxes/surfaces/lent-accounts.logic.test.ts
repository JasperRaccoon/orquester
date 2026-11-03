import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoxLentAccount, BoxLentAccountStatus } from "@orquester/api";

import { resetClock } from "../../topbar/usage-format";
import { box } from "../../../lib/boxes/fixtures.test-helpers";
import { accountLendChips, lentAccountsModel } from "./lent-accounts.logic";

// Local wall-clock times, so "today" holds in any time zone.
const NOW = new Date(2026, 10, 3, 12, 0).getTime();
const TODAY_2140 = new Date(2026, 10, 3, 21, 40).toISOString();
const TODAY_1800 = new Date(2026, 10, 3, 18, 0).toISOString();
const TOMORROW_2140 = new Date(2026, 10, 4, 21, 40).toISOString();
const THIS_MORNING = new Date(2026, 10, 3, 9, 0).toISOString();

function lend(overrides: Partial<BoxLentAccount> = {}): BoxLentAccount {
  return {
    id: "l1",
    accountId: "a1",
    agent: "claude",
    label: "work",
    threadId: "t1",
    purposeNote: "evals",
    createdAt: "2026-11-03T08:00:00.000Z",
    expiresAt: TODAY_2140,
    tokenExpiresAt: null,
    status: "active",
    statusMessage: null,
    home: "/h",
    ...overrides
  };
}

describe("a box's lent logins", () => {
  it("has none on an older daemon that omits them", () => {
    const model = lentAccountsModel(box(), NOW);
    assert.deepEqual(model.rows, []);
    assert.equal(model.canEndAll, false);
  });

  it("offers End on every status while time is left", () => {
    const statuses: BoxLentAccountStatus[] = ["installing", "active", "waiting-for-vm", "renewal-failing", "needs-login"];
    for (const status of statuses) {
      const [row] = lentAccountsModel(box({ lentAccounts: [lend({ status })] }), NOW).rows;
      assert.equal(row!.canEnd, true, status);
    }
  });

  it("offers no End past the end time, or on a box being destroyed, and End all only for two it can end", () => {
    const expired = lend({ id: "gone", expiresAt: THIS_MORNING });
    const live = lend({ id: "l2" });
    const one = lentAccountsModel(box({ lentAccounts: [expired, live] }), NOW);
    assert.deepEqual(one.rows.map((row) => row.canEnd), [false, true]);
    assert.equal(one.canEndAll, false);
    assert.equal(lentAccountsModel(box({ lentAccounts: [lend(), live] }), NOW).canEndAll, true);
    const destroying = lentAccountsModel(box({ state: "destroying", lentAccounts: [lend(), live] }), NOW);
    assert.equal(destroying.rows.some((row) => row.canEnd), false);
    assert.equal(destroying.canEndAll, false);
  });

  it("shows nothing for a destroyed box, whose lends are gone", () => {
    assert.deepEqual(lentAccountsModel(box({ state: "destroyed", lentAccounts: [lend()] }), NOW).rows, []);
  });

  it("says the date of an end time that is not today, and no clock once it passed", () => {
    const untilOf = (expiresAt: string) => lentAccountsModel(box({ lentAccounts: [lend({ expiresAt })] }), NOW).rows[0]!.until;
    const clock = resetClock(TODAY_2140, NOW);
    assert.ok(untilOf(TODAY_2140)!.endsWith(clock));
    assert.notEqual(untilOf(TOMORROW_2140), untilOf(TODAY_2140));
    assert.ok(untilOf(TOMORROW_2140)!.endsWith(clock), "the same time, after the date");
    assert.ok(!untilOf(THIS_MORNING)!.includes(resetClock(THIS_MORNING, NOW)));
    assert.equal(untilOf("not a date"), null);
  });

  it("carries the daemon's message on a status other than active, and links only needs-login", () => {
    const rowOf = (status: BoxLentAccountStatus) =>
      lentAccountsModel(box({ lentAccounts: [lend({ status, statusMessage: "why" })] }), NOW).rows[0]!;
    assert.equal(rowOf("active").statusMessage, null);
    assert.equal(rowOf("renewal-failing").statusMessage, "why");
    assert.equal(rowOf("renewal-failing").needsLogin, false);
    assert.equal(rowOf("needs-login").needsLogin, true);
  });
});

describe("the chip on a lent account", () => {
  const onBox = (id: string, ...lends: BoxLentAccount[]) => box({ id, lentAccounts: lends });

  it("takes the latest end time across boxes, in any order", () => {
    const later = onBox("b1", lend({ expiresAt: TODAY_2140 }));
    const earlier = onBox("b2", lend({ expiresAt: TODAY_1800 }));
    const chip = accountLendChips([earlier, later], NOW).get("a1")!;
    assert.equal(chip, accountLendChips([later, earlier], NOW).get("a1"));
    assert.ok(chip.endsWith(resetClock(TODAY_2140, NOW)));
    assert.notEqual(chip, accountLendChips([later], NOW).get("a1"), "the count differs");
  });

  it("counts two chats' lends on one VM as one VM, with the later end time", () => {
    const chip = accountLendChips([onBox("b1", lend({ id: "l1", expiresAt: TODAY_1800 }), lend({ id: "l2", expiresAt: TODAY_2140 }))], NOW).get("a1");
    assert.equal(chip, accountLendChips([onBox("b1", lend({ expiresAt: TODAY_2140 }))], NOW).get("a1"));
  });

  it("keeps accounts apart and leaves out ended lends and destroyed boxes", () => {
    const chips = accountLendChips(
      [
        box(),
        onBox("b2", lend({ accountId: "a1" }), lend({ id: "l2", accountId: "a2" }), lend({ id: "l3", accountId: "old", expiresAt: THIS_MORNING })),
        box({ state: "destroyed", lentAccounts: [lend({ id: "l4", accountId: "gone" })] })
      ],
      NOW
    );
    assert.deepEqual([...chips.keys()].sort(), ["a1", "a2"]);
  });
});
