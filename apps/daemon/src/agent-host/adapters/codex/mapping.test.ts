/**
 * Codex adapter — the two tables, every row of the Codex column (spec §4.3,
 * §4.4, plus §4.1's capability row and §4.5's question filter).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ApprovalDecision, RuntimeMode } from "@orquester/api/agent-chat";
import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import { CODEX_ADAPTER_CAPABILITIES } from "./capabilities.ts";
import {
  DEFAULT_APPROVAL_OPTIONS,
  approvalOptionsFromAvailableDecisions,
  toCommandDecision,
  toElicitationAction,
  toFileChangeDecision,
  toPermissionsResponse,
  unknownAvailableDecisions
} from "./decisions.ts";
import {
  interactionModeToCollaborationMode,
  runtimeModeToThreadConfig,
  runtimeModeToTurnSandboxPolicy
} from "./modes.ts";
import { toCodexAnswers, toUserInputQuestions, parseResumeCursor } from "./session.ts";
import { MINIMUM_CODEX_VERSION, codexVersionFromUserAgent, meetsMinimumVersion } from "./probe.ts";

const ALL_DECISIONS: ApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel"
];

describe("§4.3 decision mapping — the Codex column", () => {
  it("maps every decision on a command approval", () => {
    assert.equal(toCommandDecision("accept"), "accept");
    assert.equal(toCommandDecision("acceptForSession"), "acceptForSession");
    assert.equal(toCommandDecision("decline"), "decline");
    assert.equal(toCommandDecision("cancel"), "cancel");
  });

  it("acceptAlways downgrades to acceptForSession when no amendment is proposed", () => {
    assert.equal(toCommandDecision("acceptAlways"), "acceptForSession");
    assert.equal(toCommandDecision("acceptAlways", null), "acceptForSession");
  });

  it("acceptAlways takes the execpolicy amendment when the server proposed one", () => {
    // The nearest thing Codex has to a permanent grant, and the server offers
    // it first-class — the spec's blanket downgrade would lose it.
    assert.deepEqual(toCommandDecision("acceptAlways", ["ls", "-1"]), {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls", "-1"] }
    });
  });

  it("maps every decision on a file-change approval, with no amendment arm", () => {
    assert.equal(toFileChangeDecision("accept"), "accept");
    assert.equal(toFileChangeDecision("acceptForSession"), "acceptForSession");
    // The FileChange enum has no amendment arms at all.
    assert.equal(toFileChangeDecision("acceptAlways"), "acceptForSession");
    assert.equal(toFileChangeDecision("decline"), "decline");
    assert.equal(toFileChangeDecision("cancel"), "cancel");
  });

  it("maps every decision on an MCP elicitation", () => {
    assert.equal(toElicitationAction("accept"), "accept");
    assert.equal(toElicitationAction("acceptForSession"), "accept");
    assert.equal(toElicitationAction("acceptAlways"), "accept");
    assert.equal(toElicitationAction("decline"), "decline");
    assert.equal(toElicitationAction("cancel"), "cancel");
  });

  it("answers item/permissions/requestApproval with scope:'session' only for acceptForSession", () => {
    const requested = { network: null, fileSystem: null };
    assert.equal(toPermissionsResponse("accept", requested).scope, "turn");
    assert.equal(toPermissionsResponse("acceptForSession", requested).scope, "session");
    assert.equal(toPermissionsResponse("decline", requested).scope, "turn");
    assert.equal(toPermissionsResponse("cancel", requested).scope, "turn");
  });

  it("denying a permission answers with an EMPTY grant so it is withheld", () => {
    const requested = {
      network: { allowedDomains: ["example.test"] },
      fileSystem: null
    } as unknown as Parameters<typeof toPermissionsResponse>[1];
    assert.deepEqual(toPermissionsResponse("decline", requested).permissions, {});
    assert.deepEqual(toPermissionsResponse("cancel", requested).permissions, {});
    assert.ok("network" in toPermissionsResponse("accept", requested).permissions);
  });

  it("every decision produces a wire value on every surface", () => {
    for (const decision of ALL_DECISIONS) {
      assert.notEqual(toCommandDecision(decision), undefined);
      assert.notEqual(toFileChangeDecision(decision), undefined);
      assert.notEqual(toElicitationAction(decision), undefined);
    }
  });
});

describe("§4.3 options — availableDecisions is a hint, not a whitelist", () => {
  it("renders the provider's own set when one is advertised", () => {
    const options = approvalOptionsFromAvailableDecisions([
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls", "-1"] } },
      "cancel"
    ]);
    assert.deepEqual(
      options?.map((option) => option.decision),
      ["accept", "acceptAlways", "cancel"]
    );
    assert.ok(options?.find((option) => option.decision === "acceptAlways")?.warning !== undefined);
  });

  it("maps the network-policy amendment arm with its own caution", () => {
    const options = approvalOptionsFromAvailableDecisions([
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "a", action: "allow" } } }
    ] as never);
    assert.equal(options?.[0]?.decision, "acceptForSession");
    assert.ok(options?.[0]?.warning?.includes("network"));
  });

  it("falls back to the default four when nothing is advertised", () => {
    assert.equal(approvalOptionsFromAvailableDecisions(undefined), undefined);
    assert.equal(approvalOptionsFromAvailableDecisions(null), undefined);
    assert.equal(approvalOptionsFromAvailableDecisions([]), undefined);
    assert.deepEqual(
      DEFAULT_APPROVAL_OPTIONS.map((option) => option.decision),
      ["cancel", "decline", "acceptForSession", "accept"]
    );
  });

  it("surfaces an unrecognised advertised decision rather than rendering a wrong button", () => {
    const advertised = ["accept", "somethingNew", { futureArm: {} }] as never;
    assert.deepEqual(
      approvalOptionsFromAvailableDecisions(advertised)?.map((option) => option.decision),
      ["accept"]
    );
    assert.deepEqual(unknownAvailableDecisions(advertised), ["somethingNew", "futureArm"]);
  });

  it("de-duplicates decisions that map to the same button", () => {
    const options = approvalOptionsFromAvailableDecisions(["accept", "accept", "cancel"]);
    assert.deepEqual(
      options?.map((option) => option.decision),
      ["accept", "cancel"]
    );
  });
});

describe("§4.4 permission modes — the Codex column", () => {
  const expected: Record<
    RuntimeMode,
    { approvalPolicy: string; sandbox: string; approvalsReviewer: string; turnSandbox: string }
  > = {
    "approval-required": {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
      turnSandbox: "readOnly"
    },
    "auto-accept-edits": {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
      turnSandbox: "workspaceWrite"
    },
    auto: {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
      turnSandbox: "workspaceWrite"
    },
    "full-access": {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      turnSandbox: "dangerFullAccess"
    }
  };

  for (const mode of RUNTIME_MODES) {
    it(`${mode} maps to all three axes`, () => {
      const config = runtimeModeToThreadConfig(mode);
      assert.equal(config.approvalPolicy, expected[mode].approvalPolicy);
      assert.equal(config.sandbox, expected[mode].sandbox);
      assert.equal(config.approvalsReviewer, expected[mode].approvalsReviewer);
      assert.equal(runtimeModeToTurnSandboxPolicy(mode).type, expected[mode].turnSandbox);
    });
  }

  it("the turn-level sandbox uses a DIFFERENT spelling from the thread-level one", () => {
    for (const mode of RUNTIME_MODES) {
      assert.notEqual(
        runtimeModeToTurnSandboxPolicy(mode).type,
        runtimeModeToThreadConfig(mode).sandbox,
        `${mode}: the two spellings must not be confused`
      );
    }
  });

  it("approvalsReviewer is always set, so auto_review never stays sticky after a switch", () => {
    for (const mode of RUNTIME_MODES) {
      const reviewer = runtimeModeToThreadConfig(mode).approvalsReviewer;
      assert.ok(reviewer === "user" || reviewer === "auto_review");
    }
    // Only `auto` routes to the AI reviewer.
    assert.equal(runtimeModeToThreadConfig("auto").approvalsReviewer, "auto_review");
    assert.equal(runtimeModeToThreadConfig("full-access").approvalsReviewer, "user");
  });

  it("only full access opens the network", () => {
    for (const mode of RUNTIME_MODES) {
      const policy = runtimeModeToTurnSandboxPolicy(mode);
      if (policy.type === "dangerFullAccess") {
        continue;
      }
      assert.equal(
        (policy as { networkAccess: boolean }).networkAccess,
        false,
        `${mode} must not open the network`
      );
    }
  });
});

describe("§4.4 plan mode is sticky thread state", () => {
  it("always sends a collaborationMode, default included", () => {
    const plan = interactionModeToCollaborationMode("plan", { model: "gpt-5.5" });
    assert.equal(plan.mode, "plan");
    const def = interactionModeToCollaborationMode("default", { model: "gpt-5.5" });
    // Leaving it OFF does not return the thread to default; it must be sent.
    assert.equal(def.mode, "default");
  });

  it("sends developer_instructions: null so the server owns the prompt", () => {
    const mode = interactionModeToCollaborationMode("plan", {
      model: "gpt-5.5",
      effort: "medium"
    });
    assert.equal(mode.settings.developer_instructions, null);
    assert.equal(mode.settings.model, "gpt-5.5");
    assert.equal(mode.settings.reasoning_effort, "medium");
  });

  it("passes a null reasoning effort through rather than inventing one", () => {
    assert.equal(
      interactionModeToCollaborationMode("default", { model: "gpt-5.5" }).settings
        .reasoning_effort,
      null
    );
  });
});

describe("§4.1 the Codex capability row", () => {
  it("matches the spec's table", () => {
    assert.deepEqual(CODEX_ADAPTER_CAPABILITIES, {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: true,
      supportsConversationRollback: true,
      showPlanModeToggle: true,
      reportsContextWindow: true,
      compaction: { type: "native" }
    });
  });
});

describe("§4.1 the resume cursor", () => {
  it("is {threadId}", () => {
    assert.deepEqual(parseResumeCursor({ threadId: "t-1" }), { threadId: "t-1" });
  });

  it("a cursor that fails its own shape check means 'no resume', NEVER an error", () => {
    for (const bad of [undefined, null, {}, { threadId: "" }, { threadId: 4 }, "t-1", []]) {
      assert.equal(parseResumeCursor(bad), null);
    }
  });
});

describe("§4.5 the RPC question filter", () => {
  const option = { label: "MIT", description: "Short and permissive." };

  it("keys on `question`, not `prompt`", () => {
    const [question] = toUserInputQuestions([
      { id: "a", header: "License", question: "Which?", isOther: false, isSecret: false, options: [option] }
    ]);
    assert.equal(question?.question, "Which?");
  });

  it("drops a question missing id, header or question text", () => {
    assert.deepEqual(
      toUserInputQuestions([
        { id: "", header: "H", question: "Q", isOther: false, isSecret: false, options: [option] },
        { id: "a", header: " ", question: "Q", isOther: false, isSecret: false, options: [option] },
        { id: "a", header: "H", question: "  ", isOther: false, isSecret: false, options: [option] }
      ]),
      []
    );
  });

  it("drops an option whose label or description is empty", () => {
    const [question] = toUserInputQuestions([
      {
        id: "a",
        header: "H",
        question: "Q",
        isOther: false,
        isSecret: false,
        options: [option, { label: "", description: "d" }, { label: "l", description: "" }]
      }
    ]);
    assert.deepEqual(question?.options, [option]);
  });

  it("keeps a free-text-only question when isOther is set (options is nullable)", () => {
    const [question] = toUserInputQuestions([
      { id: "a", header: "H", question: "Q", isOther: true, isSecret: false, options: null }
    ]);
    assert.equal(question?.allowCustomAnswer, true);
    assert.deepEqual(question?.options, []);
  });

  it("drops an option-less question that is NOT isOther", () => {
    assert.deepEqual(
      toUserInputQuestions([
        { id: "a", header: "H", question: "Q", isOther: false, isSecret: false, options: null }
      ]),
      []
    );
  });

  it("carries isOther and isSecret through in the provider's own spelling (W13)", () => {
    const [plain, secret] = toUserInputQuestions([
      { id: "a", header: "H", question: "Q", isOther: true, isSecret: false, options: [option] },
      { id: "b", header: "H", question: "Q", isOther: false, isSecret: true, options: [option] }
    ]);
    assert.equal(plain?.isOther, true);
    assert.equal(plain?.allowCustomAnswer, true, "the canonical name is set too");
    assert.equal(plain?.isSecret, undefined, "absent means false");
    assert.equal(secret?.isSecret, true, "the composer masks this input");
    assert.equal(secret?.isOther, undefined);
  });

  it("hard-codes multiSelect false — the field does not exist on the wire", () => {
    const [question] = toUserInputQuestions([
      { id: "a", header: "H", question: "Q", isOther: false, isSecret: false, options: [option] }
    ]);
    assert.equal(question?.multiSelect, false);
  });

  it("answers with the LABEL, in T3's accepted shape", () => {
    assert.deepEqual(toCodexAnswers([{ id: "license" }], { license: "MIT" }), {
      license: { answers: ["MIT"] }
    });
    assert.deepEqual(toCodexAnswers([{ id: "license" }], { license: ["MIT", "Apache-2.0"] }), {
      license: { answers: ["MIT", "Apache-2.0"] }
    });
  });

  it("omits an unanswered question rather than sending it empty", () => {
    assert.deepEqual(toCodexAnswers([{ id: "a" }, { id: "b" }], { a: "x", b: "" }), {
      a: { answers: ["x"] }
    });
    assert.deepEqual(toCodexAnswers([{ id: "a" }], {}), {});
  });
});

describe("§3.2 / §10 the minimum-version gate", () => {
  it("reads the version out of initialize's userAgent, the only source", () => {
    assert.equal(
      codexVersionFromUserAgent(
        "orquester/0.154.0 (Ubuntu 24.4.0; x86_64) tmux-256color (orquester; 0.0.0)"
      ),
      "0.154.0"
    );
    assert.equal(codexVersionFromUserAgent("no-slash-here"), null);
  });

  it("refuses rather than degrades, and an unreadable version counts as unsupported", () => {
    assert.equal(meetsMinimumVersion(null, MINIMUM_CODEX_VERSION), false);
    assert.equal(meetsMinimumVersion("0.153.9", MINIMUM_CODEX_VERSION), false);
    assert.equal(meetsMinimumVersion("0.154.0", MINIMUM_CODEX_VERSION), true);
    assert.equal(meetsMinimumVersion("0.155.0", MINIMUM_CODEX_VERSION), true);
    assert.equal(meetsMinimumVersion("1.0.0", MINIMUM_CODEX_VERSION), true);
    assert.equal(meetsMinimumVersion("0.154.0-beta.1", MINIMUM_CODEX_VERSION), true);
  });
});
