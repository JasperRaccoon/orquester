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
  onChange: (value: string) => void;
  onSave?: () => void;
}

/** CodeMirror 6 editor with syntax highlighting (language inferred from name). */
export const Editor: React.FC<EditorProps> = ({ filename, value, readOnly, onChange, onSave }) => {
  const [langExtension, setLangExtension] = useState<Extension[]>([]);

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
        basicSetup={{ highlightActiveLine: !readOnly, foldGutter: true }}
      />
    </div>
  );
};
