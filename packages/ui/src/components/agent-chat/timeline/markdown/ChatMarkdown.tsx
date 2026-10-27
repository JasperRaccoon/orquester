import React from "react";
import { Image as ImageIcon } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseForgeLink, parseKnowledgeCitationHref } from "@orquester/api";

import { useApi } from "../../../../context/orquester-context";
import { useObjectUrl } from "../../../../hooks";
import { cn } from "../../../../lib/cn";
import { detectFileKind } from "../../../../lib/file-kind";
import { isUrlText } from "../../../../lib/github-links/text-links";
import { useAppStore } from "../../../../store/app";
import { ForgeLinkPill } from "../../forge-links/ForgeLinkPill";
import { useTimelineRowContext } from "../context";
import { CodeBlock } from "./CodeBlock";
import { extractFenceLanguage } from "./highlight-core";
import { createIncrementalMarkdownPlugin } from "./incremental";
import { KnowledgeCitation } from "./KnowledgeCitation";
import { resolveMarkdownImageSource } from "./local-image";
import { MarkdownMath } from "./MarkdownMath";
import { mathKind, mightContainMath, remarkChatMath } from "./math";
import { copyMathSelection } from "./math-clipboard";
import { MermaidBlock } from "./MermaidBlock";
import { isMermaidFence } from "./mermaid-engine";

/**
 * Assistant markdown (spec §7.3).
 *
 * `react-markdown` + `remark-gfm`, **never an HTML string**: provider text is
 * untrusted by construction, and `dangerouslySetInnerHTML` on it is stored XSS
 * in a single-user box whose sessions run shells. `react-markdown` also refuses
 * raw HTML by default, which is the behaviour we want and the reason no
 * `rehype-raw` appears anywhere near this file. Math (`math.ts`) arrives as
 * `code.language-math` elements and is typeset by `MarkdownMath`, which loads
 * KaTeX only once a message has a formula.
 *
 * Three rules, all of them T3's:
 *
 *  1. **The component map is a module constant and everything variable travels
 *     on a context.** `react-markdown` rebuilds its processor whenever the
 *     `components` or `remarkPlugins` identity changes, so a map rebuilt per
 *     render would re-derive the pipeline on every streamed token.
 *     *T3: `ChatMarkdown.tsx:2658-2727, 3345, 3366`.*
 *  2. **The incremental parser is armed narrowly**: only while streaming, only
 *     when the text already contains a fence, and only with the default plugin
 *     set. Outside those three conditions the cache cannot pay for itself and
 *     its bail-outs are not free. *T3: `ChatMarkdown.tsx:3318-3329`.*
 *  3. **Every message is `memo`ised on its text**, because the timeline
 *     re-renders on every frame of a stream and only one message changed.
 *
 * Type note: `mdast` and `unified` are transitive dependencies of
 * `react-markdown`, so their type packages are not resolvable from this
 * workspace package. The incremental plugin is typed structurally and cast to
 * `typeof remarkGfm` — the one shape in scope known to be a valid `Pluggable`.
 */

export interface ChatMarkdownProps {
  text: string;
  /** Arms the incremental parser and the per-block streaming fade. */
  streaming?: boolean;
  /** Opens a workspace-relative link in an editor tab instead of navigating. */
  onOpenFile?: ((path: string) => void) | undefined;
  /**
   * Remote (`http(s):`) images: `"load"` (the default) shows them at once; `"click"` holds each back
   * behind a "Load image" button, so text saved from elsewhere cannot fire a tracking pixel on open.
   */
  remoteImages?: "load" | "click";
  className?: string;
}

// ---------------------------------------------------------------------------
// The context every component reads, so the component map can be a constant
// ---------------------------------------------------------------------------

interface MarkdownConfig {
  mode: "light" | "dark";
  streaming: boolean;
  onOpenFile: ((path: string) => void) | undefined;
  remoteImages: "load" | "click";
}

const DEFAULT_CONFIG: MarkdownConfig = { mode: "dark", streaming: false, onOpenFile: undefined, remoteImages: "load" };

const MarkdownConfigCtx = React.createContext<MarkdownConfig>(DEFAULT_CONFIG);

const BLOCK_SPACING = "my-[0.65rem] first:mt-0 last:mb-0";
const HEADING_BASE = "mb-2 mt-5 font-semibold leading-[1.3] text-neutral-100 first:mt-0";

