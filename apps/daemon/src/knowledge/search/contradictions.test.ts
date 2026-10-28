import assert from "node:assert/strict";
import { test } from "node:test";

import type { KnowledgePairCheck, KnowledgePairChecksPort } from "../ports.ts";
import {
  type ContradictionGraph,
  findContradictions,
  isFillerNote,
  isResolvedNote,
  isSurveyEntry,
  nameNoteSides,
  noteInvolves,
  noteUsesSideLetters,
  sideNames,
  stripNonConflictSentences
} from "./contradictions.ts";
import type { GraphEdge } from "./graph.ts";
import { knowledgeScope } from "./visibility.ts";

// The phase 2 spec's contradiction rules over a hand-built concept graph (edges carry the
// `context` attribute concept merges keep): either direction, both entries visible, the edge's
// context as the note, pair checks confirming or overriding.

const scope = knowledgeScope({ kind: "all" }, []);

/** Concept → its entries; `contradicts` edges with an optional context. */
function graphOf(concepts: Record<string, string[]>, edges: (Partial<GraphEdge> & { from: string; to: string; context?: unknown })[]): ContradictionGraph {
  const full: GraphEdge[] = edges.map((edge, i) => ({ id: `e${i}`, type: "contradicts", confidence: 0.9, entryIds: null, ...edge }));
  return {
    visibleEdgesOfType: (type, _scope, around) => {
      const near = around ? new Set(around) : null;
      return full.filter((edge) => edge.type.toLowerCase() === type && (!near || near.has(edge.from) || near.has(edge.to)));
    },
    visibleEntriesOf: (conceptId) => [...(concepts[conceptId] ?? [])],
    conceptRef: (id) => (concepts[id] ? { id, name: id.toUpperCase(), type: "Tactic", description: null } : null),
    conceptIdsOfEntry: (entryId) =>
      Object.entries(concepts)
        .filter(([, entries]) => entries.includes(entryId))
        .map(([id]) => id)
  };
}

function checks(list: KnowledgePairCheck[]): KnowledgePairChecksPort {
  return { all: () => list, get: (a, b) => list.find((c) => c.a === a && c.b === b) ?? null, onChange: () => () => undefined };
}

const check = (a: string, b: string, verdict: KnowledgePairCheck["verdict"], note: string | null = null): KnowledgePairCheck => ({
  a,
  b,
  verdict,
  note,
  checkedAt: "2026-10-27T00:00:00.000Z"
});

test("graph: a concept of one entry contradicting a concept of another, in either direction, with the edge's context as the note", () => {
  const graph = graphOf({ short: ["ke_a"], long: ["ke_b", "ke_c"], other: ["ke_c"] }, [
    { from: "short", to: "long", context: "  Trials:  3 days vs 14 days " },
    { from: "other", to: "short", context: "one says daily, one says weekly" },
    { from: "long", to: "other", type: "supports" }
  ]);
  const all = findContradictions({ graph, scope, pairChecks: null, accept: () => true });
  assert.deepEqual([...all.values()], [
    { a: "ke_a", b: "ke_b", source: "graph", pairs: [{ from: { id: "short", name: "SHORT", type: "Tactic" }, to: { id: "long", name: "LONG", type: "Tactic" } }], note: "Trials: 3 days vs 14 days" },
    {
      a: "ke_a",
      b: "ke_c",
      source: "graph",
      pairs: [
        { from: { id: "short", name: "SHORT", type: "Tactic" }, to: { id: "long", name: "LONG", type: "Tactic" } },
        { from: { id: "other", name: "OTHER", type: "Tactic" }, to: { id: "short", name: "SHORT", type: "Tactic" } }
      ],
      note: "Trials: 3 days vs 14 days"
    }
  ]);
  // The same pairs, seen from one entry (B: only through `long`; an entry is never its own contradiction).
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_b" }).keys()].length, 1);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_c" }).values()].map((c) => [c.a, c.b]), [["ke_a", "ke_c"]]);
});

