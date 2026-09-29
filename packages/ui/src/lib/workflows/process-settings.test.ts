import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowNode } from "@orquester/api";

import {
  codeLimitsSummary,
  envRowProblem,
  formatMemoryMb,
  httpBodySummary,
  httpConfigWithBodyKind,
  httpRequestSummary,
  httpResponseSummary,
  httpTimeout,
  jsonBodyProblem,
  parseStatusList,
  isReservedEnvName,
  planShellEnvVariables,
  processTimeout,
  requestRowProblem,
  shellLimitsSummary,
  statusListProblem,
  successStatusesForMode
} from "./process-settings.ts";
import { node } from "./testing.ts";

describe("limits and timeouts", () => {
  it("writes memory in GB when it is a round number of them", () => {
    assert.equal(formatMemoryMb(4096), "4 GB");
    assert.equal(formatMemoryMb(1536), "1.5 GB");
    assert.equal(formatMemoryMb(16384), "16 GB");
    assert.equal(formatMemoryMb(256), "256 MB");
    assert.equal(formatMemoryMb(3000), "3000 MB");
  });

  it("picks the timeout the daemon applies: the block's own, then the block-wide one, then the default", () => {
    assert.deepEqual(processTimeout(10, 45), { minutes: 10, source: "config" });
    assert.deepEqual(processTimeout(undefined, 45), { minutes: 45, source: "node" });
    assert.deepEqual(processTimeout(undefined, undefined), { minutes: 30, source: "default" });
    assert.deepEqual(processTimeout(5000, undefined), { minutes: 1440, source: "config" }, "capped at 24 h");
    assert.deepEqual(httpTimeout(30, 2), { seconds: 30, source: "config" });
    assert.deepEqual(httpTimeout(undefined, 2), { seconds: 120, source: "node" });
    assert.deepEqual(httpTimeout(undefined, undefined), { seconds: 300, source: "default" });
    assert.deepEqual(httpTimeout(undefined, 600), { seconds: 3600, source: "node" }, "capped at 1 h");
  });

  it("summarises a code block's limits", () => {
    assert.equal(codeLimitsSummary({}), "Default limits (4 GB, 30 min)");
    assert.equal(codeLimitsSummary({ memoryMb: 8192, timeoutMinutes: 10 }), "8 GB · 10 min");
    assert.equal(codeLimitsSummary({ memoryMb: 8192 }), "8 GB · 30 min (default)");
    assert.equal(codeLimitsSummary({ timeoutMinutes: 240 }), "4 GB (default) · 4 h");
    assert.equal(codeLimitsSummary({}, 45), "4 GB (default) · 45 min (from Run behaviour)");
  });

  it("summarises a shell block's timeout", () => {
    assert.equal(shellLimitsSummary({}), "Default timeout (30 min)");
    assert.equal(shellLimitsSummary({ timeoutMinutes: 90 }), "Times out after 1 h 30 min");
    assert.equal(shellLimitsSummary({}, 45), "Times out after 45 min (from Run behaviour)");
  });
});

