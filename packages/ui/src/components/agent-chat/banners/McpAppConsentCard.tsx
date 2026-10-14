import React from "react";
import { AppWindow } from "lucide-react";

import { cn } from "../../../lib/cn";
import type { McpAppConsentRequest } from "../../../lib/agent-chat/mcp-app-consent";
import { BannerCard } from "../primitives";

const BUTTON =
  "ac-press inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

/**
 * An MCP App's request waiting on the user (spec 2026-10-14 §3): a tool its
 * server does not mark read-only, a message sent as the user, a file to save.
 * The approval card's shape — warning band, the detail verbatim in an 80px
 * scrollable, focusable block, Allow / Decline — because it is the same
 * decision: something runs on the user's behalf. Never a modal, never steals
 * focus.
 */
export function McpAppConsentCard({
  request,
  pendingCount,
  onAnswer
}: {
  request: McpAppConsentRequest;
  /** How many app requests wait behind this one; renders as `1/N`. */
  pendingCount: number;
  onAnswer: (allowed: boolean) => void;
}): React.ReactElement {
  return (
    <BannerCard
      variant="warning"
      density="spacious"
      icon={<AppWindow size={14} aria-hidden />}
      title={request.title}
      description={`${request.appName} app`}
      counter={pendingCount > 1 ? `1/${pendingCount}` : undefined}
      actions={
        <>
          <button
            type="button"
            onClick={() => onAnswer(true)}
            className={cn(BUTTON, "bg-neutral-200 text-neutral-900 hover:bg-neutral-50")}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => onAnswer(false)}
            className={cn(BUTTON, "border border-neutral-700 text-neutral-200 hover:bg-neutral-800")}
          >
            Decline
          </button>
        </>
      }
    >
      <div
        aria-label={request.kind === "message" ? "Message" : request.kind === "download" ? "Files" : "Arguments"}
        tabIndex={0}
        className={cn(
          "ac-scroll-thin block max-h-20 w-full min-w-0 overflow-auto rounded-md",
          "bg-neutral-900/50 px-2 py-1.5 text-xs text-neutral-200",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
          request.kind === "message" ? "whitespace-pre-wrap break-words font-sans" : "whitespace-pre font-mono"
        )}
      >
        {request.detail}
      </div>
    </BannerCard>
  );
}
