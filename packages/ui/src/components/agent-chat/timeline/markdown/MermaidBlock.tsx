// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatMarkdown.tsx
// (`MarkdownMermaidCodeBlock`) and MermaidDiagram.tsx.

import React from "react";
import { Code, Maximize2, Workflow } from "lucide-react";

import { Modal, ModalCloseButton } from "../../../ui";
import { ChatIconButton } from "../../primitives";
import { CodeBlock } from "./CodeBlock";
import { getMermaidRenderer } from "./mermaid-engine";
import type { MermaidRenderer, MermaidTheme } from "./mermaid-render";
import { createDiagramBlobUrl, uniquifySvgIds } from "./mermaid-svg";

/**
 * A ` ```mermaid ` fence (spec §4): a diagram once the message settles, the
 * highlighted source before that and whenever it cannot be drawn.
 *
 *  - **Streaming shows code.** A half-written diagram is a syntax error on
 *    every token, so nothing renders until the stream ends.
 *  - **Diagram ↔ code toggle** in the block's header, and the header's copy
 *    button always copies the source.
 *  - **A diagram that does not parse** keeps the highlighted source and puts
 *    the parser's message above it (with Retry when the cause was a lost
 *    chunk, not the text). A render that *throws* is caught by the boundary and
 *    falls back to the same source view.
 *  - **Expand** opens the SVG as a standalone image in the app's modal layer,
 *    through a `blob:` URL (the production `img-src` allows it; `data:` URLs
 *    failed the desktop's connect-src policy in T3).
 *
 * The one `dangerouslySetInnerHTML` here is Mermaid's SVG after Mermaid's own
 * strict sanitising and the DOMPurify pass in `mermaid-svg.ts`; it is never
 * provider text.
 */

export interface MermaidBlockProps {
  code: string;
  streaming: boolean;
  mode: MermaidTheme;
  /** Test seam; the app-wide renderer otherwise. */
  renderer?: MermaidRenderer;
}

/** Falls back when the diagram's render throws; a new source or theme tries again. */
class DiagramBoundary extends React.Component<
  { resetKey: string; fallback: React.ReactNode; children: React.ReactNode },
  { failed: boolean; resetKey: string }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; resetKey: string }
  ): { failed: boolean; resetKey: string } | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ViewToggle({ showingCode, onToggle }: { showingCode: boolean; onToggle: () => void }): React.ReactElement {
  return (
    <ChatIconButton size="xs" label={showingCode ? "Show diagram" : "Show code"} onClick={onToggle}>
      {showingCode ? (
        <Workflow size={12} strokeWidth={1.8} aria-hidden />
      ) : (
        <Code size={12} strokeWidth={1.8} aria-hidden />
      )}
    </ChatIconButton>
  );
}

let diagramMounts = 0;

