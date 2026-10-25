import assert from "node:assert/strict";
import test from "node:test";

import type { BoxKindAvailability } from "@orquester/api";

import { kind, offers, provider } from "../../../lib/boxes/fixtures.test-helpers.ts";
import {
  RUNS_ON_INITIAL,
  imageOptions,
  kindCards,
  lifetimeOptions,
  offersRequest,
  placementSelects,
  regionOptions,
  runsInBox,
  runsOnLocation,
  runsOnReady,
  runsOnReducer,
  runsOnSummary,
  sizeOptions,
  type RunsOnAction,
  type RunsOnState
} from "./runs-on.logic.ts";

const run = (...actions: RunsOnAction[]): RunsOnState => actions.reduce(runsOnReducer, RUNS_ON_INITIAL);

const MACOS: BoxKindAvailability = kind({ kind: "macos", providers: ["blacksmith"], fromHourlyUsd: 4.8, maxLifetimeMinutes: 7200 });
const MAC_OFFERS = offers({
  provider: "blacksmith",
  kind: "macos",
  sizes: [{ id: "m4-6", label: "M4 · 6 vCPU", vcpu: 6, ramGb: 14, diskGb: null, gpu: null, hourlyUsd: 4.8, regions: [] }],
  regions: [{ id: "gha", label: "GitHub Actions", country: null }],
  images: [
    { id: "macos-15", label: "macOS 15" },
    { id: "macos-14", label: "macOS 14" }
  ]
});

test("this host is the default and always ready", () => {
  assert.equal(RUNS_ON_INITIAL.choice, "host");
  assert.equal(runsOnReady(RUNS_ON_INITIAL), true);
  assert.equal(runsOnLocation(RUNS_ON_INITIAL), null);
  assert.equal(runsInBox(RUNS_ON_INITIAL), false);
  assert.equal(runsOnSummary(RUNS_ON_INITIAL), null);
});

test("choosing a kind picks its cheapest provider and asks for its offers", () => {
  const state = run({ type: "kind", availability: kind() });
  assert.equal(state.choice, "linux");
  assert.equal(state.provider, "hetzner");
  assert.deepEqual(offersRequest(state), { provider: "hetzner", kind: "linux" });
  // Not submittable until the offers are in.
  assert.equal(runsOnReady(state), false);
  assert.equal(runsInBox(state), true);
});

test("an unavailable kind cannot be chosen", () => {
  assert.equal(run({ type: "kind", availability: kind({ providers: [] }) }).choice, "host");
  assert.equal(
    run({ type: "kind", availability: kind({ unavailableReason: "Tailscale is not set up on this desktop" }) }).choice,
    "host"
  );
});

test("offers fill in the cheapest size, its first region, the first image", () => {
  const state = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  assert.equal(state.offers.status, "ready");
  assert.equal(state.size, "cx22");
  assert.equal(state.region, "fsn1");
  assert.equal(state.image, null);
  assert.deepEqual(sizeOptions(state).map((size) => size.id), ["cx22", "cx32", "ccx13"]);
  assert.deepEqual(regionOptions(state).map((region) => region.id), ["fsn1", "nbg1"]);
  assert.deepEqual(runsOnLocation(state), { kind: "box", boxKind: "linux", provider: "hetzner", size: "cx22", region: "fsn1" });
  assert.equal(runsOnReady(state), true);
});

test("an answer for a provider or kind no longer asked for is ignored", () => {
  const asked = run({ type: "kind", availability: kind() }, { type: "provider", provider: "vultr" });
  const stale = runsOnReducer(asked, { type: "offers-loaded", offers: offers() });
  assert.deepEqual(offersRequest(stale), { provider: "vultr", kind: "linux" });
  assert.equal(stale.size, null);
  const failed = runsOnReducer(asked, { type: "offers-failed", provider: "hetzner", kind: "linux", message: "boom" });
  assert.deepEqual(offersRequest(failed), { provider: "vultr", kind: "linux" });

  const ready = runsOnReducer(asked, { type: "offers-loaded", offers: offers({ provider: "vultr" }) });
  const duplicate = runsOnReducer(ready, { type: "offers-loaded", offers: offers({ provider: "vultr", sizes: [] }) });
  assert.equal(duplicate.offers.status, "ready");
  assert.equal(duplicate.size, "cx22", "a later duplicate cannot clear the chosen size");
});

