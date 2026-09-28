import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateExpression,
  hasTemplate,
  parseTemplate,
  renderTemplate,
  renderTemplateValue,
  rewriteNodeReferences,
  singleExpression,
  type ExpressionContext
} from "./expressions.ts";

function ctx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    nodes: {
      Fetch: { status: "succeeded", output: { tickets: [{ key: "A-1" }, { key: "A-2" }], count: 2, empty: "", nil: null } },
      Review: { status: "succeeded", output: { text: "Looks good\nline two\nline three" } },
      Broken: { status: "failed", error: { kind: "exit_code", message: "exit 1" } }
    },
    input: { a: 1, list: [1, 2, 3], nested: { deep: { value: "x" } }, "odd key": true },
    trigger: { kind: "manual", input: { n: 5 } },
    run: { id: "r1", attempt: 1 },
    project: { name: "app", path: "/w/ws/app" },
    secrets: { TOKEN: "s3cret-value", SHORT: "ab" },
    ...overrides
  };
}

function render(src: string, context = ctx()) {
  return renderTemplate(src, context);
}

describe("parseTemplate", () => {
  it("parses dot, index and quoted keys, and filters with arguments", () => {
    assert.equal(render(`{{nodes.Fetch.output.tickets[0]["key"] | default("none") | lines(2) | upper}}`).text, "A-1");
  });

  it("accepts literal kinds in filter arguments", () => {
    for (const [arg, value] of [
      ['"x"', "x"],
      ["'y'", "y"],
      ["42", 42],
      ["-1.5", -1.5],
      ["true", true],
      ["false", false],
      ["null", null]
    ] as const) {
      assert.deepEqual(renderTemplateValue(`{{ input.x | default(${arg}) }}`, ctx()).value, value);
    }
  });

  it("reports syntax errors and keeps the broken text literal", () => {
    const cases: [string, RegExp][] = [
      ["{{ }}", /Empty expression/],
      ["{{ foo.bar }}", /Unknown "foo"/],
      ["{{ input. }}", /Expected a name/],
      ["{{ input.list.0 }}", /Use \[0\]/],
      ["{{ input[-1] }}", /whole number/],
      ["{{ input[1.5] }}", /whole number/],
      ["{{ input | nope }}", /Unknown filter "nope"/],
      ["{{ input | default }}", /takes 1 argument/],
      ["{{ input | json(1) }}", /takes no arguments/],
      ["{{ input | lines(\"a\") }}", /lines\(n\)/],
      ["{{ input input }}", /use "\|" before a filter/],
      ["{{ input | default(\"a) }}", /not closed/],
      ["{{ input.__proto__ }}", /cannot be read/],
      ['{{ input["constructor"] }}', /cannot be read/],
      ["{{ input.prototype }}", /cannot be read/],
      ["{{ input { }}", /Unexpected character/],
      ["{{ 12 }}", /starts with one of/],
      ["{{ input[\"a\" }}", /Expected "\]"/],
      ["{{ input | default(input) }}", /filter argument/]
    ];
    for (const [src, message] of cases) {
      const parsed = parseTemplate(`a ${src} b`);
      assert.equal(parsed.errors.length, 1, src);
      assert.match(parsed.errors[0]!.message, message, src);
      assert.equal(render(`a ${src} b`).text, `a ${src} b`, src);
    }
  });

  it("an unclosed {{ is an error and the rest is text", () => {
    const parsed = parseTemplate("x {{ nodes.A.output");
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0]!.message, /not closed/);
    assert.equal(parsed.errors[0]!.root, "nodes");
    assert.equal(render("x {{ nodes.A.output").text, "x {{ nodes.A.output");
  });

  it("finds the closing braces past quoted }}", () => {
    assert.equal(render('{{ input.nope | default("}}") }}').text, "}}");
  });

  it("\\{{ is a literal", () => {
    assert.equal(render("a \\{{ input.a }} b").text, "a {{ input.a }} b");
    assert.equal(render("\\{{x}} and {{ input.a }}").text, "{{x}} and 1");
  });

  it("caps path depth", () => {
    const ok = `{{ input${".a".repeat(32)} }}`;
    assert.deepEqual(parseTemplate(ok).errors, []);
    const deep = `{{ input${".a".repeat(33)} }}`;
    assert.match(parseTemplate(deep).errors[0]!.message, /at most 32/);
  });

  it("does not parse a template over the length cap", () => {
    const huge = "{{ input.a }}" + "x".repeat(1024 * 1024);
    const parsed = parseTemplate(huge);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0]!.message, /longer than/);
    assert.equal(render(huge).text, huge);
  });

  it("handles many expressions and hostile input without blowing up", () => {
    const many = "{{ input.a }}".repeat(20_000);
    assert.equal(render(many).text, "1".repeat(20_000));
    const braces = "{".repeat(50_000) + "}".repeat(50_000);
    const result = render(braces);
    assert.ok(result.warnings.length >= 1);
    const quotes = `{{ input.nope | default("${"\\".repeat(5000)}") }}`;
    assert.equal(render(quotes).text, "\\".repeat(2500));
    assert.match(parseTemplate(`{{ input | default("${"a".repeat(5000)}") }}`).errors[0]!.message, /longer than 4096/);
  });
});

