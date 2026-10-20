import React from "react";
import { Eye } from "lucide-react";
import type { UserInputQuestionOption } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { ChatMarkdown } from "../timeline/markdown/ChatMarkdown";
import { VisualSnippet } from "../visual/VisualSnippet";

/** Tall enough for a small mockup, short enough to leave the options in view. */
const PREVIEW_BODY_HEIGHT = "max-h-[min(16rem,32dvh)]";

/**
 * The preview of the option the user is looking at (Claude's option
 * `preview`), beside the options on a wide card and below them on a narrow one.
 *
 * Markdown goes through the chat's own renderer, in the monospace box Claude
 * is told it writes for ("rendered as markdown in a monospace box"): ASCII
 * mockups keep their line breaks and runs of spaces. HTML is framed inert
 * ({@link VisualSnippet}) and never enters this DOM.
 */
export function QuestionOptionPreview({
  option,
  onOpenFile,
  className
}: {
  option: UserInputQuestionOption;
  onOpenFile?: ((path: string) => void) | undefined;
  className?: string;
}): React.ReactElement {
  const preview = option.preview ?? "";
  const format = preview.length === 0 ? "none" : (option.previewFormat ?? "markdown");
  return (
    <section
      aria-label={`Preview: ${option.label}`}
      data-question-preview={format}
      className={cn("min-w-0 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/60", className)}
    >
      <div className="flex min-w-0 items-center gap-1.5 border-b border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-500">
        <Eye size={11} className="shrink-0" aria-hidden />
        <span className="truncate">{option.label}</span>
      </div>
      {format === "none" ? (
        <p className="px-2.5 py-3 text-xs text-neutral-500">No preview for this option.</p>
      ) : format === "html" ? (
        <VisualSnippet html={preview} title={`Preview of ${option.label}`} className="h-[min(16rem,32dvh)] w-full" />
      ) : (
        <div className={cn("ac-scroll-thin overflow-auto px-2.5 py-2", PREVIEW_BODY_HEIGHT)}>
          <ChatMarkdown
            text={preview}
            onOpenFile={onOpenFile}
            className="font-mono text-xs leading-snug text-neutral-200 [&_p]:whitespace-pre-wrap"
          />
        </div>
      )}
    </section>
  );
}