/** A link target that may resolve to an editor tab rather than a navigation. */
function looksLikeWorkspacePath(href: string): boolean {
  if (href.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  if (href.startsWith("#")) return false;
  return true;
}

function nodeToText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map((child) => nodeToText(child)).join("");
  if (React.isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode };
    return nodeToText(props.children);
  }
  return "";
}

function MarkdownCode({
  className,
  children
}: {
  className?: string | undefined;
  children?: React.ReactNode;
}): React.ReactElement {
  const { mode, streaming } = React.useContext(MarkdownConfigCtx);
  const text = nodeToText(children);
  const math = mathKind(className);
  if (math) return <MarkdownMath tex={text} display={math === "display"} />;
  const language = extractFenceLanguage(className);
  // `react-markdown` marks a fenced block with `language-*`; a fence with no
  // info string arrives with no class but always with a trailing newline.
  const fenced = language.length > 0 || text.includes("\n");
  if (!fenced) {
    return (
      <code
        className={cn(
          "rounded-[0.375rem] border border-neutral-800 bg-neutral-900/70 px-[0.35rem] py-[0.1rem]",
          // 12px inside a 14px sentence, so inline code never towers over it.
          "font-mono text-[0.75rem] text-neutral-200"
        )}
      >
        {children}
      </code>
    );
  }
  const code = text.replace(/\n$/, "");
  if (isMermaidFence(language)) return <MermaidBlock code={code} streaming={streaming} mode={mode} />;
  return <CodeBlock code={code} info={language} streaming={streaming} mode={mode} />;
}

/**
 * `react-markdown`'s URL filter, which keeps relative URLs and http(s),
 * mailto, irc(s) and xmpp — plus exactly one more: a link to a knowledge
 * entry (`orquester-knowledge:entry/<id>`, the Knowledge Graph's citation),
 * which renders as a chip and never navigates. Nothing else of that scheme,
 * and nothing as an image source.
 */
export const chatUrlTransform: UrlTransform = (url, key) =>
  key === "href" && parseKnowledgeCitationHref(url) ? url : defaultUrlTransform(url);

function MarkdownLink({
  href,
  children
}: {
  href?: string | undefined;
  children?: React.ReactNode;
}): React.ReactElement {
  const { onOpenFile } = React.useContext(MarkdownConfigCtx);
  const target = href ?? "";
  const citation = parseKnowledgeCitationHref(target);
  if (citation) return <KnowledgeCitation entryId={citation.id}>{children}</KnowledgeCitation>;
  return <MarkdownAnchor target={target} onOpenFile={onOpenFile}>{children}</MarkdownAnchor>;
}

function MarkdownAnchor({
  target,
  onOpenFile,
  children
}: {
  target: string;
  onOpenFile: ((path: string) => void) | undefined;
  children?: React.ReactNode;
}): React.ReactElement {
  const forge = React.useMemo(() => parseForgeLink(target), [target]);
  // A GitHub (or GitLab/Bitbucket change request) link is a pill: an autolink shows the short
  // label, a link with the author's own words keeps them. An image-only link (a badge) stays a
  // plain link around its image.
  const text = forge ? nodeToText(children) : "";
  if (forge && text.trim().length > 0) {
    return <ForgeLinkPill link={forge}>{isUrlText(text, target) ? undefined : children}</ForgeLinkPill>;
  }
  // Info-coloured, no underline at rest; hover draws a dotted one.
  const linkClass = "text-info-300 underline-offset-2 hover:underline hover:decoration-dotted";
  if (onOpenFile && looksLikeWorkspacePath(target)) {
    return (
      <button type="button" onClick={() => onOpenFile(target)} className={cn("cursor-pointer", linkClass)}>
        {children}
      </button>
    );
  }
  return (
    <a href={target} target="_blank" rel="noreferrer noopener" className={linkClass}>
      {children}
    </a>
  );
}

const IMAGE_CLASS = "my-[0.65rem] max-h-64 max-w-full rounded-md border border-neutral-800";

function MissingImage({ label }: { label: string }): React.ReactElement {
  return <span className="text-xs text-neutral-500">Image unavailable: {label}</span>;
}

