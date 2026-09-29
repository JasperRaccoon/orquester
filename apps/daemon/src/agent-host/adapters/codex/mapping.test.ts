/**
 * Codex adapter — the two tables, every row of the Codex column (spec §4.3,
 * §4.4, plus §4.1's capability row and §4.5's question filter).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeMode } from "@orquester/api/agent-chat";
import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import {
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
import { MINIMUM_CODEX_VERSION, codexVersionFromUserAgent, meetsMinimumVersion } from "./probe.ts";

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

  it("uses session scope for a session grant and turn scope for one-off or denied grants", () => {
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

});

describe("§4.3 options — availableDecisions is a hint, not a whitelist", () => {
  it("maps the network-policy amendment arm with its own caution", () => {
    const options = approvalOptionsFromAvailableDecisions([
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "a", action: "allow" } } }
    ] as never);
    assert.equal(options?.[0]?.decision, "acceptForSession");
    assert.ok(options?.[0]?.warning);
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
