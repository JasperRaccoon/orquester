import assert from "node:assert/strict";
import test from "node:test";
import { EMBEDDING_MODEL } from "../install/pins.ts";
import { E5_SMALL_FAMILY_PARAMS, familiesOf, familyParamsFor, familyVocabularyOf, familyWords, type FamilyConcept } from "./concept-families.ts";
import { conceptEmbeddingText } from "./concept-vectors.ts";
import { OnnxSentenceEmbedder } from "./embedder.ts";

// The concept-family calibration on the pinned model (see `E5_SMALL_FAMILY_PARAMS`), on concept
// names from the live graph of 2026-10-28 and the live graph's word counts (2,979 names). Runs only
// with ORQUESTER_KG_MODEL_DIR (as in embedder.model.test.ts).
const MODEL_DIR = process.env.ORQUESTER_KG_MODEL_DIR;
const SKIP = MODEL_DIR ? false : `set ORQUESTER_KG_MODEL_DIR to a dir holding ${EMBEDDING_MODEL.id} to run`;

/** The audit's groups: each one family (every concept from its own guide). */
const GROUPS: Record<string, string[]> = {
  warmUp: [
    "Warm up the account for 48 hours before posting",
    "TikTok account warm-up",
    "Warm up each account for 3 days",
    "3-5 days of warming up",
    "Warm up the TikTok account for 5-7 days",
    "Warm up account by swiping TikToks 15-30 min with occasional like/bookmark",
    "Scroll TikTok at least 10 min every day after warm-up"
  ],
  accountsPerDevice: [
    "One device per account",
    "One new device for each US number/TikTok account",
    "Use a new device for each account",
    "2–3 accounts per device",
    "5 TikTok accounts on each iPhone",
    "Create TikTok accounts (2–3 maximum per device)"
  ],
  sim: ["No SIM in the phone", "Never keep a foreign SIM in the phone", "No SIM rather than a foreign SIM", "No SIM for US TikTok account"],
  scamalytics: [
    "Check a Scamalytics score threshold",
    "US number plus Scamalytics threshold",
    "US VPN with IP check on Scamalytics (<60)",
    "Check IP quality on IPQS/Scamalytics before creating the account"
  ],
  erased: ["Factory reset the iPhone", "Use an erased iPhone"],
  entitlements: ["Remove entitlements you don't actively use", "Remove unused entitlements"]
};

/** Close in meaning to a group, sharing only a generic or common word with it: in none of them. */
const OUTSIDERS = ["Locking accounts after chargebacks", "Offer account deletion", "Post daily on all major platforms", "One trial per IP", "Buy an ISP proxy at IPRoyal with the ip quality option and socks5 protocol"];

/** How many of the live graph's 2,979 names have each topic word of the names above. */
const LIVE_COUNTS: Record<string, number> = {
  account: 79, bookmark: 2, buy: 10, chargeback: 2, daily: 16, day: 68, deletion: 2, devic: 101, entitlement: 14, factory: 4, foreign: 2, hour: 4, ip: 19, ipq: 6,
  iproyal: 2, isp: 4, least: 4, lock: 2, major: 6, maximum: 1, min: 9, number: 25, occasional: 1, offer: 25, option: 12, platform: 19, post: 41, protocol: 1,
  proxy: 17, quality: 3, reset: 6, scamalytic: 6, scor: 32, scroll: 1, sim: 9, socks5: 2, swip: 8, threshold: 8, tiktok: 63, trial: 105, unus: 3, us: 78, vpn: 24, warm: 13
};
const LIVE_NAMES = 2_979;

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

test("concept family calibration on the pinned model: the audit's groups are families, look-alikes are not", { skip: SKIP }, async () => {
  assert.deepEqual(familyParamsFor(EMBEDDING_MODEL.id), E5_SMALL_FAMILY_PARAMS);
  const embedder = new OnnxSentenceEmbedder({
    modelDir: MODEL_DIR!,
    modelId: EMBEDDING_MODEL.id,
    dimensions: EMBEDDING_MODEL.dimensions,
    maxTokens: EMBEDDING_MODEL.maxTokens,
    queryPrefix: EMBEDDING_MODEL.queryPrefix,
    passagePrefix: EMBEDDING_MODEL.passagePrefix,
    thresholds: EMBEDDING_MODEL.thresholds
  });
  try {
    const names = [...Object.values(GROUPS).flat(), ...OUTSIDERS];
    for (const name of names) for (const word of familyWords(name)) assert.ok(word in LIVE_COUNTS, `${word} (of "${name}") has its live count`);
    const concepts: FamilyConcept[] = names.map((name, i) => ({ id: `tactic-${i}`, type: "Tactic", name, names: [name], entryIds: [`ke_entry${i}`], vectorIds: [`tactic-${i}`] }));
    const out = await embedder.embed(
      concepts.map((c) => conceptEmbeddingText({ id: c.id, type: c.type, name: c.name, aliases: [], description: null })),
      "passage"
    );
    const vectors = new Map(concepts.map((c, i) => [c.id, out[i]!]));
    const idOf = new Map(concepts.map((c) => [c.name, c.id]));
    // The look-alike the similar concepts listed (0.931 live, with descriptions): above the family bar, nothing in common but "use".
    const lookAlike = dot(vectors.get(idOf.get("Remove entitlements you don't actively use")!)!, vectors.get(idOf.get("Use an erased iPhone")!)!);
    assert.ok(lookAlike >= E5_SMALL_FAMILY_PARAMS.near, `entitlements ~ erased iPhone ${lookAlike.toFixed(3)}`);

    const families = familiesOf({ concepts, vectors, vocabulary: familyVocabularyOf(new Map(Object.entries(LIVE_COUNTS)), LIVE_NAMES) });
    const nameOf = new Map(concepts.map((c) => [c.id, c.name]));
    const groups = families.map((family) => family.concepts.map((id) => nameOf.get(id)!).sort());
    for (const [label, members] of Object.entries(GROUPS)) {
      assert.ok(
        groups.some((group) => JSON.stringify(group) === JSON.stringify([...members].sort())),
        `${label} is one family of exactly its members; families: ${JSON.stringify(groups)}`
      );
    }
    for (const outsider of OUTSIDERS) assert.ok(!groups.some((group) => group.includes(outsider)), `${outsider} is in no family`);
  } finally {
    await embedder.dispose();
  }
});
