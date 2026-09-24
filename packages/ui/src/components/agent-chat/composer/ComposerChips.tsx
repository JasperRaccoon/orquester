import React from "react";
import { Check, ChevronDown, Cpu, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import type {
  InteractionMode,
  ModelSelection,
  ProviderModel,
  RuntimeMode,
  SelectProviderOptionDescriptor
} from "@orquester/api/agent-chat";
import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import type { ChatAccountOption } from "../../../lib/agent-chat/account-switch";
import { Kbd } from "../primitives";
import { ComposerMenuRow, ComposerPopover } from "./ComposerPopover";
import {
  applyModelSelection,
  applyOptionSelection,
  currentOptionValue,
  modelChipLabel,
  optionChoiceLabel,
  optionDescriptors,
  REASONING_OPTION_IDS
} from "./composer-model";
import { shortcutLabelFor, type ComposerShortcutCommand } from "./composer-shortcuts";

/**
 * The composer's control chips (spec §7.4): model, its option descriptors,
 * account, runtime mode and the plan toggle.
 *
 * **Every chip that does something is a `<button>` carrying a
 * `data-composer-shortcut` token**, which is what lets one keybinding handler
 * drive them all (see `composer-shortcuts.ts`). The account chip carries one
 * too now that it is a picker (§3.4), but no chord is bound to it — a token
 * makes a control addressable, a chord is a separate decision (§7.4). Where a
 * thread cannot switch accounts at all it stays the label it always was,
 * because a control that could only refuse is worse than no control.
 */

const CHIP =
  "ac-press inline-flex h-7 max-w-full items-center gap-1 rounded-md px-2 text-xs " +
  "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-40";

export interface ComposerChipProps {
  shortcut?: ComposerShortcutCommand;
  icon?: React.ReactNode;
  label: string;
  /** The chip's current value, shown brighter than its label. */
  value?: string | null;
  title?: string;
  disabled?: boolean;
}

function chipContent({ icon, label, value }: ComposerChipProps): React.ReactNode {
  return (
    <>
      {icon ? <span className="shrink-0 text-neutral-500">{icon}</span> : null}
      <span className="truncate">
        {value ? <span className="text-neutral-200">{value}</span> : label}
      </span>
    </>
  );
}

export interface ModelChipProps {
  models: readonly ProviderModel[];
  selection: ModelSelection | null;
  selectedModel: ProviderModel | null;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  /** Focus returns here when the popover closes — never to a vanished button. */
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * The model chip.
 *
 * Its popover carries the model list **and** the selected model's boolean
 * option descriptors, because a boolean with one choice does not deserve a
 * chip of its own. Select descriptors get their own {@link OptionChip} so the
 * current value is readable without opening anything.
 */
export function ModelChip({
  models,
  selection,
  selectedModel,
  disabled,
  onChange,
  returnFocusTo
}: ModelChipProps): React.ReactElement {
  const booleans = optionDescriptors(selectedModel).filter(
    (descriptor) => descriptor.type === "boolean"
  );
  const combo = shortcutLabelFor("model");
  return (
    <ComposerPopover
      label="Model"
      width="w-72"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          disabled={disabled}
          data-composer-shortcut="model"
          title="Model for this thread"
          className={cn(CHIP, "font-medium")}
        >
          {chipContent({
            icon: <Cpu size={12} aria-hidden />,
            label: "Model",
            value: modelChipLabel(selectedModel, selection)
          })}
          <ChevronDown size={11} className="shrink-0 text-neutral-600" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-neutral-500">
            <span>Model</span>
            {combo ? <Kbd>{combo}</Kbd> : null}
          </div>
          {models.length === 0 ? (
            <p className="px-2 py-2 text-xs text-neutral-500">No models reported yet.</p>
          ) : null}
          {models.map((model) => (
            <ComposerMenuRow
              key={model.slug}
              selected={model.slug === selectedModel?.slug}
              hint={model.subProvider ?? (model.isLegacy ? "legacy" : undefined)}
              trailing={
                model.slug === selectedModel?.slug ? (
                  <Check size={13} className="text-info" aria-hidden />
                ) : undefined
              }
              onClick={() => {
                close();
                onChange(applyModelSelection(selection, model));
              }}
            >
              {model.name}
            </ComposerMenuRow>
          ))}
          {booleans.length > 0 ? (
            <div className="mt-1 border-t border-neutral-800 pt-1">
              {booleans.map((descriptor) => {
                const value = currentOptionValue(selection, descriptor) === true;
                return (
                  <ComposerMenuRow
                    key={descriptor.id}
                    selected={value}
                    hint={descriptor.description}
                    trailing={
                      value ? <Check size={13} className="text-info" aria-hidden /> : undefined
                    }
                    onClick={() =>
                      onChange(
                        applyOptionSelection(
                          selection ?? { model: selectedModel?.slug ?? "" },
                          descriptor.id,
                          !value
                        )
                      )
                    }
                  >
                    {descriptor.label}
                  </ComposerMenuRow>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </ComposerPopover>
  );
}

export interface OptionChipProps {
  descriptor: SelectProviderOptionDescriptor;
  selection: ModelSelection | null;
  fallbackModelSlug: string;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  returnFocusTo?: () => HTMLElement | null;
}

/** One select descriptor — effort, reasoning, service tier, agent. */
export function OptionChip({
  descriptor,
  selection,
  fallbackModelSlug,
  disabled,
  onChange,
  returnFocusTo
}: OptionChipProps): React.ReactElement {
  const value = currentOptionValue(selection, descriptor);
  // Only the reasoning select answers to `/effort` and the effort keybinding;
  // the other descriptors (service tier, agent) are pointer-only by design —
  // a token on a control nobody asked for would swallow the chord.
  const isReasoning = REASONING_OPTION_IDS.includes(descriptor.id);
  const combo = isReasoning ? shortcutLabelFor("effort") : null;

  return (
    <ComposerPopover
      label={descriptor.label}
      width="w-60"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          disabled={disabled}
          // The reasoning select is what `/effort` and the effort keybinding
          // open; the other descriptors are reachable by pointer only.
          data-composer-shortcut={isReasoning ? "effort" : undefined}
          title={descriptor.description ?? descriptor.label}
          className={CHIP}
        >
          {chipContent({
            icon: <Sparkles size={12} aria-hidden />,
            label: descriptor.label,
            value: optionChoiceLabel(descriptor, value)
          })}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-neutral-500">
            <span>{descriptor.label}</span>
            {combo ? <Kbd>{combo}</Kbd> : null}
          </div>
          {descriptor.options.map((choice) => (
            <ComposerMenuRow
              key={choice.id}
              selected={choice.id === value}
              hint={choice.description}
              trailing={
                choice.id === value ? <Check size={13} className="text-info" aria-hidden /> : undefined
              }
              onClick={() => {
                close();
                onChange(
                  applyOptionSelection(
                    selection ?? { model: fallbackModelSlug },
                    descriptor.id,
                    choice.id
                  )
                );
              }}
            >
              {choice.label}
            </ComposerMenuRow>
          ))}
        </>
      )}
    </ComposerPopover>
  );
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access"
};

const RUNTIME_MODE_HINTS: Record<RuntimeMode, string> = {
  "approval-required": "Every tool call asks first",
  "auto-accept-edits": "File edits apply without asking",
  auto: "The provider reviews its own work where it can",
  "full-access": "Nothing asks. Commands run unsupervised"
};

export interface RuntimeModeChipProps {
  mode: RuntimeMode;
  disabled?: boolean;
  onChange: (mode: RuntimeMode) => void;
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * The permission chip.
 *
 * Its menu says out loud that a change restarts the session — every provider
 * expresses the mode as launch configuration (§4.4), so this is not a setting
 * that quietly takes effect next turn.
 */
export function RuntimeModeChip({
  mode,
  disabled,
  onChange,
  returnFocusTo
}: RuntimeModeChipProps): React.ReactElement {
  const combo = shortcutLabelFor("mode");
  return (
    <ComposerPopover
      label="Permissions"
      width="w-72"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          disabled={disabled}
          data-composer-shortcut="mode"
          title="Permission mode — changing it restarts the session"
          className={CHIP}
        >
          {chipContent({
            icon: <ShieldCheck size={12} aria-hidden />,
            label: "Permissions",
            value: RUNTIME_MODE_LABELS[mode]
          })}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between px-2 py-1 text-[11px] text-neutral-500">
            <span>Permissions</span>
            {combo ? <Kbd>{combo}</Kbd> : null}
          </div>
          {RUNTIME_MODES.map((candidate) => (
            <ComposerMenuRow
              key={candidate}
              selected={candidate === mode}
              hint={RUNTIME_MODE_HINTS[candidate]}
              trailing={
                candidate === mode ? <Check size={13} className="text-info" aria-hidden /> : undefined
              }
              onClick={() => {
                close();
                if (candidate !== mode) onChange(candidate);
              }}
            >
              {RUNTIME_MODE_LABELS[candidate]}
            </ComposerMenuRow>
          ))}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-neutral-500">
            Changing this restarts the agent session. The conversation is kept.
          </p>
        </>
      )}
    </ComposerPopover>
  );
}

export interface PlanChipProps {
  interactionMode: InteractionMode;
  disabled?: boolean;
  onChange: (mode: InteractionMode) => void;
}

/** Shown only where `capabilities.showPlanModeToggle` is true (§4.4). */
export function PlanChip({
  interactionMode,
  disabled,
  onChange
}: PlanChipProps): React.ReactElement {
  const planning = interactionMode === "plan";
  return (
    <button
      type="button"
      disabled={disabled}
      data-composer-shortcut="plan"
      aria-pressed={planning}
      title={planning ? "Plan mode — the agent proposes before it acts" : "Switch to plan mode"}
      onClick={() => onChange(planning ? "default" : "plan")}
      className={cn(
        CHIP,
        planning && "bg-info-soft/40 text-info-300 hover:bg-info-soft/60 hover:text-info-300"
      )}
    >
      {chipContent({
        icon: <Sparkles size={12} aria-hidden />,
        label: "Plan",
        value: planning ? "Plan mode" : null
      })}
    </button>
  );
}

export interface AccountChipProps {
  label: string;
  /** Absent (or empty) makes the chip a plain label — see below. */
  options?: readonly ChatAccountOption[];
  /** The id currently selected; matched against `options`. */
  selectedId?: string;
  /** False while a turn, a request, a queue or a revert is in flight. */
  canSwitch?: boolean;
  /**
   * Why a closed chip is closed, in the host's words when it names one: a
   * running compaction, or a continuing goal (goals §5.5). Absent ⇒ the
   * chip's own "available when idle".
   */
  disabledReason?: string | null;
  onChange?: (accountId: string) => void;
  returnFocusTo?: () => HTMLElement | null;
}

/** Why the chip is inert, in the one place the copy lives. */
const ACCOUNT_BUSY_TITLE = "Available when the agent is idle";

/**
 * The account chip.
 *
 * It is a **picker** (§3.4's account switch), gated on the thread being idle:
 * the switch is applied on the next message by restarting the provider child,
 * which is only safe when nothing is in flight. It carries a
 * `data-composer-shortcut` token so the one keybinding handler can address it,
 * but deliberately **no chord** (§7.4).
 *
 * With no `onChange` — an OpenCode thread, whose server owns the identity — it
 * degrades to the label it has always been rather than offering a control that
 * could only refuse.
 */
export function AccountChip({
  label,
  options,
  selectedId,
  canSwitch = true,
  disabledReason = null,
  onChange,
  returnFocusTo
}: AccountChipProps): React.ReactElement {
  if (!onChange || !options || options.length === 0) {
    return (
      <span
        title={`Running as ${label}`}
        className="inline-flex h-7 max-w-40 items-center gap-1 px-2 text-xs text-neutral-500"
      >
        <UserRound size={12} aria-hidden className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <ComposerPopover
      label="Account"
      width="w-72"
      returnFocusTo={returnFocusTo}
      renderTrigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          disabled={!canSwitch}
          data-composer-shortcut="account"
          title={
            canSwitch ? `Running as ${label} — click to switch` : (disabledReason ?? ACCOUNT_BUSY_TITLE)
          }
          className={cn(CHIP, "max-w-40")}
        >
          {chipContent({
            icon: <UserRound size={12} aria-hidden />,
            label: "Account",
            value: label
          })}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2 py-1 text-[11px] text-neutral-500">Account</div>
          {options.map((option) => (
            <ComposerMenuRow
              key={option.id}
              selected={option.id === selectedId}
              hint={option.needsReauth ? "Signed out — sign in again to use it" : undefined}
              trailing={
                option.id === selectedId ? (
                  <Check size={13} className="text-info" aria-hidden />
                ) : undefined
              }
              onClick={() => {
                close();
                if (option.id !== selectedId) onChange(option.id);
              }}
            >
              {option.label}
            </ComposerMenuRow>
          ))}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-neutral-500">
            Applies to your next message. The conversation is kept.
          </p>
        </>
      )}
    </ComposerPopover>
  );
}
