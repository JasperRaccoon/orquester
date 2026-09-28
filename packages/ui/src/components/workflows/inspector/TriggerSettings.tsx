/**
 * The triggers' forms (workflows spec §6): a schedule built from presets —
 * shown back in words and as its next five fire times, computed here with
 * croner and confirmed by the daemon — a git event (which repository, which
 * event, which branches), and the manual trigger's example input.
 */

import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import cronstrue from "cronstrue";

import {
  describeSchedule,
  nextRuns,
  presetToCron,
  SCHEDULE_HOUR_STEPS,
  SCHEDULE_MINUTE_STEPS,
  validateCron,
  type GitPullRequestAction,
  type GitTriggerEvent,
  type SchedulePreset
} from "@orquester/api";
import { GIT_PR_ACTIONS } from "@orquester/config";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { formatAgo } from "../../../lib/workflows/format";
import { useWorkflowsState } from "../../../lib/workflows/hooks";
import { useAppStore } from "../../../store/app";
import { Field, NumberInput, Section, Segmented, SelectInput, TextInput, ToggleRow } from "../ui/controls";
import { FieldAnchor, useConfigSetter, useFieldMessages, useInspector } from "./inspector-context";

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type PresetKind = SchedulePreset["kind"];

const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" }
];

/**
 * The "every N" choice: only the intervals a cron step keeps evenly (divisors of 60 / 24). A stored
 * value outside them (saved before the rule) is still shown, marked, until another is picked.
 */
function StepSelect({ value, steps, onValue, label }: { value: number; steps: readonly number[]; onValue: (value: number) => void; label: string }) {
  return (
    <SelectInput value={String(value)} onValue={(next) => onValue(Number(next))} aria-label={label} className="w-20">
      {steps.includes(value) ? null : <option value={String(value)}>{value} (uneven)</option>}
      {steps.map((step) => (
        <option key={step} value={String(step)}>
          {step}
        </option>
      ))}
    </SelectInput>
  );
}

function presetOf(kind: PresetKind, previous: SchedulePreset): SchedulePreset {
  const time = "time" in previous ? previous.time : "09:00";
  switch (kind) {
    case "minutes":
      return { kind: "minutes", every: 15 };
    case "hours":
      return { kind: "hours", every: 1, atMinute: 0 };
    case "daily":
      return { kind: "daily", time };
    case "weekly":
      return { kind: "weekly", days: [1, 2, 3, 4, 5], time };
    case "monthly":
      return { kind: "monthly", day: 1, time };
    case "cron":
      return { kind: "cron" };
  }
}

