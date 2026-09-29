/**
 * Render checks for the Code, Shell and HTTP block forms (ProcessSettings.tsx).
 *
 * `lib/workflows/process-settings.test.ts` owns the summaries, the status list
 * and the shell variables' names; this checks the claims about MARKUP: a
 * collapsed section says what it holds, a problem opens the section (or the
 * Headers / Query disclosure) that holds its field and shows its message there,
 * every field validation points at has an anchor, a script with {{ … }} is
 * offered its environment variables (never a rewritten script) and shown what
 * to write instead, and undo-able text like the status list follows the config.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WORKFLOW_BLOCK_GUIDES,
  WORKFLOW_CODE_ARGUMENT_NAMES,
  WORKFLOW_CODE_ARGUMENTS,
  WORKFLOW_CODE_SIGNATURE,
  type Workflow,
  type WorkflowNode,
  type WorkflowProblem
} from "@orquester/api";

import { plainGuideText } from "../../../lib/workflows/guide-text";
import { markupText, node, workflow } from "../../../lib/workflows/testing";
import { ReadOnlyFieldset } from "../ui/controls";
import { InspectorContext, type InspectorContextValue, type InspectorReveal } from "./inspector-context";
import { CodeArgumentsHelp, CodeRuntimeHelp, CodeSettings, HttpSettings, ShellSettings } from "./ProcessSettings";

// Static rendering cannot run CodeMirror's or the modal's layout effects.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
};

function problem(field: string, severity: WorkflowProblem["severity"], message: string, code = "test"): WorkflowProblem {
  return { severity, code, message, nodeId: "n1", field };
}

function render(
  Form: React.FC,
  subject: WorkflowNode,
  options: { problems?: WorkflowProblem[]; reveal?: InspectorReveal | null; workflow?: Workflow; readOnly?: boolean } = {}
): string {
  const readOnly = options.readOnly ?? false;
  const value = {
    editor: { change: () => {} },
    workflow: options.workflow ?? workflow([subject]),
    node: subject,
    readOnly,
    projectPath: "/w/ws/app",
    secretNames: ["API_TOKEN"],
    scope: {},
    promptScope: {},
    problems: options.problems ?? [],
    openSecrets: () => {},
    reveal: options.reveal ?? null,
    revealField: () => {}
  } as unknown as InspectorContextValue;
  // As the Inspector mounts Settings: inside a (read-only when asked) fieldset.
  return renderToStaticMarkup(h(InspectorContext.Provider, { value }, h(ReadOnlyFieldset, { readOnly, children: h(Form) })));
}

const has = (html: string, text: string, why?: string): void => assert.ok(html.includes(text), why ?? `markup has ${JSON.stringify(text)}`);
const lacks = (html: string, text: string, why?: string): void => assert.ok(!html.includes(text), why ?? `markup lacks ${JSON.stringify(text)}`);
/** The markup reads a shared-guide text (its `backtick` spans rendered as code). */
const reads = (html: string, guideText: string, why?: string): void =>
  assert.ok(markupText(html).includes(plainGuideText(guideText).replace(/\s+/g, " ")), why ?? `markup reads ${JSON.stringify(guideText)}`);

