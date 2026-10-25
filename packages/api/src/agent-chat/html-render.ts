/**
 * Agent visuals — the page an agent publishes with the `orquester` MCP
 * server's `html_render` tool (spec 2026-10-14 §2), and the bridge between
 * that page and the client that frames it.
 *
 * Ported from T3 Code (MIT): `packages/shared/src/htmlRender.ts` (reference,
 * sizing, theme tokens, bootstrap, JSON-RPC bridge), adapted to Orquester's
 * names (`orq-theme`, `orq/notifications/*`) and to its shortcut model.
 *
 * Pure and dependency-free, so the daemon (publish), the host (sweep, slim)
 * and the UI (frame, rows) all read one copy:
 *
 * - the published page is a thread attachment (id suffix `-html`); the
 *   {@link HtmlRenderReference} to it lives only in the tool's result;
 * - {@link htmlRenderReferenceOfActivityPayload} finds that reference in a
 *   tool row of ANY provider's ingested shape, slimmed or not — through the
 *   session tools' provenance marker and reference reader (`session-tools.ts`),
 *   where every provider's spelling and result layout is normalised;
 * - {@link injectHtmlRenderBootstrap} puts the theme + bridge script at the
 *   head of the page at publish time;
 * - the client hands the page its theme in the URL fragment before first
 *   paint ({@link htmlRenderThemeFragment}) and live over postMessage, and
 *   reads the page's size, link and key notifications with the `read*`
 *   parsers below. The method names are MCP Apps' (`ui/…`) where one exists.
 */

import { sessionToolNameOfData, sessionToolReferences } from "./session-tools.ts";

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

/** The visual-replies toolkit's publishing tool, on the session tools' server (`session-tools.ts`). */
export const HTML_RENDER_TOOL_NAME = "html_render";
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
/** A page's `html` bound, in characters (both tools' argument, and the publisher's own refusal). */
export const HTML_RENDER_MAX_HTML_CHARS = 512_000;

/** What the `html_render` tool result carries so a client can show the page. */
export interface HtmlRenderReference {
  /** A thread attachment id ending in `-html`; it names its own thread. */
  readonly attachmentId: string;
  readonly title: string;
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number;
  /**
   * `[width, contentHeight]` pairs measured at publish, ascending by width.
   * Absent when no headless browser was available to measure.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>;
}

/** Frame widths a page is measured at, from phones to a widened chat column. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 728, 860, 1000, 1144] as const;

/**
 * The reply column's width at the default chat width (the timeline's
 * `max-w-3xl` less its padding). Agents preview at it, and it picks the
 * measured height when a client cannot know its width.
 */
export const HTML_RENDER_COLUMN_WIDTH = 728;

/** `html_preview`'s viewport width bounds, in CSS pixels. */
export const HTML_PREVIEW_MIN_WIDTH = 240;
export const HTML_PREVIEW_MAX_WIDTH = 1600;

const MAX_MEASURED_HEIGHTS = 24;
/** `<thread segment>-<uuid>-html`: the attachment store's id shape, html only. */
const HTML_ATTACHMENT_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/i;

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

/** Whether an attachment id is a published page's (`…-html`). */
export function isHtmlRenderAttachmentId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && HTML_ATTACHMENT_ID.test(value);
}

function readMeasuredHeights(value: unknown): Array<readonly [number, number]> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry: unknown) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    (entry[0] as number) >= 1 &&
    (entry[0] as number) <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : []
  );
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined;
}

/** A validated, clamped reference, or undefined when `value` is not one. */
export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { attachmentId, title, height, heights } = value as Record<string, unknown>;
  if (
    !isHtmlRenderAttachmentId(attachmentId) ||
    typeof title !== "string" ||
    typeof height !== "number" ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  const measured = readMeasuredHeights(heights);
  return {
    attachmentId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured })
  };
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference): boolean {
  const leftHeights = left.heights ?? [];
  const rightHeights = right.heights ?? [];
  return (
    left.attachmentId === right.attachmentId &&
    left.title === right.title &&
    left.height === right.height &&
    leftHeights.length === rightHeights.length &&
    leftHeights.every(
      ([width, height], index) => rightHeights[index]?.[0] === width && rightHeights[index]?.[1] === height
    )
  );
}

