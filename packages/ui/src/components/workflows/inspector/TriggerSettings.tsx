/**
 * The triggers' forms (workflows spec §6): a schedule built from presets —
 * shown back in words and as its next five fire times, computed here with
 * croner and confirmed by the daemon — a git event (which repository, which
 * event, which branches), and the manual trigger's example input.
 *
 * Every field validation can point at has an anchor and shows its own
 * messages: `config.preset` / `config.cron` in every schedule mode,
 * `config.repo.*` and `config.event.*` for git, `config.inputExample` for the
 * manual trigger. A problem on a group path that no field in view shows (a
 * release on a non-GitHub host lands on `config.event` itself) shows under the
 * group ("leftover" messages), so none is lost.
 */

import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Globe } from "lucide-react";

import {
  describeSchedule,
  nextRuns,
  presetToCron,
  repoDisplayName,
  SCHEDULE_HOUR_STEPS,
  SCHEDULE_MINUTE_STEPS,
  validateCron,
  type GitPullRequestAction,
  type GitTriggerEvent,
  type SchedulePreset,
  type Workflow,
  type WorkflowProblem
} from "@orquester/api";
import { GIT_PR_ACTIONS } from "@orquester/config";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { formatAgo } from "../../../lib/workflows/format";
import { useWorkflowsState } from "../../../lib/workflows/hooks";
import {
  cronInWords,
  eventForKind,
  formatJsonExample,
  gitEventText,
  gitPollingText,
  gitRepoText,
  hourlyStartsText,
  jsonExampleProblem,
  lastDayOfMonthCron,
  monthlySkipNote,
  presetForKind,
  PR_ACTION_TEXT,
  pullRequestWithBases,
  repoForKind,
  repoWithAccount,
  sameDays,
  scheduleHeadline,
  scheduleSummary,
  splitList,
  tagWithPattern,
  WEEKDAY_OPTIONS,
  WEEKDAY_QUICK_PICKS,
  zoneOffsetLabel
} from "../../../lib/workflows/trigger-text";
import { useAppStore } from "../../../store/app";
import { usePhoneLayout } from "../phone/phone-context";
import { RepoPicker } from "../RepoPicker";
import {
  Callout,
  ChipGroup,
  CopyChip,
  Field,
  NumberInput,
  Segmented,
  SelectInput,
  SmallButton,
  TextArea,
  TextInput,
  TimeInput,
  ToggleRow
} from "../ui/controls";
import {
  ConfigField,
  FieldAnchor,
  fieldCovered,
  fieldMessages,
  InspectorSection,
  problemsAt,
  useConfigSetter,
  useFieldMessages,
  useInspector
} from "./inspector-context";

export { cronInWords };

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** An error and / or a warning line under a group of fields, styled like a Field's. */
const Messages: React.FC<{ error?: string | null; warning?: string | null }> = ({ error, warning }) =>
  error || warning ? (
    <div className="space-y-0.5">
      {error ? <p className="text-[11px] leading-4 text-danger">{error}</p> : null}
      {warning ? <p className="text-[11px] leading-4 text-warn">{warning}</p> : null}
    </div>
  ) : null;

/** The first error and warning on `field` or under it that none of the `covered` fields (shown elsewhere) holds. */
function leftoverMessages(
  problems: readonly WorkflowProblem[],
  field: string,
  covered: readonly string[]
): { error: string | null; warning: string | null } {
  return fieldMessages(
    problems.filter((problem) => problem.field === undefined || !fieldCovered(problem.field, covered)),
    field
  );
}

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className="rounded bg-neutral-800/80 px-1 font-mono text-[11px] text-neutral-200">{children}</code>
);

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type PresetKind = SchedulePreset["kind"];