test("an edge without context has no note; an entry that is not accepted is never on either side", () => {
  const graph = graphOf({ x: ["ke_a", "ke_hidden"], y: ["ke_b", "ke_hidden"] }, [{ from: "x", to: "y" }]);
  const visible = (id: string) => id !== "ke_hidden";
  const all = [...findContradictions({ graph, scope, pairChecks: null, accept: visible }).values()];
  assert.deepEqual(all.map((c) => [c.a, c.b, c.note]), [["ke_a", "ke_b", null]]);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: visible, entryId: "ke_hidden" }).values()], []);
  const checked = checks([check("ke_a", "ke_hidden", "contradicts", "secret")]);
  assert.ok(![...findContradictions({ graph, scope, pairChecks: checked, accept: visible }).values()].some((c) => c.note === "secret"));
});

test("checked: a `contradicts` pair check adds the pair (or confirms the graph's, keeping the pairs its note speaks of); `consistent` and `unrelated` override the graph", () => {
  const graph = graphOf({ x: ["ke_a"], y: ["ke_b"], z: ["ke_c"] }, [
    { from: "x", to: "y", context: "graph says" },
    { from: "x", to: "z", context: "z refutes x outright" }
  ]);
  const port = checks([check("ke_a", "ke_b", "contradicts", "the checker says"), check("ke_a", "ke_c", "consistent"), check("ke_b", "ke_d", "contradicts", "d")]);
  const found = findContradictions({ graph, scope, pairChecks: port, accept: (id) => id !== "ke_d" });
  assert.deepEqual([...found.values()], [
    { a: "ke_a", b: "ke_b", source: "checked", pairs: [], note: "the checker says" }
  ]);
  const only = findContradictions({ graph, scope, pairChecks: checks([check("ke_b", "ke_c", "contradicts", null)]), accept: () => true, entryId: "ke_c" });
  assert.deepEqual([...only.values()], [
    { a: "ke_a", b: "ke_c", source: "graph", pairs: [{ from: { id: "x", name: "X", type: "Tactic" }, to: { id: "z", name: "Z", type: "Tactic" } }], note: "z refutes x outright" },
    { a: "ke_b", b: "ke_c", source: "checked", pairs: [], note: null }
  ]);
});

test("an entry linked to both concepts of a contradicting pair discusses it: a side of neither, from every direction", () => {
  // ke_map quotes both sides (as a contradiction map does); ke_a and ke_b each take one.
  const graph = graphOf({ gmail: ["ke_a", "ke_map"], outlook: ["ke_b", "ke_map"], other: ["ke_map"] }, [{ from: "gmail", to: "outlook", context: "Alex says only Gmail is safe; jason says use Outlook or Proton" }]);
  const all = findContradictions({ graph, scope, pairChecks: null, accept: () => true });
  assert.deepEqual([...all.values()].map((c) => [c.a, c.b]), [["ke_a", "ke_b"]]);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_map" }).values()], []);
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryId: "ke_a" }).values()].map((c) => [c.a, c.b]), [["ke_a", "ke_b"]]);
});

