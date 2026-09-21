import React from "react";
import { FileDiff } from "lucide-react";

import { cn } from "../../../../lib/cn";
import { parseUnifiedDiff } from "../../../git/git-diff";
import { looksLikeUnifiedDiff } from "../row-format";
import { countDiffLines, splitUnifiedDiff } from "../unified-diff";
import { shortenPath } from "../../../../lib/agent-chat/presentation.logic";

/**
 * A file change rendered as a real unified diff, with click-through.
 *
 * The daemon hands a file-change activity's patch through the slimmed `detail`
 * field; when it parses as a diff we render it the way the git tab does — same
 * `--diff-add-*` / `--diff-del-*` tokens, same line-number gutter — rather than
 * as an undifferentiated block of `pre` text with plus signs in it. Clicking the
 * file heading opens it in an editor tab (§7.3).
 */
export const InlineDiff = React.memo(function InlineDiff({
  diff,
  workspaceRoot,
  onOpenFile
}: {
  diff: string;
  workspaceRoot: string | undefined;
  onOpenFile: (path: string) => void;
}): React.ReactElement {
  const files = React.useMemo(() => splitUnifiedDiff(diff), [diff]);
  if (files.length === 0) {
    return (
      <pre className="ac-scroll-thin max-h-64 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-400">
        {diff}
      </pre>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {files.map((file) => {
        const parsed = parseUnifiedDiff(file.patch);
        const stat = countDiffLines(file.patch);
        return (
          <div key={file.path} className="overflow-hidden rounded-md border border-neutral-800">
            <button
              type="button"
              onClick={() => onOpenFile(file.path)}
              className="flex w-full min-w-0 items-center gap-2 bg-neutral-900/60 px-2 py-1 text-left transition-colors hover:bg-neutral-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
            >
              <FileDiff size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
                {shortenPath(file.path, workspaceRoot)}
              </span>
              <span className="ac-tabular shrink-0 font-mono text-[10px]">
                <span className="text-[color:var(--diff-add-fg)]">+{stat.additions}</span>{" "}
                <span className="text-[color:var(--diff-del-fg)]">−{stat.deletions}</span>
              </span>
            </button>
            {file.binary ? (
              <div className="px-2 py-1 text-xs italic text-neutral-600">Binary file</div>
            ) : (
              <div className="ac-scroll-thin max-h-64 select-text overflow-auto font-mono text-[11px] leading-5">
                {parsed.hunks.map((hunk, hunkIndex) => (
                  // A hunk's position within one patch is stable.
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={hunkIndex}>
                    <div className="flex bg-neutral-900 text-neutral-500">
                      <span className="w-14 shrink-0 select-none border-r border-neutral-800" />
                      <span className="min-w-0 whitespace-pre-wrap break-words px-2">{hunk.header}</span>
                    </div>
                    {hunk.rows.map((diffRow, rowIndex) => (
                      <div
                        // eslint-disable-next-line react/no-array-index-key
                        key={rowIndex}
                        className={cn(
                          "flex",
                          diffRow.type === "add" &&
                            "bg-[color:var(--diff-add-bg)] text-[color:var(--diff-add-fg)]",
                          diffRow.type === "del" &&
                            "bg-[color:var(--diff-del-bg)] text-[color:var(--diff-del-fg)]",
                          diffRow.type === "context" && "text-neutral-400"
                        )}
                      >
                        <span className="flex shrink-0 select-none border-r border-neutral-800 text-neutral-600">
                          <span className="ac-tabular w-7 px-1 text-right">{diffRow.oldNo ?? ""}</span>
                          <span className="ac-tabular w-7 px-1 text-right">{diffRow.newNo ?? ""}</span>
                        </span>
                        <span className="w-4 shrink-0 select-none text-center">
                          {diffRow.type === "add" ? "+" : diffRow.type === "del" ? "-" : " "}
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words pr-2">{diffRow.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export { looksLikeUnifiedDiff };
