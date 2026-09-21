// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx
import React from "react";
import { Check, ChevronLeft, MessageCircleQuestion, Paperclip, X } from "lucide-react";
import type { AttachmentRef, PendingUserInput, UserInputQuestion } from "@orquester/api/agent-chat";
import { MAX_TURN_ATTACHMENTS } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { BannerCard, ChatIconButton, DisclosurePanel, Kbd } from "../primitives";
import {
  allowsAnswerAttachments,
  allowsCustomAnswer,
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  isOtherOption,
  isSecretQuestion,
  questionAttachmentKey,
  questionOptionValue,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingAnswerDraft
} from "./pending-answer";

/** A file staged against one question, with the upload's own state. */
export interface QuestionAttachment {
  key: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  ref?: AttachmentRef;
}

export interface QuestionCardProps {
  request: PendingUserInput;
  isResponding: boolean;
  /** Per-question attachment drafts, keyed by {@link questionAttachmentKey}. */
  attachments: Record<string, QuestionAttachment[]>;
  onAttachFiles?: (questionId: string, files: File[]) => void;
  onRemoveAttachment?: (questionId: string, key: string) => void;
  onSubmit: (input: {
    answers: Record<string, string | string[]>;
    attachmentsByQuestionId: Record<string, AttachmentRef[]>;
  }) => void;
  /** Offered only when the request carries `dismissible` (§4.2, §6.2). */
  onDismiss: (() => void) | null;
  /** Text an option click displaced, carried back rather than discarded. */
  onCarryTextToDraft: (text: string) => void;
  /** The compact layout used while the mobile composer is collapsed (§7.8). */
  compact?: boolean;
  /** Mobile's one focus-moving affordance: "Write a custom answer". */
  onRequestCustomAnswerFocus?: () => void;
}

/** 200 ms: long enough to see the tick land, short enough not to feel slow. */
const AUTO_ADVANCE_MS = 200;

/**
 * The question card.
 *
 * Five behaviours are load-bearing and each one was learned by T3 the hard way:
 *
 *  - **Collapse is keyed by the QUESTION id, not by a bare flag.** A tall
 *    prompt must stop covering the thread the user is reading, but the next
 *    question must not arrive already hidden — and the prompt can advance
 *    without a click.
 *  - **Digit shortcuts are suppressed while collapsed**, since the numbers
 *    they refer to are off screen.
 *  - **Single-select commits optimistically and advances after 200 ms**;
 *    multi-select toggles in place and never advances on its own.
 *  - **A non-empty custom answer beats selected options**, so clicking an
 *    option carries the typed text back into the thread draft instead of
 *    dropping it (§7.5) — except a secret answer, which is never echoed
 *    anywhere.
 *  - **The card never steals focus.** No autofocus, no modal, no focus trap:
 *    the user can keep typing in the composer with a question sitting there.
 *    On mobile the one exception is explicit — the "Write a custom answer"
 *    button.
 *
 * *T3: `ComposerPendingUserInputPanel.tsx:75-82, 118-135, 137-166, 247-272`.*
 */
