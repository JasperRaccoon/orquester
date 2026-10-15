/**
 * An Orquester approval card in the banner dock (unified MCP §7.1, §9.3): an agent's Admin call,
 * a call across a project boundary, or `request_toolset`. Provider-agnostic: the daemon composed
 * everything on it from the call's structured arguments, and `parseToolApprovalSummary` sanitised
 * it before it reached state — every agent-derived string renders as plain text.
 *
 * What makes it safe to decide on:
 *
 *  - **No autofocus, ever.** Nothing on the card takes focus by itself when it appears. The user
 *    may be typing in the composer when it slides in. (Pressing "Deny with a reason…" moves focus
 *    into the field that replaces the pressed toggle — the user's own act.)
 *  - **Keyboard approval is ⌘/Ctrl+Enter on the focused card, and only after 1.5 s.** The chord is
 *    ignored for {@link TOOL_APPROVAL_KEYBOARD_GUARD_MS} after the card appears or changes
 *    (`toolApprovalGuardKey`), and Enter alone never approves — not on the card, not on a focused
 *    Approve button, not on a grant row. The composer's own ⌘/Ctrl+Enter never reaches the card:
 *    the card only listens to keys pressed inside it, and swallows the chords it owns.
 *  - **The preview is complete.** A long section has "View all"; a summary the daemon had to cut
 *    fetches the whole preview (`GET toolApproval`) before showing the rest, and Approve (grant
 *    rows too) stays disabled, with its reason as the tooltip, until the user loaded it.
 *  - **A double click never approves the next card.** Any click on Approve or a grant row (pointer,
 *    assistive or programmatic) is ignored for `TOOL_APPROVAL_POINTER_GUARD_MS` after the card
 *    appears or changes; a full preview loaded for other content no longer counts.
 *  - **Grants only as offered.** The Approve menu lists exactly the card's `grantOptions`.
 *  - **Secrets stay in this component.** Masked inputs for `secretFields`; the values go into the
 *    answer body and are cleared from state as soon as it is sent, whatever the outcome.
 *  - **On a phone** the preview opens in a bottom sheet; the flags stay on the card.
 */

import React from "react";
import { ChevronDown, KeyRound, Settings2, ShieldAlert, Wrench } from "lucide-react";
import {
  sanitizeApprovalLabel,
  TOOL_APPROVAL_DENY_REASON_MAX_CHARS,
  TOOL_APPROVAL_KEYBOARD_GUARD_MS,
  TOOL_APPROVAL_SECRET_MAX_CHARS,
  type ParsedToolApprovalSummary,
  type ToolApprovalAnswer,
  type ToolApprovalGrantScope
} from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { BottomSheet } from "../../ui/sheet";
import { ComposerMenuRow, ComposerPopover } from "../composer/ComposerPopover";
import { BannerCard } from "../primitives";
import {
  toolApprovalAnswerFailure,
  toolApprovalApproveBlockedReason,
  toolApprovalChangeSentence,
  toolApprovalExpired,
  toolApprovalExpiryText,
  toolApprovalGrantChoices,
  toolApprovalGuardKey,
  toolApprovalKeyAction,
  toolApprovalKindBadge,
  toolApprovalCardKey,
  toolApprovalClickGuarded,
  toolApprovalPreviewIsCut,
  toolApprovalPrimaryLabel,
  type ToolApprovalKeyEvent
} from "./banner-model";
import { CARD_INPUT_CLASS, SECRET_INPUT_ATTRIBUTES } from "./secret-input";
import { previewFlagSections, ToolApprovalPreview } from "./tool-approval-preview";

