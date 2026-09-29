/**
 * A text field that takes workflow templates (workflows spec §3.3): CodeMirror
 * with `{{ … }}` expressions, `{variables}` and `secrets.*` highlighted, and
 * autocompletion of what the block can read at the caret — upstream blocks'
 * outputs, the trigger, the run, the project, secrets, filters, and (in an
 * agent prompt) the saved-prompt variables.
 *
 * Painted with the theme's own variables (not oneDark), so it matches the
 * inspector in every scheme and mode. The completion source is the pure
 * `templateCompletions`, handed to the basic setup's `autocompletion()` as
 * language data — no direct `@codemirror/autocomplete` import. Single-line
 * fields refuse newlines.
 *
 * Inside a `Field` its editable content takes the Field's id, label
 * (`aria-labelledby`) and message ids (`useFieldControl`); inside a read-only
 * form (`useReadOnly`) it can't be edited. Its ref's `insertData()` types `{{  }}` at the caret
 * as the user would, which opens the completion list — so "what can I put
 * here" needs no knowledge of the `{{` trigger.
 */

import React, { useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, {
  Decoration,
  EditorState,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  placeholder as placeholderExtension,
  type DecorationSet,
  type ViewUpdate
} from "@uiw/react-codemirror";

import { isPromptVariableName } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { templateCompletions, type CompletionScope } from "../../../lib/workflows/inspector-autocomplete";
import { useFieldControl, useReadOnly } from "../ui/controls";

export interface TemplateEditorProps {
  value: string;
  onChange: (value: string) => void;
  scope: CompletionScope;
  multiline?: boolean;
  /** Multi-line: the editor's minimum / maximum height in px. */
  minHeight?: number;
  maxHeight?: number;
  placeholder?: string;
  ariaLabel: string;
  invalid?: boolean;
  monospace?: boolean;
  className?: string;
  onBlur?: () => void;
  autoFocus?: boolean;
  /** The editable content's id; defaults to the enclosing Field's (its label points here). */
  id?: string;
}

/** What a TemplateEditor's ref can do. */
export interface TemplateEditorHandle {
  /** Type `{{  }}` at the caret (replacing a selection) and open the completion list inside it. */
  insertData: () => void;
  focus: () => void;
}

const EXPR = Decoration.mark({ class: "cm-wf-expr" });
const SECRET = Decoration.mark({ class: "cm-wf-secret" });
const VARIABLE = Decoration.mark({ class: "cm-wf-var" });

function tokenDecorator(promptVariables: boolean): MatchDecorator {
  return new MatchDecorator({
    regexp: /\{\{[^\n]*?\}\}|\{[A-Za-z][A-Za-z0-9]*\}/g,
    decoration: (match, view, pos) => {
      const text = match[0];
      if (text.startsWith("{{")) {
        if (pos > 0 && view.state.doc.sliceString(pos - 1, pos) === "\\") return null;
        return /^\{\{\s*secrets\./.test(text) ? SECRET : EXPR;
      }
      if (!promptVariables) return null;
      const name = text.slice(1, -1);
      if (!isPromptVariableName(name)) return null;
      // `{{name}}` is an escape; the single-brace match inside it is not a variable.
      if (pos > 0 && view.state.doc.sliceString(pos - 1, pos) === "{") return null;
      return VARIABLE;
    }
  });
}

function tokenPlugin(promptVariables: boolean) {
  const decorator = tokenDecorator(promptVariables);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(update: ViewUpdate): void {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

/** The slice of CodeMirror's CompletionContext the source reads. */
interface CompletionContextLike {
  state: EditorState;
  pos: number;
}

const THEME = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "rgb(var(--n-100))",
    fontSize: "13px"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "6px 0", caretColor: "rgb(var(--n-50))", fontFamily: "inherit" },
  ".cm-line": { padding: "0 10px", lineHeight: "20px" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--n-50))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgb(var(--n-600) / 0.45) !important"
  },
  ".cm-placeholder": { color: "rgb(var(--n-600))" },
  ".cm-scroller": { fontFamily: "inherit", overflowX: "hidden" },
  ".cm-tooltip": {
    backgroundColor: "rgb(var(--n-900))",
    border: "1px solid rgb(var(--n-800))",
    borderRadius: "10px",
    boxShadow: "0 16px 40px -12px rgb(0 0 0 / 0.55)",
    overflow: "hidden"
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16em", padding: "4px" },
  ".cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px",
    borderRadius: "6px",
    color: "rgb(var(--n-200))",
    lineHeight: "20px"
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "rgb(var(--n-800))",
    color: "rgb(var(--n-50))"
  },
  ".cm-completionDetail": { color: "rgb(var(--n-500))", fontStyle: "normal", marginLeft: "8px", fontSize: "11px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "rgb(var(--n-50))", fontWeight: "600" },
  ".cm-completionIcon": { opacity: "0.6", width: "1.1em" }
});

const MONO = EditorView.theme({
  ".cm-content, .cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px"
  }
});

