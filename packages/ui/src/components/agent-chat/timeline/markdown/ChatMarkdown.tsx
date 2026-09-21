import React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../../../lib/cn";
import { useAppStore } from "../../../../store/app";
import { CodeBlock } from "./CodeBlock";
import { extractFenceLanguage } from "./highlight-core";
import { createIncrementalMarkdownPlugin } from "./incremental";

/**
 * Assistant markdown (spec §7.3).
 *
 * `react-markdown` + `remark-gfm`, **never an HTML string**: provider text is
 * untrusted by construction, and `dangerouslySetInnerHTML` on it is stored XSS
 * in a single-user box whose sessions run shells. `react-markdown` also refuses
 * raw HTML by default, which is the behaviour we want and the reason no
 * `rehype-raw` appears anywhere near this file.
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
  className?: string;
}

// ---------------------------------------------------------------------------
// The context every component reads, so the component map can be a constant
// ---------------------------------------------------------------------------

interface MarkdownConfig {
  mode: "light" | "dark";
  streaming: boolean;
  onOpenFile: ((path: string) => void) | undefined;
}

const DEFAULT_CONFIG: MarkdownConfig = { mode: "dark", streaming: false, onOpenFile: undefined };

const MarkdownConfigCtx = React.createContext<MarkdownConfig>(DEFAULT_CONFIG);

const BLOCK_SPACING = "my-[0.65rem] first:mt-0 last:mb-0";
const HEADING_BASE = "mb-2 mt-5 font-semibold leading-[1.3] text-neutral-100 first:mt-0";

/** A link target that may resolve to an editor tab rather than a navigation. */
export function looksLikeWorkspacePath(href: string): boolean {
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
  const language = extractFenceLanguage(className);
  const text = nodeToText(children);
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
  return <CodeBlock code={text.replace(/\n$/, "")} info={language} streaming={streaming} mode={mode} />;
}

function MarkdownLink({
  href,
  children
}: {
  href?: string | undefined;
  children?: React.ReactNode;
}): React.ReactElement {
  const { onOpenFile } = React.useContext(MarkdownConfigCtx);
  const target = href ?? "";
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
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="my-[0.65rem] max-h-64 max-w-full rounded-md border border-neutral-800"
    />
  ),
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
    <td className="max-w-96 truncate px-3 py-[0.45rem] align-top text-neutral-300">{children}</td>
  )
};

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

const STATIC_PLUGINS = [remarkGfm];

/**
 * Arms the incremental parser: streaming, and the text already contains a
 * fence. Below that there is nothing expensive to skip, and the cache's
 * bail-out checks are not free. *T3: `ChatMarkdown.tsx:3318-3329`.*
 */
export function shouldArmIncrementalParser(text: string, streaming: boolean): boolean {
  return streaming && (text.includes("```") || text.includes("~~~"));
}

export const ChatMarkdown = React.memo(function ChatMarkdown({
  text,
  streaming = false,
  onOpenFile,
  className
}: ChatMarkdownProps): React.ReactElement {
  const mode = useAppStore((state) => state.resolvedMode);

  // One cache per renderer instance, as the port requires: it must survive the
  // whole streamed message, so it is a ref rather than a memo.
  const incrementalPlugin = React.useRef<typeof remarkGfm | null>(null);
  incrementalPlugin.current ??= createIncrementalMarkdownPlugin() as unknown as typeof remarkGfm;

  const armed = shouldArmIncrementalParser(text, streaming);
  const plugins = React.useMemo(
    () => (armed ? [remarkGfm, incrementalPlugin.current as typeof remarkGfm] : STATIC_PLUGINS),
    [armed]
  );

  const config = React.useMemo<MarkdownConfig>(
    () => ({ mode, streaming, onOpenFile }),
    [mode, streaming, onOpenFile]
  );

  return (
    <MarkdownConfigCtx.Provider value={config}>
      <div
        className={cn(
          "ac-stream min-w-0 text-sm leading-relaxed text-neutral-300 [overflow-wrap:anywhere]",
          className
        )}
        {...(streaming ? { "data-streaming": "true" } : {})}
      >
        <Markdown remarkPlugins={plugins} components={COMPONENTS}>
          {text}
        </Markdown>
      </div>
    </MarkdownConfigCtx.Provider>
  );
});

export default ChatMarkdown;
