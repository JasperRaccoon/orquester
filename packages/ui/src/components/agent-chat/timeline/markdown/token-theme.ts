/**
 * The code-block token palette.
 *
 * **This is the one surface in the chat that deliberately does not theme.**
 * AGENTS.md says the CodeMirror editor swaps only on the resolved *mode*, and
 * the design reference repeats it (§3.5, "two surfaces that do not theme"):
 * chat code blocks are highlighted by the same Lezer parsers as that editor, so
 * they follow light/dark and ignore the seven colour schemes. That is expected
 * and is not a bug to "fix" by wiring these to `--n-*`.
 *
 * The dark values are CodeMirror's One Dark, so a snippet in the chat and the
 * same file in the editor read identically; the light values are its usual
 * light counterpart, checked to stay legible on `bg-neutral-900/60` in a light
 * scheme (which is a near-white surface).
 */

import type { TokenClass } from "./highlight-core";

export type TokenPalette = Record<TokenClass, string>;

const DARK: TokenPalette = {
  keyword: "#c678dd",
  control: "#c678dd",
  operator: "#56b6c2",
  name: "#61afef",
  definition: "#e06c75",
  type: "#e5c07b",
  property: "#e06c75",
  number: "#d19a66",
  string: "#98c379",
  regexp: "#98c379",
  escape: "#56b6c2",
  comment: "#7d8799",
  meta: "#7d8799",
  punctuation: "#abb2bf",
  bracket: "#abb2bf",
  heading: "#e06c75",
  link: "#61afef",
  emphasis: "#c678dd",
  strong: "#e5c07b",
  invalid: "#ff5370"
};

const LIGHT: TokenPalette = {
  keyword: "#a626a4",
  control: "#a626a4",
  operator: "#0184bc",
  name: "#4078f2",
  definition: "#e45649",
  type: "#986801",
  property: "#e45649",
  number: "#986801",
  string: "#50a14f",
  regexp: "#50a14f",
  escape: "#0184bc",
  comment: "#8a8f98",
  meta: "#8a8f98",
  punctuation: "#383a42",
  bracket: "#383a42",
  heading: "#e45649",
  link: "#4078f2",
  emphasis: "#a626a4",
  strong: "#986801",
  invalid: "#e45649"
};

export function tokenPalette(mode: "light" | "dark"): TokenPalette {
  return mode === "light" ? LIGHT : DARK;
}

export function tokenColor(mode: "light" | "dark", cls: TokenClass | null): string | undefined {
  return cls === null ? undefined : tokenPalette(mode)[cls];
}