test("a failed offers read can be retried", () => {
  const failed = run(
    { type: "kind", availability: kind() },
    { type: "offers-failed", provider: "hetzner", kind: "linux", message: "Rate limited" }
  );
  assert.deepEqual(failed.offers, { status: "error", provider: "hetzner", kind: "linux", message: "Rate limited" });
  assert.equal(runsOnReady(failed), false);
  const retried = runsOnReducer(failed, { type: "retry-offers" });
  assert.deepEqual(offersRequest(retried), { provider: "hetzner", kind: "linux" });
});

test("changing the provider starts over on its offers", () => {
  const state = run(
    { type: "kind", availability: kind() },
    { type: "offers-loaded", offers: offers() },
    { type: "provider", provider: "vultr" }
  );
  assert.equal(state.size, null);
  assert.equal(state.region, null);
  assert.deepEqual(offersRequest(state), { provider: "vultr", kind: "linux" });
});

test("a size keeps the region when it is rented there, else takes its first", () => {
  const ready = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  // cx32 lists no regions = all of them: the region stays.
  assert.equal(runsOnReducer(ready, { type: "size", id: "cx32" }).region, "fsn1");
  const ccx = runsOnReducer(ready, { type: "size", id: "ccx13" });
  assert.equal(ccx.region, "ash");
});

test("a region the size is not rented in switches to the cheapest size that is", () => {
  const ready = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  const ash = runsOnReducer(ready, { type: "region", id: "ash" });
  assert.equal(ash.region, "ash");
  // cx32 (all regions, $0.0238) and ccx13 ($0.0238, ash) tie: the sort is stable, cx32 first.
  assert.equal(ash.size, "cx32");
  assert.equal(runsOnReducer(ready, { type: "region", id: "nbg1" }).size, "cx22");
});

test("macOS shows the OS version instead of a single region, with its lifetime", () => {
  const state = run({ type: "kind", availability: MACOS }, { type: "offers-loaded", offers: MAC_OFFERS });
  assert.deepEqual(placementSelects(state), { region: false, image: true });
  assert.deepEqual(imageOptions(state).map((image) => image.id), ["macos-15", "macos-14"]);
  assert.equal(state.lifetimeMinutes, 7200);
  assert.deepEqual(runsOnLocation(state), {
    kind: "box",
    boxKind: "macos",
    provider: "blacksmith",
    size: "m4-6",
    region: "gha",
    image: "macos-15",
    lifetimeMinutes: 7200
  });
  const older = runsOnReducer(state, { type: "image", id: "macos-14" });
  assert.equal(runsOnLocation(older)?.image, "macos-14");
});

test("regions and images both show when both are a choice; neither images → region only", () => {
  const both = run(
    { type: "kind", availability: kind({ kind: "windows" }) },
    { type: "offers-loaded", offers: offers({ kind: "windows", images: [{ id: "w22", label: "Windows Server 2022" }] }) }
  );
  assert.deepEqual(placementSelects(both), { region: true, image: true });
  const linux = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  assert.deepEqual(placementSelects(linux), { region: true, image: false });
});

test("the lifetime is clamped to the provider maximum and offered in steps", () => {
  const state = run({ type: "kind", availability: MACOS }, { type: "offers-loaded", offers: MAC_OFFERS });
  assert.equal(runsOnReducer(state, { type: "lifetime", minutes: 99_999 }).lifetimeMinutes, 7200);
  assert.equal(runsOnReducer(state, { type: "lifetime", minutes: 5 }).lifetimeMinutes, 60);
  assert.equal(runsOnReducer(state, { type: "lifetime", minutes: 1440 }).lifetimeMinutes, 1440);
  assert.deepEqual(lifetimeOptions(7200), [60, 240, 720, 1440, 2880, 4320, 5760, 7200]);
  assert.deepEqual(lifetimeOptions(300), [60, 240, 300]);
  assert.deepEqual(lifetimeOptions(null), []);
  // A kind without a maximum has no lifetime to choose.
  const linux = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  assert.equal(runsOnLocation(runsOnReducer(linux, { type: "lifetime", minutes: 600 }))?.lifetimeMinutes, undefined);
});