const SINGLE_LINE = [
  EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
  EditorView.theme({ ".cm-content": { padding: "5px 0" }, ".cm-line": { lineHeight: "20px" } })
];

export const TemplateEditor = React.forwardRef<TemplateEditorHandle, TemplateEditorProps>(function TemplateEditor({
  value,
  onChange,
  scope,
  multiline = false,
  minHeight = 96,
  maxHeight = 360,
  placeholder,
  ariaLabel,
  invalid,
  monospace,
  className,
  onBlur,
  autoFocus,
  id
}, ref) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const viewRef = useRef<EditorView | null>(null);
  const control = useFieldControl(id);
  // Inside a read-only form: a disabled fieldset doesn't reach a contenteditable, so say it here.
  const readOnly = useReadOnly();

  useImperativeHandle(
    ref,
    () => ({
      insertData: () => {
        const view = viewRef.current;
        if (!view || readOnly) return;
        view.focus();
        const { from, to } = view.state.selection.main;
        // "input.type" is what makes CodeMirror's completion start, as if typed.
        view.dispatch({ changes: { from, to, insert: "{{  }}" }, selection: { anchor: from + 3 }, userEvent: "input.type", scrollIntoView: true });
      },
      focus: () => viewRef.current?.focus()
    }),
    [readOnly]
  );

  const extensions = useMemo(() => {
    const source = (context: CompletionContextLike) => {
      const answer = templateCompletions(context.state.doc.toString(), context.pos, scopeRef.current);
      if (answer === null) return null;
      return {
        from: answer.from,
        to: answer.to,
        options: answer.options.map((option) => ({
          label: option.label,
          type: option.type,
          ...(option.apply !== undefined ? { apply: option.apply } : {}),
          ...(option.detail !== undefined ? { detail: option.detail } : {})
        })),
        validFor: /^[A-Za-z0-9_]*$/
      };
    };
    return [
      THEME,
      ...(monospace ? [MONO] : []),
      ...(multiline ? [EditorView.lineWrapping] : SINGLE_LINE),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      tokenPlugin(scope.promptVariables),
      EditorState.languageData.of(() => [{ autocomplete: source }]),
      EditorView.contentAttributes.of({
        // Inside a Field its visible label names the editor; `ariaLabel` otherwise.
        ...(control.labelledBy ? { "aria-labelledby": control.labelledBy } : { "aria-label": ariaLabel }),
        ...(control.id ? { id: control.id } : {}),
        ...(control.describedBy ? { "aria-describedby": control.describedBy } : {}),
        ...(invalid ? { "aria-invalid": "true" } : {})
      }),
      ...(placeholder ? [placeholderExtension(placeholder)] : [])
    ];
    // The scope rides a ref: a new upstream list must not rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiline, monospace, scope.promptVariables, ariaLabel, placeholder, control.id, control.describedBy, control.labelledBy, invalid, readOnly]);

  return (
    <div
      className={cn(
        "wf-cm min-w-0 rounded-md border bg-neutral-950/60 transition-colors",
        invalid ? "border-danger/60" : "border-neutral-800 hover:border-neutral-700 focus-within:border-neutral-600",
        className
      )}
      onKeyDown={(event) => {
        // Keep the editor's own keys (Escape closes its completion list) out of the canvas shortcuts.
        event.stopPropagation();
      }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        autoFocus={autoFocus}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        theme="none"
        extensions={extensions}
        minHeight={multiline ? `${minHeight}px` : undefined}
        maxHeight={multiline ? `${maxHeight}px` : undefined}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          highlightSelectionMatches: false,
          bracketMatching: false,
          closeBrackets: false,
          autocompletion: true,
          completionKeymap: true,
          searchKeymap: false,
          lintKeymap: false,
          foldKeymap: false,
          indentOnInput: false,
          crosshairCursor: false,
          rectangularSelection: false,
          dropCursor: false
        }}
      />
    </div>
  );
});