test("survey entries (a synthesis, a note titled as a map, audit, hub or index) are never a side, of the graph's guesses or of a pair check", () => {
  const meta: Record<string, { kind: string; title: string }> = {
    ke_a: { kind: "post", title: "Use Gmail for the account" },
    ke_b: { kind: "post", title: "Use Outlook or Proton" },
    ke_syn: { kind: "synthesis", title: "End-to-end playbook" },
    ke_audit: { kind: "research note", title: "Claims audit / stale-tip register" },
    ke_hub: { kind: "note", title: "Map of the knowledge base (hub)" },
    ke_post: { kind: "post", title: "Index your site with IndexNow" }
  };
  const graph = graphOf({ gmail: ["ke_a", "ke_syn", "ke_audit"], outlook: ["ke_b", "ke_hub", "ke_post"] }, [{ from: "gmail", to: "outlook", context: "Gmail versus Outlook for new accounts" }]);
  const entryMeta = (id: string) => meta[id] ?? null;
  const all = findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryMeta });
  assert.deepEqual([...all.values()].map((c) => [c.a, c.b]), [
    ["ke_a", "ke_b"],
    ["ke_a", "ke_post"]
  ], "a post's title naming an index is not a survey");
  assert.deepEqual([...findContradictions({ graph, scope, pairChecks: null, accept: () => true, entryMeta, entryId: "ke_syn" }).values()], []);
  // A verdict recorded before survey entries were left out of pair checks: ignored, whatever it says.
  const checked = findContradictions({
    graph,
    scope,
    pairChecks: checks([check("ke_audit", "ke_b", "contradicts", "the audit marks it stale"), check("ke_a", "ke_syn", "consistent", "the synthesis agrees")]),
    accept: () => true,
    entryMeta
  });
  assert.deepEqual([...checked.values()].map((c) => [c.a, c.b, c.source]), [
    ["ke_a", "ke_b", "graph"],
    ["ke_a", "ke_post", "graph"]
  ]);
  assert.equal(findContradictions({ graph, scope, pairChecks: checks([check("ke_hub", "ke_b", "contradicts", "x")]), accept: () => true, entryMeta, entryId: "ke_hub" }).size, 0);
});

test("a note that says nothing is null; an edge whose note says the conflict is only apparent or resolved is no disagreement", () => {
  const graph = graphOf({ a: ["ke_a"], b: ["ke_b"], c: ["ke_c"], d: ["ke_d"], e: ["ke_e"] }, [
    { from: "a", to: "b", context: "n/a" },
    { from: "a", to: "c", context: "Unresolved; notes disagree on magnitude" },
    { from: "a", to: "d", context: "Apparent only; HIG exempts legal consent" },
    { from: "a", to: "e", context: "placeholder" },
    { from: "b", to: "e", context: "Not either/or; the playbook runs both in parallel" },
    { from: "c", to: "e", context: "Daily posting beats weekly for new accounts" },
    { from: "c", to: "d", context: "Both can work through sends per reach" },
    { from: "d", to: "e", context: "Not a real conflict: different storefronts" }
  ]);
  const found = findContradictions({ graph, scope, pairChecks: null, accept: () => true });
  assert.deepEqual([...found.values()].map((c) => [c.a, c.b, c.note]), [
    ["ke_a", "ke_b", null],
    ["ke_a", "ke_c", null],
    ["ke_a", "ke_e", null],
    ["ke_c", "ke_e", "Daily posting beats weekly for new accounts"]
  ]);
  for (const note of ["n/a", "None", "placeholder", "Unknown.", "unresolved; magnitude", "too short", ""]) assert.ok(isFillerNote(note), note);
  for (const note of ["Depends on what a trial costs you", "Web lost about a third of initial conversions"]) assert.ok(!isFillerNote(note) && !isResolvedNote(note), note);
  for (const note of ["Apparent only; HIG exempts legal consent", "only apparently at odds", "Both true at different scales", "Resolved by the 2026 policy", "Everyone agrees IP reputation is the problem"]) {
    assert.ok(isResolvedNote(note), note);
  }
  assert.ok(!isResolvedNote("Unresolved; notes disagree"), "unresolved is not resolved");
});

