import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  envRowProblem,
  httpConfigWithBodyKind,
  jsonBodyProblem,
  parseStatusList,
  planShellEnvVariables,
  requestRowProblem,
  statusListProblem,
  successStatusesForMode
} from "./process-settings.ts";

describe("switching the body kind and the success mode", () => {
  const base = { method: "POST", url: "https://x.test", headers: [], query: [], successStatuses: "2xx", followRedirects: true } as const;
  it("leaves the config untouched when the kind is already chosen", () => {
    const form = { ...base, body: { kind: "form", fields: [{ name: "a", value: "1" }] } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.deepEqual(httpConfigWithBodyKind(form, "form"), form, "re-picking Form keeps its fields");
    const text = { ...base, body: { kind: "text", value: "hi", contentType: "text/csv" } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.deepEqual(httpConfigWithBodyKind(text, "text"), text, "re-picking Text keeps its content type");
  });

  it("carries a written value across, and starts JSON as an empty object", () => {
    const text = { ...base, body: { kind: "text", value: "hi", contentType: "text/csv" } } as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    assert.deepEqual(httpConfigWithBodyKind(text, "json").body, { kind: "json", value: "hi" });
    assert.deepEqual(httpConfigWithBodyKind(text, "form").body, { kind: "form", fields: [] });
    assert.equal("body" in httpConfigWithBodyKind(text, "none"), false);
    const none = base as unknown as Parameters<typeof httpConfigWithBodyKind>[0];
    const body = httpConfigWithBodyKind(none, "json").body!;
    assert.equal(body.kind, "json");
    assert.deepEqual(JSON.parse((body as { value: string }).value), {});
  });

  it("keeps the success statuses when their mode is re-picked, and restores the latest list", () => {
    const list = [200, 404];
    assert.deepEqual(successStatusesForMode(list, "list", [201]), list, "re-picking the list keeps edits");
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
    assert.ok(statusListProblem("200, abc"));
    assert.ok(statusListProblem("20, 30"));
    assert.ok(statusListProblem(""));
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
    assert.ok(problem);
    assert.ok(!/position/.test(problem!), problem!);
    assert.ok(jsonBodyProblem("{ a: 1 }") !== null);
    assert.ok(jsonBodyProblem('{ "a": {{ input.a }} {{ input.b }} }') !== null, "two values in a row");
    assert.ok(jsonBodyProblem("   "));
  });
});

describe("planShellEnvVariables", () => {
  type Row = { name: string; value: string };
  const names = (script: string, env: Row[] = []): string[] => {
    const proposed = planShellEnvVariables(script, env).variables.map((variable) => variable.name);
    assert.ok(proposed.length > 0, "each supplied expression needs a variable");
    for (const name of proposed) assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    return proposed;
  };

  it("plans one row per distinct expression", () => {
    const plan = planShellEnvVariables('echo {{ input.text }} "{{input.text}}" {{ nodes.Fetch.output.id }}', []);
    const expressions = ["{{ input.text }}", "{{ nodes.Fetch.output.id }}"];
    assert.deepEqual(plan.env.map((row) => row.value), expressions);
    assert.deepEqual(plan.variables.map((variable) => variable.expression), expressions);
    assert.equal(new Set(plan.env.map((row) => row.name)).size, 2);
    for (const variable of plan.variables) {
      assert.equal(plan.env.find((row) => row.name === variable.name)?.value, variable.expression);
      assert.equal(variable.added, true);
    }
    assert.equal(plan.incomplete, false);
  });

  it("never suggests a name the shell, the loader or a common tool reads", () => {
    // These names have externally defined shell/loader/tool behavior.
    const reserved = ["PATH", "IFS", "PS4", "RANDOM", "BASH_ENV", "EDITOR", "SUDO_ASKPASS",
      "LESSOPEN", "TMOUT", "DOCKER_HOST", "GIT_ASKPASS", "NPM_CONFIG_REGISTRY", "PIP_INDEX_URL",
      "PYTHONSTARTUP", "LD_PRELOAD", "KUBECONFIG", "SSH_AUTH_SOCK", "GIT_DIR", "HIST_FILE", "HTTP_PROXY"];
    const expressions = [
      ...reserved.map((name) => `{{ secrets.${name} }}`),
      "{{ secrets.http_proxy }}", "{{ nodes.Git.output.dir }}", "{{ nodes.Docker.output.host }}", "{{ nodes.Hist.output.file }}"
    ];
    for (const expression of expressions) {
      const plan = planShellEnvVariables(`echo "${expression}"`, []);
      assert.equal(plan.env.length, 1);
      const row = plan.env[0]!;
      assert.match(row.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      assert.equal(reserved.includes(row.name.toUpperCase()), false, expression);
      assert.equal(row.value, expression);
    }
  });

  it("never takes a name a row or a word of the script already uses", () => {
    const occupied = "INPUT_TEXT";
    assert.notEqual(names("echo {{ input.text }}", [{ name: occupied, value: "other" }])[0], occupied);
    assert.notEqual(names('VERSION=1.0; echo "{{ nodes.Version.output }}" "$VERSION"')[0], "VERSION");
    assert.notEqual(names("for INPUT_A in 1; do echo {{ input.a }}; done")[0], "INPUT_A");
    const planned = names("echo {{ input.a }} {{ input.a | trim }}", [{ name: "INPUT_A_2", value: "x" }]);
    assert.equal(planned.length, 2);
    assert.equal(new Set(planned).size, 2);
    assert.equal(planned.includes("INPUT_A_2"), false);
    const plan = planShellEnvVariables("echo {{ input.text }}", [{ name: "", value: "" }, { name: "1BAD", value: "{{ input.text }}" }]);
    assert.equal(plan.variables[0]?.added, true, "a row with an unusable name isn't reused");
    assert.match(plan.variables[0]!.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it("reuses a row only when it holds exactly that expression and wins at run time", () => {
    assert.deepEqual(planShellEnvVariables("echo {{input.a}}", [{ name: "A", value: "{{ input.a }}" }]).variables, [
      { name: "A", expression: "{{input.a}}", added: false }
    ]);
    assert.notEqual(names("echo {{ input.a }}", [{ name: "A", value: " {{ input.a }}" }])[0], "A", "surrounding spaces are part of its value");
    assert.notEqual(names("echo {{ input.a }}", [{ name: "A", value: "x{{ input.a }}" }])[0], "A", "surrounding text");
    assert.notEqual(names("echo {{ input.a }}", [{ name: "A", value: "{{ input.a | trim }}" }])[0], "A", "another expression");
    assert.notEqual(
      names("echo {{ input.a }}", [
        { name: "A", value: "{{ input.a }}" },
        { name: "A", value: "other" }
      ])[0],
      "A",
      "a later row with the same name wins at run time"
    );
    assert.notEqual(names("echo {{ input.a }}", [{ name: "PATH", value: "{{ input.a }}" }])[0], "PATH", "a reserved name isn't suggested");
  });

  it("doesn't reuse a row the script itself sets or reads other than as $NAME", () => {
    const row = [{ name: "A", value: "{{ input.a }}" }];
    assert.notEqual(names('A=x; echo "$A" {{ input.a }}', row)[0], "A");
    assert.notEqual(names("read A; echo {{ input.a }}", row)[0], "A");
    assert.notEqual(names("declare -n A=B; echo {{ input.a }}", row)[0], "A");
    assert.notEqual(names("echo ${A:=x} {{ input.a }}", row)[0], "A");
    assert.deepEqual(names('echo "$A" "${A}" {{ input.a }}', row), ["A"], "plain reads are fine");
  });

  it("keeps every row as it was, fields a newer version wrote included", () => {
    const rows = [{ name: "KEEP", value: "1", note: "kept" } as Row, { name: "A", value: "{{ input.a }}", secret: true } as Row];
    const plan = planShellEnvVariables("echo {{ input.a }} {{ input.b }}", rows);
    assert.deepEqual(plan.env.slice(0, 2), rows);
    assert.equal(plan.env.length, 3);
    assert.equal(plan.env[2]?.value, "{{ input.b }}");
  });

  it("adds nothing the second time, also once the script reads the variables", () => {
    const script = 'VERSION=2; echo {{ input.a }} "{{ secrets.PATH }}" {{ input.a }}';
    const first = planShellEnvVariables(script, [{ name: "X", value: "y" }]);
    const second = planShellEnvVariables(script, first.env);
    assert.deepEqual(second.env, first.env);
    assert.equal(second.variables.length, first.variables.length);
    assert.equal(second.variables.every((variable) => !variable.added), true);
    const [input] = first.variables;
    assert.ok(input);
    // Halfway through manual replacement, already allocated variables are reused.
    const halfDone = planShellEnvVariables(`VERSION=2; echo "$${input.name}" "{{ secrets.PATH }}" {{ input.a }}`, first.env);
    assert.deepEqual(halfDone.env, first.env);
    assert.equal(halfDone.variables.length, first.variables.length);
    assert.equal(halfDone.variables.every((variable) => !variable.added), true);
  });

  it("leaves Go-style {{.Field}} alone and notes a broken expression", () => {
    assert.deepEqual(planShellEnvVariables("gh pr list --template '{{.title}}' --repo {{ input.repo }}", []).variables.map((variable) => variable.expression), ["{{ input.repo }}"]);
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
    assert.ok(envRowProblem(rows, 0).warning);
    assert.ok(envRowProblem(rows, 1).error);
    assert.equal(envRowProblem(rows, 2).error, null);
    assert.ok(envRowProblem(rows, 2).warning);
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
    assert.ok(requestRowProblem(rows, 1, "header").error);
    assert.deepEqual(requestRowProblem(rows, 1, "query"), { error: null, warning: null }, "a query name may hold spaces");
    assert.ok(requestRowProblem(rows, 2, "query").warning);
    assert.deepEqual(requestRowProblem(rows, 3, "header"), { error: null, warning: null }, "a fresh empty row says nothing");
  });
});
