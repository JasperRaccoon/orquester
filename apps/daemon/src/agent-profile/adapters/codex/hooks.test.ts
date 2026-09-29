import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CodexHookEntry,
  type CodexHooksDocument,
  type HookPosition,
  codexHookHash,
  eventSnake,
  hookEntryIds,
  hookPositionId,
  listHookEntries,
  parseHooksDocument,
  parseStateKey,
  rekeyHookState,
  stateKey
} from "./hooks.ts";

/**
 * `currentHash` values `hooks/list` of codex-cli 0.155.1 reported for these
 * handlers on a temp CODEX_HOME (2026-09-28), plus the managed hash this
 * host's own config.toml stores for Orquester's SessionStart hook.
 */
const OBSERVED: Array<{ event: string; matcher?: string; handler: Record<string, unknown>; hash: string }> = [
  { event: "PreToolUse", matcher: "Bash", handler: { type: "command", command: "echo a" }, hash: "sha256:e858b0fa107866bd5702cb2dffd866040cad81f83f76ff7697d1c7fad904b5e5" },
  { event: "PreToolUse", matcher: "Bash", handler: { type: "command", command: "echo b", timeout: 30, statusMessage: "checking" }, hash: "sha256:5fa6a66550e3dc0e5e11b9044b31400444aab83f9c2cb12d73b1d6743e7b2f4a" },
  { event: "PreToolUse", handler: { type: "command", command: "echo c", timeout: 10 }, hash: "sha256:d322f88473fb89e6e477477feaf559b76561790e1baf2e057dff59a0b84beeda" },
  { event: "SessionStart", matcher: "startup", handler: { type: "command", command: "echo ss", timeout: 5 }, hash: "sha256:9dc96a1fa042332bf2a2dfa3422047acc11757bdc6c8144cd15ac098873d57fe" },
  { event: "Stop", matcher: "ignored", handler: { type: "command", command: "echo stop", async: true }, hash: "sha256:15ef4f26bc8f6b43c1e00904949feba5dfe0587e2ee2bdb93017aab285582f31" },
  { event: "PreToolUse", matcher: "", handler: { type: "command", command: "p0", timeout: 0 }, hash: "sha256:f5759444fba192b2b36a39b4aa343b7baace6ebbeae13f50ed3af713919778fb" },
  { event: "PreToolUse", matcher: "", handler: { type: "command", command: "pbig", timeout: 100000 }, hash: "sha256:cb9bee46f9b48b1aef682bdcec27f2a54aafafa3f72656e72d3a8c7da39f62d5" },
  { event: "PreToolUse", matcher: "", handler: { type: "command", command: "psm", statusMessage: "" }, hash: "sha256:b8348d1e1fc6a9b24c9dd73feb8a36e276c04b5e57c0862d914966efe32b3804" },
  { event: "PostToolUse", matcher: "*", handler: { type: "command", command: "star" }, hash: "sha256:4d1fd78dd3dc7dea3bb2dc921611573a1e373a53eade7fb830b2618e1beb4fd3" },
  { event: "SessionEnd", handler: { type: "command", command: "se30", timeout: 30 }, hash: "sha256:bdb1ed16c8da1b2c5f196447e523fc0d7a884760f1e25aaa6ec6cac390bd0f0f" },
  { event: "SessionEnd", handler: { type: "command", command: "se0", timeout: 0 }, hash: "sha256:23bb6aec3b586018fb307a6b4243489869f4da0cea8a3590c307f97d782ea083" },
  { event: "Interrupt", handler: { type: "command", command: "i5", timeout: 5 }, hash: "sha256:a988bfa88f9b4a64f7bd8ef27104ca2c88e93b3f254608799ad3fd4cc4017dde" },
  { event: "PreToolUse", matcher: "m", handler: { type: "command", command: "echo PreToolUse" }, hash: "sha256:59627e4deef6fca60d3ee848a7a3e9973ba41f734a29cf2cf1123337daa5dacb" },
  { event: "PermissionRequest", matcher: "m", handler: { type: "command", command: "echo PermissionRequest" }, hash: "sha256:d4f731468619197ff2c9ef5e88b8331a47a0b99cef15ba1e0f3d17c18ca6e853" },
  { event: "PostToolUse", matcher: "m", handler: { type: "command", command: "echo PostToolUse" }, hash: "sha256:6ab19b6bebfe243d048a950f2acd40475c13ae4af47bef46e51ae6de216935b1" },
  { event: "PreCompact", matcher: "m", handler: { type: "command", command: "echo PreCompact" }, hash: "sha256:3e6d9b55f5a73c074c428095d57f72e169a1662f9ca5f60952d93ad1ee927210" },
  { event: "PostCompact", matcher: "m", handler: { type: "command", command: "echo PostCompact" }, hash: "sha256:d940698fb29b5b885c1ba211c93d3d8381ef34039bd942e3aee9eada80466179" },
  { event: "SessionStart", matcher: "m", handler: { type: "command", command: "echo SessionStart" }, hash: "sha256:615777f11cf2b9bc62b00c46c167708a49d029c6d617f40f39953260f2ccb936" },
  { event: "SessionEnd", matcher: "m", handler: { type: "command", command: "echo SessionEnd" }, hash: "sha256:1ade299144041005615b8554b3d5715ca33884e368c3f83a924d8a473d9802ce" },
  { event: "UserPromptSubmit", matcher: "m", handler: { type: "command", command: "echo UserPromptSubmit" }, hash: "sha256:743ba7e2ae9eb1598441def7bc593add4241e493fe567b28567db3c2b82b1a71" },
  { event: "SubagentStart", matcher: "m", handler: { type: "command", command: "echo SubagentStart" }, hash: "sha256:d271e4940d17f046729d4df019852169a2b30367119c54c2e7835d55563c199a" },
  { event: "SubagentStop", matcher: "m", handler: { type: "command", command: "echo SubagentStop" }, hash: "sha256:5f31a6c6cbc1d94edcb38e8bb6defe8bfab91c04ea80028a53103d13529ec441" },
  { event: "Stop", matcher: "m", handler: { type: "command", command: "echo Stop" }, hash: "sha256:7773e56566e95134864bef4b6cd2d68e86a6321cbd95c91839a8bf57958fd74a" },
  { event: "Interrupt", matcher: "m", handler: { type: "command", command: "echo Interrupt" }, hash: "sha256:e267be66a406f8e0d639a8e26c32750c665ae169716d5eec2f84ad49e3659d58" },
  // Stored by the real CLI in this host's ~/.codex/config.toml for Orquester's managed hook.
  {
    event: "SessionStart",
    handler: { type: "command", command: "'/var/lib/orquester/daemon/hooks/agent-hook.sh' codex SessionStart", timeout: 10 },
    hash: "sha256:14472e520f5a8261d0e0dd430909c508009d6fe37c8c616be146d4f672ab6654"
  }
];