describe("HTTP summaries", () => {
  const http = (config: Record<string, unknown>): Extract<WorkflowNode, { type: "http" }> =>
    node("h", "http", config) as Extract<WorkflowNode, { type: "http" }>;

  it("says the request in one line with its row counts", () => {
    assert.equal(httpRequestSummary(http({ method: "POST", url: "https://hooks.slack.com/x" })), "POST hooks.slack.com/x");
    assert.equal(
      httpRequestSummary(
        http({
          url: "https://api.example.com/items",
          query: [{ name: "a", value: "1" }],
          headers: [
            { name: "A", value: "1" },
            { name: "B", value: "2" }
          ]
        })
      ),
      "GET api.example.com/items · 1 query parameter · 2 headers"
    );
    assert.equal(httpRequestSummary(http({ url: "" })), "GET · no URL yet");
  });

  it("says what body is sent, and that GET / HEAD send none", () => {
    assert.equal(httpBodySummary({ method: "POST" }), "No body");
    assert.equal(httpBodySummary({ method: "POST", body: { kind: "json", value: "{}" } }), "JSON");
    assert.equal(httpBodySummary({ method: "PUT", body: { kind: "text", value: "a" } }), "Text (text/plain)");
    assert.equal(httpBodySummary({ method: "PUT", body: { kind: "text", value: "a", contentType: "text/csv" } }), "Text (text/csv)");
    assert.equal(httpBodySummary({ method: "PATCH", body: { kind: "form", fields: [{ name: "a", value: "" }] } }), "Form · 1 field");
    assert.equal(httpBodySummary({ method: "GET" }), "Not sent with GET");
    assert.equal(httpBodySummary({ method: "HEAD", body: { kind: "json", value: "{}" } }), "Ignored: HEAD sends no body");
  });

  it("says what counts as success, redirects and the timeout", () => {
    assert.equal(
      httpResponseSummary({ successStatuses: "2xx", followRedirects: true }),
      "Any 2xx · follows redirects · 5 min (default) timeout"
    );
    assert.equal(
      httpResponseSummary({ successStatuses: [200, 404], followRedirects: false, timeoutSeconds: 30 }),
      "Only 200, 404 · doesn't follow redirects · 30 s timeout"
    );
    assert.equal(
      httpResponseSummary({ successStatuses: "2xx", followRedirects: true }, 2),
      "Any 2xx · follows redirects · 2 min (from Run behaviour) timeout"
    );
  });
});

