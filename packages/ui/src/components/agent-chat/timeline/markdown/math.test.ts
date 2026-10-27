import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatInlineMarkdown, ChatMarkdown } from "./ChatMarkdown.tsx";
import { createIncrementalMarkdownPlugin } from "./incremental.ts";
import {
  mathKind,
  remarkChatMath
} from "./math.ts";
import { loadMathEngine } from "./math-typeset.ts";

type Formula = [kind: "inline" | "display", tex: string];

function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** Parses `markdown` with the chat's math plugins; formulas are collected, not rendered. */
function parse(markdown: string, extra: unknown[] = []): { formulas: Formula[]; html: string } {
  const formulas: Formula[] = [];
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkChatMath as unknown as typeof remarkGfm, ...(extra as Array<typeof remarkGfm>)],
      components: {
        code: ({ className, children }) => {
          const kind = mathKind(className);
          if (kind === null) return createElement("code", { className }, children);
          formulas.push([kind, textOf(children)]);
          return null;
        }
      },
      children: markdown
    })
  );
  return { formulas, html };
}

const formulas = (markdown: string): Formula[] => parse(markdown).formulas;

/** The text a reader sees outside formulas, tags stripped. */
function text(markdown: string): string {
  return parse(markdown)
    .html.replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("delimiters", () => {
  const cases: Array<[source: string, expected: Formula[]]> = [
    // The four delimiters models emit.
    ["Inline $x^2$ and \\(y_1\\), display $$a+b$$ and \\[c\\].", [["inline", "x^2"], ["inline", "y_1"], ["inline", "a+b"], ["display", "c"]]],
    ["$x$", [["inline", "x"]]],
    ["\\(x\\)", [["inline", "x"]]],
    ["\\[x\\]", [["display", "x"]]],
    ["$$x$$", [["display", "x"]]],
    ["so $$a+b$$ here", [["inline", "a+b"]]],
    // Blocks.
    ["$$\n\\frac{a}{b}\n$$", [["display", "\\frac{a}{b}"]]],
    ["\\[\n\\frac{a}{b}\n\\]", [["display", "\\frac{a}{b}"]]],
    ["Where\n\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]\nholds.", [["display", "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}"]]],
    ["\\[\nx\n- y\n# z\n\\]\nafter", [["display", "x\n- y\n# z"]]],
    ["\\[\na\n=\nb\n\\]", [["display", "a\n=\nb"]]],
    // A `\]` after content is not a block's closer: this is inline math alone in its paragraph.
    ["\\[\nx \\]", [["display", "x"]]],
    ["\\[\nx\n   \\]", [["display", "x"]]],
    ["> $$\n> x\n> $$", [["display", "x"]]],
    ["> \\[\n> x\n> \\]", [["display", "x"]]],
    ["- intro\n\n  $$\n  x^2\n  $$", [["display", "x^2"]]],
    ["$$x^2\n+y^2$$", [["display", "x^2\n+y^2"]]],
    ["Intro\n\n$$ E = mc^2 $$\n\nOutro", [["display", "E = mc^2"]]],
    ["Intro\n\n\\[ E = mc^2 \\]\n\nOutro", [["display", "E = mc^2"]]],
    ["$$a$$ is the first formula.\nSome prose.\n$$\nb\n$$", [["inline", "a"], ["display", "b"]]],
    // Fences.
    ["```math\nx^2\n```", [["display", "x^2"]]],
    ["~~~math\nx^2\n~~~", [["display", "x^2"]]],
    ["```Math\nx^2\n```", [["display", "x^2"]]],
    ["> ```math\n> x^2\n> ```", [["display", "x^2"]]],
    // TeX inside formulas.
    ["\\(\\left(x\\right)\\)", [["inline", "\\left(x\\right)"]]],
    ["\\(a \\\\ b\\)", [["inline", "a \\\\ b"]]],
    ["\\(\\{x\\}\\)", [["inline", "\\{x\\}"]]],
    ["\\(x\n+y\\)", [["inline", "x\n+y"]]],
    ["\\[\\alpha\\]", [["display", "\\alpha"]]],
    ["\\[x_1, x_2\\]", [["display", "x_1, x_2"]]],
    ["\\(1\\)", [["inline", "1"]]],
    ["Pay \\$$x$ now.", [["inline", "x"]]],
    // Containers and other inline syntax.
    ["- [ ] check \\(x\\)\n- [x] then $y$", [["inline", "x"], ["inline", "y"]]],
    ["**bold \\(x\\)** and *em $y$*", [["inline", "x"], ["inline", "y"]]],
    ["[label \\(x\\)](https://example.com)", [["inline", "x"]]],
    ["| A | B |\n| --- | --- |\n| \\(x\\) | $y$ |", [["inline", "x"], ["inline", "y"]]],
    ["| Name | Value |\n| --- | --- |\n| first | \\(x |\n| second | y\\) |\n| valid | $z$ |", [["inline", "z"]]],
    // Not math.
    ["As shown in \\[1\\] and \\[2, 3\\].", []],
    ["call f\\(\\) here", []],
    ["empty \\( \\) parens", []],
    ["Escaped \\\\(x\\\\) stays.", []],
    ["\\(a `\\)` b", []],
    ["text \\[a`\\]`", []],
    ["See [docs](https://example.com/\\(a\\)) here.", []],
    ["Energy \\(E = mc", []],
    ["$$\nx^2", []],
    ["\\[\nx^2\n- y", []],
    ["$$E=mc^2", []],
    ["```math\nx^2", []],
    ["`\\(x\\)` and `$y$`", []],
    ["    \\(x\\)", []],
    ["```\n$x$ \\(y\\) \\[z\\]\n```", []]
  ];
  for (const [source, expected] of cases) {
    it(JSON.stringify(source), () => {
      assert.deepEqual(formulas(source), expected);
    });
  }
});

describe("what is left as text", () => {
  const cases: Array<[source: string, rendered: string]> = [
    ["As shown in \\[1\\] and \\[2, 3\\].", "As shown in [1] and [2, 3]."],
    ["Escaped \\\\(x\\\\) stays.", "Escaped \\(x\\) stays."],
    ["Escaped \\$x\\$ stays.", "Escaped $x$ stays."],
    ["\\(a `\\)` b", "(a \\) b"],
    ["call f\\(\\) here", "call f() here"],
    ["Energy \\(E = mc", "Energy (E = mc"],
    ["$$E=mc^2", "$$E=mc^2"],
    ["Use `$x$` in code.", "Use $x$ in code."],
    ["`\\(x\\)` and `\\[y\\]`", "\\(x\\) and \\[y\\]"]
  ];
  for (const [source, rendered] of cases) {
    it(JSON.stringify(source), () => {
      assert.equal(text(source).trim(), rendered);
    });
  }

  it("keeps the code a code block holds, delimiters and all", () => {
    const { html, formulas: found } = parse("```\n$x$ \\(y\\) \\[z\\]\n$$\nw\n$$\n```");
    assert.deepEqual(found, []);
    assert.ok(html.includes("$x$ \\(y\\) \\[z\\]\n$$\nw\n$$"), html);
  });

  it("keeps an unclosed math fence a code block showing its source", () => {
    const { html } = parse("```math\nx^2");
    assert.ok(html.includes('<code class="language-math">x^2'), html);
  });

  it("keeps link destinations with dollars and parentheses intact", () => {
    const { html, formulas: found } = parse(
      "Set $TOKEN, then open [users](https://graph.microsoft.com/v1.0/users?$select=id) and \\(x\\)."
    );
    assert.ok(html.includes('href="https://graph.microsoft.com/v1.0/users?$select=id"'), html);
    assert.deepEqual(found, [["inline", "x"]]);
    const autolink = parse("Set $TOKEN, then open <https://graph.microsoft.com/v1.0/users?$select=id>.").html;
    assert.ok(autolink.includes('href="https://graph.microsoft.com/v1.0/users?$select=id"'), autolink);
  });

  it("keeps an adjacent code span whole", () => {
    for (const [source, code] of [
      ["$a`$HOME`", "$HOME"],
      ["\\(a`\\)`", "\\)"],
      ["\\(a\\alpha`\\)`", "\\)"],
      ["text \\[a`\\]`", "\\]"]
    ] as const) {
      const { html, formulas: found } = parse(source);
      assert.deepEqual(found, [], source);
      assert.ok(html.includes(`<code>${code}</code>`), `${source}: ${html}`);
    }
  });
});

describe("currency", () => {
  for (const prose of [
    "It costs $5 and then $10.",
    "It costs $5 and $10.",
    "price $20,000 or $30,000",
    "Between $5 and $10 per seat, plus $3.50 tax",
    "Budget $5-$10 per seat, or $20,000-$30,000 a year.",
    "Plans are $5/$10 monthly.",
    "We paid $ 5 and $ 10",
    "Run $browser then $deploy on it.",
    "Set $HOME before running.",
    "$5",
    "just a lone $ sign"
  ]) {
    it(JSON.stringify(prose), () => {
      assert.deepEqual(formulas(prose), []);
      assert.equal(text(prose).trim(), prose);
    });
  }

  it("keeps prices as prose when real math follows on the same line", () => {
    for (const price of ["$5-$10", "$5 and $10", "$5/$10", "$20,000-$30,000"]) {
      const source = `Price ${price} stays literal. The formula is $x_i$ and \\(y\\).`;
      assert.deepEqual(formulas(source), [["inline", "x_i"], ["inline", "y"]], source);
      assert.ok(text(source).startsWith(`Price ${price} stays literal.`), source);
    }
  });

  it("still finds real math next to currency", () => {
    assert.deepEqual(formulas("costs $5, then $x$ is the unknown"), [["inline", "x"]]);
  });
});

describe("structure around an unclosed block (streaming)", () => {
  it("keeps the lists and quotes after an unclosed $$ or \\[ as they are", () => {
    for (const opener of ["$$", "\\["]) {
      const { html } = parse(`${opener}\nx^2\n- y\n\n> q`);
      assert.ok(html.includes("<ul>\n<li>y</li>\n</ul>"), html);
      assert.ok(html.includes("<blockquote>"), html);
    }
  });

  it("does not split the paragraph above an unclosed block", () => {
    for (const opener of ["$$", "\\["]) {
      const { html } = parse(`text\n${opener}\nx^2`);
      assert.equal(html.match(/<p>/g)?.length, 1, html);
    }
  });

  it("does not let a `\\]` ending a later line of prose close a block", () => {
    const { html, formulas: found } = parse("\\[\na+b\n\n- item one\n- item see foo\\]");
    assert.deepEqual(found, []);
    assert.equal(html.match(/<li>/g)?.length, 2, html);
  });

  it("composes with the incremental fence cache", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const prefix = "```text\ncode\n```\n\n";
    parse(`${prefix}$a$ and \\(b`, [plugin]);
    const second = parse(`${prefix}$a$ and \\(b\\) and\n\\[\nc\n\\]\n`, [plugin]);
    assert.deepEqual(second.formulas, [["inline", "a"], ["inline", "b"], ["display", "c"]]);
  });
});