export interface ToolApprovalCardProps {
  card: ParsedToolApprovalSummary;
  /** How many cards are pending in this chat, this one included; renders as `1/N`. */
  pendingCount: number;
  /** A phone: the preview goes in a bottom sheet. */
  isMobile?: boolean;
  /** Send the answer. Resolves once the daemon took it; rejects with the HTTP status (or null). */
  onAnswer: (answer: ToolApprovalAnswer) => Promise<void>;
  /** Fetch the whole preview ("View all" on a cut summary); resolves null when it is gone. */
  onLoadFull: () => Promise<ParsedToolApprovalSummary | null>;
  /** Open Settings › Agent tools (the footer's pointer to grants). */
  onOpenSettings?: () => void;
  /** The clock (tests). */
  now?: () => number;
}

const BUTTON =
  "ac-press inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-neutral-200 text-neutral-900 hover:bg-neutral-50";
const SECONDARY = "border border-neutral-700 text-neutral-200 hover:bg-neutral-800";
const LINK =
  "rounded text-[11px] text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

function useTicker(now: () => number, intervalMs: number): number {
  const [time, setTime] = React.useState(now);
  React.useEffect(() => {
    const id = setInterval(() => setTime(now()), intervalMs);
    return () => clearInterval(id);
  }, [now, intervalMs]);
  return time;
}

const systemNow = (): number => Date.now();

function keyEventOf(event: React.KeyboardEvent): ToolApprovalKeyEvent {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    repeat: event.repeat
  };
}

