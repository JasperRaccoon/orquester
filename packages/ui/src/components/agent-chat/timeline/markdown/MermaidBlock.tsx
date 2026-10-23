// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatMarkdown.tsx
// (`MarkdownMermaidCodeBlock`) and MermaidDiagram.tsx (the pele mount).

import React from "react";
import { Code, Maximize2, Workflow } from "lucide-react";

import { Modal, ModalCloseButton } from "../../../ui";
import { ChatIconButton } from "../../primitives";
import { CodeBlock } from "./CodeBlock";
import {
  detectDiagramType,
  loadedMathResolver,
  loadedPele,
  loadMathResolver,
  loadPele,
  type MathResolver,
  type PeleEngine
} from "./mermaid-engine";
import { createDiagramBlobUrl, createDiagramSanitizers, type DiagramSanitizers } from "./mermaid-svg";

/**
 * A ` ```mermaid ` fence (spec §4): a diagram once the message settles, the
 * highlighted source before that and whenever it cannot be drawn.
 *
 *  - **Streaming shows code.** A half-written diagram is a syntax error on
 *    every token, so nothing renders until the stream ends.
 *  - **Diagram ↔ code toggle** in the block's header, and the header's copy
 *    button always copies the source.
 *  - **A diagram that cannot be drawn** keeps the highlighted source and puts
 *    the reason above it: pele's parse error, a diagram type pele does not
 *    know, or a renderer chunk that failed to load (with Retry). A render that
 *    *throws* is caught by the boundary and falls back to the same source view.
 *  - **Expand** opens the SVG as a standalone image in the app's modal layer,
 *    through a `blob:` URL (the production `img-src` allows it; `data:` URLs
 *    failed the desktop's connect-src policy in T3).
 *  - **Theme** is CSS: pele paints with `--pele-*` variables, mapped to the
 *    palette under `.ac-mermaid` in `agent-chat.css`, so a colour scheme or
 *    mode switch repaints the mounted SVG without drawing it again.
 *
 * Pele mounts the SVG itself, after the DOMPurify pass in `mermaid-svg.ts`;
 * nothing here hands provider text to the browser as HTML.
 */

export interface MermaidBlockProps {
  code: string;
  streaming: boolean;
  /** For the source view's highlighting only; the diagram follows the CSS theme. */
  mode: "light" | "dark";
}

/** Falls back when the diagram throws; a new source tries again. */
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

// ---------------------------------------------------------------------------
// Getting the renderer ready
// ---------------------------------------------------------------------------

type Readiness =
  | { status: "loading" }
  | { status: "ready"; pele: PeleEngine; math: MathResolver | null }
  | { status: "unsupported" }
  | { status: "failed" };

/** What is already loaded answers at once, so a remount never flashes "Rendering…". */
function readinessNow(source: string): Readiness | null {
  const pele = loadedPele();
  if (!pele) return null;
  const type = detectDiagramType(pele, source);
  if (type === null) return { status: "unsupported" };
  if (!pele.registered(type)) return null;
  if (!source.includes("$$")) return { status: "ready", pele, math: null };
  const math = loadedMathResolver();
  return math ? { status: "ready", pele, math } : null;
}

async function prepare(source: string): Promise<Readiness> {
  try {
    const pele = await loadPele();
    const type = detectDiagramType(pele, source);
    if (type === null) return { status: "unsupported" };
    if (!(await pele.load(type))) return { status: "unsupported" };
    // A diagram whose labels fail to typeset still draws, with their TeX.
    const math = source.includes("$$") ? await loadMathResolver() : null;
    return { status: "ready", pele, math };
  } catch {
    return { status: "failed" };
  }
}

function useReadiness(source: string, attempt: number): Readiness {
  const [state, setState] = React.useState<{ source: string; attempt: number; readiness: Readiness }>(() => ({
    source,
    attempt,
    readiness: readinessNow(source) ?? { status: "loading" }
  }));
  const current =
    state.source === source && state.attempt === attempt
      ? state.readiness
      : (readinessNow(source) ?? { status: "loading" as const });
  React.useEffect(() => {
    if (current.status !== "loading") return undefined;
    let cancelled = false;
    void prepare(source).then((readiness) => {
      if (!cancelled) setState({ source, attempt, readiness });
    });
    return () => {
      cancelled = true;
    };
  }, [source, attempt, current.status]);
  return current;
}

