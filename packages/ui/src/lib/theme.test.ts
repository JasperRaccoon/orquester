/**
 * Agent visuals' theme tokens (spec 2026-10-14 §2.3): every colour scheme ×
 * mode, as `styles/globals.css` paints it, gives a page every token as hex.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  HTML_RENDER_PALETTE_VARIABLES,
  HTML_RENDER_STOCK_PALETTES,
  HTML_RENDER_THEME_TOKENS
} from "@orquester/api/agent-chat";

import { COLOR_SCHEMES, htmlRenderThemeTokens, type ColorScheme, type ResolvedMode } from "./theme";

const CSS = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every innermost `selector { declarations }` block, selector whitespace removed. */
function blocks(css: string): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A statement before the block (`@tailwind base;`) is not its selector.
    const selector = match[1]!.slice(match[1]!.lastIndexOf(";") + 1).replace(/\s+/g, "");
    const declarations: Record<string, string> = {};
    for (const declaration of match[2]!.split(";")) {
      const at = declaration.indexOf(":");
      if (at > 0) declarations[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
    }
    found.set(selector, { ...found.get(selector), ...declarations });
  }
  return found;
}

const BLOCKS = blocks(CSS);

/** The custom properties `<html data-scheme data-mode>` resolves, as the cascade would. */
function paletteOf(scheme: ColorScheme, mode: ResolvedMode): Record<string, string> {
  const root = BLOCKS.get(':root,[data-mode="dark"]');
  assert.ok(root, "the stock block exists");
  return {
    ...root,
    ...(mode === "light" ? BLOCKS.get('[data-mode="light"]') : {}),
    ...BLOCKS.get(`[data-scheme="${scheme}"][data-mode="${mode}"]`)
  };
}

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

test("every scheme × mode gives a page every token, each colour a valid hex", () => {
  for (const { id: scheme } of COLOR_SCHEMES) {
    for (const mode of ["dark", "light"] as const) {
      const palette = paletteOf(scheme, mode);
      for (const variable of HTML_RENDER_PALETTE_VARIABLES) {
        assert.match(palette[variable] ?? "", /^\d{1,3} \d{1,3} \d{1,3}$/, `${scheme}/${mode} defines ${variable}`);
      }
      const theme = htmlRenderThemeTokens(mode, (variable) => palette[variable]);
      assert.equal(theme.appearance, mode);
      assert.deepEqual(Object.keys(theme.variables), [...HTML_RENDER_THEME_TOKENS], `${scheme}/${mode}`);
      for (const [token, value] of Object.entries(theme.variables)) {
        if (token === "--radius" || token.startsWith("--font-")) continue;
        assert.match(value, HEX, `${scheme}/${mode} ${token}`);
      }
      // `--background` is the thread surface behind the frame.
      const [r, g, b] = palette["--n-950"]!.split(" ").map(Number);
      assert.equal(
        theme.variables["--background"],
        `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`,
        `${scheme}/${mode} background`
      );
    }
  }
});

test("schemes differ where their neutrals do", () => {
  const backgrounds = new Set(
    COLOR_SCHEMES.map(({ id }) => htmlRenderThemeTokens("dark", (variable) => paletteOf(id, "dark")[variable]).variables["--background"])
  );
  assert.ok(backgrounds.size > 1);
});

test("the stock palette a published page falls back to is the stylesheet's mono palette", () => {
  for (const mode of ["dark", "light"] as const) {
    const palette = paletteOf("mono", mode);
    for (const variable of HTML_RENDER_PALETTE_VARIABLES) {
      assert.equal(HTML_RENDER_STOCK_PALETTES[mode][variable], palette[variable], `${mode} ${variable}`);
    }
  }
});