export function ToolApprovalCard({
  card,
  pendingCount,
  isMobile = false,
  onAnswer,
  onLoadFull,
  onOpenSettings,
  now = systemNow
}: ToolApprovalCardProps): React.ReactElement {
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState("");
  // The whole preview, kept with the key of the card content it was loaded FOR: when the same
  // card comes back with other content, it no longer counts (the gate locks again).
  const cardKey = React.useMemo(() => toolApprovalCardKey(card), [card]);
  const [fullState, setFullState] = React.useState<{ key: string; card: ParsedToolApprovalSummary } | null>(null);
  const full = fullState !== null && fullState.key === cardKey ? fullState.card : null;
  const [loadingFor, setLoadingFor] = React.useState<string | null>(null);
  const loadingFull = loadingFor === cardKey;
  const [fullError, setFullError] = React.useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // Enter then a click can both land before a re-render; this guard is synchronous.
  const inFlight = React.useRef(false);
  const denyReasonId = React.useId();
  const denyReasonRef = React.useRef<HTMLTextAreaElement>(null);
  // Set when the user opens the reason field: focus follows into it (the toggle they pressed is gone).
  const focusDenyReason = React.useRef(false);

  const shown = full ?? card;
  // Memoised: hashing a large preview on every countdown tick would be wasted work.
  const guardKey = React.useMemo(() => toolApprovalGuardKey(shown, full ? 1 : 0), [shown, full]);
  // When the card (or what it says) last changed: keyboard approval waits 1.5 s from here, and a
  // pointer click on Approve is ignored for TOOL_APPROVAL_POINTER_GUARD_MS.
  const shownAt = React.useRef(now());
  const lastGuardKey = React.useRef(guardKey);
  if (lastGuardKey.current !== guardKey) {
    lastGuardKey.current = guardKey;
    shownAt.current = now();
  }

  // A new card is a new card: nothing typed for the last one survives.
  React.useEffect(() => {
    setSecrets({});
    setError(null);
    setDenyOpen(false);
    setDenyReason("");
    setSheetOpen(false);
  }, [card.approvalId]);
  // New content (same card or not): the full preview loaded for the old content is dropped, and
  // the guards restart (the guard key moves with the shown content).
  React.useEffect(() => {
    setFullState((current) => (current !== null && current.key !== cardKey ? null : current));
    setFullError(null);
  }, [cardKey]);

  React.useEffect(() => {
    if (denyOpen && focusDenyReason.current) {
      focusDenyReason.current = false;
      denyReasonRef.current?.focus({ preventScroll: true });
    }
  }, [denyOpen]);

  const time = useTicker(now, 1000);
  const expired = toolApprovalExpired(card.expiresAt, time);
  // A summary the daemon had to cut: approving waits until the user loaded the whole preview.
  const previewCut = toolApprovalPreviewIsCut(card);
  const previewComplete = !previewCut || full !== null;
  const approveBlocked = toolApprovalApproveBlockedReason({ card, secrets, submitting, expired, previewComplete });
  const canApprove = approveBlocked === null;
  const grantChoices = toolApprovalGrantChoices(card);
  const toolset = card.kind === "toolset";

  const send = async (answer: ToolApprovalAnswer): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // The values leave state now: they live in the answer body alone from here on.
    setSecrets({});
    try {
      await onAnswer(answer);
    } catch (failure) {
      setError(toolApprovalAnswerFailure(typeof failure === "number" ? failure : null).text);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const approve = (grant?: ToolApprovalGrantScope): void => {
    if (!canApprove) return;
    const asked = card.secretFields.length > 0 ? { secrets: { ...secrets } } : {};
    void send({ decision: "approve", ...(grant ? { grant } : {}), ...asked });
  };
  const deny = (): void => {
    if (submitting) return;
    const reason = denyReason.trim();
    void send({ decision: "deny", ...(reason ? { reason } : {}) });
  };

  const guarded = (): boolean => now() - shownAt.current < TOOL_APPROVAL_KEYBOARD_GUARD_MS;

  /**
   * A click on a control that approves, inside the appearance window, is ignored — whatever its
   * `detail` (the second click of a double click meant for the previous card; an assistive or
   * programmatic click). Measured from the card's timestamp, never the event's. Keyboard chords
   * have the longer guard in {@link approveKeys}.
   */
  const approveClick = (run: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (toolApprovalClickGuarded({ now: now(), shownAt: shownAt.current })) {
      event.preventDefault();
      return;
    }
    run();
  };

  /**
   * The keyboard on a control that approves: Enter alone never does (it would be the same Enter
   * the user meant for something else a moment ago); Space only after the guard; ⌘/Ctrl+Enter
   * runs this control's own approval after the guard.
   */
  const approveKeys = (run: () => void) => ({
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (toolApprovalKeyAction(keyEventOf(event), { now: now(), shownAt: shownAt.current }) === "approve") run();
        return;
      }
      if (event.key === " " && guarded()) event.preventDefault();
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === " " && guarded()) event.preventDefault();
    }
  });

  const onCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const inDenyReason = (event.target as HTMLElement | null)?.id === denyReasonId;
    const action = toolApprovalKeyAction(keyEventOf(event), { now: now(), shownAt: shownAt.current, inDenyReason });
    if (action === null) return;
    // The card's chord, guarded or not, is never handed on to the composer or the shell.
    event.preventDefault();
    event.stopPropagation();
    if (action === "approve") approve();
    else if (action === "deny") deny();
  };

  const loadFull = (): void => {
    if (loadingFull || full !== null) return;
    // Kept for the content it was asked for: an answer that lands after the card changed is not
    // the preview of what is shown now.
    const forKey = cardKey;
    setLoadingFor(forKey);
    setFullError(null);
    onLoadFull()
      .then((detail) => {
        if (detail === null) setFullError("The full preview is no longer available.");
        else setFullState({ key: forKey, card: detail });
      })
      .catch(() => setFullError("Could not load the full preview. Try again."))
      .finally(() => setLoadingFor((current) => (current === forKey ? null : current)));
  };

  const preview = (expandAll: boolean): React.ReactElement => (
    <>
      <ToolApprovalPreview
        sections={shown.sections}
        fullLoaded={previewComplete}
        loadingFull={loadingFull}
        onLoadFull={loadFull}
        expandAll={expandAll}
      />
      {previewCut && full === null ? (
        <button type="button" className={cn(LINK, "mt-1.5 text-info-300")} disabled={loadingFull} onClick={loadFull} data-load-full="">
          {loadingFull ? "Loading the full preview…" : "View all — load the whole preview"}
        </button>
      ) : null}
      {fullError ? <p className="mt-1 text-[11px] text-danger-300">{fullError}</p> : null}
    </>
  );

  const flags = previewFlagSections(shown.sections);
  const warningCount = flags.length;

  return (
    <BannerCard
      variant={card.kind === "unknown" ? "error" : "warning"}
      density="spacious"
      icon={toolset ? <Wrench size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
      title={toolApprovalKindBadge(card)}
      description={card.tool}
      counter={pendingCount > 1 ? `1/${pendingCount}` : undefined}
    >
      {/* `role="group"` with a name: the card is one decision, read as one. Never focused by itself. */}
      <div
        role="group"
        aria-label={`Approval: ${card.title}`}
        data-tool-approval={card.approvalId}
        data-approval-kind={card.kind}
        className="min-w-0"
        onKeyDown={onCardKeyDown}
      >
        <p className="break-words text-sm font-medium text-neutral-100">{card.title}</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-300" data-scope-badge="">
            {card.scope.label}
          </span>
          {(card.scope.projects ?? []).map((project) => (
            <span
              key={project.path}
              className="rounded-full bg-neutral-800/70 px-2 py-0.5 text-neutral-400"
              title={sanitizeApprovalLabel(project.path, 4096)}
            >
              {project.workspace}
              {project.gitAccountLabel ? ` · git ${project.gitAccountLabel}` : ""}
            </span>
          ))}
        </div>
        <p className="mt-2 break-words text-xs text-neutral-300" data-change-sentence="">
          {toolApprovalChangeSentence(card)}
        </p>
        {card.reason ? (
          <div className="mt-2 text-xs">
            <span className="text-neutral-500">The agent's reason</span>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-neutral-400">{card.reason}</p>
          </div>
        ) : null}

        <div className="mt-2 min-w-0">
          {isMobile ? (
            <>
              {/* The flags stay in sight on the card; screen readers get them once, in the sheet
                  (the review button says how many there are). */}
              {flags.length > 0 ? (
                <div aria-hidden="true" data-flags-duplicate="">
                  <ToolApprovalPreview sections={flags} fullLoaded loadingFull={false} onLoadFull={loadFull} />
                </div>
              ) : null}
              <button
                type="button"
                className={cn(BUTTON, SECONDARY, "mt-2 w-full justify-center")}
                onClick={() => {
                  setSheetOpen(true);
                  // Opening the review is viewing it: a cut preview loads whole there.
                  if (previewCut) loadFull();
                }}
                data-review-preview=""
              >
                Review what will run ({shown.sections.length} {shown.sections.length === 1 ? "part" : "parts"}
                {warningCount > 0 ? `, ${warningCount} ${warningCount === 1 ? "flag" : "flags"}` : ""})
              </button>
              <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} label={`Preview: ${card.title}`}>
                <div className="px-2 pb-3 text-xs">
                  <p className="mb-2 break-words text-sm font-medium text-neutral-100">{card.title}</p>
                  {preview(true)}
                </div>
              </BottomSheet>
            </>
          ) : (
            preview(false)
          )}
        </div>

        {card.secretFields.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2" data-secret-fields="">
            {card.secretFields.map((field) => {
              const inputId = `${card.approvalId}-secret-${field.key}`;
              return (
                <div key={field.key} className="min-w-0">
                  <label htmlFor={inputId} className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-400">
                    <KeyRound size={11} aria-hidden />
                    {field.label}
                  </label>
                  <input
                    id={inputId}
                    {...SECRET_INPUT_ATTRIBUTES}
                    value={secrets[field.key] ?? ""}
                    disabled={submitting}
                    maxLength={TOOL_APPROVAL_SECRET_MAX_CHARS}
                    placeholder="Type the value (hidden)"
                    onChange={(event) => {
                      const value = event.target.value;
                      setSecrets((current) => ({ ...current, [field.key]: value }));
                    }}
                    className={CARD_INPUT_CLASS}
                  />
                </div>
              );
            })}
            <p className="text-[11px] text-neutral-500">
              Typed here, sent with your approval for this one change; never shown to the agent or kept in the chat.
            </p>
          </div>
        ) : null}

        {denyOpen ? (
          <div className="mt-3 min-w-0">
            <label htmlFor={denyReasonId} className="mb-1 block text-[11px] text-neutral-400">
              Why not? Sent to the agent as your words (optional)
            </label>
            <textarea
              ref={denyReasonRef}
              id={denyReasonId}
              value={denyReason}
              disabled={submitting}
              maxLength={TOOL_APPROVAL_DENY_REASON_MAX_CHARS}
              rows={2}
              onChange={(event) => setDenyReason(event.target.value)}
              className={cn(CARD_INPUT_CLASS, "resize-y")}
            />
          </div>
        ) : null}

        {error !== null ? (
          <p role="alert" className="mt-2 text-[11px] text-danger-300">
            {error}
          </p>
        ) : null}

        {/* Phones have no hover tooltip: why Approve is disabled is said next to it. */}
        {isMobile && approveBlocked !== null && !submitting ? (
          <p className="mt-2 text-[11px] text-warn-300" data-approve-blocked="">
            {previewComplete ? approveBlocked : "Open Review to load the whole preview before approving."}
          </p>
        ) : null}

        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-neutral-500">
            <span className="ac-tabular" data-expiry="">
              {toolApprovalExpiryText(card.expiresAt, time)}
            </span>
            {onOpenSettings ? (
              <button type="button" className={cn(LINK, "inline-flex items-center gap-1")} onClick={onOpenSettings}>
                <Settings2 size={11} aria-hidden />
                Grants in Settings › Agent tools
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!denyOpen ? (
              <button
                type="button"
                className={LINK}
                disabled={submitting}
                onClick={() => {
                  focusDenyReason.current = true;
                  setDenyOpen(true);
                }}
              >
                Deny with a reason…
              </button>
            ) : null}
            <button type="button" className={cn(BUTTON, SECONDARY)} disabled={submitting} onClick={deny} data-deny="">
              Deny
            </button>
            <div className="inline-flex items-center">
              <button
                type="button"
                className={cn(BUTTON, PRIMARY, grantChoices.length > 0 && "rounded-r-none")}
                disabled={!canApprove}
                onClick={approveClick(() => approve())}
                {...approveKeys(() => approve())}
                data-approve=""
                title={approveBlocked ?? undefined}
              >
                {submitting ? "Sending…" : toolApprovalPrimaryLabel(card)}
              </button>
              {grantChoices.length > 0 ? (
                <ComposerPopover
                  align="end"
                  width="w-72"
                  label="Approve and grant"
                  renderTrigger={(triggerProps) => (
                    <button
                      {...triggerProps}
                      type="button"
                      disabled={!canApprove}
                      aria-label="More ways to approve"
                      title={approveBlocked ?? "More ways to approve"}
                      className={cn(BUTTON, PRIMARY, "w-7 justify-center rounded-l-none border-l border-neutral-400 px-0")}
                      data-grant-menu=""
                    >
                      <ChevronDown size={13} aria-hidden />
                    </button>
                  )}
                >
                  {(close) =>
                    grantChoices.map((choice) => (
                      <ComposerMenuRow
                        key={choice.scope}
                        disabled={!canApprove}
                        hint={choice.hint}
                        title={approveBlocked ?? undefined}
                        data-grant={choice.scope}
                        {...approveKeys(() => {
                          close();
                          approve(choice.scope);
                        })}
                        onClick={approveClick(() => {
                          close();
                          approve(choice.scope);
                        })}
                      >
                        {choice.label}
                      </ComposerMenuRow>
                    ))
                  }
                </ComposerPopover>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </BannerCard>
  );
}