try {
  // --- Code ------------------------------------------------------------------
  {
    const html = render(CodeSettings, node("n1", "code"));
    has(html, 'data-wf-field="config.source"');
    has(html, "Its default export runs; what it returns is this block&#x27;s output.");
    has(html, "What the function receives");
    has(html, "How it runs, its result and limits");
    assert.ok(!markupText(html).includes(plainGuideText(WORKFLOW_CODE_ARGUMENTS.require)), "the argument list starts folded away");
    has(html, "Default limits (4 GB, 30 min)", "collapsed Limits says the defaults");
    lacks(html, 'data-wf-field="config.memoryMb"', "collapsed Limits renders no fields");
  }
  {
    const html = render(CodeSettings, node("n1", "code", { memoryMb: 8192, timeoutMinutes: 240 }));
    has(html, "8 GB · 4 h");
  }
  {
    // An error opens Limits and sits under its field; both limits are anchored.
    const html = render(CodeSettings, node("n1", "code", { memoryMb: 99 }), {
      problems: [problem("config.memoryMb", "error", "Run: memory is 256–16384 MB")]
    });
    has(html, 'data-wf-field="config.memoryMb"');
    has(html, 'data-wf-field="config.timeoutMinutes"');
    has(html, "memory is 256–16384 MB");
    has(html, "256 MB – 16 GB · Default: 4096 MB (4 GB)");
    has(html, 'aria-invalid="true"');
  }
  {
    // Picking a timeout problem opens Limits; 240 min reads as 4 hours.
    const html = render(CodeSettings, node("n1", "code", { timeoutMinutes: 240 }), { reveal: { field: "config.timeoutMinutes", nonce: 1 } });
    assert.match(html, /<option value="hours" selected="">hours<\/option>/);
    has(html, 'aria-label="Timeout unit"');
  }
  {
    // A block-wide timeout applies when the code's own is unset — the summary and the default note say so.
    const legacy = node("n1", "code", {}, { timeoutMinutes: 45 });
    has(render(CodeSettings, legacy), "4 GB (default) · 45 min (from Run behaviour)");
    has(render(CodeSettings, legacy, { reveal: { field: "config.timeoutMinutes", nonce: 1 } }), "45 min (the block timeout set under Run behaviour)");
  }

  {
    // The folded Code help is the shared guide: every argument, in order, with its text, and the signature.
    const html = renderToStaticMarkup(h(CodeArgumentsHelp));
    const text = markupText(html);
    has(text, WORKFLOW_CODE_SIGNATURE);
    let from = 0;
    for (const name of WORKFLOW_CODE_ARGUMENT_NAMES) {
      has(html, `>${name}</div>`, `the ${name} argument is listed`);
      const at = text.indexOf(plainGuideText(WORKFLOW_CODE_ARGUMENTS[name]), from);
      assert.ok(at >= from, `${name} is explained, in the guide's order`);
      from = at;
    }
    has(html, "<code", "code spans render as <code>");
    lacks(html, "`", "no raw backticks");

    const runtime = renderToStaticMarkup(h(CodeRuntimeHelp));
    for (const section of WORKFLOW_BLOCK_GUIDES.code.filter((entry) => entry.title !== "Arguments")) {
      has(runtime, `>${section.title}</h4>`);
      for (const item of section.items) reads(runtime, item.text, `Code ${section.title}: ${item.term ?? item.text.slice(0, 30)}`);
    }
    lacks(runtime, "`");
  }

  // --- Shell -----------------------------------------------------------------
  {
    const html = render(ShellSettings, node("n1", "shell", { script: "echo hello" }));
    has(html, 'aria-label="Shell"');
    has(html, ">Shell</span>", "the shell switch has a visible label");
    has(html, "Runs in the project folder. Exit code 0 means success.");
    has(html, 'aria-label="About Commands"', "the script's help tip holds the shared guide");
    has(html, "isn&#x27;t allowed inside the script itself");
    has(html, "Default timeout (30 min)");
    lacks(html, "Add as environment variables");
  }
  {
    // A {{ … }} in the script: the error, and a one-click "add as environment variables" naming what it adds.
    const html = render(ShellSettings, node("n1", "shell", { script: 'echo "{{ input.text }}" {{ secrets.PATH }}' }), {
      problems: [problem("config.script", "error", "Run: {{ … }} cannot be used inside a shell script", "shell_template")]
    });
    has(html, "cannot be used inside a shell script");
    has(html, "Add as environment variables");
    has(html, "INPUT_TEXT, WF_PATH", "the rows it adds, a reserved name prefixed");
    has(html, "The script isn&#x27;t");
    has(html, "then replace each {{ … }} in it with the variable shown");
    has(html, 'aria-label="Copy &quot;$INPUT_TEXT&quot;"', "what to write instead, copyable");
    has(html, "&quot;$WF_PATH&quot;");
    has(html, "printf&#x27;s first argument");
    lacks(html, "Move to variables", "the script rewrite is gone");
  }
  {
    // Once each value is under Environment: nothing more to add, only what to write in the script.
    const html = render(
      ShellSettings,
      node("n1", "shell", { script: 'echo "{{ input.text }}"', env: [{ name: "INPUT_TEXT", value: "{{ input.text }}" }] })
    );
    lacks(html, "Add as environment variables");
    has(html, "Now replace each {{ … }} in the script with the variable shown");
    has(html, 'aria-label="Copy &quot;$INPUT_TEXT&quot;"');
    has(html, "Scripts never contain {{ … }}", "the error stays until the script is edited");
  }
  {
    // Read-only: no helper at all, but the code can still be opened larger (a view, not a disabled button).
    const html = render(ShellSettings, node("n1", "shell", { script: 'echo "{{ input.text }}"' }), { readOnly: true });
    lacks(html, "Add as environment variables");
    lacks(html, "Copy &quot;$INPUT_TEXT&quot;");
    assert.match(html, /<span role="button"[^>]*>(?:(?!<\/span>).)*<svg[^>]*>(?:(?!Open larger).)*Open larger/s);
  }
  {
    // Only a broken {{ … }}: how to do it by hand, and what to fix.
    const html = render(ShellSettings, node("n1", "shell", { script: "echo {{ input.text" }));
    lacks(html, "Add as environment variables");
    has(html, "&quot;$VALUE&quot;");
    has(html, "isn&#x27;t complete");
    has(html, "Scripts never contain {{ … }}", "a local error even before validation answers");
  }
  {
    // Per-row messages: a bad name (local) and a validation warning on a value, each under its row, anchored.
    const html = render(
      ShellSettings,
      node("n1", "shell", {
        script: 'echo "$A"',
        env: [
          { name: "1A", value: "x" },
          { name: "B", value: "{{ secrets.NOPE }}" }
        ]
      }),
      { problems: [problem("config.env.1.value", "warning", "Run: there is no secret named NOPE")] }
    );
    has(html, "Letters, digits and _ only, not starting with a digit — the block fails otherwise.");
    has(html, "there is no secret named NOPE");
    has(html, 'data-wf-field="config.env.1"');
  }

  // --- HTTP ------------------------------------------------------------------
  {
    const html = render(HttpSettings, node("n1", "http", { url: "https://api.example.com/items" }));
    has(html, 'data-wf-field="config.url"');
    has(html, 'data-wf-field="config.method"');
    has(html, 'data-wf-field="config.query"');
    has(html, 'data-wf-field="config.headers"');
    has(html, "Query parameters");
    assert.match(html, /Query parameters<\/span>(?:(?!<\/button>).)*· none/s, "an empty row list is folded with its count");
    has(html, "Not sent with GET", "Body is folded for GET, saying why");
    has(html, "Any 2xx · follows redirects · 5 min (default) timeout");
    has(html, 'aria-label="About URL"', "the URL's help tip holds the shared guide's request facts");
  }
  {
    // A problem on one header opens Headers and shows under that row; the header count is in its label while folded.
    const subject = node("n1", "http", {
      url: "https://x.test",
      headers: [
        { name: "Authorization", value: "Bearer {{ secrets.NOPE }}" },
        { name: "Bad Header", value: "1" }
      ]
    });
    const html = render(HttpSettings, subject, { problems: [problem("config.headers.0.value", "warning", "Run: there is no secret named NOPE")] });
    has(html, 'data-wf-field="config.headers.0"');
    has(html, "there is no secret named NOPE");
    has(html, "Not a valid header name");
  }
  {
    // A POST JSON body that won't parse: a warning under it; the body section is open for POST.
    const html = render(HttpSettings, node("n1", "http", { method: "POST", url: "https://x.test", body: { kind: "json", value: '{ "a": 1, }' } }));
    has(html, 'data-wf-field="config.body.value"');
    has(html, "Not valid JSON:");
    has(html, "Sent as application/json.");
    has(html, "Write values as {{ … | json }}.");
    has(html, 'aria-label="About JSON"');
  }
  {
    // A body on a GET, revealed: the ignored-body warning.
    const html = render(HttpSettings, node("n1", "http", { url: "https://x.test", body: { kind: "text", value: "hi" } }), {
      reveal: { field: "config.body.value", nonce: 1 }
    });
    has(html, "GET requests send no body, so this one is ignored");
    has(html, "text/plain; charset=utf-8", "the text body's default content type");
  }
  {
    // A status list: summarised while folded; revealed, the field shows the stored list.
    const subject = node("n1", "http", { url: "https://x.test", successStatuses: [200, 404], followRedirects: false, timeoutSeconds: 30 });
    has(render(HttpSettings, subject), "Only 200, 404 · doesn&#x27;t follow redirects · 30 s timeout");
    const open = render(HttpSettings, subject, { reveal: { field: "config.successStatuses", nonce: 1 } });
    has(open, 'value="200, 404"');
    has(open, "fails the block unless its status is listed above");
    assert.match(open, /<option value="seconds" selected="">seconds<\/option>/, "30 s shows in seconds");
  }
  {
    // A timeout error opens Response and sits under the field.
    const html = render(HttpSettings, node("n1", "http", { url: "https://x.test", timeoutSeconds: 7200 }), {
      problems: [problem("config.timeoutSeconds", "error", "Run: the timeout is at most 60 min")]
    });
    has(html, 'data-wf-field="config.timeoutSeconds"');
    has(html, "the timeout is at most 60 min");
  }
} finally {
  console.error = consoleError;
}