describe("switching the body kind and the success mode", () => {
  const base = { method: "POST", url: "https://x.test", headers: [], query: [], successStatuses: "2xx", followRedirects: true } as const;
  it("leaves the config untouched when the kind is already chosen", () => {
    const form = { ...base, body: { kind: "form", fields: [{ name: "a", value: "1" }] } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.equal(httpConfigWithBodyKind(form, "form"), form, "re-picking Form keeps its fields");
    const text = { ...base, body: { kind: "text", value: "hi", contentType: "text/csv" } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.equal(httpConfigWithBodyKind(text, "text"), text, "re-picking Text keeps its content type");
  });

  it("carries a written value across, and starts JSON as an empty object", () => {
    const text = { ...base, body: { kind: "text", value: "hi", contentType: "text/csv" } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.deepEqual(httpConfigWithBodyKind(text, "json").body, { kind: "json", value: "hi" });
    assert.deepEqual(httpConfigWithBodyKind(text, "form").body, { kind: "form", fields: [] });
    assert.equal("body" in httpConfigWithBodyKind(text, "none"), false);
    const none = base as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.deepEqual(httpConfigWithBodyKind(none, "json").body, { kind: "json", value: "{\n  \n}" });
  });

  it("keeps the success statuses when their mode is re-picked, and restores the latest list", () => {
    const list = [200, 404];
    assert.equal(successStatusesForMode(list, "list", [201]), list, "re-picking the list keeps edits");
    assert.equal(successStatusesForMode("2xx", "2xx", [201]), "2xx");
    assert.equal(successStatusesForMode(list, "2xx", list), "2xx");
    assert.deepEqual(successStatusesForMode("2xx", "list", [200, 404]), [200, 404]);
    assert.deepEqual(successStatusesForMode("2xx", "list", []), [200]);
  });
});

describe("parseStatusList / statusListProblem", () => {
  it("reads codes separated by commas, semicolons or spaces, once each, in order", () => {
    assert.deepEqual(parseStatusList("200, 201 404;200"), { statuses: [200, 201, 404], invalid: [] });
    assert.deepEqual(parseStatusList(" "), { statuses: [], invalid: [] });
  });

  it("names what isn't a status code", () => {
    assert.deepEqual(parseStatusList("200, 2xx, 99, 600, 4"), { statuses: [200], invalid: ["2xx", "99", "600", "4"] });
    assert.equal(statusListProblem("200, abc"), "“abc” isn't a status code (100–599)");
    assert.equal(statusListProblem("20, 30"), "“20”, “30” aren't status codes (100–599)");
    assert.equal(statusListProblem(""), "List at least one status code, e.g. 200");
    assert.equal(statusListProblem("200 204"), null);
  });
});

describe("jsonBodyProblem", () => {
  it("accepts JSON, with expressions standing in for values or inside strings", () => {
    assert.equal(jsonBodyProblem('{ "a": 1 }'), null);
    assert.equal(jsonBodyProblem('{ "text": {{ nodes.Review.output.text | json }} }'), null);
    assert.equal(jsonBodyProblem('{ "id": "{{ input.id }}", "n": {{ input.n }} }'), null);
    assert.equal(jsonBodyProblem('{ "q": "say \\"{{ input.word }}\\"" }'), null, "escaped quotes stay inside the string");
  });

  it("accepts exactly one expression: its value is encoded as JSON", () => {
    assert.equal(jsonBodyProblem("{{ input }}"), null);
    assert.equal(jsonBodyProblem("  {{ nodes.Fetch.output.body }}\n"), null);
  });

  it("names a body that won't parse, without positions into the stand-in text", () => {
    const problem = jsonBodyProblem('{ "a": 1, }');
    assert.ok(problem !== null && problem.startsWith("Not valid JSON: "), String(problem));
    assert.ok(!/position/.test(problem!), problem!);
    assert.ok(jsonBodyProblem("{ a: 1 }") !== null);
    assert.ok(jsonBodyProblem('{ "a": {{ input.a }} {{ input.b }} }') !== null, "two values in a row");
    assert.equal(jsonBodyProblem("   "), "Empty — a JSON body needs a value, e.g. {}");
  });

  it("leaves a broken expression to the validator", () => {
    assert.equal(jsonBodyProblem('{ "a": {{ input. }} }'), null);
  });
});

describe("planShellEnvVariables", () => {
  type Row = { name: string; value: string };
  const names = (script: string, env: Row[] = []): string[] => planShellEnvVariables(script, env).variables.map((variable) => variable.name);

  it("plans one row per distinct expression and never touches the script", () => {
    const script = 'echo {{ input.text }} "{{input.text}}" {{ nodes.Fetch.output.id }}';
    const plan = planShellEnvVariables(script, []);
    assert.deepEqual(plan.variables, [
      { name: "INPUT_TEXT", expression: "{{ input.text }}", added: true },
      { name: "FETCH_ID", expression: "{{ nodes.Fetch.output.id }}", added: true }
    ]);
    assert.deepEqual(plan.env, [
      { name: "INPUT_TEXT", value: "{{ input.text }}" },
      { name: "FETCH_ID", value: "{{ nodes.Fetch.output.id }}" }
    ]);
    assert.equal(plan.incomplete, false);
    assert.equal("script" in plan, false, "there is no rewritten script to apply");
  });

  it("names variables after what they read", () => {
    assert.deepEqual(names("echo {{ nodes.Fetch.output.body.pullRequest.id }}"), ["FETCH_PULL_REQUEST_ID"]);
    assert.deepEqual(names("echo {{ nodes.Fetch.output }}"), ["FETCH"]);
    assert.deepEqual(names("echo {{ secrets.API_TOKEN }}"), ["API_TOKEN"]);
    assert.deepEqual(names("echo {{ trigger.input | trim }}"), ["TRIGGER_INPUT"]);
    assert.deepEqual(names('echo {{ nodes["My block"].output.items[0].id }}'), ["MY_BLOCK_ITEMS_ID"]);
    assert.deepEqual(names("echo {{ input.seconds }} {{ trigger.tz }}"), ["INPUT_SECONDS", "TRIGGER_TZ"], "prefixed names are fine");
    for (const name of names("echo {{ input.a }} {{ nodes.x.output }} {{ secrets.b }}")) assert.match(name, /^[A-Z_][A-Z0-9_]*$/);
  });

  it("never suggests a name the shell, the loader or a common tool reads", () => {
    const cases: [string, string][] = [
      ["{{ secrets.PATH }}", "WF_PATH"],
      ["{{ secrets.IFS }}", "WF_IFS"],
      ["{{ secrets.PS4 }}", "WF_PS4"],
      ["{{ secrets.RANDOM }}", "WF_RANDOM"],
      ["{{ secrets.BASH_ENV }}", "WF_BASH_ENV"],
      ["{{ secrets.EDITOR }}", "WF_EDITOR"],
      ["{{ secrets.SUDO_ASKPASS }}", "WF_SUDO_ASKPASS"],
      ["{{ secrets.LESSOPEN }}", "WF_LESSOPEN"],
      ["{{ secrets.TMOUT }}", "WF_TMOUT"],
      ["{{ secrets.DOCKER_HOST }}", "WF_DOCKER_HOST"],
      ["{{ secrets.GIT_ASKPASS }}", "WF_GIT_ASKPASS"],
      ["{{ secrets.NPM_CONFIG_REGISTRY }}", "WF_NPM_CONFIG_REGISTRY"],
      ["{{ secrets.PIP_INDEX_URL }}", "WF_PIP_INDEX_URL"],
      ["{{ secrets.PYTHONSTARTUP }}", "WF_PYTHONSTARTUP"],
      ["{{ secrets.LD_PRELOAD }}", "WF_LD_PRELOAD"],
      ["{{ secrets.KUBECONFIG }}", "WF_KUBECONFIG"],
      ["{{ secrets.SSH_AUTH_SOCK }}", "WF_SSH_AUTH_SOCK"],
      ["{{ nodes.Git.output.dir }}", "WF_GIT_DIR"],
      ["{{ nodes.Docker.output.host }}", "WF_DOCKER_HOST"],
      ["{{ nodes.Hist.output.file }}", "WF_HIST_FILE"]
    ];
    for (const [expression, expected] of cases) {
      assert.deepEqual(names(`echo "${expression}"`), [expected], expression);
      assert.equal(isReservedEnvName(expected), false, expected);
    }
    assert.equal(isReservedEnvName("http_proxy"), true, "a lowercase proxy name counts too");
    assert.equal(isReservedEnvName("INPUT_TEXT"), false);
  });

  it("never takes a name a row or a word of the script already uses", () => {
    assert.deepEqual(names("echo {{ input.text }}", [{ name: "INPUT_TEXT", value: "other" }]), ["INPUT_TEXT_2"]);
    assert.deepEqual(names('VERSION=1.0; echo "{{ nodes.Version.output }}" "$VERSION"'), ["VERSION_2"]);
    assert.deepEqual(names("for INPUT_A in 1; do echo {{ input.a }}; done"), ["INPUT_A_2"]);
    assert.deepEqual(names("echo {{ secrets.API_TOKEN }}"), ["API_TOKEN"], "words inside the expressions don't count");
    assert.deepEqual(names("echo {{ input.a }} {{ input.a | trim }}", [{ name: "INPUT_A_2", value: "x" }]), ["INPUT_A", "INPUT_A_3"]);
    const plan = planShellEnvVariables("echo {{ input.text }}", [{ name: "", value: "" }, { name: "1BAD", value: "{{ input.text }}" }]);
    assert.deepEqual(plan.variables, [{ name: "INPUT_TEXT", expression: "{{ input.text }}", added: true }], "a row with an unusable name isn't reused");
  });

  it("reuses a row only when it holds exactly that expression and wins at run time", () => {
    assert.deepEqual(planShellEnvVariables("echo {{input.a}}", [{ name: "A", value: "{{ input.a }}" }]).variables, [
      { name: "A", expression: "{{input.a}}", added: false }
    ]);
    assert.deepEqual(names("echo {{ input.a }}", [{ name: "A", value: " {{ input.a }}" }]), ["INPUT_A"], "surrounding spaces are part of its value");
    assert.deepEqual(names("echo {{ input.a }}", [{ name: "A", value: "x{{ input.a }}" }]), ["INPUT_A"], "surrounding text");
    assert.deepEqual(names("echo {{ input.a }}", [{ name: "A", value: "{{ input.a | trim }}" }]), ["INPUT_A"], "another expression");
    assert.deepEqual(
      names("echo {{ input.a }}", [
        { name: "A", value: "{{ input.a }}" },
        { name: "A", value: "other" }
      ]),
      ["INPUT_A"],
      "a later row with the same name wins at run time"
    );
    assert.deepEqual(names("echo {{ input.a }}", [{ name: "PATH", value: "{{ input.a }}" }]), ["INPUT_A"], "a reserved name isn't suggested");
  });

  it("doesn't reuse a row the script itself sets or reads other than as $NAME", () => {
    const row = [{ name: "A", value: "{{ input.a }}" }];
    assert.deepEqual(names('A=x; echo "$A" {{ input.a }}', row), ["INPUT_A"]);
    assert.deepEqual(names("read A; echo {{ input.a }}", row), ["INPUT_A"]);
    assert.deepEqual(names("declare -n A=B; echo {{ input.a }}", row), ["INPUT_A"]);
    assert.deepEqual(names("echo ${A:=x} {{ input.a }}", row), ["INPUT_A"]);
    assert.deepEqual(names('echo "$A" "${A}" {{ input.a }}', row), ["A"], "plain reads are fine");
  });

  it("keeps every row as it was, fields a newer version wrote included", () => {
    const rows = [{ name: "KEEP", value: "1", note: "kept" } as Row, { name: "A", value: "{{ input.a }}", secret: true } as Row];
    const plan = planShellEnvVariables("echo {{ input.a }} {{ input.b }}", rows);
    assert.deepEqual(plan.env, [
      { name: "KEEP", value: "1", note: "kept" },
      { name: "A", value: "{{ input.a }}", secret: true },
      { name: "INPUT_B", value: "{{ input.b }}" }
    ]);
    assert.notEqual(plan.env[0], rows[0], "rows are copied, not shared");
  });

  it("adds nothing the second time, also once the script reads the variables", () => {
    const script = 'VERSION=2; echo {{ input.a }} "{{ secrets.PATH }}" {{ input.a }}';
    const first = planShellEnvVariables(script, [{ name: "X", value: "y" }]);
    assert.deepEqual(first.variables.map((variable) => variable.name), ["INPUT_A", "WF_PATH"]);
    const second = planShellEnvVariables(script, first.env);
    assert.deepEqual(second.env, first.env);
    assert.deepEqual(second.variables.map((variable) => [variable.name, variable.added]), [
      ["INPUT_A", false],
      ["WF_PATH", false]
    ]);
    // Half-way through replacing them by hand: the variables are still the rows already added.
    const halfDone = planShellEnvVariables('VERSION=2; echo "$INPUT_A" "{{ secrets.PATH }}" {{ input.a }}', first.env);
    assert.deepEqual(halfDone.env, first.env);
    assert.equal(halfDone.variables.every((variable) => !variable.added), true);
  });

  it("leaves Go-style {{.Field}} alone and notes a broken expression", () => {
    assert.deepEqual(names("gh pr list --template '{{.title}}' --repo {{ input.repo }}"), ["INPUT_REPO"]);
    const broken = planShellEnvVariables("echo {{ input.a", []);
    assert.deepEqual(broken.variables, []);
    assert.equal(broken.incomplete, true);
    assert.equal(planShellEnvVariables("echo hello", []).variables.length, 0);
  });
});

describe("row notes", () => {
  it("flags environment names the shell block fails on, and repeats", () => {
    const rows = [
      { name: "", value: "x" },
      { name: "1BAD", value: "" },
      { name: "OK", value: "a" },
      { name: "OK", value: "b" }
    ];
    assert.match(envRowProblem(rows, 0).warning!, /without one/);
    assert.match(envRowProblem(rows, 1).error!, /Letters, digits and _/);
    assert.deepEqual(envRowProblem(rows, 2), { error: null, warning: "Set again in row 4; the last one wins." });
    assert.deepEqual(envRowProblem(rows, 3), { error: null, warning: null });
  });

  it("flags header names the HTTP block fails on and nameless rows it skips", () => {
    const rows = [
      { name: "X-Token", value: "a" },
      { name: "Bad Header", value: "a" },
      { name: "", value: "orphan" },
      { name: "", value: "" }
    ];
    assert.deepEqual(requestRowProblem(rows, 0, "header"), { error: null, warning: null });
    assert.match(requestRowProblem(rows, 1, "header").error!, /valid header name/);
    assert.deepEqual(requestRowProblem(rows, 1, "query"), { error: null, warning: null }, "a query name may hold spaces");
    assert.match(requestRowProblem(rows, 2, "query").warning!, /left out/);
    assert.deepEqual(requestRowProblem(rows, 3, "header"), { error: null, warning: null }, "a fresh empty row says nothing");
  });
});
