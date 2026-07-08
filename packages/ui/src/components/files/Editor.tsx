import React, { useEffect, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export interface EditorProps {
  filename: string;
  value: string;
  readOnly?: boolean;
  /** 1-based line to scroll to + place the cursor on (e.g. a search-result jump). */
  jumpToLine?: number;
  /** Changes on every search-result open so re-clicking the same line re-jumps. */
  jumpNonce?: number;
  onChange: (value: string) => void;
  onSave?: () => void;
}

/** CodeMirror 6 editor with syntax highlighting (language inferred from name). */
export const Editor: React.FC<EditorProps> = ({ filename, value, readOnly, jumpToLine, jumpNonce, onChange, onSave }) => {
  const [langExtension, setLangExtension] = useState<Extension[]>([]);
  const [view, setView] = useState<EditorView | null>(null);

  // Scroll to + select the requested line once the view exists and the document
  // has content. Keyed on (view, jumpToLine, jumpNonce, content-ready) so it fires
  // for the initial jump, for later jumps to a different line, AND for a repeat
  // click on the same line (jumpNonce changes), but not on every edit.
  const hasContent = value.length > 0;
  useEffect(() => {
    if (!view || jumpToLine == null || !hasContent) return;
    const doc = view.state.doc;
    if (doc.lines === 0) return;
    const clamped = Math.min(Math.max(1, Math.floor(jumpToLine)), doc.lines);
    const pos = doc.line(clamped).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" })
    });
  }, [view, jumpToLine, jumpNonce, hasContent]);

  useEffect(() => {
    let active = true;
    const description = LanguageDescription.matchFilename(languages, filename);
    if (!description) {
      setLangExtension([]);
      return;
    }
    description
      .load()
      .then((support) => {
        if (active) {
          setLangExtension([support]);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [filename]);

  return (
    <div
      className="h-full min-h-0 overflow-hidden text-[13px]"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          onSave?.();
        }
      }}
    >
      <CodeMirror
        value={value}
        height="100%"
        style={{ height: "100%" }}
        theme={oneDark}
        readOnly={readOnly}
        editable={!readOnly}
        // Soft-wrap long lines so text never runs off-screen (mobile or desktop);
        // the editor then only scrolls vertically. Matches the Git diff view.
        extensions={[EditorView.lineWrapping, ...langExtension]}
        onChange={onChange}
        onCreateEditor={(v) => setView(v)}
        basicSetup={{ highlightActiveLine: !readOnly, foldGutter: true }}
      />
    </div>
  );
};