test("note checks: a negated or bare resolved word is a disagreement; a note is filler only whole or as a heading", () => {
  const table: [note: string, resolved: boolean, filler: boolean][] = [
    // Disagreements the old checks read as resolved.
    ["The claims are not consistent: one says weekly, the other daily", false, false],
    ["Not resolved: sources disagree on the trial length", false, false],
    ["These are not compatible strategies for a new account", false, false],
    ["Still isn't really resolved by either source", false, false],
    ["Never resolved; both cite their own tests", false, false],
    ["Both posts are consistent in tone but disagree on the price", false, false],
    ["Gmail and Outlook are compatible with the signup flow, but one is banned", false, false],
    ["The un-resolved question is which proxy works", false, false],
    // Resolved or apparent only.
    ["Apparent only; HIG exempts legal consent", true, false],
    ["Resolved by the 2026 policy update", true, false],
    ["The dispute was resolved in the later post", true, false],
    ["It is not a real conflict: different storefronts", true, false],
    ["Both true at different scales", true, false],
    ["Compatible only because the 2019 claim was about matching", true, false],
    // Notes that start with a filler word but say something.
    ["Unknown proxy provider recommended over a residential one", false, false],
    ["None of the tested apps kept the trial", false, false],
    ["Placeholder pages rank in one source and not the other", false, false],
    // Filler: whole, or a filler word set apart as a heading.
    ["n/a", false, true],
    ["N/A.", false, true],
    ["placeholder", false, true],
    ["Unknown.", false, true],
    ["TBD - placeholder", false, true],
    ["Unresolved; notes disagree on magnitude", false, true],
    ["unresolved: see both entries for the numbers", false, true],
    ["Unclear: the second post never says", false, true],
    ["too short", false, true],
    ["", false, true]
  ];
  for (const [note, resolved, filler] of table) {
    assert.equal(isResolvedNote(note), resolved, `resolved: ${note}`);
    assert.equal(isFillerNote(note), filler, `filler: ${note}`);
  }
});

test("isSurveyEntry: synthesis entries, and notes titled as surveys", () => {
  assert.ok(isSurveyEntry({ kind: "synthesis", title: "Plan length is the hidden master variable" }));
  assert.ok(isSurveyEntry({ kind: "research note", title: "Cross-links: where the saved tips collide" }));
  assert.ok(isSurveyEntry({ kind: "note", title: "App Store Review Guidelines (index of every section)" }));
  assert.ok(!isSurveyEntry({ kind: "research note", title: "IndexNow does not feed ChatGPT" }));
  assert.ok(!isSurveyEntry({ kind: "article", title: "A 10-step roadmap to market an app" }));
  assert.ok(!isSurveyEntry({ kind: "post", title: "Map out your funnel" }));
  assert.ok(!isSurveyEntry(null));
});

test("a checked contradiction keeps only the graph's concept pairs its note speaks of", () => {
  const names: Record<string, string> = {
    selfhost: "Self-host Outline VPN on Hetzner ($5/mo) instead of NordVPN",
    appstore: "US App Store download and warm-up",
    residential: "Residential IP for a US TikTok account"
  };
  const base = graphOf({ selfhost: ["ke_daniel"], appstore: ["ke_note"], residential: ["ke_note"] }, [
    { from: "selfhost", to: "appstore" },
    { from: "selfhost", to: "residential" }
  ]);
  const graph: ContradictionGraph = { ...base, conceptRef: (id, at) => (base.conceptRef(id, at) ? { id, name: names[id]!, type: "Tactic", description: null } : null) };
  const note = "Claude says a residential IP beats a datacenter one for a US TikTok account; daniel recommends a self-hosted VPN on a Hetzner datacenter VPS.";
  const [found] = [...findContradictions({ graph, scope, pairChecks: checks([check("ke_daniel", "ke_note", "contradicts", note)]), accept: () => true }).values()];
  assert.deepEqual(found!.pairs.map((pair) => [pair.from.id, pair.to.id]), [["selfhost", "residential"]], "not the App Store download, which the note never mentions");
  assert.equal(noteInvolves(note, names.selfhost!), true);
  assert.equal(noteInvolves(note, names.appstore!), false);
});