const FREQUENCIES: readonly { id: PresetKind; label: string }[] = [
  { id: "minutes", label: "Every few minutes" },
  { id: "hours", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Certain weekdays" },
  { id: "monthly", label: "Monthly" },
  { id: "cron", label: "Custom (cron)" }
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

/** The cron cheat sheet (croner's syntax, as `validateCron` accepts it). */
const CronHelp: React.FC = () => (
  <>
    <p>
      Five fields, separated by spaces: <strong>minute</strong> (0–59), <strong>hour</strong> (0–23), <strong>day of the month</strong>{" "}
      (1–31), <strong>month</strong> (1–12) and <strong>weekday</strong> (0–6, Sunday is 0 or 7).
    </p>
    <p>
      <Code>*</Code> any · <Code>1,5</Code> a list · <Code>1-5</Code> a range · <Code>*/15</Code> every 15th · <Code>L</Code> the last day
      of the month. Names work too: <Code>MON-FRI</Code>, <Code>JAN</Code>.
    </p>
    <ul className="space-y-0.5">
      <li>
        <Code>*/15 * * * *</Code> every 15 minutes
      </li>
      <li>
        <Code>0 9 * * 1-5</Code> weekdays at 09:00
      </li>
      <li>
        <Code>30 18 * * 5</Code> Fridays at 18:30
      </li>
      <li>
        <Code>0 0 1 * *</Code> the 1st of every month at 00:00
      </li>
      <li>
        <Code>0 9 L * *</Code> the last day of every month at 09:00
      </li>
    </ul>
    <p>With both a day of the month and a weekday set, it runs on either.</p>
    <p>An optional sixth field in front sets the second — one fixed value: a workflow runs at most once a minute.</p>
  </>
);

export const ScheduleSettings: React.FC = () => {
  const api = useApi();
  const { node, workflow, problems } = useInspector();
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
  /** Switch to "Custom (cron)" with `cron`. */
  const switchToCron = (cron: string): void => setConfig({ preset: { kind: "cron" }, cron }, "schedule");

  const localError = validateCron(config.cron, timezone);
  const next = useMemo(() => (localError ? [] : nextRuns(config.cron, timezone, 5)), [config.cron, timezone, localError]);
  const fromPreset = !describeSchedule(preset, config.cron).startsWith("Cron ");
  const headline = scheduleHeadline(preset, config.cron);
  // Under a preset's own words, the cron's reading adds detail; a custom cron's headline already is it.
  const words = useMemo(() => (fromPreset ? cronInWords(config.cron) : null), [fromPreset, config.cron]);
  const offset = zoneOffsetLabel(timezone);

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

  // What the preset's own fields show; the rest of `config.preset`'s problems show under the group.
  const covered =
    preset.kind === "weekly"
      ? ["config.preset.days", "config.preset.time"]
      : preset.kind === "monthly"
        ? ["config.preset.day", "config.preset.time"]
        : [];
  const presetMessages = leftoverMessages(problems, "config.preset", covered);
  const mismatch = problemsAt(problems, "config.cron").some((problem) => problem.code === "schedule_preset_mismatch");
  // A cleared cron box is not written (a schedule always has a cron): say which one still counts.
  const typedBlank = preset.kind === "cron" && cronText.trim() === "" && config.cron.trim() !== "";

  const preview = (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-neutral-100">{headline}</div>
          {words && words !== headline ? <div className="text-[11.5px] leading-4 text-neutral-500">{words}</div> : null}
        </div>
        <CopyChip text={config.cron} label={`Copy the cron expression ${config.cron}`} className="text-[10.5px]" />
      </div>
      {next.length > 0 ? (
        <div className="mt-2.5 border-t border-neutral-800/80 pt-2">
          <div className="mb-1 text-[10.5px] font-medium text-neutral-500">Next runs</div>
          <ol className="space-y-0.5" aria-label="Next runs">
            {next.map((iso, index) => (
              <li key={iso} className="flex items-center gap-2 text-[11.5px] tabular-nums">
                <span className="w-3 text-neutral-600">{index + 1}</span>
                <span className="text-neutral-300">{formatFireTime(iso, timezone)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="mt-2 space-y-1 text-[11px] leading-4 text-neutral-500">
        <div className="flex items-start gap-1.5">
          <Globe size={11} aria-hidden className="mt-[2.5px] shrink-0" />
          <span>
            Times are in <span className="text-neutral-300">{timezone}</span>
            {offset ? ` (${offset})` : ""} · change it in Workflow settings
          </span>
        </div>
        {localError ? (
          <div className="flex items-start gap-1.5 text-danger">
            <AlertCircle size={11} aria-hidden className="mt-[2.5px] shrink-0" />
            <span>{localError}</span>
          </div>
        ) : confirmed && confirmed.cron === config.cron ? (
          confirmed.ok ? (
            <div className="flex items-start gap-1.5">
              <CheckCircle2 size={11} aria-hidden className="mt-[2.5px] shrink-0 text-ok" />
              <span>Confirmed by the server</span>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 text-danger">
              <AlertCircle size={11} aria-hidden className="mt-[2.5px] shrink-0" />
              <span>{confirmed.error ?? "The server cannot schedule this."}</span>
            </div>
          )
        ) : null}
        {!workflow.enabled ? <p>The workflow is disabled: it runs on this schedule only once you enable it.</p> : null}
      </div>
    </div>
  );

  return (
    <InspectorSection
      title="When it runs"
      anchors={["config.preset", "config.cron"]}
      defaultOpen
      summary={scheduleSummary(preset, config.cron, timezone)}
    >
      <Segmented<PresetKind>
        label="How often it runs"
        size="sm"
        wrap
        value={preset.kind}
        onChange={(kind) => {
          // Re-picking the current frequency keeps its settings (and the cron) as they are.
          if (kind !== preset.kind) apply(presetForKind(kind, preset), kind === "cron" ? config.cron : undefined);
        }}
        options={FREQUENCIES}
      />

      <FieldAnchor field="config.preset" className="space-y-4">
        {preset.kind === "minutes" ? (
          <Field
            label="Interval"
            error={presetMessages.error}
            warning={presetMessages.warning}
            hint="Only intervals that divide an hour evenly are offered."
          >
            <div className="flex items-center gap-2 text-[13px] text-neutral-300">
              Every
              <StepSelect
                value={preset.every}
                steps={SCHEDULE_MINUTE_STEPS}
                onValue={(every) => apply({ ...preset, every })}
                label="Minutes between runs"
              />
              {preset.every === 1 ? "minute" : "minutes"}
            </div>
          </Field>
        ) : null}
        {preset.kind === "hours" ? (
          <Field
            label="Interval"
            error={presetMessages.error}
            warning={presetMessages.warning}
            hint={`Counted from midnight: ${hourlyStartsText(preset.every, preset.atMinute ?? 0)}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-300">
              Every
              <StepSelect value={preset.every} steps={SCHEDULE_HOUR_STEPS} onValue={(every) => apply({ ...preset, every })} label="Hours between runs" />
              {preset.every === 1 ? "hour" : "hours"}, at minute
              <NumberInput
                value={preset.atMinute}
                onValue={(atMinute) => apply({ ...preset, atMinute: Math.round(atMinute ?? 0) })}
                min={0}
                max={59}
                className="w-16"
                allowEmpty={false}
                aria-label="Minutes past the hour"
              />
            </div>
          </Field>
        ) : null}
        {preset.kind === "daily" ? (
          <Field label="Time" error={presetMessages.error} warning={presetMessages.warning}>
            <TimeInput value={preset.time} onValue={(time) => apply({ ...preset, time })} ariaLabel="Time of day" />
          </Field>
        ) : null}
        {preset.kind === "weekly" ? (
          <>
            <ConfigField path="config.preset.days" label="Days">
              <div className="space-y-1.5">
                <ChipGroup
                  ariaLabel="Days of the week"
                  min={1}
                  values={preset.days.map(String)}
                  options={WEEKDAY_OPTIONS}
                  onValues={(values) => apply({ ...preset, days: values.map(Number) })}
                />
                <div className="flex flex-wrap gap-1" role="group" aria-label="Quick picks">
                  {WEEKDAY_QUICK_PICKS.map((pick) => {
                    const active = sameDays(preset.days, pick.days);
                    return (
                      <SmallButton
                        key={pick.label}
                        variant="ghost"
                        aria-pressed={active}
                        onClick={() => apply({ ...preset, days: [...pick.days] })}
                        className={cn("h-6 px-2 text-[11px]", active && "bg-neutral-800 text-neutral-100")}
                      >
                        {pick.label}
                      </SmallButton>
                    );
                  })}
                </div>
              </div>
            </ConfigField>
            <ConfigField path="config.preset.time" label="Time">
              <TimeInput value={preset.time} onValue={(time) => apply({ ...preset, time })} ariaLabel="Time of day" />
            </ConfigField>
          </>
        ) : null}
        {preset.kind === "monthly" ? (
          <>
            <ConfigField path="config.preset.day" label="Day of the month">
              <NumberInput
                value={preset.day}
                onValue={(day) => apply({ ...preset, day: Math.round(day ?? 1) })}
                min={1}
                max={31}
                className="w-20"
                allowEmpty={false}
                aria-label="Day of the month"
              />
            </ConfigField>
            {monthlySkipNote(preset.day) ? (
              <Callout
                tone="info"
                action={
                  <SmallButton onClick={() => switchToCron(lastDayOfMonthCron(preset.time))}>Use the last day of every month</SmallButton>
                }
              >
                {monthlySkipNote(preset.day)} The last day of every month needs a custom cron (<Code>L</Code>).
              </Callout>
            ) : null}
            <ConfigField path="config.preset.time" label="Time">
              <TimeInput value={preset.time} onValue={(time) => apply({ ...preset, time })} ariaLabel="Time of day" />
            </ConfigField>
          </>
        ) : null}
        {preset.kind === "weekly" || preset.kind === "monthly" || preset.kind === "cron" ? (
          <Messages error={presetMessages.error} warning={presetMessages.warning} />
        ) : null}
      </FieldAnchor>

      {preset.kind === "cron" ? (
        <>
          <FieldAnchor field="config.cron">
            <Field
              label="Cron expression"
              help={<CronHelp />}
              hint={
                <>
                  minute hour day month weekday — e.g. <Code>0 16 * * 1,5</Code>
                </>
              }
              error={typedBlank ? `Type a cron expression. Until you do, the last one (${config.cron}) is kept.` : (localError ?? cronMessages.error)}
              warning={cronMessages.warning}
            >
              <TextInput
                value={cronText}
                onValue={(text) => {
                  setCronText(text);
                  if (text.trim()) setConfig({ preset: preset.kind === "cron" ? preset : { kind: "cron" }, cron: text.trim() }, "cron");
                }}
                className="font-mono"
                invalid={typedBlank || localError !== null}
                placeholder="0 9 * * 1-5"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
          </FieldAnchor>
          {preview}
        </>
      ) : (
        <FieldAnchor field="config.cron" className="space-y-2">
          {mismatch ? (
            <Callout
              tone="warn"
              title="The cron doesn't match these settings"
              action={
                <>
                  <SmallButton onClick={() => apply(preset)}>Use these settings</SmallButton>
                  <SmallButton variant="ghost" onClick={() => switchToCron(config.cron)}>
                    Keep the cron
                  </SmallButton>
                </>
              }
            >
              The saved cron is <Code>{config.cron}</Code>, and the cron is what runs. Rewrite it from these settings, or keep it as a custom cron.
            </Callout>
          ) : null}
          <Messages
            error={localError ? null : cronMessages.error}
            warning={mismatch ? null : cronMessages.warning}
          />
          {preview}
        </FieldAnchor>
      )}
    </InspectorSection>
  );
};

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

type GitConfig = { repo: { kind: "project" } | { kind: "url"; url: string; accountId?: string }; event: GitTriggerEvent };

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

/** The anchored branch / tag globs (apps/daemon triggers/glob.ts). */
const GlobHelp: React.FC<{ example: string; matches: string; misses: string }> = ({ example, matches, misses }) => (
  <>
    <p>
      <Code>*</Code> matches any characters except <Code>/</Code>, <Code>**</Code> any characters including <Code>/</Code>, <Code>?</Code> one
      character. No brackets or braces.
    </p>
    <p>
      A pattern matches the whole name: <Code>{example}</Code> matches {matches} but not {misses}. A name without wildcards matches only
      itself.
    </p>
  </>
);

const EVENTS: readonly { id: GitTriggerEvent["kind"]; label: string }[] = [
  { id: "push", label: "Push" },
  { id: "tag", label: "New tag" },
  { id: "release", label: "Release" },
  { id: "pull_request", label: "Pull request" }
];

/** Where "This workflow's project" points, from the workflow's project (apps/daemon triggers/repo-resolve.ts). */
const ProjectRepoNote: React.FC<{ project: Workflow["project"] }> = ({ project }) => {
  if (project.kind === "existing") {
    return <p className="text-[11px] leading-4 text-neutral-500">Watches the project's origin remote, read with its workspace's git account.</p>;
  }
  if (project.source.kind === "clone") {
    return (
      <p className="text-[11px] leading-4 text-neutral-500">
        Watches <span className="text-neutral-300">{repoDisplayName(project.source.url)}</span>, the repository this workflow clones, read with
        the {project.workspace} workspace's git account.
      </p>
    );
  }
  return (
    <Callout tone="warn">
      This workflow starts in an empty folder, so there is no repository to watch. Choose Another repository.
    </Callout>
  );
};

export const GitSettings: React.FC = () => {
  const { node, workflow, problems } = useInspector();
  const setConfig = useConfigSetter<GitConfig>();
  const config = node.config as GitConfig;
  const phone = usePhoneLayout();
  const accounts = useAppStore((state) => state.accounts);
  const summary = useWorkflowsState().summaries.get(workflow.id);
  const status = summary?.triggers.find((trigger) => trigger.nodeId === node.id);
  const urlMessages = useFieldMessages("config.repo.url");
  const event = config.event;
  const [now] = useState(() => Date.now());

  const setEvent = (next: GitTriggerEvent): void => setConfig({ event: next }, "event");

  const repo = config.repo;
  const accountId = repo.kind === "url" ? repo.accountId : undefined;
  const account = accountId ? (accounts.find((candidate) => candidate.id === accountId) ?? null) : null;
  const repoLeftover = leftoverMessages(problems, "config.repo", ["config.repo.accountId", "config.repo.url"]);
  const eventCovered =
    event.kind === "push"
      ? ["config.event.branches"]
      : event.kind === "tag"
        ? ["config.event.pattern"]
        : event.kind === "pull_request"
          ? ["config.event.actions", "config.event.baseBranches"]
          : [];
  const eventLeftover = leftoverMessages(problems, "config.event", eventCovered);

  const lastError = status?.lastError ?? null;
  const lastPollAt = status?.lastPollAt ?? null;
  const polling = gitPollingText(event.kind);

  return (
    <>
      <InspectorSection title="Repository" anchors={["config.repo"]} defaultOpen summary={gitRepoText(repo, account?.label ?? null)}>
        <Segmented
          label="Which repository"
          wrap
          value={repo.kind}
          onChange={(kind) => {
            // Re-picking the current choice keeps the URL and account.
            if (kind !== repo.kind) setConfig((current) => ({ ...current, repo: repoForKind(kind, current.repo) }), "repo-kind");
          }}
          options={[
            { id: "project", label: "This workflow's project" },
            { id: "url", label: "Another repository" }
          ]}
        />
        {repo.kind === "url" ? (
          <>
            <ConfigField
              path="config.repo.accountId"
              label="Access"
              help={
                <>
                  <p>The git account the daemon reads this repository with. A public repository needs none; a private one needs an account that can see it.</p>
                  <p>An account with an API token also lists its repositories below.</p>
                </>
              }
              hint={accountId ? undefined : "Anyone can read a public repository."}
            >
              <SelectInput
                value={accountId ?? ""}
                onValue={(next) =>
                  setConfig(
                    (current) => ({ ...current, repo: current.repo.kind === "url" ? repoWithAccount(current.repo, next) : current.repo }),
                    "repo-account"
                  )
                }
              >
                <option value="">Public repository (no sign-in)</option>
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label} · {candidate.host}
                  </option>
                ))}
                {accountId && !account ? <option value={accountId}>Unknown account ({accountId})</option> : null}
              </SelectInput>
            </ConfigField>
            <FieldAnchor field="config.repo.url" className="space-y-1.5">
              <RepoPicker
                account={account}
                value={repo.url}
                label="Repository"
                touch={phone}
                noAccountHint={
                  account
                    ? "This account has no API token, so its repositories can't be listed — paste the URL."
                    : "To pick from a list, choose an account under Access."
                }
                urlInputClassName="font-mono text-[12px]"
                onChange={(url) => setConfig((current) => ({ ...current, repo: { ...(current.repo as { kind: "url"; url: string }), url } }), "repo-url")}
              />
              <Messages
                error={repo.url.trim() === "" ? "Pick a repository or paste its URL." : urlMessages.error}
                warning={urlMessages.warning}
              />
            </FieldAnchor>
          </>
        ) : (
          <ProjectRepoNote project={workflow.project} />
        )}
        <Messages error={repoLeftover.error} warning={repoLeftover.warning} />
        <Callout tone={lastError ? "danger" : "info"} title={lastError ? "The last check failed" : undefined}>
          {lastError ? (
            <>
              {lastError} Failing checks are retried less and less often: up to 15 minutes apart, or up to an hour when the host asks to wait.
            </>
          ) : (
            <>
              {polling}{" "}
              {!workflow.enabled
                ? "Nothing is checked while the workflow is disabled."
                : lastPollAt
                  ? `Last checked ${formatAgo(lastPollAt, now)}.`
                  : "The first check only notes what is already there; later changes start runs."}
            </>
          )}
        </Callout>
      </InspectorSection>

      <InspectorSection title="Event" anchors={["config.event"]} defaultOpen summary={gitEventText(event)}>
        <Segmented<GitTriggerEvent["kind"]>
          label="Event"
          size="sm"
          wrap
          value={event.kind}
          onChange={(kind) => {
            // Re-picking the current event keeps its branches, pattern or actions.
            if (kind !== event.kind) setEvent(eventForKind(kind, event));
          }}
          options={EVENTS}
        />
        <FieldAnchor field="config.event" className="space-y-4">
          {event.kind === "push" ? (
            <ConfigField
              path="config.event.branches"
              label="Branches"
              optional
              help={<GlobHelp example="release/*" matches="release/1.2" misses="release/1.2/hotfix" />}
              hint="Separate with commas. Empty = the default branch. A new branch that matches counts as a push."
            >
              <ListInput value={event.branches} onChange={(branches) => setEvent({ ...event, branches })} placeholder="main, release/*" label="Branches" />
            </ConfigField>
          ) : null}
          {event.kind === "tag" ? (
            <ConfigField
              path="config.event.pattern"
              label="Tag pattern"
              optional
              help={<GlobHelp example="v*" matches="v1.2.0" misses="release/v1" />}
              hint="Empty = any new tag. A moved or deleted tag starts nothing."
            >
              <TextInput
                value={event.pattern ?? ""}
                placeholder="v*"
                aria-label="Tag pattern"
                className="font-mono text-[12px]"
                onValue={(pattern) => setEvent(tagWithPattern(event, pattern))}
              />
            </ConfigField>
          ) : null}
          {event.kind === "release" ? (
            <>
              <ToggleRow
                checked={event.includePrereleases}
                onChange={(includePrereleases) => setEvent({ ...event, includePrereleases })}
                label="Include pre-releases"
                description="Drafts never start a run; a release counts once it is published."
              />
              {eventLeftover.warning || eventLeftover.error ? null : (
                <p className="text-[11px] leading-4 text-neutral-500">GitHub only — on Bitbucket, use New tag.</p>
              )}
            </>
          ) : null}
          {event.kind === "pull_request" ? (
            <>
              <ConfigField
                path="config.event.actions"
                label="Pull request events"
                help={
                  <>
                    <ul className="space-y-0.5">
                      {GIT_PR_ACTIONS.map((action) => (
                        <li key={action}>
                          <strong>{PR_ACTION_TEXT[action].label}</strong>: {PR_ACTION_TEXT[action].description}
                        </li>
                      ))}
                    </ul>
                    <p>Reopening a pull request starts nothing. One opened and merged between two checks starts both.</p>
                  </>
                }
              >
                <ChipGroup<GitPullRequestAction>
                  ariaLabel="Pull request actions"
                  min={1}
                  values={event.actions}
                  options={GIT_PR_ACTIONS.map((action) => ({
                    value: action,
                    label: PR_ACTION_TEXT[action].label,
                    title: PR_ACTION_TEXT[action].description
                  }))}
                  onValues={(actions) => setEvent({ ...event, actions })}
                />
              </ConfigField>
              <ConfigField
                path="config.event.baseBranches"
                label="Into branches"
                optional
                help={<GlobHelp example="release/*" matches="release/1.2" misses="release/1.2/hotfix" />}
                hint="The branch it merges into. Separate with commas; empty = any."
              >
                <ListInput
                  value={event.baseBranches ?? []}
                  onChange={(baseBranches) => setEvent(pullRequestWithBases(event, baseBranches))}
                  placeholder="main"
                  label="Base branches"
                />
              </ConfigField>
            </>
          ) : null}
          <Messages error={eventLeftover.error} warning={eventLeftover.warning} />
          {event.kind === "pull_request" || event.kind === "release" ? (
            <Callout tone="warn" title="Treat its text as untrusted">
              {event.kind === "pull_request"
                ? "Pull request titles and descriptions are written by whoever opens them."
                : "Release notes are written by whoever publishes the release."}{" "}
              A prompt that includes them can be steered by their author (prompt injection).
            </Callout>
          ) : null}
        </FieldAnchor>
      </InspectorSection>
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
  const messages = useFieldMessages("config.inputExample");
  const text = config.inputExample ?? "";
  const error = jsonExampleProblem(text);
  const formatted = formatJsonExample(text);
  return (
    <InspectorSection
      title="Run now"
      anchors={["config.inputExample"]}
      defaultOpen
      summary={text.trim() ? "With an example input" : "No example input"}
      description="Starts the workflow from the toolbar's Run now, the rail, or an agent through the MCP — even while the workflow is disabled."
    >
      <FieldAnchor field="config.inputExample">
        <Field
          label="Example input"
          optional
          error={error ?? messages.error}
          warning={messages.warning}
          aside={
            <SmallButton
              variant="ghost"
              disabled={formatted === null || formatted === text}
              onClick={() => formatted !== null && setConfig({ inputExample: formatted }, "example")}
              className="h-6 px-2 text-[11px]"
            >
              Format JSON
            </SmallButton>
          }
          hint={
            <>
              JSON, prefilled in Run now (you can change it there). Later blocks read it as <CopyChip text="{{ trigger.input }}" className="align-middle text-[10.5px]" />
            </>
          }
        >
          <TextArea
            value={text}
            onValue={(value) => setConfig({ inputExample: value || undefined }, "example")}
            mono
            rows={6}
            autosize
            maxRows={16}
            invalid={error !== null}
            placeholder={'{ "ticket": "PROJ-123" }'}
          />
        </Field>
      </FieldAnchor>
    </InspectorSection>
  );
};