/** A file on the daemon's host, read through the file API (`local-image.ts`). */
function LocalMarkdownImage({ path, alt }: { path: string; alt: string }): React.ReactElement {
  const api = useApi();
  const fetchBytes = React.useCallback((p: string, signal?: AbortSignal) => api.readFileBytes(p, signal), [api]);
  const { kind, mime } = detectFileKind(path);
  const { url, error } = useObjectUrl(fetchBytes, path, mime, kind === "image");
  if (kind !== "image" || error) return <MissingImage label={alt || path} />;
  if (!url) return <span className="text-xs text-neutral-600">Loading image…</span>;
  return <img src={url} alt={alt} title={path} className={IMAGE_CLASS} />;
}

/** A remote image held back until clicked (`remoteImages: "click"`): nothing is requested before. */
function ClickToLoadImage({ src, alt }: { src: string; alt: string }): React.ReactElement {
  const [load, setLoad] = React.useState(false);
  if (load) return <img src={src} alt={alt} className={IMAGE_CLASS} />;
  let host = "";
  try {
    host = new URL(src, "http://invalid").host;
  } catch {
    // Unparseable: the button just says "Load image".
  }
  const label = [alt.trim(), host && host !== "invalid" ? `(${host})` : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      title={src}
      onClick={() => setLoad(true)}
      className="inline-flex max-w-full items-center gap-1 rounded border border-neutral-800 px-1.5 py-0.5 align-middle text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
    >
      <ImageIcon size={12} className="shrink-0" />
      <span className="truncate">Load image{label ? `: ${label}` : ""}</span>
    </button>
  );
}

function MarkdownImage({ src, alt }: { src?: string | undefined; alt?: string | undefined }): React.ReactElement {
  const { workspaceRoot } = useTimelineRowContext();
  const { remoteImages } = React.useContext(MarkdownConfigCtx);
  const source = resolveMarkdownImageSource(src ?? "", workspaceRoot);
  if (source.kind === "local") return <LocalMarkdownImage path={source.path} alt={alt ?? ""} />;
  if (source.kind === "unresolved") return <MissingImage label={alt || source.src} />;
  if (remoteImages === "click") return <ClickToLoadImage key={source.src} src={source.src} alt={alt ?? ""} />;
  return <img src={source.src} alt={alt ?? ""} className={IMAGE_CLASS} />;
}

/** Module constant: its identity never changes, so neither does the processor. */
const COMPONENTS: Components = {
  p: ({ children }) => <p className={BLOCK_SPACING}>{children}</p>,
  // Headings barely exceed body text: a chat heading is structure, not a
  // billboard. *T3: `index.css:1689-1705`.*
  h1: ({ children }) => <h1 className={cn(HEADING_BASE, "text-[1.25rem]")}>{children}</h1>,
  h2: ({ children }) => <h2 className={cn(HEADING_BASE, "text-[1.125rem]")}>{children}</h2>,
  h3: ({ children }) => <h3 className={cn(HEADING_BASE, "text-[1rem]")}>{children}</h3>,
  h4: ({ children }) => <h4 className={cn(HEADING_BASE, "text-[0.875rem]")}>{children}</h4>,
  h5: ({ children }) => <h5 className={cn(HEADING_BASE, "text-[0.875rem]")}>{children}</h5>,
  h6: ({ children }) => <h6 className={cn(HEADING_BASE, "text-[0.875rem]")}>{children}</h6>,
  ul: ({ children }) => <ul className={cn(BLOCK_SPACING, "list-disc pl-5")}>{children}</ul>,
  ol: ({ children }) => (
    <ol
      className={cn(
        BLOCK_SPACING,
        "list-decimal pl-5 [&>li]:[&::marker]:[font-variant-numeric:tabular-nums]"
      )}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="[&+li]:mt-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className={cn(BLOCK_SPACING, "border-l-2 border-neutral-700 pl-[0.8rem] text-neutral-400")}>
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-neutral-800" />,
  // `pre` is a pass-through: the fenced block builds its own chrome, and a
  // `<div>` of chrome may not be nested inside a `<pre>`.
  pre: ({ children }) => <>{children}</>,
  code: MarkdownCode,
  a: MarkdownLink,
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className={cn(BLOCK_SPACING, "ac-scroll-thin overflow-x-auto")}>
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="text-neutral-300">{children}</thead>,
  // Row separators only, no zebra. *T3: `index.css:1915-1939`.*
  tr: ({ children }) => <tr className="border-b border-neutral-800 last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-[0.45rem] text-left font-semibold text-neutral-200">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-[0.45rem] align-top break-words text-neutral-300">{children}</td>
  )
};

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