export function QuestionCard({
  request,
  isResponding,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  onSubmit,
  onDismiss,
  onCarryTextToDraft,
  compact = false,
  onRequestCustomAnswerFocus
}: QuestionCardProps): React.ReactElement | null {
  const [draftAnswers, setDraftAnswers] = React.useState<Record<string, PendingAnswerDraft>>({});
  const [questionIndex, setQuestionIndex] = React.useState(0);
  const [collapsedQuestionId, setCollapsedQuestionId] = React.useState<string | null>(null);
  const [optimisticSelection, setOptimisticSelection] = React.useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const advanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const customAnswerRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // A new request is a new card: everything about the old one is gone.
  const requestId = request.requestId;
  React.useEffect(() => {
    setDraftAnswers({});
    setQuestionIndex(0);
    setCollapsedQuestionId(null);
    setOptimisticSelection(null);
  }, [requestId]);

  React.useEffect(
    () => () => {
      if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current);
    },
    []
  );

  const progress = derivePendingUserInputProgress(request.questions, draftAnswers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  const attachmentsFor = React.useCallback(
    (question: UserInputQuestion): QuestionAttachment[] =>
      attachments[questionAttachmentKey(requestId, question.id)] ?? [],
    [attachments, requestId]
  );

  // Staged files and in-flight preparations count together, and an unfinished
  // upload blocks the answer rather than silently dropping the file.
  const activeAttachments = activeQuestion ? attachmentsFor(activeQuestion) : [];
  const attachmentsBlocked = activeAttachments.some((entry) => entry.status !== "ready");

  const effectiveDraftAnswers = React.useMemo(() => {
    const merged: Record<string, PendingAnswerDraft> = {};
    for (const question of request.questions) {
      const staged = attachmentsFor(question);
      merged[question.id] = {
        ...draftAnswers[question.id],
        attachmentCount: staged.length,
        attachmentsBlocked: staged.some((entry) => entry.status !== "ready")
      };
    }
    return merged;
  }, [attachmentsFor, draftAnswers, request.questions]);

  const mergedProgress = derivePendingUserInputProgress(
    request.questions,
    effectiveDraftAnswers,
    questionIndex
  );

  const advance = React.useCallback(() => {
    setQuestionIndex((index) => Math.min(index + 1, Math.max(0, request.questions.length - 1)));
  }, [request.questions.length]);

  const selectOption = React.useCallback(
    (question: UserInputQuestion, optionValue: string) => {
      const existing = draftAnswers[question.id];
      // A custom answer outranks a selection, so the click would discard it.
      const displaced = carryDisplacedCustomAnswerIntoPrompt("", existing?.customAnswer, {
        isSecret: isSecretQuestion(question)
      });
      if (displaced.length > 0) onCarryTextToDraft(displaced);

      const option = question.options.find((entry) => questionOptionValue(entry) === optionValue);
      setDraftAnswers((current) => ({
        ...current,
        [question.id]: togglePendingUserInputOptionSelection(question, current[question.id], optionValue)
      }));

      // "Other…" is a request for the text field, not an answer: it must not
      // auto-advance past a question the user has not answered yet.
      if (option && isOtherOption(option)) {
        setOptimisticSelection(null);
        customAnswerRef.current?.focus();
        return;
      }
      if (question.multiSelect) {
        setOptimisticSelection(null);
        return;
      }
      setOptimisticSelection({ questionId: question.id, optionValue });
      if (advanceTimerRef.current !== null) clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        advance();
      }, AUTO_ADVANCE_MS);
    },
    [advance, draftAnswers, onCarryTextToDraft]
  );

  // Digits 1–9 pick an option when focus is outside an editable field. The
  // collapsed opt-out is deliberate: those numbers are off screen.
  React.useEffect(() => {
    if (!activeQuestion || isResponding || isCollapsed) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = activeQuestion.options[digit - 1];
      if (!option) return;
      event.preventDefault();
      selectOption(activeQuestion, questionOptionValue(option));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isCollapsed, isResponding, selectOption]);

  React.useEffect(() => {
    if (!optimisticSelection || !activeQuestion) return;
    if (optimisticSelection.questionId !== activeQuestion.id) setOptimisticSelection(null);
  }, [activeQuestion, optimisticSelection]);

  if (!activeQuestion) return null;

  const customAllowed = allowsCustomAnswer(activeQuestion);
  const attachAllowed = allowsAnswerAttachments(activeQuestion) && Boolean(onAttachFiles);
  const secret = isSecretQuestion(activeQuestion);
  const customAnswerActive = mergedProgress.customAnswer.trim().length > 0;
  const total = request.questions.length;

  const submit = () => {
    const answers = buildPendingUserInputAnswers(request.questions, effectiveDraftAnswers);
    if (!answers) return;
    const attachmentsByQuestionId: Record<string, AttachmentRef[]> = {};
    for (const question of request.questions) {
      const refs = attachmentsFor(question)
        .map((entry) => entry.ref)
        .filter((ref): ref is AttachmentRef => ref !== undefined);
      if (refs.length > 0) attachmentsByQuestionId[question.id] = refs;
    }
    onSubmit({ answers, attachmentsByQuestionId });
  };

  const primaryDisabled =
    isResponding ||
    attachmentsBlocked ||
    (mergedProgress.isLastQuestion ? !mergedProgress.isComplete : !mergedProgress.canAdvance);

  return (
    <BannerCard
      variant="info"
      density="spacious"
      icon={<MessageCircleQuestion size={14} aria-hidden />}
      title={
        <button
          type="button"
          aria-expanded={!isCollapsed}
          title={isCollapsed ? "Show the question and its options" : "Hide the question and its options"}
          data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
          onClick={() => setCollapsedQuestionId(isCollapsed ? null : activeQuestion.id)}
          className="rounded px-0.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          {activeQuestion.header}
        </button>
      }
      description={isCollapsed ? activeQuestion.question : undefined}
      counter={total > 1 ? `${mergedProgress.questionIndex + 1}/${total}` : undefined}
      onDismiss={onDismiss && !isResponding ? onDismiss : undefined}
      dismissLabel="Dismiss question without answering"
    >
      <DisclosurePanel open={!isCollapsed}>
        <div className="min-w-0 pb-0.5">
          <p className="break-words text-sm text-neutral-200">{activeQuestion.question}</p>
          {activeQuestion.multiSelect ? (
            <p className="mt-1 text-[11px] text-neutral-500">Select one or more options.</p>
          ) : null}

          <div className="mt-2 space-y-0.5">
            {activeQuestion.options.map((option, index) => {
              const optionValue = questionOptionValue(option);
              const optimistic =
                optimisticSelection?.questionId === activeQuestion.id &&
                optimisticSelection.optionValue === optionValue;
              const selected =
                optimistic ||
                (!customAnswerActive && mergedProgress.selectedOptionValues.includes(optionValue));
              const shortcut = index < 9 ? index + 1 : null;
              return (
                <button
                  key={`${activeQuestion.id}:${optionValue}`}
                  type="button"
                  disabled={isResponding}
                  onClick={() => selectOption(activeQuestion, optionValue)}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left",
                    "transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
                    selected
                      ? "bg-neutral-800/60 text-neutral-100"
                      : "bg-transparent text-neutral-300 hover:bg-neutral-800/40",
                    isResponding ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{option.label}</span>
                    {option.description && option.description !== option.label ? (
                      <span className="text-[11px] text-neutral-500">{option.description}</span>
                    ) : null}
                  </span>
                  {selected ? (
                    <Check size={14} className="shrink-0 text-info" aria-hidden />
                  ) : shortcut !== null ? (
                    <Kbd variant="plain">{shortcut}</Kbd>
                  ) : null}
                </button>
              );
            })}
          </div>

          {customAllowed ? (
            <div className="mt-2">
              {compact && onRequestCustomAnswerFocus ? (
                <button
                  type="button"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={onRequestCustomAnswerFocus}
                  aria-label="Write a custom answer"
                  className={cn(
                    "w-full truncate rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2",
                    "text-left text-sm text-neutral-500 transition-colors hover:bg-neutral-900"
                  )}
                >
                  {mergedProgress.customAnswer || "Write a custom answer"}
                </button>
              ) : (
                <input
                  ref={customAnswerRef as React.RefObject<HTMLInputElement>}
                  type={secret ? "password" : "text"}
                  value={mergedProgress.customAnswer}
                  disabled={isResponding}
                  autoComplete={secret ? "off" : undefined}
                  spellCheck={secret ? false : undefined}
                  placeholder={secret ? "Enter the value (hidden)" : "Write a custom answer"}
                  aria-label={secret ? "Custom answer (hidden)" : "Custom answer"}
                  onChange={(event) =>
                    setDraftAnswers((current) => ({
                      ...current,
                      [activeQuestion.id]: setPendingUserInputCustomAnswer(
                        current[activeQuestion.id],
                        event.target.value
                      )
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    if (primaryDisabled) return;
                    if (mergedProgress.isLastQuestion) submit();
                    else advance();
                  }}
                  className={cn(
                    "w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm",
                    "text-neutral-100 placeholder:text-neutral-600",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                    "disabled:opacity-50"
                  )}
                />
              )}
            </div>
          ) : null}

          {attachAllowed ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (files.length > 0) onAttachFiles?.(activeQuestion.id, files);
                }}
              />
              <button
                type="button"
                disabled={isResponding || activeAttachments.length >= MAX_TURN_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "ac-press inline-flex h-6 items-center gap-1 rounded-md border border-neutral-800",
                  "px-2 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                <Paperclip size={11} aria-hidden />
                Attach
              </button>
              {activeAttachments.map((attachment) => (
                <span
                  key={attachment.key}
                  className={cn(
                    "inline-flex h-6 max-w-48 items-center gap-1 rounded-md border px-2 text-[11px]",
                    attachment.status === "failed"
                      ? "border-danger-900/50 bg-danger-soft/40 text-danger-300"
                      : "border-neutral-800 bg-neutral-900/60 text-neutral-300"
                  )}
                >
                  <span className="truncate">{attachment.name}</span>
                  {attachment.status === "uploading" ? (
                    <span className="ac-tabular shrink-0 text-neutral-500">…</span>
                  ) : null}
                  {onRemoveAttachment ? (
                    <ChatIconButton
                      label={`Remove ${attachment.name}`}
                      size="micro"
                      onClick={() => onRemoveAttachment(activeQuestion.id, attachment.key)}
                    >
                      <X size={10} aria-hidden />
                    </ChatIconButton>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-end gap-2">
            {mergedProgress.questionIndex > 0 ? (
              <button
                type="button"
                disabled={isResponding}
                onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
                className={cn(
                  "ac-press inline-flex h-7 items-center gap-1 rounded-full border border-neutral-700",
                  "px-3 text-xs text-neutral-200 hover:bg-neutral-800",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                  "disabled:pointer-events-none disabled:opacity-50"
                )}
              >
                <ChevronLeft size={12} aria-hidden />
                Previous
              </button>
            ) : null}
            <button
              type="button"
              disabled={primaryDisabled}
              onClick={() => (mergedProgress.isLastQuestion ? submit() : advance())}
              className={cn(
                "ac-press inline-flex h-7 items-center rounded-full bg-neutral-200 px-4",
                "text-xs font-medium text-neutral-900 hover:bg-neutral-50",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              {isResponding
                ? "Submitting…"
                : !mergedProgress.isLastQuestion
                  ? compact
                    ? "Next"
                    : "Next question"
                  : mergedProgress.questionIndex > 0
                    ? "Submit answers"
                    : "Submit answer"}
            </button>
          </div>
        </div>
      </DisclosurePanel>
    </BannerCard>
  );
}
