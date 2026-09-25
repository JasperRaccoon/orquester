import React from "react";

export interface FullOutputPaneProps {
  /** The read is in flight. */
  loading: boolean;
  /** The whole output, as the viewer shows it. */
  text: string;
  /**
   * What the host said about it (`fullOutputNotes`): a running call's output
   * is what exists now, a join past the host's cap is its head, and what a
   * completion kept is only part of the output.
   */
  notes: readonly string[];
}

/**
 * The full-output viewer's body (spec §5.6, §6.3): the text, and above it the
 * notes the read came back with — said where the viewer opens, never after
 * 8 MiB of text.
 */
export function FullOutputPane({ loading, text, notes }: FullOutputPaneProps): React.ReactElement {
  return (
    <>
      {!loading && notes.length > 0 ? (
        <div className="space-y-0.5 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          {notes.map((note) => (
            <p key={note} data-full-output-note="">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-neutral-300">
        {loading ? "Loading…" : text}
      </pre>
    </>
  );
}