describe("codex hooks — identity and trust", () => {

  it("reproduces the hash codex-cli 0.155.1 reports for every event and field variation", () => {
    for (const { event, matcher, handler, hash } of OBSERVED) {
      assert.equal(codexHookHash(eventSnake(event), handler, matcher), hash, `${event} ${String(handler.command)}`);
    }
  });

  it("has no hash for handlers Codex does not run", () => {
    assert.equal(codexHookHash("stop", { type: "prompt", prompt: "x" }, undefined), null);
  });

  it("parses state keys from the right, paths with colons included", () => {
    assert.deepEqual(parseStateKey("/a:b/hooks.json:pre_tool_use:2:1"), {
      path: "/a:b/hooks.json",
      eventSnake: "pre_tool_use",
      groupIndex: 2,
      handlerIndex: 1
    });
    assert.equal(parseStateKey("nonsense"), null);
  });

  it("refuses a hooks.json it could not edit safely", () => {
    assert.throws(() => parseHooksDocument("[]"), /JSON object/);
    assert.throws(() => parseHooksDocument('{"hooks": {"Stop": {}}}'), /list of matcher groups/);
    assert.throws(() => parseHooksDocument('{"hooks": {"Stop": [{"hooks": 3}]}}'), /list of handlers/);
    assert.deepEqual(parseHooksDocument('{"other": 1}'), { other: 1, hooks: {} });
  });

  it("gives identical handlers distinct ids", () => {
    const doc: CodexHooksDocument = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }, { hooks: [{ type: "command", command: "x" }] }] }
    };
    const ids = hookEntryIds(listHookEntries(doc));
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.match(ids[0], /^hook:Stop:[0-9a-f]{16}$/);
  });
});