test("a note from before input version 4 names its sides: A is the check's `a` entry, B its `b`; only notes using both letters as sides change", () => {
  const jason = { title: "Make any phone hit a US audience on TikTok: 13 steps", author: "jason", handle: "jasonugc" };
  const alex = { title: "Step-by-step iPhone setup", author: "Alex Nguyen", handle: null };
  assert.equal(
    nameNoteSides("A says to create the account with Outlook. B says to use only Gmail.", jason, alex),
    "jason says to create the account with Outlook. Alex Nguyen says to use only Gmail."
  );
  assert.equal(
    nameNoteSides("Both target the US, but A recommends an ISP proxy while B says shared proxies get flagged; A's proxy is checked on IPQS.", jason, alex),
    "Both target the US, but jason recommends an ISP proxy while Alex Nguyen says shared proxies get flagged; jason's proxy is checked on IPQS."
  );
  assert.equal(nameNoteSides("B claims a VPS looks residential. A claims it is labelled datacenter.", jason, alex), "Alex Nguyen claims a VPS looks residential. jason claims it is labelled datacenter.");
  for (const untouched of ["Both run A/B tests on the paywall.", "A residential IP beats a datacenter one; jason disagrees.", "jason says 48 hours; Alex Nguyen says 1-2 days."]) {
    assert.equal(noteUsesSideLetters(untouched), false, untouched);
    assert.equal(nameNoteSides(untouched, jason, alex), untouched);
  }
  assert.deepEqual(sideNames({ title: "x", author: null, handle: "@jasonugc" }, { title: "Super short guide: US TikTok", author: null, handle: null }), ["@jasonugc", "“Super short guide”"]);
  assert.deepEqual(sideNames({ title: "TikTok's privacy policy names its region inputs (SIM region, …)", author: "Claude" }, { title: "Since Jan 2026 a separate US company runs TikTok's US feed and more", author: "claude" }), [
    "“TikTok's privacy policy names its region…”",
    "“Since Jan 2026 a separate US…”"
  ], "one author on both sides: short titles");

  // findContradictions names them from the entries' meta (A = the check's `a`), on every reader's path.
  const graph = graphOf({}, []);
  const meta: Record<string, { kind: string; title: string; author: string | null; handle: string | null }> = {
    ke_a: { kind: "post", ...jason },
    ke_b: { kind: "post", ...alex }
  };
  const port = checks([check("ke_a", "ke_b", "contradicts", "A says Outlook. B says Gmail.")]);
  const [found] = [...findContradictions({ graph, scope, pairChecks: port, accept: () => true, entryMeta: (id) => meta[id] ?? null }).values()];
  assert.equal(found!.note, "jason says Outlook. Alex Nguyen says Gmail.");
  const [page] = [...findContradictions({ graph, scope, pairChecks: port, accept: () => true, entryId: "ke_b", entryMeta: (id) => meta[id] ?? null }).values()];
  assert.equal(page!.note, "jason says Outlook. Alex Nguyen says Gmail.", "the same on either entry's page");
});

/**
 * The `contradicts` notes stored in the live knowledge base's pair-checks.json (2026-10-28, read from
 * a copy): only jason ↔ Emanuele Totaro's ends in a sentence about a mere difference of choice.
 */
