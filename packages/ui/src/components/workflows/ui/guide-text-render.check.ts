/**
 * Render checks for the shared-guide renderer (`ui/GuideText.tsx`):
 * `backtick` spans become <code> (escaped like any text), a fact's term sits
 * beside its text or is replaced by the form's own name for it, and a section
 * titles its facts. `lib/workflows/guide-text.test.ts` owns the splitting.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GuideItems, GuideSections, GuideText } from "./GuideText";

const CODE = /<code class="[^"]*">/g;

{
  const html = renderToStaticMarkup(h(GuideText, { text: "Read `{{ input.text }}` or `nodes.<Name>.output`; a lone ` stays." }));
  assert.equal(html.match(CODE)?.length, 2, "each backtick pair is one <code>");
  assert.ok(html.includes(">{{ input.text }}</code>"));
  assert.ok(html.includes(">nodes.&lt;Name&gt;.output</code>"), "code is escaped like any text");
  assert.ok(html.includes("; a lone ` stays."), "an unpaired backtick is left as written");
  assert.ok(html.startsWith("Read "), "plain text is not wrapped");
}

{
  const html = renderToStaticMarkup(
    h(GuideItems, {
      items: [{ term: "left", text: "A `template`." }, { text: "A fact without a term." }],
      termLabel: (term: string) => (term === "left" ? "Value" : term)
    })
  );
  assert.ok(html.includes(">Value</div>"), "a term shows as the form names it");
  assert.ok(!html.includes(">left<"));
  assert.ok(html.includes("col-span-2"), "a fact without a term spans the row");
  assert.equal(html.match(CODE)?.length, 1);
}

{
  const html = renderToStaticMarkup(
    h(GuideSections, {
      sections: [
        { title: "Result", items: [{ term: "return", text: "The block's output." }] },
        { title: "Limits", items: [{ text: "At most `4 h`." }] }
      ]
    })
  );
  assert.ok(html.indexOf(">Result</h4>") < html.indexOf(">Limits</h4>"), "sections keep their order, each titled");
  assert.ok(html.includes(">return</div>") && html.includes("The block&#x27;s output."));
  assert.ok(html.includes(">4 h</code>"));
}