describe("renderTemplate", () => {
  it("inserts strings as they are and anything else as pretty JSON", () => {
    assert.equal(render("{{ nodes.Review.output.text | lines(1) }}").text, "Looks good");
    assert.equal(render("n={{ input.a }}").text, "n=1");
    assert.equal(render("{{ input.list }}").text, "[\n  1,\n  2,\n  3\n]");
    assert.equal(render("{{ input.nested }}").text, JSON.stringify({ deep: { value: "x" } }, null, 2));
    assert.equal(render("{{ nodes.Fetch.output.nil }}").text, "null");
    assert.equal(render('{{ input["odd key"] }}').text, "true");
  });

  it("reads node status and error", () => {
    assert.equal(render("{{ nodes.Broken.status }}: {{ nodes.Broken.error.message }}").text, "failed: exit 1");
  });

  it("a missing path renders empty and warns with the expression", () => {
    const result = render("[{{ nodes.Fetch.output.nope.deeper }}]");
    assert.equal(result.text, "[]");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /nodes\.Fetch\.output\.nope\.deeper/);
    assert.match(result.warnings[0]!, /nothing at nodes\.Fetch\.output\.nope/);
    assert.match(render("{{ nodes.Unknown.output }}").warnings[0]!, /nothing at nodes\.Unknown/);
    assert.equal(render("{{ input.list[9] }}").text, "");
    assert.equal(render("{{ workflow.name }}").warnings.length, 1);
  });

  it("default() fills a missing, null or empty value and silences the warning", () => {
    assert.deepEqual(render('{{ input.nope | default("none") }}'), { text: "none", warnings: [] });
    assert.equal(render('{{ nodes.Fetch.output.nil | default("x") }}').text, "x");
    assert.equal(render('{{ nodes.Fetch.output.empty | default("x") }}').text, "x");
    assert.equal(render('{{ input.a | default("x") }}').text, "1");
    assert.equal(render("{{ input.nope | default(3) }}").text, "3");
    assert.equal(render('{{ input.nope | upper | default("later") }}').text, "later");
  });

  it("filters", () => {
    assert.equal(render("{{ input | compact }}").text, JSON.stringify(ctx().input));
    assert.equal(render("{{ input.list | json }}").text, "[\n  1,\n  2,\n  3\n]");
    assert.equal(render('{{ nodes.Review.output.text | json }}').text, JSON.stringify("Looks good\nline two\nline three"));
    assert.equal(render("{{ input.nested.deep.value | upper }}").text, "X");
    assert.equal(render("{{ project.name | upper | lower }}").text, "app");
    assert.equal(render('{{ input.nope | default("  pad  ") | trim }}').text, "pad");
    assert.equal(render("{{ nodes.Review.output.text | lines(2) }}").text, "Looks good\nline two");
    assert.equal(render("{{ nodes.Review.output.text | lines(0) }}").text, "");
    assert.equal(render("{{ input.list | first }}").text, "1");
    assert.equal(render("{{ input.list | last }}").text, "3");
    assert.equal(render("{{ nodes.Fetch.output.tickets | last }}").text, JSON.stringify({ key: "A-2" }, null, 2));
    assert.equal(render("{{ project.name | first }}").text, "a");
    assert.equal(render("{{ input.list | length }}").text, "3");
    assert.equal(render("{{ project.name | length }}").text, "3");
    assert.equal(render("{{ input.nested | length }}").text, "1");
    assert.equal(render("{{ input.list.length }}").text, "3");
  });

  it("filter misuse warns and renders empty", () => {
    const first = render("{{ input.a | first }}");
    assert.equal(first.text, "");
    assert.match(first.warnings[0]!, /needs a list or a text/);
    assert.match(render("{{ input.a | length }}").warnings[0]!, /"length" needs/);
    assert.equal(render('{{ nodes.Fetch.output.empty | first | default("-") }}').text, "-");
  });

  it("a cyclic value warns rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = render("{{ input | json }}", ctx({ input: cyclic }));
    assert.equal(result.text, "");
    assert.match(result.warnings[0]!, /cannot be written as JSON/);
    assert.equal(render("{{ input }}", ctx({ input: cyclic })).text, "");
  });

  it("broken expressions stay as written and warn", () => {
    const result = render("a {{ oops }} b {{ input.a }}");
    assert.equal(result.text, "a {{ oops }} b 1");
    assert.match(result.warnings[0]!, /Template error: Unknown "oops"/);
  });

  it("escapeValue applies to inserted values only", () => {
    const result = renderTemplate("{date} {{ input.v }}", ctx({ input: { v: "{diff}" } }), {
      escapeValue: (text) => text.replace(/\{/g, "{{").replace(/\}/g, "}}")
    });
    assert.equal(result.text, "{date} {{diff}}");
  });
});