describe("codex hooks — re-keying hooks.state", () => {
  const SYS = "/home/u/.codex/hooks.json";
  const A1 = "/appdir/agent-accounts/codex/a1/home/hooks.json";
  const A2 = "/appdir/agent-accounts/codex/a2/home/hooks.json";
  const PATHS = [SYS, A1, A2];
  const managed = (event: string) => ({ type: "command", command: `'/appdir/hooks/agent-hook.sh' codex ${event}`, timeout: 10 });

  function stateFor(doc: CodexHooksDocument, overrides: Record<string, Record<string, unknown>> = {}) {
    const state: Record<string, Record<string, unknown>> = {};
    for (const entry of listHookEntries(doc)) {
      for (const path of PATHS) {
        state[stateKey(path, entry)] = {
          enabled: true,
          trusted_hash: codexHookHash(entry.eventSnake, entry.handler, entry.matcher)!,
          ...(overrides[hookPositionId(entry)] ?? {})
        };
      }
    }
    return state;
  }

  function movedBy(before: CodexHookEntry[], after: CodexHookEntry[]): Map<string, HookPosition> {
    const moved = new Map<string, HookPosition>();
    for (const entry of after) {
      const old = before.find((candidate) => candidate.handler === entry.handler);
      if (old !== undefined) moved.set(hookPositionId(old), entry);
    }
    return moved;
  }

  function apply(state: Record<string, Record<string, unknown>>, result: ReturnType<typeof rekeyHookState>) {
    const next = { ...state };
    for (const key of result.remove) delete next[key];
    for (const [key, entry] of result.write) next[key] = entry;
    return next;
  }

  it("repairs an entry already keyed to the wrong position by its trusted hash", () => {
    const user = { type: "command", command: "mine" };
    const doc: CodexHooksDocument = { hooks: { Stop: [{ hooks: [user] }, { hooks: [managed("Stop")] }] } };
    const managedHash = codexHookHash("stop", managed("Stop"), undefined)!;
    // The managed trust sits at 0:0 (the position before a hand edit), nothing at 1:0.
    const state = { [`${SYS}:stop:0:0`]: { enabled: true, trusted_hash: managedHash } };
    const before = listHookEntries(doc);
    const result = rekeyHookState({ before, after: before, moved: movedBy(before, before), state, paths: [SYS] });
    const next = apply(state, result);
    assert.deepEqual(next[`${SYS}:stop:1:0`], { enabled: true, trusted_hash: managedHash });
    assert.equal(next[`${SYS}:stop:0:0`], undefined);
  });

  it("keeps a modified hook's entry (stale trust, its off switch) at its moved position", () => {
    const edited = { type: "command", command: "changed by hand" };
    const doc: CodexHooksDocument = { hooks: { Stop: [{ hooks: [edited] }] } };
    const state = { [`${SYS}:stop:0:0`]: { enabled: false, trusted_hash: "sha256:stale" } };
    const before = listHookEntries(doc);
    doc.hooks.Stop.unshift({ hooks: [{ type: "command", command: "new" }] });
    const after = listHookEntries(doc);
    const next = apply(state, rekeyHookState({ before, after, moved: movedBy(before, after), state, paths: [SYS] }));
    assert.deepEqual(next[`${SYS}:stop:1:0`], { enabled: false, trusted_hash: "sha256:stale" });
    assert.equal(next[`${SYS}:stop:0:0`], undefined);
  });

  it("keeps two identical handlers' own switches apart", () => {
    const a = { type: "command", command: "same" };
    const b = { type: "command", command: "same" };
    const doc: CodexHooksDocument = { hooks: { Stop: [{ hooks: [{ type: "command", command: "gone" }] }, { hooks: [a] }, { hooks: [b] }] } };
    const state = stateFor(doc, { "stop:1:0": { enabled: false } });
    const before = listHookEntries(doc);
    doc.hooks.Stop.splice(0, 1);
    const after = listHookEntries(doc);
    const next = apply(state, rekeyHookState({ before, after, moved: movedBy(before, after), state, paths: [SYS] }));
    assert.equal(next[`${SYS}:stop:0:0`].enabled, false);
    assert.equal(next[`${SYS}:stop:1:0`].enabled, true);
    assert.equal(next[`${SYS}:stop:2:0`], undefined);
  });

});
