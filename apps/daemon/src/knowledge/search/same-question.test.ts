import assert from "node:assert/strict";
import { test } from "node:test";

import { KnowledgeGraph } from "./graph.ts";
import {
  SAME_QUESTION_MIN_SIMILARITY,
  type SameQuestion,
  answeredElsewhereTest,
  compoundMainStep,
  conceptsByType,
  namesTopic,
  questionWords,
  sameQuestionByVectors,
  sameQuestionWithFamilies
} from "./same-question.ts";
import { FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";

const tactic = (id: string, name: string) => ({ id, type: "Tactic", name });

test("question words: forms folded; numbers, units, action words and words common to many names left out", () => {
  assert.deepEqual([...questionWords("Warm up the account for 48 hours before posting", new Set(["account", "post"]))], ["warm"]);
  assert.deepEqual([...questionWords("3-5 days of warming up")], ["warm"], "warming and warm meet; days is a unit");
  assert.deepEqual([...questionWords("Remove the SIM card and stay on VPN 24/7", new Set(["card"]))].sort(), ["sim", "vpn"]);
  assert.deepEqual([...questionWords("Use an erased iPhone")].sort(), ["eras", "iphon"], "erased and erase meet");
  assert.deepEqual([...questionWords("One new device for each US number/TikTok account", new Set(["new", "device", "tiktok", "account"]))], [], "a number counts, it names no subject");
});

test("the fallback rule: one type, concept vectors at the bar, and a telling name word in common", () => {
  const cosine = new Map<string, number>([
    ["a|b", SAME_QUESTION_MIN_SIMILARITY],
    ["a|c", 0.99],
    ["a|d", SAME_QUESTION_MIN_SIMILARITY - 0.001]
  ]);
  const similarity = (x: string, y: string) => cosine.get([x, y].sort().join("|")) ?? null;
  const warm48 = tactic("a", "Warm up the account for 48 hours before posting");
  const common = new Set(["account", "post"]);
  assert.equal(sameQuestionByVectors(warm48, tactic("b", "3-5 days of warming up"), similarity, common), true);
  assert.equal(sameQuestionByVectors(warm48, tactic("c", "2 posts per account per day"), similarity, common), false, "close, but only common words and units in common");
  assert.equal(sameQuestionByVectors(warm48, tactic("d", "Warm up each account for 3 days"), similarity, common), false, "below the bar");
  assert.equal(sameQuestionByVectors(warm48, { id: "b", type: "Result", name: "3-5 days of warming up" }, similarity, common), false, "another type");
  assert.equal(sameQuestionByVectors(warm48, tactic("x", "Warm up for a week"), similarity, common), false, "no vectors: no answer");
  assert.equal(sameQuestionByVectors(warm48, warm48, () => null, common), true, "a concept answers its own question");
});

test("concept families decide for their members, the fallback for concepts in none", () => {
  const families = new Map([
    ["w48", ["w48", "w35"]],
    ["w35", ["w48", "w35"]],
    ["d23", ["d23", "d5"]],
    ["d5", ["d23", "d5"]]
  ]);
  const asked: string[] = [];
  const fallback: SameQuestion = (a, b) => {
    asked.push(`${a.id}|${b.id}`);
    return true;
  };
  const rule = sameQuestionWithFamilies((id) => families.get(id) ?? null, fallback);
  assert.equal(rule(tactic("w48", "Warm up for 48 hours"), tactic("w35", "3-5 days of warming up")), true, "one family");
  assert.equal(rule(tactic("w48", "Warm up for 48 hours"), tactic("d5", "5 accounts per iPhone")), false, "two families: different questions, whatever the fallback says");
  assert.deepEqual(asked, []);
  assert.equal(rule(tactic("w48", "Warm up for 48 hours"), tactic("lone", "Scroll 15-30 min")), true, "a concept in no family: the fallback");
  assert.deepEqual(asked, ["w48|lone"]);
});

test("a compound's main step: before a colon, else its first part without a trailing qualifier; none for one part", () => {
  assert.equal(compoundMainStep("Create a new iCloud account with fresh Gmail and Apple ID"), "Create a new iCloud account");
  assert.equal(compoundMainStep("Remove the SIM card and stay on VPN 24/7"), "Remove the SIM card");
  assert.equal(compoundMainStep("UGC and slideshows system: research, make a lot, kill losers, remake winners"), "UGC and slideshows system");
  assert.equal(compoundMainStep("Use an erased iPhone"), null);
  assert.equal(compoundMainStep("Show up on both ChatGPT and Gemini"), null, "an \"and\" between names joins no steps");
  assert.equal(compoundMainStep("Install a VPN (NordVPN, Los Angeles or San Francisco) before downloading TikTok"), null, "parentheses never split");
});

test("a concept names a topic when two or more of its words, half of them, are the topic's", () => {
  assert.equal(namesTopic("Making a US-based TikTok account", "How to create a US TikTok account and target only the US (7 steps)"), true, "an entry's title");
  assert.equal(namesTopic("Targeting US users on TikTok", "US TikTok account targeting"), true, "a cluster's label");
  assert.equal(namesTopic("Warm up the TikTok account for 5-7 days", "US TikTok account targeting"), false, "a claim made under the topic");
  assert.equal(namesTopic("TikTok", "US TikTok account targeting"), false, "one word is no topic");
});

test("answered elsewhere: another entry's concept of the type answers the same question, or names a compound's main step", () => {
  const others = conceptsByType(
    ["ke_ema", "ke_claude", "ke_self"],
    (id) =>
      ({
        ke_ema: [tactic("t-icloud", "Create a US iCloud account using a virtual number via TextMe"), { id: "r-warm", type: "Result", name: "Warm-up length" }],
        ke_claude: [tactic("t-nosim", "No SIM in the phone"), tactic("t-real", "Warm up by hand like a real user")],
        ke_self: [tactic("t-own", "Something only here")]
      })[id] ?? [],
    "ke_self"
  );
  assert.deepEqual([...others.keys()].sort(), ["result", "tactic"]);
  assert.ok(!others.get("tactic")!.some((c) => c.id === "t-own"), "the entry's own concepts are left out");
  const pairs = new Set(["t-sim|t-real"]);
  const rule: SameQuestion = (a, b) => pairs.has(`${a.id}|${b.id}`);
  const common = new Set(["account", "new", "card"]);
  const answered = answeredElsewhereTest(others, rule, common);
  assert.equal(answered(tactic("t-sim", "Simulate real user behavior")), true, "the rule");
  assert.equal(answered(tactic("t-gmail", "Create a new iCloud account with fresh Gmail and Apple ID")), true, "its iCloud account step");
  assert.equal(answered(tactic("t-simvpn", "Remove the SIM card and stay on VPN 24/7")), true, "its SIM step");
  assert.equal(answered(tactic("t-sim1", "Remove the SIM card")), false, "one part: words alone are no answer");
  assert.equal(answered(tactic("t-five", "Do it daily, then weekly")), false, "a main step with no telling word");
  assert.equal(answered({ id: "t-sim", type: "Result", name: "Simulate real user behavior" }), false, "the rule is asked of the same type only");
  // Only concepts on another entry count (`elsewhere`), and no rule (nothing can answer) asks nothing.
  assert.equal(answered(tactic("t-sim", "Simulate real user behavior"), (other) => other.id !== "t-real"), false);
  assert.equal(answered(tactic("t-simvpn", "Remove the SIM card and stay on VPN 24/7"), (other) => other.id !== "t-nosim"), false);
  const unasked = answeredElsewhereTest(others, null, common);
  assert.equal(unasked(tactic("t-sim", "Simulate real user behavior")), false);
  assert.equal(unasked(tactic("t-simvpn", "Remove the SIM card and stay on VPN 24/7")), true, "the main step needs no rule");
});

test("the graph answers with the injected rule, else the fallback over concept merges' vectors; both move the backing revision", async () => {
  const store = new FakeStore();
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(graph, [
    node("tactic-w48", "Warm up the account for 48 hours before posting", ["ke_jason00000000.md"]),
    node("tactic-w35", "3-5 days of warming up", ["ke_evgeniy000000.md"]),
    node("tactic-p2", "Buy 3 used iPhones (~$100 each)", ["ke_yanme000000000.md"])
  ]);
  const w48 = tactic("tactic-w48", "Warm up the account for 48 hours before posting");
  const w35 = tactic("tactic-w35", "3-5 days of warming up");
  const p2 = tactic("tactic-p2", "Buy 3 used iPhones (~$100 each)");
  assert.equal(graph.sameQuestion(w48, w35), false, "no vectors yet: none");
  assert.equal(graph.answersSameQuestions(), false, "callers need not ask");
  const before = graph.backingRevision();
  graph.setConceptSimilarity(() => 0.95);
  assert.ok(graph.backingRevision() > before);
  assert.equal(graph.answersSameQuestions(), true);
  assert.equal(graph.sameQuestion(w48, w35), true);
  assert.equal(graph.sameQuestion(w48, p2), false, "no telling word in common");
  const revision = graph.backingRevision();
  graph.setSameQuestion((a, b) => a.id === b.id || (a.id === "tactic-w48" && b.id === "tactic-p2"));
  assert.ok(graph.backingRevision() > revision);
  assert.equal(graph.sameQuestion(w48, p2), true, "the injected rule");
  assert.equal(graph.sameQuestion(w48, w35), false, "only the injected rule");
  graph.setSameQuestion(null);
  assert.equal(graph.sameQuestion(w48, w35), true, "the fallback again");
});