/** "0 9 * * 1-5" in words, or null when cronstrue cannot read it. */
export function cronInWords(cron: string): string | null {
  try {
    const text = cronstrue.toString(cron, { use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
    return text || null;
  } catch {
    return null;
  }
}

function formatFireTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

const TimeInput: React.FC<{ value: string; onChange: (value: string) => void; label: string }> = ({ value, onChange, label }) => (
  <input
    type="time"
    value={value}
    aria-label={label}
    onChange={(event) => event.target.value && onChange(event.target.value)}
    className="h-8 rounded-md border border-neutral-800 bg-neutral-950/60 px-2 text-[13px] tabular-nums text-neutral-100 focus:border-neutral-600 focus:outline-none"
  />
);

export const ScheduleSettings: React.FC = () => {
  const api = useApi();
  const { node, workflow } = useInspector();
  const setConfig = useConfigSetter<{ preset: SchedulePreset; cron: string }>();
  const config = node.config as { preset: SchedulePreset; cron: string };
  const timezone = workflow.settings.timezone;
  const cronMessages = useFieldMessages("config.cron");
  const preset = config.preset;
  const [cronText, setCronText] = useState(config.cron);

  useEffect(() => setCronText(config.cron), [config.cron]);

  const apply = (next: SchedulePreset, typedCron?: string): void => {
    const cron = presetToCron(next) ?? typedCron ?? config.cron;
    setConfig({ preset: next, cron }, "schedule");
  };

  const localError = validateCron(config.cron, timezone);
  const next = useMemo(() => (localError ? [] : nextRuns(config.cron, timezone, 5)), [config.cron, timezone, localError]);
  const words = useMemo(() => cronInWords(config.cron), [config.cron]);

  // The daemon's own reading, after the edits settle.
  const [confirmed, setConfirmed] = useState<{ cron: string; ok: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (localError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .previewWorkflowSchedule({ cron: config.cron, tz: timezone, count: 5 }, controller.signal)
        .then((answer) =>
          setConfirmed({ cron: config.cron, ok: answer.valid, ...(answer.error ? { error: answer.error } : {}) })
        )
        .catch(() => undefined);
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, config.cron, timezone, localError]);

  return (
    <Section title="When it runs">
      <Segmented<PresetKind>
        label="Schedule kind"
        size="sm"
        value={preset.kind}
        onChange={(kind) => apply(presetOf(kind, preset), kind === "cron" ? config.cron : undefined)}
        options={[
          { id: "minutes", label: "Minutes" },
          { id: "hours", label: "Hours" },
          { id: "daily", label: "Daily" },
          { id: "weekly", label: "Days" },
          { id: "monthly", label: "Monthly" },
          { id: "cron", label: "Cron" }
        ]}
      />
      <FieldAnchor field="config" className="space-y-3">
        {preset.kind === "minutes" ? (
          <div className="flex items-center gap-2 text-[13px] text-neutral-300">
            Every
            <StepSelect value={preset.every} steps={SCHEDULE_MINUTE_STEPS} onValue={(every) => apply({ kind: "minutes", every })} label="Minutes" />
            minutes
          </div>
        ) : null}
        {preset.kind === "hours" ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-300">
            Every
            <StepSelect value={preset.every} steps={SCHEDULE_HOUR_STEPS} onValue={(every) => apply({ ...preset, every })} label="Hours" />
            hours, at minute
            <NumberInput value={preset.atMinute} onValue={(atMinute) => apply({ ...preset, atMinute: Math.round(atMinute ?? 0) })} min={0} max={59} className="w-16" allowEmpty={false} aria-label="At minute" />
          </div>
        ) : null}
        {preset.kind === "daily" ? (
          <div className="flex items-center gap-2 text-[13px] text-neutral-300">
            Every day at <TimeInput value={preset.time} onChange={(time) => apply({ kind: "daily", time })} label="Time" />
          </div>
        ) : null}
        {preset.kind === "weekly" ? (
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Days of the week">
              {DAYS.map((day) => {
                const on = preset.days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const days = on ? preset.days.filter((value) => value !== day.value) : [...preset.days, day.value];
                      if (days.length > 0) apply({ ...preset, days });
                    }}
                    className={cn(
                      "h-8 w-10 rounded-md text-[12px] font-medium transition-colors",
                      on ? "bg-neutral-100 text-neutral-900" : "bg-neutral-900 text-neutral-400 ring-1 ring-inset ring-neutral-800 hover:text-neutral-100"
                    )}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 text-[13px] text-neutral-300">
              at <TimeInput value={preset.time} onChange={(time) => apply({ ...preset, time })} label="Time" />
            </div>
          </div>
        ) : null}
        {preset.kind === "monthly" ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-300">
            On day
            <NumberInput value={preset.day} onValue={(day) => apply({ ...preset, day: Math.round(day ?? 1) })} min={1} max={31} className="w-16" allowEmpty={false} aria-label="Day of the month" />
            at <TimeInput value={preset.time} onChange={(time) => apply({ ...preset, time })} label="Time" />
          </div>
        ) : null}
        {preset.kind === "cron" ? (
          <Field label="Cron expression" hint="minute hour day month weekday — e.g. 0 16 * * 1,5" error={localError ?? cronMessages.error}>
            <TextInput
              value={cronText}
              onValue={(text) => {
                setCronText(text);
                if (text.trim()) setConfig({ preset: { kind: "cron" }, cron: text.trim() }, "cron");
              }}
              className="font-mono"
              invalid={localError !== null}
              aria-label="Cron expression"
            />
          </Field>
        ) : null}
      </FieldAnchor>

      <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-neutral-100">{describeSchedule(preset, config.cron)}</div>
            {words ? <div className="text-[11.5px] leading-4 text-neutral-500">{words}</div> : null}
          </div>
          <code className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[10.5px] text-neutral-400">{config.cron}</code>
        </div>
        {next.length > 0 ? (
          <ol className="mt-2.5 space-y-0.5 border-t border-neutral-800/80 pt-2">
            {next.map((iso, index) => (
              <li key={iso} className="flex items-center gap-2 text-[11.5px] tabular-nums">
                <span className="w-3 text-neutral-600">{index + 1}</span>
                <span className="text-neutral-300">{formatFireTime(iso, timezone)}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-neutral-500">
          {localError ? (
            <>
              <AlertCircle size={11} className="text-danger" />
              <span className="text-danger">{localError}</span>
            </>
          ) : confirmed && confirmed.cron === config.cron ? (
            confirmed.ok ? (
              <>
                <CheckCircle2 size={11} className="text-ok" /> Checked by the daemon · {timezone}
              </>
            ) : (
              <>
                <AlertCircle size={11} className="text-danger" />
                <span className="text-danger">{confirmed.error ?? "The daemon cannot schedule this."}</span>
              </>
            )
          ) : (
            <span>Times in {timezone} (change it in the workflow's settings)</span>
          )}
        </div>
      </div>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

type GitConfig = { repo: { kind: "project" } | { kind: "url"; url: string; accountId?: string }; event: GitTriggerEvent };

const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** A comma-separated list field that keeps what is being typed. */
const ListInput: React.FC<{ value: readonly string[]; onChange: (value: string[]) => void; placeholder: string; label: string }> = ({
  value,
  onChange,
  placeholder,
  label
}) => {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    if (splitList(text).join(",") !== value.join(",")) setText(value.join(", "));
    // Only an outside change (undo, another tab) rewrites what is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <TextInput
      value={text}
      aria-label={label}
      placeholder={placeholder}
      className="font-mono text-[12px]"
      onValue={(next) => {
        setText(next);
        onChange(splitList(next));
      }}
    />
  );
};

export const GitSettings: React.FC = () => {
  const { node, workflow } = useInspector();
  const setConfig = useConfigSetter<GitConfig>();
  const config = node.config as GitConfig;
  const accounts = useAppStore((state) => state.accounts);
  const summary = useWorkflowsState().summaries.get(workflow.id);
  const status = summary?.triggers.find((trigger) => trigger.nodeId === node.id);
  const releaseMessages = useFieldMessages("config.event");
  const event = config.event;
  const [now] = useState(() => Date.now());

  const setEvent = (next: GitTriggerEvent): void => setConfig({ event: next }, "event");

  return (
    <>
      <Section title="Repository">
        <Segmented
          label="Repository"
          value={config.repo.kind}
          onChange={(kind) => setConfig({ repo: kind === "project" ? { kind: "project" } : { kind: "url", url: "" } }, "repo-kind")}
          options={[
            { id: "project", label: "This workflow's project" },
            { id: "url", label: "Another repository" }
          ]}
        />
        {config.repo.kind === "url" ? (
          <FieldAnchor field="config.repo" className="space-y-3">
            <Field label="Clone URL">
              <TextInput
                value={config.repo.url}
                placeholder="git@github.com:owner/repo.git"
                className="font-mono text-[12px]"
                onValue={(url) => setConfig((current) => ({ ...current, repo: { ...(current.repo as { kind: "url"; url: string }), url } }), "repo-url")}
              />
            </Field>
            <Field label="Read it as" hint="A private repository needs one of your git accounts.">
              <SelectInput
                value={config.repo.accountId ?? ""}
                aria-label="Git account"
                onValue={(accountId) =>
                  setConfig(
                    (current) => ({
                      ...current,
                      repo: { kind: "url", url: (current.repo as { url: string }).url, ...(accountId ? { accountId } : {}) }
                    }),
                    "repo-account"
                  )
                }
              >
                <option value="">Public — no account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} · {account.host}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </FieldAnchor>
        ) : (
          <p className="text-[11px] leading-4 text-neutral-500">Its origin, read with the workspace's git account.</p>
        )}
        {status && (status.lastPollAt || status.lastError) ? (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-4",
              status.lastError ? "border-danger/40 bg-danger-soft/20 text-danger" : "border-neutral-800 text-neutral-400"
            )}
          >
            {status.lastError ? <AlertCircle size={13} className="mt-px shrink-0" /> : <CheckCircle2 size={13} className="mt-px shrink-0 text-ok" />}
            <span>
              {status.lastError ? `Last check failed: ${status.lastError}` : `Last checked ${formatAgo(status.lastPollAt, now)}`}
            </span>
          </div>
        ) : null}
      </Section>
      <Section title="Event">
        <Segmented<GitTriggerEvent["kind"]>
          label="Event"
          size="sm"
          value={event.kind}
          onChange={(kind) =>
            setEvent(
              kind === "push"
                ? { kind: "push", branches: [] }
                : kind === "tag"
                  ? { kind: "tag", pattern: "v*" }
                  : kind === "release"
                    ? { kind: "release", includePrereleases: false }
                    : { kind: "pull_request", actions: ["opened", "updated"] }
            )
          }
          options={[
            { id: "push", label: "Push" },
            { id: "tag", label: "New tag" },
            { id: "release", label: "Release" },
            { id: "pull_request", label: "Pull request" }
          ]}
        />
        <FieldAnchor field="config.event" className="space-y-3">
          {event.kind === "push" ? (
            <Field label="Branches" hint="Comma-separated globs (release/*). Empty = the default branch.">
              <ListInput value={event.branches} onChange={(branches) => setEvent({ kind: "push", branches })} placeholder="main, release/*" label="Branches" />
            </Field>
          ) : null}
          {event.kind === "tag" ? (
            <Field label="Tag pattern" hint="A glob; empty = any new tag.">
              <TextInput
                value={event.pattern ?? ""}
                placeholder="v*"
                className="font-mono text-[12px]"
                onValue={(pattern) => setEvent(pattern ? { kind: "tag", pattern } : { kind: "tag" })}
              />
            </Field>
          ) : null}
          {event.kind === "release" ? (
            <>
              <ToggleRow
                checked={event.includePrereleases}
                onChange={(includePrereleases) => setEvent({ kind: "release", includePrereleases })}
                label="Include pre-releases"
              />
              <p className={cn("text-[11px] leading-4", releaseMessages.error ? "text-danger" : "text-neutral-500")}>
                {releaseMessages.error ?? "GitHub only — on Bitbucket, use New tag."}
              </p>
            </>
          ) : null}
          {event.kind === "pull_request" ? (
            <>
              <Field label="When a pull request is">
                <div className="flex flex-wrap gap-1.5">
                  {GIT_PR_ACTIONS.map((action) => {
                    const on = event.actions.includes(action);
                    return (
                      <label
                        key={action}
                        className={cn(
                          "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] ring-1 ring-inset transition-colors",
                          on ? "bg-neutral-800 text-neutral-100 ring-neutral-600" : "text-neutral-400 ring-neutral-800 hover:text-neutral-200"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const actions = on ? event.actions.filter((entry) => entry !== action) : [...event.actions, action];
                            if (actions.length > 0) setEvent({ ...event, actions: actions as GitPullRequestAction[] });
                          }}
                          className="h-3 w-3 accent-neutral-300"
                        />
                        {action}
                      </label>
                    );
                  })}
                </div>
              </Field>
              <Field label="Into branches" hint="Comma-separated globs; empty = any base branch.">
                <ListInput
                  value={event.baseBranches ?? []}
                  onChange={(baseBranches) => {
                    const { baseBranches: _old, ...rest } = event;
                    setEvent(baseBranches.length > 0 ? { ...rest, baseBranches } : rest);
                  }}
                  placeholder="main"
                  label="Base branches"
                />
              </Field>
              <p className="text-[11px] leading-4 text-warn">
                Titles and descriptions come from whoever opened the pull request — treat them as untrusted in prompts.
              </p>
            </>
          ) : null}
        </FieldAnchor>
      </Section>
    </>
  );
};

// ---------------------------------------------------------------------------
// Manual
// ---------------------------------------------------------------------------

export const ManualSettings: React.FC = () => {
  const { node } = useInspector();
  const setConfig = useConfigSetter<{ inputExample?: string }>();
  const config = node.config as { inputExample?: string };
  const text = config.inputExample ?? "";
  let error: string | null = null;
  if (text.trim()) {
    try {
      JSON.parse(text);
    } catch (reason) {
      error = `Not valid JSON: ${reason instanceof Error ? reason.message : String(reason)}`;
    }
  }
  return (
    <Section title="Run now">
      <p className="text-[12px] leading-5 text-neutral-400">
        Starts the workflow from the toolbar's Run now, the rail, or an agent through the MCP — even while the workflow is disabled.
      </p>
      <Field label="Example input" hint="Prefilled in Run now; read it as {{ trigger.input }}." error={error}>
        <textarea
          value={text}
          onChange={(event) => setConfig({ inputExample: event.target.value || undefined }, "example")}
          rows={6}
          spellCheck={false}
          placeholder={'{ "ticket": "PROJ-123" }'}
          aria-label="Example input"
          className={cn(
            "w-full resize-y rounded-md border bg-neutral-950/60 px-2.5 py-2 font-mono text-[12px] leading-5 text-neutral-100 placeholder:text-neutral-600 focus:outline-none",
            error ? "border-danger/60" : "border-neutral-800 focus:border-neutral-600"
          )}
        />
      </Field>
    </Section>
  );
};
