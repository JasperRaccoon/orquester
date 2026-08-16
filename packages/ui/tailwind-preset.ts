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

const sem = (name: string) => `rgb(var(--sem-${name}) / <alpha-value>)`;

/**
 * The semantic (status) scale — the second variable layer, defined in the same
 * `[data-mode]` blocks as the neutrals. Status colours are NOT theme colours,
 * so they are deliberately scheme-independent; what they do need is a per-MODE
 * weight, because a 400-shade tuned for a near-black surface is unreadable on a
 * near-white one (`text-red-400` measured 2.70:1 on light).
 *
 * Step numbers name the dark source shade (`danger-400` is Tailwind red-400),
 * so a sweep is a rename and dark output is unchanged. Components should
 * normally reach for the unnumbered `danger`/`warn`/`ok`/`info` (the standard
 * foreground) and `*-soft` (the wash/band base, always used with an alpha
 * modifier); the numbered steps exist for the sites that were already using a
 * neighbouring shade for emphasis or hover.
 *
 * `*-muted` is the same colour pre-dimmed for a site that renders it under a
 * /70–/80 opacity modifier: identical to the base step on dark (where alpha
 * composites toward black), a step or two deeper on light (where it composites
 * toward white and would otherwise drop the text under 4.5:1). Use it INSTEAD
 * of the base step at those sites — the alpha modifier stays.
 */
const status = {
  danger: {
    DEFAULT: sem("danger-400"),
    soft: sem("danger-950"),
    muted: sem("danger-muted"),
    200: sem("danger-200"),
    300: sem("danger-300"),
    400: sem("danger-400"),
    500: sem("danger-500"),
    600: sem("danger-600"),
    800: sem("danger-800"),
    900: sem("danger-900"),
    950: sem("danger-950")
  },
  warn: {
    DEFAULT: sem("warn-400"),
    soft: sem("warn-950"),
    muted: sem("warn-muted"),
    /** The /80 variant of `warn-500` (its own token: dark keeps amber-500). */
    "muted-500": sem("warn-500-muted"),
    50: sem("warn-50"),
    300: sem("warn-300"),
    400: sem("warn-400"),
    500: sem("warn-500"),
    700: sem("warn-700"),
    900: sem("warn-900"),
    950: sem("warn-950")
  },
  ok: {
    DEFAULT: sem("ok-400"),
    soft: sem("ok-900"),
    muted: sem("ok-muted"),
    /** The /70 site needs one step deeper than the /80 one on light. */
    muted70: sem("ok-70-muted"),
    300: sem("ok-300"),
    400: sem("ok-400"),
    500: sem("ok-500"),
    900: sem("ok-900"),
    /** The brighter, yellower green of the idle session dot (Tailwind green-400). */
    vivid: sem("ok-vivid")
  },
  info: {
    DEFAULT: sem("info-400"),
    soft: sem("info-900"),
    300: sem("info-300"),
    400: sem("info-400"),
    500: sem("info-500"),
    900: sem("info-900")
  }
};

export const orquesterPreset = {
  content: [],
  theme: {
    extend: {
      colors: { neutral, ...status }
    }
  }
} satisfies Config;

export default orquesterPreset;
