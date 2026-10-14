import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import { createIncrementalMarkdownPlugin } from "./incremental.ts";
import { isPlausibleSingleDollarMath, KATEX_OPTIONS, mightContainMath, remarkChatMath } from "./math.ts";

function render(source: string, extra: unknown[] = []): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkChatMath as unknown as typeof remarkGfm, ...(extra as Array<typeof remarkGfm>)],
      rehypePlugins: [[rehypeKatex, KATEX_OPTIONS]] as never,
      children: source
    })
  );
}

const codes = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));
const isMath = (html: string): boolean => html.includes('class="katex"') || html.includes('class="katex-error"');

describe("currency text is not math", () => {
  for (const text of [
    "It costs $5 and then $10.",
    "price $20,000 or $30,000",
    "Between $5 and $10 per seat, plus $3.50 tax",
    "We paid $ 5 and $ 10",
    "$5",
    "just a lone $ sign"
  ]) {
    it(JSON.stringify(text), () => {
      const html = render(text);
      assert.equal(isMath(html), false, html);
      assert.equal(html, `<p>${text}</p>`);
    });
  }

  it("still finds real math next to currency", () => {
    const html = render("costs $5, then $x$ is the unknown");
    assert.equal(isMath(html), true);
    assert.ok(html.startsWith("<p>costs $5, then "), html);
    assert.ok(html.includes('<annotation encoding="application/x-tex">x</annotation>'));
    assert.ok(html.endsWith(" is the unknown</p>"));
  });
});

describe("math renders", () => {
  it("renders $…$ inline inside the paragraph", () => {
    const html = render("Euler: $e^{i\\pi}+1=0$ holds");
    assert.ok(html.startsWith("<p>Euler: <span class=\"katex\">"), html);
    assert.ok(html.includes('encoding="application/x-tex">e^{i\\pi}+1=0<'));
    assert.ok(!html.includes("katex-display"));
  });

  it("renders $$…$$ blocks as display math", () => {
    const html = render("$$\n\\int_0^1 x^2\\,dx\n$$");
    assert.ok(html.includes("katex-display"), html);
    assert.ok(html.includes('display="block"'));
  });

  it("accepts a double-dollar run inline in a sentence", () => {
    assert.equal(isMath(render("so $$a+b$$ here")), true);
  });

  it("leaves escaped dollars and code alone", () => {
    assert.equal(render("a \\$x\\$ b"), "<p>a $x$ b</p>");
    assert.equal(render("`$x$` code"), "<p><code>$x$</code> code</p>");
    assert.equal(isMath(render("```\n$x$\n```")), false);
  });

  it("renders a bad formula as marked source, not an exception", () => {
    const html = render("bad $\\foo{$ done");
    assert.ok(html.includes('class="katex-error"'), html);
    assert.ok(html.includes("color:rgb(var(--sem-danger-400))"), "in the theme's danger colour, not a fixed one");
    assert.ok(html.includes("done"));
  });

  it("ignores unknown commands quietly (strict: ignore)", () => {
    assert.doesNotThrow(() => render("$\\unknowncommand x$"));
  });

  it("refuses links and remote loads from inside a formula (trust: false)", () => {
    const html = render("$\\href{https://evil.example/}{click}$ and $\\includegraphics{https://evil.example/x.png}$");
    assert.ok(!html.includes("<a "), html);
    assert.ok(!html.includes("evil.example/x.png\""), html);
    assert.ok(!html.includes("href=\"https://evil.example"), html);
  });

  it("never turns provider HTML into elements", () => {
    const html = render("<img src=x onerror=alert(1)> and $x$");
    assert.ok(!html.includes("<img"), html);
  });

  it("composes with the incremental fence cache", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const prefix = "```text\ncode\n```\n\n";
    render(`${prefix}$a$ and tail`, [plugin]);
    const html = render(`${prefix}$a$ and $b$ tail`, [plugin]);
    assert.equal((html.match(/class="katex"/g) ?? []).length, 2, html);
  });
});

describe("single-dollar rules", () => {
  const verdict = (text: string, next: string | null): boolean =>
    isPlausibleSingleDollarMath(codes(text), next === null ? null : next.charCodeAt(0));

  it("accepts tight pairs not followed by a digit", () => {
    assert.equal(verdict("$x$", " "), true);
    assert.equal(verdict("$x$", null), true);
    assert.equal(verdict("$x$", "."), true);
    assert.equal(verdict("$a b$", ","), true);
  });

  it("rejects padded pairs and a closing dollar before a digit", () => {
    assert.equal(verdict("$ x$", " "), false);
    assert.equal(verdict("$x $", " "), false);
    assert.equal(verdict("$5 and $", "1"), false);
  });

  it("does not second-guess runs of two or more dollars", () => {
    assert.equal(verdict("$$ x $$", "1"), true);
  });
});

describe("gate", () => {
  it("arms the math plugins only when the text has a dollar sign", () => {
    assert.equal(mightContainMath("plain prose"), false);
    assert.equal(mightContainMath("costs $5"), true);
  });
});

describe("one-line display math", () => {
  it("promotes a paragraph that is only a $$…$$ run to display math", () => {
    const html = render("Intro\n\n$$ E = mc^2 $$\n\nOutro");
    assert.ok(html.includes("katex-display"), html);
    assert.ok(!html.includes("<p><span"), html);
  });

  it("keeps a $$ run inside a sentence, and a lone $x$ line, inline", () => {
    assert.ok(!render("so $$a+b$$ here").includes("katex-display"));
    assert.ok(!render("$x$").includes("katex-display"));
  });

  it("promotes inside list items and block quotes too", () => {
    assert.ok(render("- item\n\n  $$a+b$$\n").includes("katex-display"));
    assert.ok(render("> $$a+b$$").includes("katex-display"));
  });
});

describe("untrusted size limits", () => {
  const dimensions = (html: string): number[] =>
    [...html.matchAll(/(?:width|height):([\d.]+)em/g)].map((match) => Number(match[1]));

  it("clamps user-specified lengths (\\rule) to maxSize", () => {
    assert.equal(KATEX_OPTIONS.maxSize, 20);
    const html = render("$\\rule{999em}{999em}$");
    const sizes = dimensions(html);
    assert.ok(sizes.length > 0, html);
    assert.ok(Math.max(...sizes) <= 20, `largest dimension ${Math.max(...sizes)}em in ${html}`);
  });

  it("bounds macro expansion (maxExpand)", () => {
    assert.equal(KATEX_OPTIONS.maxExpand, 1000);
    const html = render("$\\def\\a{\\a\\a}\\a$");
    assert.ok(html.includes("katex-error"), "a runaway macro is an error span, not a hang");
  });
});

describe("known limit: tight dollar pairs that are not math", () => {
  it("reads ${A}/${B} and $a/$b as math (documented in math.ts)", () => {
    assert.equal(isMath(render("path ${A}/${B}")), true);
    assert.equal(isMath(render("cost is $a/$b")), true);
  });

  it("still reads 'the $n$th term' as math, which is why the rules stop at digits", () => {
    assert.equal(isMath(render("the $n$th term")), true);
  });
});
