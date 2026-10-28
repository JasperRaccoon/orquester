import assert from "node:assert/strict";
import test from "node:test";
import { conceptAttributions } from "./concept-attribution.ts";
import { KnowledgeGraph } from "./graph.ts";
import { FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";

const TIKTOK = "kc_tiktoktikt";
const alexPost = "ke_alexalexale1";
const jasonPost = "ke_jasonjasonj1";
const note = "ke_notenotenot1";
const synth = "ke_synthsynths1";
const alexOther = "ke_alexothero1";
const impostor = "ke_impostorimp1";
const claudeNote = "ke_claudeclaud1";

/**
 * The live case: a research note links Alex and jason to "Use Gmail only" and "No SIM in the phone";
 * their own posts sit on other concepts ("Gmail", "Remove the SIM card…", "Buy a used iPhone 12…").
 */
async function fixture() {
  const store = new FakeStore();
  store.collection(TIKTOK, "TikTok");
  store.put(alexPost, "Create a new iCloud account with a fresh Gmail. Remove the SIM card and stay on VPN.", [TIKTOK], { title: "US TikTok in 10 steps", author: "Alex Nguyen", handle: "alexcooldev", kind: "post", postedAt: "2026-09-01" }, true);
  store.put(alexOther, "My favourite pasta recipes.", [TIKTOK], { title: "Pasta", author: "Alex Nguyen", handle: "alexcooldev", kind: "post", postedAt: "2026-10-01" }, true);
  store.put(jasonPost, "Buy a used iPhone 12, factory reset it and take the SIM out.", [TIKTOK], { title: "jason's guide", author: "jason", handle: "jasonugc", kind: "post" }, true);
  store.put(note, "Alex and jason recommend Gmail only and no SIM in the phone.", [TIKTOK], { title: "US TikTok setup notes", author: "Claude (research)", kind: "research note" }, true);
  store.put(synth, "Guides on SIMs.", [TIKTOK], { title: "SIM map across guides", author: "Alex Nguyen", kind: "synthesis" }, true);
  // Same display name, another account.
  store.put(impostor, "Gmail tips: remove the SIM.", [TIKTOK], { title: "Other Alex", author: "Alex Nguyen", handle: "alex_other", kind: "post" }, true);
  store.put(claudeNote, "Gmail only, no SIM.", [TIKTOK], { title: "Another note", author: "Claude (research)", kind: "research note" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    [
      node("tactic-use-gmail-only", "Use Gmail only", [`${note}.md`, `${claudeNote}.md`], { type: "Tactic" }),
      node("tactic-no-sim-in-the-phone", "No SIM in the phone", [`${note}.md`], { type: "Tactic" }),
      node("tactic-remove-the-sim-card", "Remove the SIM card and stay on VPN", [`${alexPost}.md`], { type: "Tactic" }),
      node("tool-gmail", "Gmail", [`${alexPost}.md`, `${impostor}.md`], { type: "Tool" }),
      node("tactic-buy-a-used-iphone", "Buy a used iPhone 12, factory reset it and take the SIM out", [`${jasonPost}.md`], { type: "Tactic" }),
      node("tactic-pasta", "Cook pasta al dente", [`${alexOther}.md`], { type: "Tactic" }),
      node("tactic-factory-reset", "Factory reset the iPhone", [`${alexPost}.md`, `${note}.md`], { type: "Tactic" }),
      node("person-alex-nguyen", "Alex Nguyen", [`${note}.md`], { type: "Person", aliases: ["alexcooldev", "person-personalexnguyen"], attributes: { handle: { value: "alexcooldev", confidence: 1 } } }),
      node("person-jason", "jason", [`${note}.md`], { type: "Person", attributes: { handle: { value: "jasonugc", confidence: 1 } } }),
      node("person-yuan", "Yuan", [`${note}.md`], { type: "Person", attributes: { handle: { value: "yuanmunjal", confidence: 1 } } }),
      node("person-claude-research", "Claude (research)", [`${note}.md`], { type: "Person" })
    ],
    [
      edge("e1", "person-alex-nguyen", "tactic-use-gmail-only", [`${note}.md`], "recommends"),
      edge("e2", "person-alex-nguyen", "tactic-no-sim-in-the-phone", [`${note}.md`], "recommends"),
      edge("e3", "person-jason", "tactic-no-sim-in-the-phone", [`${note}.md`], "recommends"),
      edge("e4", "person-yuan", "tactic-no-sim-in-the-phone", [`${note}.md`], "recommends"),
      // Alex's own post is behind it already: nothing to add.
      edge("e5", "person-alex-nguyen", "tactic-factory-reset", [`${alexPost}.md`], "recommends"),
      edge("e6", "person-claude-research", "tactic-use-gmail-only", [`${note}.md`], "recommends"),
      // Not a claim type.
      edge("e7", "person-jason", "person-alex-nguyen", [`${note}.md`], "related_to")
    ]
  );
  const attributions = () =>
    conceptAttributions({
      concepts: graph.currentConcepts(),
      edges: graph.baseEdges(),
      canonical: (id) => graph.canonicalConceptId(id),
      entries: store.listMeta(),
      conceptsOfEntry: (id) => graph.conceptIdsOfEntry(id)
    });
  return { store, graph, attributions };
}

test("a Person linked as recommending a concept: that Person's own entry about it is attributed to it", async () => {
  const { attributions } = await fixture();
  const map = attributions();
  // Alex's post (on "Gmail" and "Remove the SIM card…") for "Use Gmail only"; not his pasta post, not
  // the other Alex's (another handle), not the synthesis under his name; not Claude's own notes.
  assert.deepEqual(map.get("tactic-use-gmail-only"), [{ entryId: alexPost, personId: "person-alex-nguyen", basis: [note] }]);
  // jason's and Alex's posts for "No SIM in the phone"; Yuan has no entry.
  assert.deepEqual(
    map.get("tactic-no-sim-in-the-phone")?.map((a) => [a.entryId, a.personId]),
    [
      [alexPost, "person-alex-nguyen"],
      [jasonPost, "person-jason"]
    ]
  );
  // Alex's own entry is behind "Factory reset the iPhone" already.
  assert.equal(map.get("tactic-factory-reset"), undefined);
  assert.equal(map.get("person-alex-nguyen"), undefined);
});

test("an author is matched by handle, or by name unless the entry's handle is another; slugs are no names", async () => {
  const { store, graph, attributions } = await fixture();
  // No handle on the entry: the display name decides.
  store.put(jasonPost, "Take the SIM out.", [TIKTOK], { title: "jason's guide", author: "Jason", handle: null, kind: "post" }, true);
  assert.ok(attributions().get("tactic-no-sim-in-the-phone")?.some((a) => a.entryId === jasonPost));
  // A handle written as the author.
  store.put(jasonPost, "Take the SIM out.", [TIKTOK], { title: "jason's guide", author: "@jasonugc", handle: null, kind: "post" }, true);
  assert.ok(attributions().get("tactic-no-sim-in-the-phone")?.some((a) => a.entryId === jasonPost));
  // Another account under the same name: not his.
  store.put(jasonPost, "Take the SIM out.", [TIKTOK], { title: "jason's guide", author: "jason", handle: "jason_elsewhere", kind: "post" }, true);
  assert.ok(!attributions().get("tactic-no-sim-in-the-phone")?.some((a) => a.entryId === jasonPost));
  // A Person known only by a machine slug matches nobody named like it.
  store.put(jasonPost, "Take the SIM out.", [TIKTOK], { title: "x", author: "person-personalexnguyen", handle: null, kind: "post" }, true);
  await loadGraph(
    graph,
    [
      node("tactic-no-sim-in-the-phone", "No SIM in the phone", [`${note}.md`], { type: "Tactic" }),
      node("tactic-buy-a-used-iphone", "Take the SIM out", [`${jasonPost}.md`], { type: "Tactic" }),
      node("person-personalexnguyen", "person-personalexnguyen", [`${note}.md`], { type: "Person", aliases: ["person-personalexnguyen"] })
    ],
    [edge("e1", "person-personalexnguyen", "tactic-no-sim-in-the-phone", [`${note}.md`], "recommends")]
  );
  assert.equal(attributions().get("tactic-no-sim-in-the-phone"), undefined);
});

test("only an entry about the concept: one linking a concept that shares a topic word with it", async () => {
  const { graph, attributions } = await fixture();
  // jason's post links only a pasta concept now: nothing of his is about SIMs.
  await loadGraph(
    graph,
    [
      node("tactic-no-sim-in-the-phone", "No SIM in the phone", [`${note}.md`], { type: "Tactic" }),
      node("tactic-pasta", "Cook pasta al dente", [`${jasonPost}.md`], { type: "Tactic" }),
      node("person-jason", "jason", [`${note}.md`], { type: "Person", attributes: { handle: { value: "jasonugc", confidence: 1 } } })
    ],
    [edge("e3", "person-jason", "tactic-no-sim-in-the-phone", [`${note}.md`], "recommends")]
  );
  assert.equal(attributions().get("tactic-no-sim-in-the-phone"), undefined);
});
