// Adapted from T3 Code (MIT): apps/web/src/components/chat/ComposerFooterControls.tsx
/**
 * The composer's resting controls (§7.4): attach, the rewind picker, the model,
 * option, permission-mode, plan, profile and account chips, and the "When you
 * return" compaction chip.
 *
 * Its own memoised component so typing does not re-render it: the draft lives
 * in `ChatComposer`, and nothing here reads the draft's text. Every prop is a
 * value the draft does not move or a callback held stable by the composer
 * (`returnFocusTo`, `onPickFiles`, `onNotice`), so a keystroke leaves the
 * whole bar — and the popovers its chips own — alone.
 */

import React from "react";
import { Paperclip } from "lucide-react";
import type {
  InteractionMode,
  ModelSelection,
  ProviderSnapshot,
  RuntimeMode,
  SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import type { ChatAccountOption } from "../../../lib/agent-chat/account-switch";
import type { AgentChatActions } from "../../../lib/agent-chat/contracts";
import type { RewindTarget } from "../../../lib/agent-chat/rewind.logic";
import { AccountChip, ModelChip, OptionChip, PlanChip, RuntimeModeChip } from "./ComposerChips";
import { optionDescriptors, resolveSelectedModel } from "./composer-model";
import { ProfileChip, type ProfileChipProps } from "./ProfileChip";
import { ResumeCompactionChip } from "./ResumeCompactionChip";
import { RewindControl } from "./RewindControl";

export interface ComposerFooterControlsProps {
  /** A revert is rewriting the thread: every control waits (§7.5). */
  reverting: boolean;
  /** The tray holds its eight: the attach button rests. */
  attachmentsFull: boolean;
  /** Files the picker chose, staged like a drop. */
  onPickFiles: (files: readonly File[]) => void;
  rewindTargets: readonly RewindTarget[];
  isTurnActive: boolean;
  hasPendingRequest: boolean;
  isSending: boolean;
  onRewind: (target: RewindTarget) => void;
  /** Where focus goes back to when a chip's popover closes: the composer's field. */
  returnFocusTo: () => HTMLElement | null;
  provider: ProviderSnapshot | null;
  modelSelection: ModelSelection | null;
  onModelSelectionChange: (selection: ModelSelection) => void;
  runtimeMode: RuntimeMode;
  showPlanModeToggle: boolean;
  interactionMode: InteractionMode;
  onPlanModeChange: (mode: InteractionMode) => void;
  profileChip?: Omit<ProfileChipProps, "onChange" | "returnFocusTo"> | undefined;
  accountLabel: string | null;
  accountOptions?: readonly ChatAccountOption[] | undefined;
  accountId?: string | undefined;
  accountSwitchEnabled?: boolean | undefined;
  accountSwitchRefusal?: string | null | undefined;
  accountNote?: string | undefined;
  resumeCompactionTokens: number | null;
  keepFullHistory: boolean;
  onToggleFullHistory: () => void;
  /** The thread's commands: the mode, profile and account switches. */
  actions: Pick<AgentChatActions, "setMode" | "setProfile" | "setAccount">;
  /** A refused switch is said on the composer's status line. */
  onNotice: (text: string) => void;
}

const NO_MODELS: NonNullable<ProviderSnapshot["models"]> = [];

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const ComposerFooterControls = React.memo(function ComposerFooterControls({
  reverting,
  attachmentsFull,
  onPickFiles,
  rewindTargets,
  isTurnActive,
  hasPendingRequest,
  isSending,
  onRewind,
  returnFocusTo,
  provider,
  modelSelection,
  onModelSelectionChange,
  runtimeMode,
  showPlanModeToggle,
  interactionMode,
  onPlanModeChange,
  profileChip,
  accountLabel,
  accountOptions,
  accountId,
  accountSwitchEnabled,
  accountSwitchRefusal,
  accountNote,
  resumeCompactionTokens,
  keepFullHistory,
  onToggleFullHistory,
  actions,
  onNotice
}: ComposerFooterControlsProps): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const models = provider?.models ?? NO_MODELS;
  const selectedModel = resolveSelectedModel(models, modelSelection);
  const selectDescriptors = React.useMemo(
    () =>
      optionDescriptors(selectedModel).filter(
        (descriptor): descriptor is SelectProviderOptionDescriptor => descriptor.type === "select"
      ),
    [selectedModel]
  );

  return (
    <div
      data-chat-composer-resting-controls="true"
      className="flex min-w-0 flex-wrap items-center gap-0.5"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          onPickFiles(files);
        }}
      />
      <button
        type="button"
        data-composer-shortcut="attach"
        aria-label="Attach files"
        title="Attach files"
        disabled={reverting || attachmentsFull}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "ac-press inline-flex h-7 w-7 items-center justify-center rounded-md",
          "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          "disabled:pointer-events-none disabled:opacity-40"
        )}
      >
        <Paperclip size={14} aria-hidden />
      </button>
      {/* The rewind picker — the double Escape's destination (§5.5).
          Renders nothing while there is no message to go back to. */}
      <RewindControl
        targets={rewindTargets}
        isTurnActive={isTurnActive}
        reverting={reverting}
        hasPendingRequest={hasPendingRequest}
        isSending={isSending}
        onRewind={onRewind}
        returnFocusTo={returnFocusTo}
      />

      <ModelChip
        models={models}
        selection={modelSelection}
        selectedModel={selectedModel}
        disabled={reverting}
        onChange={onModelSelectionChange}
        returnFocusTo={returnFocusTo}
      />
      {selectDescriptors.map((descriptor) => (
        <OptionChip
          key={descriptor.id}
          descriptor={descriptor}
          selection={modelSelection}
          fallbackModelSlug={selectedModel?.slug ?? ""}
          disabled={reverting}
          onChange={onModelSelectionChange}
          returnFocusTo={returnFocusTo}
        />
      ))}
      <RuntimeModeChip
        mode={runtimeMode}
        disabled={reverting}
        onChange={(mode) => {
          void actions.setMode({ runtimeMode: mode }).catch((error: unknown) => {
            onNotice(failureText(error, "Could not change the permission mode."));
          });
        }}
        returnFocusTo={returnFocusTo}
      />
      {showPlanModeToggle ? (
        <PlanChip interactionMode={interactionMode} disabled={reverting} onChange={onPlanModeChange} />
      ) : null}
      {profileChip ? (
        <ProfileChip
          {...profileChip}
          canSwitch={profileChip.canSwitch && !reverting}
          onChange={(next) => {
            void actions.setProfile({ profileId: next }).catch((error: unknown) => {
              onNotice(failureText(error, "Could not switch the profile."));
            });
          }}
          returnFocusTo={returnFocusTo}
        />
      ) : null}
      {accountLabel ? (
        <AccountChip
          label={accountLabel}
          {...(accountOptions ? { options: accountOptions } : {})}
          {...(accountId !== undefined ? { selectedId: accountId } : {})}
          canSwitch={accountSwitchEnabled === true && !reverting}
          disabledReason={accountSwitchRefusal}
          {...(accountNote ? { note: accountNote } : {})}
          {...(accountOptions
            ? {
                onChange: (next: string) => {
                  void actions.setAccount({ accountId: next }).catch((error: unknown) => {
                    onNotice(failureText(error, "Could not switch the account."));
                  });
                }
              }
            : {})}
          returnFocusTo={returnFocusTo}
        />
      ) : null}
      {resumeCompactionTokens !== null ? (
        <ResumeCompactionChip
          tokens={resumeCompactionTokens}
          keepFullHistory={keepFullHistory}
          disabled={reverting}
          onToggle={onToggleFullHistory}
        />
      ) : null}
    </div>
  );
});