// The taller of the heights measured at the nearest widths on each side: a
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeight(heights: ReadonlyArray<readonly [number, number]>, width: number): number {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width: the page's own reported
 * `contentHeight` when the client has one, else the publish-time measurement
 * for that width. A page even a few pixels taller than its frame scrolls
 * inside it and takes the reader's scroll, so the frame fits the page. The
 * agent's `height` caps it only when it is below the page's height at the
 * column width (the agent asked for a scrolling frame), or when the page was
 * never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number
): number {
  const heights = reference.heights;
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height));
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)));
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}

// ---------------------------------------------------------------------------
// Finding the reference in a tool row, whatever the provider
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The result field the reference travels in, and its slim-kept session-tool reference key (§1.5). */
const HTML_RENDER_REFERENCE_KEY = "htmlRender";

/**
 * The page reference on a tool row of the session tools' `html_render` call,
 * or undefined. The row must carry the host ingestion's provenance marker
 * (`data.sessionTool`, `session-tools.ts`), stamped for every provider's
 * spelling of a REGISTERED tool — so a user's own server that shares the
 * `orquester` name (or has an `html_render`) never renders a page. The
 * reference is read with the session tools' one reader
 * ({@link sessionToolReferences}): what a slim kept
 * (`data.sessionTool.references.htmlRender`), else the provider's result in
 * whichever layout it recorded it — Claude's `tool_result` block, Codex's
 * `{content, structuredContent}`, OpenCode's output text, Grok's `use_tool`
 * `rawOutput` (`output.OkayOutput`, the result's text).
 *
 * The status is the caller's to judge: a failed call carries no reference.
 */
export function htmlRenderReferenceOfActivityPayload(payload: unknown): HtmlRenderReference | undefined {
  const data = asRecord(asRecord(payload)?.data);
  if (data === undefined || sessionToolNameOfData(data) !== HTML_RENDER_TOOL_NAME) return undefined;
  return readHtmlRenderReference(sessionToolReferences(data, [HTML_RENDER_REFERENCE_KEY])?.[HTML_RENDER_REFERENCE_KEY]);
}

// ---------------------------------------------------------------------------
// Theme tokens
// ---------------------------------------------------------------------------

export type HtmlRenderAppearance = "light" | "dark";

export interface HtmlRenderFonts {
  readonly sans: string;
  readonly mono: string;
}

/** The app's own sans stack (globals.css `body`) and concrete monospace names. */
export const HTML_RENDER_DEFAULT_FONTS: HtmlRenderFonts = {
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  // Concrete names only: some engines alias `ui-monospace` to the proportional UI font.
  mono: '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'
};

/**
 * Fonts a headless browser lays pages out with when measuring: Arial-metric
 * faces stand in for the system UI fonts readers see, so measured heights
 * wrap text close to how a client will.
 */
export const HTML_RENDER_MEASURE_FONTS: HtmlRenderFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace'
};

/** The resolved theme a client hands a page. */
export interface HtmlRenderTheme {
  readonly appearance: HtmlRenderAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

/** Every token a page receives, in the order the theme guide lists them. */
export const HTML_RENDER_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--border",
  "--input",
  "--ring",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--accent-surface",
  "--accent-surface-foreground",
  "--destructive",
  "--destructive-foreground",
  "--destructive-surface",
  "--warning",
  "--warning-foreground",
  "--warning-surface",
  "--success",
  "--success-foreground",
  "--info",
  "--info-foreground",
  "--code-background",
  "--code-foreground",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--radius",
  "--font-sans",
  "--font-mono"
] as const;

/**
 * The palette variables the tokens are mapped from: Orquester's own
 * `--n-*` neutral scale (scheme × mode), `--sem-*` status colours and
 * `--lane-*` categorical hues (mode only), each an `"r g b"` triple.
 */
const HTML_RENDER_PALETTE_VARIABLES = [
  "--n-100",
  "--n-200",
  "--n-400",
  "--n-500",
  "--n-700",
  "--n-800",
  "--n-900",
  "--n-950",
  "--sem-danger-400",
  "--sem-danger-500",
  "--sem-danger-950",
  "--sem-warn-400",
  "--sem-warn-500",
  "--sem-warn-950",
  "--sem-ok-400",
  "--sem-ok-500",
  "--sem-info-400",
  "--sem-info-500",
  "--lane-1",
  "--lane-2",
  "--lane-3",
  "--lane-4",
  "--lane-5",
  "--lane-6"
] as const;

export type HtmlRenderPaletteVariable = (typeof HTML_RENDER_PALETTE_VARIABLES)[number];

/** One palette: every {@link HTML_RENDER_PALETTE_VARIABLES} entry as an `"r g b"` triple. */
export type HtmlRenderPalette = Readonly<Record<HtmlRenderPaletteVariable, string>>;

