/**
 * Previewing and measuring agent pages (design 2026-10-14 §2.1, §2.2) — what
 * `html_preview` answers and what `html_render` publishes its heights with.
 *
 * Ported from T3 Code (MIT): `apps/server/src/htmlRender/HtmlRender.ts`
 * (`preview`, `measure`). Both load the page as it is published: the theme +
 * bridge bootstrap injected, local images from inside the thread's project
 * inlined (`../agent-chat/html-render-publish.ts`), the stock theme for the
 * requested appearance in the URL fragment, Arial-metric fonts so text wraps
 * close to how readers see it.
 */

import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  HTML_PREVIEW_MAX_WIDTH,
  HTML_PREVIEW_MIN_WIDTH,
  htmlRenderStockTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  type HtmlRenderAppearance
} from "@orquester/api/agent-chat";

import { inlineLocalImages, type HtmlRenderHeights, type LocalImageReader } from "../agent-chat/html-render-publish.ts";
import type { HtmlConsoleMessage, HtmlPageRenderer, HtmlScreenshot } from "./browser.ts";

export { HtmlPreviewBrowser, HtmlPreviewError } from "./browser.ts";
export type { HtmlConsoleMessage, HtmlPageRenderer, HtmlScreenshot } from "./browser.ts";

export interface HtmlPreviewInput {
  html: string;
  /** CSS pixels, clamped to 240..1600; the reply column's width by default. */
  width?: number;
  /** Dark by default. */
  appearance?: HtmlRenderAppearance;
  /** The realpath local images must sit inside (the thread's project), or null for none. */
  sandboxRoot: string | null;
  /** boxes: where the images are read when the project lives in a box (absent: this host). */
  images?: LocalImageReader;
  signal?: AbortSignal;
}

export interface HtmlPreview {
  /** The top `capturedHeight` pixels: PNG, or JPEG (possibly scaled down) when a PNG would be too large. */
  screenshot: HtmlScreenshot;
  width: number;
  contentHeight: number;
  capturedHeight: number;
  consoleMessages: HtmlConsoleMessage[];
  /** Local image paths that could not be read; they show as broken images. */
  missingImages?: string[];
  /** Local image paths outside the thread's project; never read, they show as broken images. */
  imagesOutsideProject?: string[];
}

/**
 * Screenshots a page as a reader would see it at `width`. Unlike publishing,
 * an unreadable local image is reported, not refused, so the agent can see
 * the rest of the page; a too-large image or page still throws
 * `HtmlRenderPublishError`.
 */
export async function previewHtmlPage(browser: HtmlPageRenderer, input: HtmlPreviewInput): Promise<HtmlPreview> {
  const width = Math.min(
    HTML_PREVIEW_MAX_WIDTH,
    Math.max(HTML_PREVIEW_MIN_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH))
  );
  const theme = htmlRenderStockTheme(input.appearance ?? "dark", HTML_RENDER_MEASURE_FONTS);
  let missing: string[] = [];
  let outside: string[] = [];
  const capture = await browser.capture({
    // Inlined only once the call has its browser slot, so waiting calls hold
    // no inlined pages. The bootstrap goes in first, so its head scan never
    // runs over inlined image data.
    html: async () => {
      const inlined = await inlineLocalImages(injectHtmlRenderBootstrap(input.html), input.sandboxRoot, input.images);
      ({ missing, outside } = inlined);
      return inlined.html;
    },
    width,
    urlFragment: htmlRenderThemeFragment(theme),
    ...(input.signal ? { signal: input.signal } : {})
  });
  return {
    screenshot: capture.screenshot,
    width,
    contentHeight: capture.contentHeight,
    capturedHeight: capture.capturedHeight,
    consoleMessages: capture.consoleMessages,
    ...(missing.length > 0 ? { missingImages: missing } : {}),
    ...(outside.length > 0 ? { imagesOutsideProject: outside } : {})
  };
}

// Measured in the dark theme with Arial-metric fonts, so text wraps close to how clients show it.
const MEASURE_FRAGMENT = htmlRenderThemeFragment(htmlRenderStockTheme("dark", HTML_RENDER_MEASURE_FONTS));

/**
 * The heights a published page carries: the PREPARED page measured at every
 * client width, or undefined when no browser could measure it in time.
 */
export function measureHtmlPage(
  browser: HtmlPageRenderer,
  preparedHtml: string,
  signal?: AbortSignal
): Promise<HtmlRenderHeights | undefined> {
  return browser.measure({
    html: preparedHtml,
    widths: HTML_RENDER_MEASURE_WIDTHS,
    urlFragment: MEASURE_FRAGMENT,
    ...(signal ? { signal } : {})
  });
}