describe("malformed input stays readable without quadratic rescanning", () => {
  // These exercise the public markdown pipeline, including source lookahead
  // before tokenization. Private consume counters missed that work entirely.
  // CPU time excludes scheduling delays; five seconds leaves ample headroom
  // over normal parsing while detecting both historical quadratic algorithms.
  function boundedParse(source: string): ReturnType<typeof parse> {
    const started = process.cpuUsage();
    const result = parse(source);
    const used = process.cpuUsage(started);
    const cpuMs = (used.user + used.system) / 1000;
    assert.ok(cpuMs < 5_000, `${Math.round(cpuMs)} ms of CPU to parse malformed markdown`);
    return result;
  }

  const prose = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  it("keeps unclosed inline delimiters literal and renders the later formula within the CPU budget", () => {
    const result = boundedParse("x \\( y ".repeat(5_000) + "`stop` and \\(z\\)");
    assert.deepEqual(result.formulas, [["inline", "z"]]);
    assert.equal(prose(result.html), "x ( y ".repeat(5_000) + "stop and");
  });

  it("keeps unclosed block delimiters literal and renders the later formula within the CPU budget", () => {
    const result = boundedParse("\\[\n".repeat(16_000) + "\n\nAfter. $z$");
    assert.deepEqual(result.formulas, [["inline", "z"]]);
    assert.equal(prose(result.html), "[ ".repeat(16_000) + "After.");
  });

  it("still finds the formula after a run of unclosed openers", () => {
    assert.deepEqual(formulas("a \\( b ".repeat(50) + "`c` and \\(x\\) and \\[y\\]"), [
      ["inline", "x"],
      ["display", "y"]
    ]);
    assert.deepEqual(formulas("\\( a `b` \\( c \\)"), [["inline", "c"]]);
  });
});