test("the summary states the price, the monthly cost and what the box does", () => {
  const linux = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  assert.deepEqual(runsOnSummary(linux), {
    tone: "info",
    text: "≈ $0.0119/h, ~$8.69 a month. The box runs until you delete this project. Setup clones the repo and installs its toolchain."
  });
  const mac = run({ type: "kind", availability: MACOS }, { type: "offers-loaded", offers: MAC_OFFERS });
  assert.deepEqual(runsOnSummary(mac), {
    tone: "warn",
    text:
      "$4.80/h, about $115 a day. macOS boxes are destroyed automatically after at most 5 days (≈ $576 if left running). The project row shows a countdown."
  });
  const shorter = runsOnReducer(mac, { type: "lifetime", minutes: 1440 });
  assert.match(runsOnSummary(shorter)!.text, /after at most 1 day \(≈ \$115 if left running\)/);
  const unpriced = run(
    { type: "kind", availability: kind() },
    { type: "offers-loaded", offers: offers({ sizes: [{ ...offers().sizes[1], hourlyUsd: null }] }) }
  );
  assert.match(runsOnSummary(unpriced)!.text, /^The price for this size is unknown\./);
});

test("a kind that goes away sends the choice back to this host; a removed provider to the next", () => {
  const ready = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
  assert.equal(runsOnReducer(ready, { type: "kinds", kinds: [] }).choice, "host");
  assert.equal(runsOnReducer(ready, { type: "kinds", kinds: [kind({ providers: [] })] }).choice, "host");
  const same = runsOnReducer(ready, { type: "kinds", kinds: [kind()] });
  assert.equal(same.offers.status, "ready");
  const moved = runsOnReducer(ready, { type: "kinds", kinds: [kind({ providers: ["vultr"] })] });
  assert.deepEqual(offersRequest(moved), { provider: "vultr", kind: "linux" });
});

test("host and reset start over", () => {
  for (const type of ["host", "reset"] as const) {
    const ready = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers() });
    const reset = runsOnReducer(ready, { type });
    assert.equal(reset.choice, "host");
    assert.equal(runsInBox(reset), false);
    assert.equal(runsOnLocation(reset), null);
    assert.equal(runsOnReady(reset), true);
  }
});

test("a location is only built once the choice is complete", () => {
  const loading = run({ type: "kind", availability: MACOS });
  assert.equal(runsOnLocation(loading), null);
  const noSizes = run({ type: "kind", availability: kind() }, { type: "offers-loaded", offers: offers({ sizes: [] }) });
  assert.equal(runsOnLocation(noSizes), null);
  assert.equal(runsOnReady(noSizes), false);
});

test("cards: one per kind with a provider or a reason, priced, with the reason as tooltip", () => {
  const cards = kindCards(
    [
      kind(),
      kind({ kind: "linux-gpu", providers: [], fromHourlyUsd: null }),
      kind({ kind: "windows", providers: [], fromHourlyUsd: null, unavailableReason: "Tailscale is not set up on this desktop" }),
      MACOS
    ],
    [provider(), provider({ id: "vultr", label: "Vultr" }), provider({ id: "blacksmith", label: "Blacksmith" })]
  );
  assert.deepEqual(cards, [
    { kind: "linux", label: "Linux VM", providers: "Hetzner, Vultr", price: "from $0.0119/h", disabled: false, reason: null },
    {
      kind: "windows",
      label: "Windows",
      providers: "",
      price: null,
      disabled: true,
      reason: "Tailscale is not set up on this desktop"
    },
    { kind: "macos", label: "macOS", providers: "Blacksmith", price: "$4.80/h · max 5 days", disabled: false, reason: null }
  ]);
  assert.deepEqual(kindCards(null, null), []);
});