const STORED_NOTES = [
  "Alex Nguyen says to post nothing on day one and start posting the first video after 1–2 days of casual use. Erikas Mališauskas says to wait a few days before uploading the first video.",
  'Agent skill recommends a permission-priming screen with Enable and Not now, and placeholder "aspirational" testimonials and projected stats. Claude (research) says Apple\'s HIG allows only one Continue button with no way out, and that such testimonials and stats fall foul of the FTC fake-review rule and App Store 2.3.14.',
  "jason says to create the TikTok account with an Outlook or Proton email, while Alex Nguyen says to use only Gmail and that Outlook, Yahoo and ProtonMail carry a significantly higher risk of the account being flagged or banned.",
  "Evgeniy Mikholap says to warm up the account for 3-5 days before filling the profile and posting daily; Alex Nguyen says not to post on day one and to start posting your first video after 1-2 days of casual usage.",
  "Emanuele Totaro says to warm up the account for 5-7 days; Evgeniy Mikholap says 3-5 days of warming up before filling the profile and posting.",
  "Alex Nguyen says to create only 2-3 TikTok accounts maximum per device, while yanme recommends 5 accounts on each iPhone. They also differ on warm-up: Alex Nguyen says to start posting after 1-2 days, yanme says to warm up for 3 days.",
  "jason says to warm up for 48 hours before posting; Evgeniy Mikholap says 3-5 days of warming up before filling the profile and posting.",
  "daniel says a self-hosted Outline VPN on a Hetzner VPS makes TikTok see a normal US home user, while Claude (research) says that IP is labelled datacenter/hosting, not residential, so the VPS swaps one red flag for another.",
  "jason says to warm up an account for 48 hours before posting, while yanme says to warm up each account for 3 days.",
  "Emanuele Totaro recommends using NordVPN (connected to Los Angeles or San Francisco) for a US TikTok account, while daniel says not to use NordVPN because it gets you shadow banned instantly, and to self-host Outline VPN instead.",
  "Erikas Mališauskas says to post no more than 1 video per day in the first week, and only then up to 3 per day. yanme says to post 2 videos per account per day after a 3-day warm-up, which is during that first week.",
  "“Agent skill” tells the user to write aspirational testimonials with persona tags when the app has no real ones, and to replace them later. Claude (research) says that if such placeholders ship, they are fake testimonials banned by the FTC rule, and it calls this advice the clearest conflict with the rule. It recommends real quotes or no testimonial instead.",
  "Emanuele Totaro says to warm up the account for 5-7 days; yanme says to warm up each account for 3 days.",
  "Claude (research) says to keep to 2-3 accounts per device because bans follow device IDs, while yanme says to run 5 TikTok accounts on each iPhone.",
  'Claude (research) backs the "2–3 accounts per device" rule, since a ban follows the device. yanme says to run 5 TikTok accounts on each used iPhone.'
];
const PADDED =
  "jason says to warm up the account for 48 hours before posting, while Emanuele Totaro says to warm up for 5-7 days. The tool choices differ (ISP proxy with Shadowrocket versus NordVPN), but that is a difference of choice, not a conflict.";
const PADDED_CLAIMS = "jason says to warm up the account for 48 hours before posting, while Emanuele Totaro says to warm up for 5-7 days.";

test("stripNonConflictSentences: a sentence that only says what does not conflict goes; a side's claim always stays (real stored notes)", () => {
  assert.equal(stripNonConflictSentences(PADDED), PADDED_CLAIMS);
  for (const note of STORED_NOTES) assert.equal(stripNonConflictSentences(note), note);
  const claim = "jason says to warm up for 48 hours; Ema Totaro says 5-7 days.";
  for (const padding of [
    "They otherwise agree on the setup.",
    "The rest of their steps are compatible.",
    "Both can hold for different niches.",
    "The VPN choice is compatible.",
    "Their proxies do not conflict.",
    "Using different VPN apps is not a disagreement."
  ]) {
    assert.equal(stripNonConflictSentences(`${claim} ${padding}`), claim, padding);
    assert.equal(stripNonConflictSentences(`${padding} ${claim}`), claim, padding);
  }
  // A sentence that states a side's claim stays, whatever else it says.
  const stated = "Alex Nguyen says to use only Gmail, which is not a difference of choice: he warns Outlook gets flagged.";
  assert.equal(stripNonConflictSentences(`${claim} ${stated}`), `${claim} ${stated}`);
  // A note of nothing else stays whole (never an empty note); "e.g." does not end a sentence.
  assert.equal(stripNonConflictSentences("A difference of choice, not a conflict."), "A difference of choice, not a conflict.");
  assert.equal(stripNonConflictSentences("Alex Nguyen says to use one app, e.g. Gmail. The rest is compatible."), "Alex Nguyen says to use one app, e.g. Gmail.");
});

test("a stored checked note is read without its padding sentences; the stored text is not changed", () => {
  const graph = graphOf({ x: ["ke_a"], y: ["ke_b"] }, []);
  const stored = check("ke_a", "ke_b", "contradicts", PADDED);
  const [found] = [...findContradictions({ graph, scope, pairChecks: checks([stored]), accept: () => true }).values()];
  assert.equal(found!.note, PADDED_CLAIMS);
  assert.equal(stored.note, PADDED);
});