/**
 * The stock ("mono") palette per mode, as `styles/globals.css` defines it.
 * A published page falls back to it when no client theme reaches it (a
 * direct download, a headless preview).
 */
const HTML_RENDER_STOCK_PALETTES: Readonly<Record<HtmlRenderAppearance, HtmlRenderPalette>> = {
  dark: {
    "--n-100": "245 245 245",
    "--n-200": "229 229 229",
    "--n-400": "183 183 183",
    "--n-500": "132 132 132",
    "--n-700": "64 64 64",
    "--n-800": "35 35 35",
    "--n-900": "18 18 18",
    "--n-950": "3 3 3",
    "--sem-danger-400": "248 113 113",
    "--sem-danger-500": "239 68 68",
    "--sem-danger-950": "69 10 10",
    "--sem-warn-400": "251 191 36",
    "--sem-warn-500": "245 158 11",
    "--sem-warn-950": "69 26 3",
    "--sem-ok-400": "52 211 153",
    "--sem-ok-500": "34 197 94",
    "--sem-info-400": "56 189 248",
    "--sem-info-500": "14 165 233",
    "--lane-1": "96 165 250",
    "--lane-2": "52 211 153",
    "--lane-3": "251 191 36",
    "--lane-4": "244 114 182",
    "--lane-5": "167 139 250",
    "--lane-6": "34 211 238"
  },
  light: {
    "--n-100": "24 24 27",
    "--n-200": "39 39 42",
    "--n-400": "100 100 106",
    "--n-500": "124 124 132",
    "--n-700": "208 208 212",
    "--n-800": "226 226 230",
    "--n-900": "240 240 243",
    "--n-950": "252 252 253",
    "--sem-danger-400": "185 28 28",
    "--sem-danger-500": "220 38 38",
    "--sem-danger-950": "254 202 202",
    "--sem-warn-400": "146 64 14",
    "--sem-warn-500": "180 83 9",
    "--sem-warn-950": "252 211 77",
    "--sem-ok-400": "6 95 70",
    "--sem-ok-500": "21 128 61",
    "--sem-info-400": "3 105 161",
    "--sem-info-500": "2 132 199",
    "--lane-1": "37 99 235",
    "--lane-2": "4 120 87",
    "--lane-3": "133 77 14",
    "--lane-4": "219 39 119",
    "--lane-5": "124 58 237",
    "--lane-6": "14 116 144"
  }
};

type Rgb = readonly [number, number, number];

