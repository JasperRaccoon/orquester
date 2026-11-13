// The embed's CSS, made to work inside a shadow root (design §5.7, §5.8):
// document-level selectors move to the shadow host or the wrapper, and every
// theme colour becomes overridable from outside through an `--orq-*` variable.

import postcss, { type PluginCreator } from "postcss";

/** Theme variables a host may override: the neutrals, the semantic steps and the diff bands. */
const THEMABLE = /^--(?:n|sem|diff)-[\w-]+$/;

/** The two font variables the embed adds; they exist only in its CSS. */
export const FONT_VARIABLES = ["--orq-font-sans", "--orq-font-mono"] as const;

/** Splits a selector list on its top-level commas (not those inside `:is(…)` or `[…]`). */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** A compound selector's simple selectors after a type or `:root`: `[…]`, `.x`, `#x`, `:x(…)`. */
const COMPOUND = String.raw`((?:\[[^\]]*\]|\.[\w-]+|#[\w-]+|:(?!:)[\w-]+(?:\([^)]*\))?)*)`;
const DOCUMENT_ROOT = new RegExp(String.raw`(^|[\s>+~(])(?:html|:root)(?![\w-])${COMPOUND}`, "g");
const BODY = /(^|[\s>+~(,])body(?![\w-])/;

/**
 * One selector list with `:root` and `html` moved to `:host` (a compound such as
 * `:root[data-x]` becomes `:host([data-x])`) and `body` to the wrapper class;
 * returned unchanged when it has none of them.
 */
function shadowSelector(selector: string, rootClass: string): string {
  const parts = splitSelectorList(selector);
  const rewritten = parts.map((part) =>
    part
      .replace(DOCUMENT_ROOT, (_match, before: string, compound: string) =>
        compound ? `${before}:host(${compound})` : `${before}:host`
      )
      .replace(new RegExp(BODY, "g"), (_match, before: string) => `${before}.${rootClass}`)
  );
  if (rewritten.every((part, index) => part === parts[index])) return selector;
  return [...new Set(rewritten)].join(",\n");
}

export interface EmbedShadowCssOptions {
  /** The wrapper element's class (`EMBED_ROOT_CLASS`). */
  rootClass: string;
}

/**
 * The PostCSS step of the embed build. Runs after Tailwind (in `OnceExit`), so
 * the preflight's `html`/`body` rules are rewritten too:
 *
 * - `:root`, `html` → `:host`; `body` → `.<rootClass>`;
 * - `--n-*`, `--sem-*`, `--diff-*: <v>` → `var(--orq-…, <v>)`;
 * - a `font-family` on `body` → `var(--orq-font-sans, <v>)`.
 */
export const embedShadowCss: PluginCreator<EmbedShadowCssOptions> = (options) => {
  const rootClass = options?.rootClass;
  if (!rootClass) throw new Error("embedShadowCss: rootClass is required");
  return {
    postcssPlugin: "orquester-embed-shadow-css",
    OnceExit(root) {
      root.walkRules((rule) => {
        const parent = rule.parent;
        if (parent?.type === "atrule" && /keyframes$/i.test((parent as postcss.AtRule).name)) return;
        const targetsBody = BODY.test(rule.selector);
        rule.selector = shadowSelector(rule.selector, rootClass);
        rule.each((node) => {
          if (node.type !== "decl") return;
          if (THEMABLE.test(node.prop) && !node.value.startsWith("var(--orq-")) {
            node.value = `var(--orq-${node.prop.slice(2)}, ${node.value})`;
          } else if (targetsBody && node.prop === "font-family" && !node.value.startsWith("var(--orq-")) {
            node.value = `var(--orq-font-sans, ${node.value})`;
          }
        });
      });
    }
  };
};
embedShadowCss.postcss = true;

/**
 * The `--orq-*` variables a host can set, in `globals.css` order: one per themable
 * variable it declares, then the two font variables. This is the contract list
 * written to `dist/embed/variables.json` and documented in docs/embed-agent-chat.md.
 */
export function embedCssVariables(globalsCss: string): string[] {
  const names = new Set<string>();
  postcss.parse(globalsCss).walkDecls((decl) => {
    if (THEMABLE.test(decl.prop)) names.add(`--orq-${decl.prop.slice(2)}`);
  });
  return [...names, ...FONT_VARIABLES];
}

/** The app's body font stack: the last `body { font-family }` in `globals.css`. */
export function bodyFontStack(globalsCss: string): string {
  let stack: string | null = null;
  postcss.parse(globalsCss).walkRules((rule) => {
    if (!splitSelectorList(rule.selector).includes("body")) return;
    rule.walkDecls("font-family", (decl) => {
      stack = decl.value.replace(/\s+/g, " ").trim();
    });
  });
  if (stack === null) throw new Error("globals.css declares no body font-family");
  return stack;
}