describe("rendered in a message", () => {
  before(async () => {
    await loadMathEngine();
  });

  const message = (value: string, streaming = false): string =>
    renderToStaticMarkup(createElement(ChatMarkdown, { text: value, streaming }));
  const katexCount = (html: string): number => (html.match(/class="katex"/g) ?? []).length;

  it("typesets every delimiter, inline and display", () => {
    const html = message("Inline $x$ and \\(y\\).\n\n$$\na\n$$\n\n\\[\nb\n\\]\n\n```math\nc\n```");
    assert.equal(katexCount(html), 5, html);
    assert.equal((html.match(/data-markdown-math="display"/g) ?? []).length, 3, html);
    assert.equal((html.match(/data-markdown-math="inline"/g) ?? []).length, 2, html);
    assert.ok(html.includes('data-markdown-copy="\\(x\\)"'), html);
    assert.ok(html.includes('data-markdown-copy="\\[\na\n\\]"'), html);
  });

  it("keeps formulas reachable by keyboard", async () => {
    const { JSDOM } = await import("jsdom");
    for (const [source, formula] of [["$x$", "x"], ["$$\ny\n$$", "y"]] as const) {
      const fragment = JSDOM.fragment(message(source));
      const named = (element: Element): boolean => Boolean(
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("aria-labelledby")?.split(/\s+/).some((id) => fragment.getElementById(id)?.textContent?.trim())
      );
      const equation = fragment.querySelector<HTMLElement>('[role~="group"], [role~="region"]');
      assert.ok(equation && named(equation), "the equation has a named accessible region");
      assert.ok(
        [equation, ...equation.querySelectorAll<HTMLElement>("*")].some((target) =>
          target.tabIndex >= 0 && named(target) && target.textContent?.includes(formula)
        ),
        "the formula itself has a named keyboard focus target"
      );
    }
  });

  it("shows a formula KaTeX cannot parse as its source, not an error", () => {
    const html = message("bad \\(\\frac{1}{\\) done");
    assert.ok(!html.includes("katex-error"), html);
    assert.ok(html.includes(">\\(\\frac{1}{\\)<"), html);
    assert.ok(html.includes("done"));
  });

  it("refuses links and remote loads from inside a formula (trust: false)", () => {
    // `\(…\)`: a dollar run holding `://` is not math at all (a link's URL).
    const html = message("\\(\\href{https://evil.example/}{click}\\) and \\(\\includegraphics{https://evil.example/x.png}\\)");
    assert.equal(katexCount(html), 2, html);
    assert.ok(!html.includes("<a "), html);
    assert.ok(!html.includes('href="https://evil.example'), html);
    assert.ok(!html.includes('src="https://evil.example'), html);
  });

  it("never turns provider HTML into elements", () => {
    const html = message("<img src=x onerror=alert(1)> and $x$ and \\(<b>y</b>\\)");
    assert.ok(!html.includes("<img"), html);
    assert.ok(!html.includes("<b>"), html);
  });

  it("shows a streaming math fence as code until it closes", () => {
    const open = message("```math\nx_i^2", true);
    assert.equal(katexCount(open), 0, open);
    assert.ok(open.includes("x_i^2"), open);
    assert.equal(katexCount(message("```math\nx_i^2\n```", true)), 1);
  });

  it("keeps an unclosed display block and the prose after it readable while streaming", () => {
    for (const opener of ["$$\nx^2\n", "\\[\nx^2\n"]) {
      const html = message(`${opener}\nFollowing prose.`, true);
      assert.equal(katexCount(html), 0, html);
      assert.ok(!html.includes("data-markdown-math"), html);
      assert.ok(html.includes("x^2") && html.includes("Following prose."), html);
    }
  });

  it("renders math in a control's inline markdown without a tab stop or a button", () => {
    const html = renderToStaticMarkup(createElement(ChatInlineMarkdown, { text: "Use \\(x^2\\) here" }));
    assert.equal(katexCount(html), 1, html);
    assert.ok(!html.includes("tabindex=\"0\""), html);
    assert.ok(!html.includes('role="group"'), html);
  });
});

describe("untrusted size limits", () => {
  before(async () => {
    await loadMathEngine();
  });

  const message = (value: string): string => renderToStaticMarkup(createElement(ChatMarkdown, { text: value }));
  const dimensions = (html: string): number[] =>
    [...html.matchAll(/(?:width|height):([\d.]+)em/g)].map((match) => Number(match[1]));

  it("clamps user-specified lengths (\\rule) to maxSize", () => {
    const sizes = dimensions(message("$\\rule{999em}{999em}$"));
    assert.ok(sizes.length > 0);
    assert.ok(Math.max(...sizes) <= 20, `largest dimension ${Math.max(...sizes)}em`);
  });

  it("bounds macro expansion (maxExpand)", () => {
    const html = message("$\\def\\a{\\a\\a}\\a$");
    assert.ok(!html.includes('class="katex"'), "a runaway macro shows its source, not a hang");
  });
});

describe("known limit: tight dollar pairs that are not math", () => {

  it("still reads 'the $n$th term' as math, which is why the rules stop at digits", () => {
    assert.deepEqual(formulas("the $n$th term"), [["inline", "n"]]);
  });
});
