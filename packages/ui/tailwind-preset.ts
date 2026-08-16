import type { Config } from "tailwindcss";

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/**
 * Theming without touching a single component: every surface in the app already
 * paints with Tailwind's `neutral` scale, so pointing that scale at CSS
 * variables makes a colour scheme eleven numbers per mode (see the
 * `[data-scheme][data-mode]` blocks in `src/styles/globals.css`) and no
 * component ever branches on it.
 *
 * The `<alpha-value>` placeholder is what keeps opacity modifiers working —
 * `bg-neutral-900/40` still compiles to `rgb(var(--n-900) / 0.4)`. A plain
 * `var(--x)` value would silently drop the slash-alpha syntax.
 *
 * The variables carry the fork's stock look (Tailwind's own `neutral` triples)
 * by default, so the unthemed app renders pixel-identically to before.
 */
const neutral = Object.fromEntries(
  STEPS.map((step) => [step, `rgb(var(--n-${step}) / <alpha-value>)`])
);

export const orquesterPreset = {
  content: [],
  theme: {
    extend: {
      colors: { neutral }
    }
  }
} satisfies Config;

export default orquesterPreset;