// ---------------------------------------------------------------------------
// The diagram
// ---------------------------------------------------------------------------

let sanitizers: DiagramSanitizers | null = null;

function DiagramBody({
  pele,
  math,
  source,
  onError,
  onExpand,
  hostRef
}: {
  pele: PeleEngine;
  math: MathResolver | null;
  source: string;
  onError: (message: string) => void;
  onExpand: () => void;
  hostRef: React.RefObject<HTMLSpanElement>;
}): React.ReactElement {
  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    sanitizers ??= createDiagramSanitizers(window);
    const sanitize = math ? sanitizers.math : sanitizers.plain;
    const mounted = pele.mount(host, source, {
      links: false,
      images: false,
      zoom: false,
      // Keep the author's direction: a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
      sanitize,
      ...(math ? { math } : {}),
      onError: (error) => onError(error instanceof Error ? error.message : "The diagram could not be rendered.")
    });
    return () => mounted.destroy();
  }, [pele, math, source, onError, hostRef]);

  return (
    // The header's "Expand diagram" is the one control assistive tech and the
    // keyboard get; the diagram itself is a mouse shortcut for it, so it is
    // out of the tab order and hidden from the accessibility tree.
    <div role="img" aria-label="Mermaid diagram" className="ac-mermaid ac-scroll-thin overflow-x-auto px-[0.9rem] pb-[0.8rem] pt-1">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onExpand}
        className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500"
      >
        <span ref={hostRef} className="flex w-full justify-center" />
      </button>
    </div>
  );
}

function ExpandedDiagram({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }): React.ReactElement {
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

function SourceWithNotice({
  code,
  mode,
  message,
  onRetry
}: {
  code: string;
  mode: "light" | "dark";
  message: string;
  onRetry?: (() => void) | undefined;
}): React.ReactElement {
  return (
    <CodeBlock
      code={code}
      info="mermaid"
      streaming={false}
      mode={mode}
      notice={
        <div className="flex items-center justify-between gap-2 px-[0.9rem] pb-1 pt-1">
          <p className="m-0 min-w-0 text-xs text-danger-300 [overflow-wrap:anywhere]">
            Unable to render diagram: {message}
          </p>
          {onRetry ? (
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

function SettledDiagram({
  code,
  mode,
  onToggle
}: {
  code: string;
  mode: "light" | "dark";
  onToggle: () => void;
}): React.ReactElement {
  const source = code.trim();
  const [attempt, setAttempt] = React.useState(0);
  const readiness = useReadiness(source, attempt);
  const [renderError, setRenderError] = React.useState<{ source: string; message: string } | null>(null);
  const [expanded, setExpanded] = React.useState<SVGSVGElement | null>(null);
  const hostRef = React.useRef<HTMLSpanElement>(null);
  const onError = React.useCallback((message: string) => setRenderError({ source, message }), [source]);
  const closeExpanded = React.useCallback(() => setExpanded(null), []);
  const expand = React.useCallback(() => {
    const svg = hostRef.current?.querySelector("svg");
    if (svg) setExpanded(svg);
  }, []);

  if (readiness.status === "failed") {
    return (
      <SourceWithNotice
        code={code}
        mode={mode}
        message="The diagram renderer failed to load."
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (readiness.status === "unsupported") {
    return <SourceWithNotice code={code} mode={mode} message="This diagram type is not supported." />;
  }
  if (renderError !== null && renderError.source === source) {
    return <SourceWithNotice code={code} mode={mode} message={renderError.message} />;
  }
  if (readiness.status === "loading") {
    return (
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
            <ChatIconButton size="xs" label="Expand diagram" onClick={expand}>
              <Maximize2 size={12} strokeWidth={1.8} aria-hidden />
            </ChatIconButton>
          </>
        }
        body={
          <DiagramBody
            pele={readiness.pele}
            math={readiness.math}
            source={source}
            onError={onError}
            onExpand={expand}
            hostRef={hostRef}
          />
        }
      />
      {expanded ? <ExpandedDiagram svg={expanded} onClose={closeExpanded} /> : null}
    </>
  );
}

export function MermaidBlock({ code, streaming, mode }: MermaidBlockProps): React.ReactElement {
  const [showCode, setShowCode] = React.useState(false);
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

  return (
    <DiagramBoundary resetKey={code} fallback={source}>
      <SettledDiagram code={code} mode={mode} onToggle={toggle} />
    </DiagramBoundary>
  );
}

export default MermaidBlock;