const STATIC_PLUGINS = [remarkGfm];
const MATH_PLUGINS = [remarkGfm, remarkChatMath as unknown as typeof remarkGfm];

/**
 * Arms the incremental parser: streaming, and the text already contains a
 * fence. Below that there is nothing expensive to skip, and the cache's
 * bail-out checks are not free. *T3: `ChatMarkdown.tsx:3318-3329`.*
 */
function shouldArmIncrementalParser(text: string, streaming: boolean): boolean {
  return streaming && (text.includes("```") || text.includes("~~~"));
}

export const ChatMarkdown = React.memo(function ChatMarkdown({
  text,
  streaming = false,
  onOpenFile,
  remoteImages = "load",
  className
}: ChatMarkdownProps): React.ReactElement {
  const mode = useAppStore((state) => state.resolvedMode);

  // One cache per renderer instance, as the port requires: it must survive the
  // whole streamed message, so it is a ref rather than a memo.
  const incrementalPlugin = React.useRef<typeof remarkGfm | null>(null);
  incrementalPlugin.current ??= createIncrementalMarkdownPlugin() as unknown as typeof remarkGfm;

  const armed = shouldArmIncrementalParser(text, streaming);
  // Math is armed per message by a delimiter (`mightContainMath`), so the
  // common message pays nothing for it; the arrays are memoised so a stream's
  // tokens keep the processor unless one of the two switches flips.
  const math = mightContainMath(text);
  const plugins = React.useMemo(() => {
    const base = math ? MATH_PLUGINS : STATIC_PLUGINS;
    return armed ? [...base, incrementalPlugin.current as typeof remarkGfm] : base;
  }, [armed, math]);

  const config = React.useMemo<MarkdownConfig>(
    () => ({ mode, streaming, onOpenFile, remoteImages }),
    [mode, streaming, onOpenFile, remoteImages]
  );

  return (
    <MarkdownConfigCtx.Provider value={config}>
      <div
        className={cn(
          "ac-stream min-w-0 text-sm leading-relaxed text-neutral-300 [overflow-wrap:anywhere]",
          className
        )}
        {...(streaming ? { "data-streaming": "true" } : {})}
        onCopy={math ? copyMathSelection : undefined}
      >
        <Markdown remarkPlugins={plugins} components={COMPONENTS} urlTransform={chatUrlTransform}>
          {text}
        </Markdown>
      </div>
    </MarkdownConfigCtx.Provider>
  );
});

// ---------------------------------------------------------------------------
// Inline markdown, for text that lives inside a control
// ---------------------------------------------------------------------------

/**
 * Emphasis, code, math and links only; everything else is unwrapped to its text. A
 * question option's description sits inside the option's `<button>`, where a
 * block (`<div>`, `<p>`, `<pre>`) or a second interactive element is invalid
 * markup — and a link that navigated would swallow the click that picks the
 * option — so a link reads as one and nothing more.
 */
const INLINE_ELEMENTS = ["p", "strong", "em", "del", "code", "a", "br"];

const INLINE_COMPONENTS: Components = {
  // A `<span>`, not a `<p>`: phrasing content only inside a button.
  p: ({ children }) => <span className="block [&:not(:first-child)]:mt-1">{children}</span>,
  code: ({ className, children }) => {
    const math = mathKind(className);
    if (math) return <MarkdownMath tex={nodeToText(children)} display={math === "display"} focusable={false} />;
    return (
      <code className="rounded-[0.3rem] border border-neutral-800 bg-neutral-900/70 px-1 font-mono text-[0.92em] text-neutral-300">
        {children}
      </code>
    );
  },
  a: ({ children }) => <span className="text-info-300">{children}</span>
};

export interface ChatInlineMarkdownProps {
  text: string;
  className?: string;
}

/** {@link ChatMarkdown}'s inline subset, as phrasing content (see `INLINE_ELEMENTS`). */
export const ChatInlineMarkdown = React.memo(function ChatInlineMarkdown({
  text,
  className
}: ChatInlineMarkdownProps): React.ReactElement {
  return (
    <span className={cn("min-w-0 [overflow-wrap:anywhere]", className)}>
      <Markdown
        remarkPlugins={mightContainMath(text) ? MATH_PLUGINS : STATIC_PLUGINS}
        allowedElements={INLINE_ELEMENTS}
        unwrapDisallowed
        components={INLINE_COMPONENTS}
      >
        {text}
      </Markdown>
    </span>
  );
});

export default ChatMarkdown;