/** An `"r g b"` triple, or undefined when the text is not one. */
function parseTriple(value: string | undefined): Rgb | undefined {
  const match = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/.exec(value ?? "");
  if (!match) return undefined;
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return channels.every((channel) => channel <= 255) ? channels : undefined;
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of `top` over `base`, per channel. */
function mix(top: Rgb, base: Rgb, amount: number): Rgb {
  return [0, 1, 2].map((index) => top[index]! * amount + base[index]! * (1 - amount)) as unknown as Rgb;
}

/**
 * Maps a palette to the variables a page styles against (T3's token names,
 * spec §2.3), as hex. `--background` is the thread surface behind the frame
 * (`bg-neutral-950`); `--accent` is the first lane hue, since every scheme's
 * neutrals are greys. A palette variable that does not read as a triple
 * falls back to the stock palette's for the same mode, so a page always gets
 * every token.
 */
export function htmlRenderThemeFromPalette(
  read: (variable: HtmlRenderPaletteVariable) => string | undefined,
  appearance: HtmlRenderAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS
): HtmlRenderTheme {
  const stock = HTML_RENDER_STOCK_PALETTES[appearance];
  const rgb = (variable: HtmlRenderPaletteVariable): Rgb =>
    parseTriple(read(variable)) ?? parseTriple(stock[variable])!;
  const hex = (variable: HtmlRenderPaletteVariable): string => rgbToHex(rgb(variable));
  return {
    appearance,
    variables: {
      "--background": hex("--n-950"),
      "--foreground": hex("--n-100"),
      "--muted": hex("--n-900"),
      "--muted-foreground": hex("--n-400"),
      "--card": hex("--n-900"),
      "--card-foreground": hex("--n-100"),
      "--popover": hex("--n-900"),
      "--popover-foreground": hex("--n-100"),
      "--secondary": hex("--n-800"),
      "--secondary-foreground": hex("--n-100"),
      "--border": hex("--n-800"),
      "--input": hex("--n-700"),
      "--ring": hex("--n-500"),
      "--primary": hex("--n-100"),
      "--primary-foreground": hex("--n-950"),
      "--accent": hex("--lane-1"),
      "--accent-foreground": hex("--n-950"),
      "--accent-surface": rgbToHex(mix(rgb("--lane-1"), rgb("--n-950"), 0.16)),
      "--accent-surface-foreground": hex("--lane-1"),
      "--destructive": hex("--sem-danger-500"),
      "--destructive-foreground": hex("--sem-danger-400"),
      "--destructive-surface": hex("--sem-danger-950"),
      "--warning": hex("--sem-warn-500"),
      "--warning-foreground": hex("--sem-warn-400"),
      "--warning-surface": hex("--sem-warn-950"),
      "--success": hex("--sem-ok-500"),
      "--success-foreground": hex("--sem-ok-400"),
      "--info": hex("--sem-info-500"),
      "--info-foreground": hex("--sem-info-400"),
      "--code-background": hex("--n-900"),
      "--code-foreground": hex("--n-200"),
      "--chart-1": hex("--lane-1"),
      "--chart-2": hex("--lane-2"),
      "--chart-3": hex("--lane-3"),
      "--chart-4": hex("--lane-4"),
      "--chart-5": hex("--lane-5"),
      "--chart-6": hex("--lane-6"),
      "--radius": "0.5rem",
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono
    }
  };
}

/** The stock theme for a mode, from {@link HTML_RENDER_STOCK_PALETTES}. */
export function htmlRenderStockTheme(
  appearance: HtmlRenderAppearance,
  fonts: HtmlRenderFonts = HTML_RENDER_DEFAULT_FONTS
): HtmlRenderTheme {
  return htmlRenderThemeFromPalette((variable) => HTML_RENDER_STOCK_PALETTES[appearance][variable], appearance, fonts);
}

/** Agent-facing reference for the injected variables, for tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "Orquester injects the user's live theme as CSS custom properties on :root (hex colours), and they follow the user's colour scheme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it."
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop by default, wider if the reader widens chat, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background colour (transparent). This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again."
].join(" ");

// ---------------------------------------------------------------------------
// The bridge (JSON-RPC over postMessage)
// ---------------------------------------------------------------------------

// MCP Apps method names (https://github.com/modelcontextprotocol/ext-apps),
// so the same host code can later drive upstream MCP apps.
export const HTML_RENDER_HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
export const HTML_RENDER_OPEN_LINK_METHOD = "ui/open-link";
export const HTML_RENDER_SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
// Not MCP Apps: a focused frame keeps its keys from the app, so the client
// tells the page which chords are app shortcuts and the page passes those on.
export const HTML_RENDER_SHORTCUTS_METHOD = "orq/notifications/shortcuts";
export const HTML_RENDER_KEY_DOWN_METHOD = "orq/notifications/keydown";

/** The content height in a page's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  const record = asRecord(data);
  if (record?.jsonrpc !== "2.0" || record.method !== HTML_RENDER_SIZE_CHANGED_METHOD) return undefined;
  const height = asRecord(record.params)?.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

export interface HtmlRenderLinkRequest {
  readonly id: string | number;
  readonly url: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** A page's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readHtmlRenderLinkRequest(data: unknown): HtmlRenderLinkRequest | undefined {
  const record = asRecord(data);
  if (record?.jsonrpc !== "2.0" || record.method !== HTML_RENDER_OPEN_LINK_METHOD) return undefined;
  const { id } = record;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const params = asRecord(record.params);
  const url = params?.url;
  if (typeof url !== "string" || url.length > 8192 || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { id, url, metaKey: params?.metaKey === true, ctrlKey: params?.ctrlKey === true };
}

export interface HtmlRenderKeyDown {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}

/** The key a page passed on in an `orq/notifications/keydown` notification. */
export function readHtmlRenderKeyDown(data: unknown): HtmlRenderKeyDown | undefined {
  const record = asRecord(data);
  if (record?.jsonrpc !== "2.0" || record.method !== HTML_RENDER_KEY_DOWN_METHOD) return undefined;
  const params = asRecord(record.params);
  const key = params?.key;
  const code = params?.code;
  if (typeof key !== "string" || typeof code !== "string" || key.length > 32 || code.length > 32) {
    return undefined;
  }
  return {
    key,
    code,
    metaKey: params?.metaKey === true,
    ctrlKey: params?.ctrlKey === true,
    shiftKey: params?.shiftKey === true,
    altKey: params?.altKey === true,
    repeat: params?.repeat === true
  };
}

/** A chord a page may pass on: `key` lowercase as `KeyboardEvent.key` reads it. */
export interface HtmlRenderShortcut {
  readonly key: string;
  /** The physical key (`KeyK`), which survives a layout that rewrites `key`. */
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Whether a reported key is exactly one of the chords a client allowed. */
export function matchesHtmlRenderShortcut(
  key: Pick<HtmlRenderKeyDown, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  shortcut: HtmlRenderShortcut
): boolean {
  return (
    key.metaKey === shortcut.metaKey &&
    key.ctrlKey === shortcut.ctrlKey &&
    key.shiftKey === shortcut.shiftKey &&
    key.altKey === shortcut.altKey &&
    (key.key.toLowerCase() === shortcut.key || (shortcut.code !== undefined && key.code === shortcut.code))
  );
}

/** The `orq/notifications/shortcuts` notification a client posts into a page. */
export function htmlRenderShortcutsMessage(shortcuts: ReadonlyArray<HtmlRenderShortcut>) {
  return { jsonrpc: "2.0", method: HTML_RENDER_SHORTCUTS_METHOD, params: { shortcuts } } as const;
}

/** The empty result a client sends back for a page's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

const THEME_FRAGMENT_KEY = "orq-theme";

/** URL fragment that hands a page its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The `host-context-changed` notification a client posts into a mounted page when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HTML_RENDER_HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } }
  } as const;
}

/**
 * The theme a page's bootstrap would apply from a `host-context-changed`
 * payload: keys must match `^--[a-z0-9-]+$` and values lose `;{}<>`. The
 * bootstrap script below inlines the same rule; this is its testable twin.
 */
export function sanitizeHtmlRenderThemeVariables(variables: unknown): Record<string, string> {
  const record = asRecord(variables);
  const clean: Record<string, string> = {};
  if (record === undefined) return clean;
  for (const [key, value] of Object.entries(record)) {
    if (/^--[a-z0-9-]+$/.test(key)) clean[key] = String(value).replace(/[;{}<>]/g, "");
  }
  return clean;
}

// ---------------------------------------------------------------------------
// The bootstrap injected into a published page
// ---------------------------------------------------------------------------

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  // Focus outlines paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks never replaces the page inside the thread: a framed page
// asks its client to open it, and a top-level page opens it as a new window.
// A framed page reports its content height, so its client can fit the frame
// to it. A chord the client named as an app shortcut is passed on rather than
// left to the browser, unless a text field has focus or the page handled it:
// the deciding listener is added while the key dispatches, so it runs after
// every listener the page has.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("orq-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HTML_RENDER_HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"orq-link-"+(++n),method:${JSON.stringify(HTML_RENDER_OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(HTML_RENDER_SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);var K=[];window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HTML_RENDER_SHORTCUTS_METHOD)}&&p&&Array.isArray(p.shortcuts))K=p.shortcuts;});window.addEventListener("keydown",function(e){var t=e.composedPath()[0],l=(e.key||"").toLowerCase(),f,m=function(s){return s&&s.metaKey===e.metaKey&&s.ctrlKey===e.ctrlKey&&s.shiftKey===e.shiftKey&&s.altKey===e.altKey&&(s.key===l||(!!s.code&&s.code===e.code));};if(!e.isTrusted||e.isComposing||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))||!K.some(m))return;f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(HTML_RENDER_KEY_DOWN_METHOD)},params:{key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat}},"*");};window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);}})();`;

function bootstrapMarkup(markup: string): string {
  const dark = htmlRenderStockTheme("dark");
  const light = htmlRenderStockTheme("light");
  // Without a client-provided theme (a direct download, a headless preview
  // with no fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="orq-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`
  ].join("");
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
function blankNonMarkup(html: string): string {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length)
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join("");
}

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/**
 * The CSP every served page carries (spec §2.2): an opaque origin, scripts
 * and forms, popups and downloads — no modals, no same-origin, no top
 * navigation. The web's Caddy adds `frame-ancestors 'self'` on its own.
 */
export const HTML_RENDER_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

/** A signed page URL lives at most this long (spec §2.2). */
export const HTML_RENDER_URL_MAX_LIFETIME_MS = 15 * 60_000;
/** A frame mounting with less life than this left on a cached URL mints a new one. */
export const HTML_RENDER_URL_MIN_REMAINING_MS = 5 * 60_000;