function DiagramBody({ svg, onExpand }: { svg: string; onExpand: () => void }): React.ReactElement {
  // The cached SVG is shared by every mount of this diagram; its ids are made this mount's own.
  const [mount] = React.useState(() => ++diagramMounts);
  const html = React.useMemo(() => uniquifySvgIds(svg, `m${mount}`), [svg, mount]);
  return (
    // The header's "Expand diagram" is the one control assistive tech and the
    // keyboard get; the diagram itself is a mouse shortcut for it, so it is
    // out of the tab order and hidden from the accessibility tree.
    <div role="img" aria-label="Mermaid diagram" className="ac-scroll-thin overflow-x-auto px-[0.9rem] pb-[0.8rem] pt-1">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onExpand}
        className="flex w-full cursor-zoom-in justify-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ExpandedDiagram({ svg, onClose }: { svg: string; onClose: () => void }): React.ReactElement {
  const [view, setView] = React.useState<{ url: string } | { error: string } | null>(null);
  // Created on open and revoked on close, so a closed viewer holds no blob.
  React.useEffect(() => {
    try {
      const created = createDiagramBlobUrl(svg);
      setView({ url: created });
      return () => URL.revokeObjectURL(created);
    } catch (error) {
      setView({ error: error instanceof Error ? error.message : "The diagram could not be opened." });
      return undefined;
    }
  }, [svg]);
  return (
    <Modal open onClose={onClose} className="max-h-[90vh] max-w-6xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
          <span className="truncate text-sm text-neutral-200">Mermaid diagram</span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="ac-scroll-thin min-h-0 flex-1 overflow-auto p-3">
          {view !== null && "error" in view ? (
            <p className="m-0 text-sm text-danger-300">{view.error}</p>
          ) : view !== null ? (
            // Small diagrams grow to a readable width; wide ones keep their
            // natural size and scroll.
            <img
              src={view.url}
              alt="Mermaid diagram"
              className="mx-auto block max-w-none"
              style={{ minWidth: "min(100%, 60rem)" }}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** Suspends until the diagram is drawn (or has failed). */
function SettledDiagram({
  code,
  mode,
  renderer,
  onToggle,
  onRetry
}: {
  code: string;
  mode: MermaidTheme;
  renderer: MermaidRenderer;
  onToggle: () => void;
  onRetry: () => void;
}): React.ReactElement {
  const result = renderer.read(code, mode);
  const [expanded, setExpanded] = React.useState(false);
  const closeExpanded = React.useCallback(() => setExpanded(false), []);

  if (result.status === "error") {
    return (
      <CodeBlock
        code={code}
        info="mermaid"
        streaming={false}
        mode={mode}
        notice={
          <div className="flex items-center justify-between gap-2 px-[0.9rem] pb-1 pt-1">
            <p className="m-0 min-w-0 text-xs text-danger-300 [overflow-wrap:anywhere]">
              Unable to render diagram: {result.message}
            </p>
            {result.retryable ? (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 rounded-md px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                Retry
              </button>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <>
      <CodeBlock
        code={code}
        info="mermaid"
        streaming={false}
        mode={mode}
        leadingActions={
          <>
            <ViewToggle showingCode={false} onToggle={onToggle} />
            <ChatIconButton size="xs" label="Expand diagram" onClick={() => setExpanded(true)}>
              <Maximize2 size={12} strokeWidth={1.8} aria-hidden />
            </ChatIconButton>
          </>
        }
        body={<DiagramBody svg={result.svg} onExpand={() => setExpanded(true)} />}
      />
      {expanded ? <ExpandedDiagram svg={result.svg} onClose={closeExpanded} /> : null}
    </>
  );
}

export function MermaidBlock({ code, streaming, mode, renderer }: MermaidBlockProps): React.ReactElement {
  const [showCode, setShowCode] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const toggle = React.useCallback(() => setShowCode((value) => !value), []);

  const showDiagram = !showCode && !streaming && code.trim().length > 0;
  const source = (
    <CodeBlock
      code={code}
      info="mermaid"
      streaming={streaming}
      mode={mode}
      leadingActions={showCode && !streaming ? <ViewToggle showingCode onToggle={toggle} /> : undefined}
    />
  );
  if (!showDiagram) return source;

  const live = renderer ?? getMermaidRenderer();
  return (
    <DiagramBoundary resetKey={`${mode}\n${code}`} fallback={source}>
      <React.Suspense
        key={attempt}
        fallback={
          <CodeBlock
            code={code}
            info="mermaid"
            streaming={false}
            mode={mode}
            body={
              <div className="flex min-h-24 items-center justify-center px-3 pb-3 text-xs text-neutral-500">
                Rendering diagram…
              </div>
            }
          />
        }
      >
        <SettledDiagram
          code={code}
          mode={mode}
          renderer={live}
          onToggle={toggle}
          onRetry={() => {
            live.invalidate(code, mode);
            setAttempt((value) => value + 1);
          }}
        />
      </React.Suspense>
    </DiagramBoundary>
  );
}

export default MermaidBlock;