describe("safety", () => {
  it("never reads inherited properties", () => {
    for (const src of [
      "{{ input.toString }}",
      "{{ input.hasOwnProperty }}",
      "{{ input.valueOf }}",
      "{{ input.list.map }}",
      "{{ project.name.length }}",
      "{{ input.a.toFixed }}",
      "{{ run.__defineGetter__ }}"
    ]) {
      const result = render(src);
      assert.equal(result.text, "", src);
      assert.equal(result.warnings.length, 1, src);
    }
  });

  it("does not traverse non-plain objects", () => {
    const date = new Date(0);
    assert.equal(render("{{ input.d.getTime }}", ctx({ input: { d: date } })).text, "");
    class Thing {
      field = 1;
    }
    assert.equal(render("{{ input.t.field }}", ctx({ input: { t: new Thing() } })).text, "");
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = "v";
    assert.equal(render("{{ input.b.k }}", ctx({ input: { b: bare } })).text, "v");
  });

  it("own JSON keys that look dangerous are refused at parse time", () => {
    const polluted = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    const result = render('{{ input["__proto__"].x }}', ctx({ input: polluted }));
    assert.equal(result.text, '{{ input["__proto__"].x }}');
    assert.match(result.warnings[0]!, /cannot be read/);
  });

  it("secrets must name exactly one secret", () => {
    assert.equal(render("{{ secrets.TOKEN }}").text, "s3cret-value");
    const bare = render("{{ secrets }}");
    assert.equal(bare.text, "");
    assert.match(bare.warnings[0]!, /exactly one secret/);
    assert.equal(render("{{ secrets | json }}").text, "");
    assert.equal(render("{{ secrets.TOKEN.length }}").text, "");
    assert.equal(render("{{ secrets.NOPE }}").text, "");
    assert.equal(render("{{ secrets[0] }}").text, "");
    assert.equal(render('{{ secrets.NOPE | default("d") }}').text, "d");
  });

  it("a context missing a root reads as missing", () => {
    const partial = { nodes: {}, secrets: {} } as unknown as ExpressionContext;
    assert.equal(render("{{ input.a }}", partial).text, "");
    assert.equal(render("{{ trigger }}", partial).warnings.length, 1);
  });
});

describe("renderTemplateValue", () => {
  it("a single expression yields the raw value", () => {
    assert.deepEqual(renderTemplateValue("{{ input.list }}", ctx()).value, [1, 2, 3]);
    assert.equal(renderTemplateValue("  {{ input.a }}\n", ctx()).value, 1);
    assert.equal(renderTemplateValue("{{ input.nested.deep.value | upper }}", ctx()).value, "X");
    assert.equal(renderTemplateValue("{{ input.list | length }}", ctx()).value, 3);
    const missing = renderTemplateValue("{{ input.nope }}", ctx());
    assert.equal(missing.value, undefined);
    assert.equal(missing.warnings.length, 1);
  });

  it("anything else renders as text", () => {
    assert.equal(renderTemplateValue("n={{ input.a }}", ctx()).value, "n=1");
    assert.equal(renderTemplateValue("{{ input.a }}{{ input.a }}", ctx()).value, "11");
    assert.equal(renderTemplateValue("plain", ctx()).value, "plain");
    assert.equal(renderTemplateValue("{{ bad }}", ctx()).value, "{{ bad }}");
  });
});

describe("evaluateExpression", () => {
  it("reports missing separately from the value", () => {
    const expr = singleExpression("{{ nodes.Fetch.output.count }}")!;
    assert.deepEqual(evaluateExpression(expr, ctx()), { value: 2, missing: false, warnings: [] });
    const gone = evaluateExpression(singleExpression("{{ nodes.Fetch.output.x }}")!, ctx());
    assert.equal(gone.missing, true);
    assert.equal(gone.value, undefined);
  });
});

describe("references", () => {
  it("hasTemplate: workflow expressions only", () => {
    assert.equal(hasTemplate("echo {{ input.a }}"), true);
    assert.equal(hasTemplate("echo {{ nodes.A.output"), true, "an unclosed expression is still an attempt");
    assert.equal(hasTemplate("echo {{ secrets.X | nope }}"), true, "a broken expression with a root");
    assert.equal(hasTemplate("docker inspect -f '{{.State.Status}}' app"), false);
    assert.equal(hasTemplate("echo \\{{ input }}"), false);
    assert.equal(hasTemplate("echo $HOME"), false);
  });
});

describe("rewriteNodeReferences", () => {
  it("rewrites dot and bracket references, preserving the rest", () => {
    const src = "A {{nodes.Old.output.text}} B {{ nodes['Old'].status | upper }} C {{ nodes.Older.output }} D {{ input.Old }}";
    assert.equal(
      rewriteNodeReferences(src, "Old", "New"),
      "A {{nodes.New.output.text}} B {{ nodes['New'].status | upper }} C {{ nodes.Older.output }} D {{ input.Old }}"
    );
    assert.equal(rewriteNodeReferences('{{ nodes["Old"] }}', "Old", "N2"), '{{ nodes["N2"] }}');
  });

  it("leaves escapes, broken expressions and unrelated text alone", () => {
    const src = "\\{{ nodes.Old.output }} {{ nodes.Old.output | nope }} nodes.Old";
    assert.equal(rewriteNodeReferences(src, "Old", "New"), src);
    assert.equal(rewriteNodeReferences("{{ nodes.Old }}", "Old", "Old"), "{{ nodes.Old }}");
  });

  it("round-trips several references in one template", () => {
    const src = "{{ nodes.X.output }}-{{ nodes.X.status }}-{{ nodes.X.error }}";
    const renamed = rewriteNodeReferences(src, "X", "LongerName");
    assert.equal(renamed, "{{ nodes.LongerName.output }}-{{ nodes.LongerName.status }}-{{ nodes.LongerName.error }}");
    assert.equal(rewriteNodeReferences(renamed, "LongerName", "X"), src);
  });
});
