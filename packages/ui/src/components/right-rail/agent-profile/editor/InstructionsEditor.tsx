/**
 * The agent's global instruction file (agent profile spec §3, §7.4): a large
 * CodeMirror markdown editor. Save carries the revision it read; when the file
 * changed on disk meanwhile the owner picks Reload (take the disk's text) or
 * Overwrite (re-read for the fresh revision, then write theirs). The file's
 * warnings show above it (a shadowing `AGENTS.override.md`), and Grok's dead
 * `GROK.md` gets a "Move GROK.md into AGENTS.md".
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { ProfileInstructionsInfo, ProfileInstructionsResponse } from "@orquester/api";

import { sanitizeInstructions } from "../../../../lib/agent-profile/sanitize";
import { CodeArea } from "./CodeArea";
import { useEditorEnv, useReportDirty } from "./env";
import { EditorShell } from "./EditorShell";
import { isAbort, profileError } from "./errors";
import { Banner, SmallButton } from "./fields";
import { Progress } from "./ImportSources";
import { instructionsFileName, instructionsSummary, legacyFileName, overwriteInstructions } from "./instructions.logic";
import { agentLabel } from "./layout.logic";
import { publishSaved } from "./saved";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

export type InstructionsLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; response: ProfileInstructionsResponse };

export const InstructionsEditor: React.FC<{ initial?: { load: InstructionsLoad; text?: string } }> = ({ initial }) => {
  const env = useEditorEnv();
  const { agent, api } = env;
  const [load, setLoad] = useState<InstructionsLoad>(initial?.load ?? { status: "loading" });
  const [text, setText] = useState(initial?.text ?? (initial?.load.status === "loaded" ? initial.load.response.text : ""));
  const [attempt, setAttempt] = useState(0);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const submit = useProfileSubmit();
  const preset = useRef(initial !== undefined);
  const loaded = load.status === "loaded" ? load.response : null;
  const dirty = loaded !== null && text !== loaded.text;
  useReportDirty(dirty);

  useEffect(() => {
    if (preset.current) {
      preset.current = false;
      return;
    }
    const controller = new AbortController();
    setLoad({ status: "loading" });
    api.getAgentProfileInstructions(agent, controller.signal).then(
      (raw) => {
        const response = readInstructions(raw);
        setLoad({ status: "loaded", response });
        setText(response.text);
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setLoad({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, agent, attempt]);

  const reload = useCallback(() => {
    submit.clear();
    setAttempt((n) => n + 1);
  }, [submit]);

  const save = () => {
    if (!loaded) return;
    const revision = loaded.info.revision;
    void submit.run(() => api.writeAgentProfileInstructions(agent, { text, revision }));
  };
  const overwrite = () => {
    void submit.run(() =>
      overwriteInstructions(
        {
          read: async (target) => readInstructions(await api.getAgentProfileInstructions(target)),
          write: (target, request) => api.writeAgentProfileInstructions(target, request)
        },
        agent,
        text
      )
    );
  };
  const migrate = async () => {
    if (!loaded) return;
    setMigrating(true);
    setMigrateError(null);
    try {
      const response = await api.migrateAgentProfileLegacyInstructions(agent, { revision: loaded.info.revision });
      publishSaved(agent, response);
      setAttempt((n) => n + 1);
    } catch (error) {
      setMigrateError(profileError(error).message);
    } finally {
      setMigrating(false);
    }
  };

  const fileName = loaded ? instructionsFileName(loaded.info.path) : "Instructions";
  return (
    <EditorShell
      title={loaded ? fileName : "Instructions"}
      subtitle={loaded ? loaded.info.path : agentLabel(agent)}
      fill
      status={
        submit.placement === "changed" && submit.error ? (
          <InstructionsConflict message={submit.error.message} onReload={reload} onOverwrite={overwrite} />
        ) : (
          <SubmitStatus state={submit} />
        )
      }
      primary={
        loaded
          ? {
              label: "Save",
              busy: submit.busy,
              disabled: !dirty,
              title: dirty ? undefined : "Nothing changed",
              onClick: save
            }
          : null
      }
      cancelLabel={loaded ? "Cancel" : "Close"}
    >
      {load.status === "loading" ? <Progress label={`Reading ${agentLabel(agent)}'s instructions…`} /> : null}
      {load.status === "error" ? (
        <Banner tone="error" title="Couldn't read the file" actions={<SmallButton onClick={reload}>Retry</SmallButton>}>
          {load.message}
        </Banner>
      ) : null}
      {loaded ? (
        <InstructionsBody
          info={loaded.info}
          text={text}
          onChange={(next) => {
            setText(next);
            if (submit.placement !== "changed") submit.clear();
          }}
          onSave={save}
          dirty={dirty}
          migrating={migrating}
          migrateError={migrateError}
          onMigrate={() => void migrate()}
        />
      ) : null}
    </EditorShell>
  );
};

/** The daemon's answer, field by field: a text, and the info the panel's store reads the same way. */
function readInstructions(raw: unknown): ProfileInstructionsResponse {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { text: typeof record.text === "string" ? record.text : "", info: sanitizeInstructions(record.info) };
}

export const InstructionsConflict: React.FC<{ message: string; onReload: () => void; onOverwrite: () => void }> = ({
  message,
  onReload,
  onOverwrite
}) => (
  <Banner
    tone="warn"
    title="Changed on disk"
    actions={
      <>
        <SmallButton onClick={onReload}>Reload (discard mine)</SmallButton>
        <SmallButton tone="danger" onClick={onOverwrite}>
          Overwrite
        </SmallButton>
      </>
    }
  >
    {message} Someone — a session, an editor — changed this file since you opened it.
  </Banner>
);

export const InstructionsBody: React.FC<{
  info: ProfileInstructionsInfo;
  text: string;
  onChange: (text: string) => void;
  onSave: () => void;
  dirty: boolean;
  migrating: boolean;
  migrateError: string | null;
  onMigrate: () => void;
}> = ({ info, text, onChange, onSave, dirty, migrating, migrateError, onMigrate }) => {
  const fileName = instructionsFileName(info.path);
  const legacy = legacyFileName(info);
  return (
    <>
      {info.warnings.length > 0 || legacy ? (
        <div className="shrink-0 space-y-2">
          {info.warnings
            // The legacy file's own warning is the banner below, which can act on it.
            .filter((warning) => !legacy || !warning.message.includes(legacy))
            .map((warning) => (
              <Banner key={`${warning.code}:${warning.message}`} tone="warn">
                {warning.message}
              </Banner>
            ))}
          {legacy ? (
            <Banner
              tone="warn"
              title={`${legacy} is never read`}
              actions={
                <SmallButton
                  onClick={onMigrate}
                  disabled={migrating || dirty}
                  title={dirty ? "Save or discard your changes first" : undefined}
                >
                  {migrating ? "Moving…" : `Move ${legacy} into ${fileName}`}
                </SmallButton>
              }
            >
              <span className="font-mono">{info.legacyPath}</span> exists, but the agent only loads {fileName}. Moving
              appends it to {fileName} and removes it.
              {migrateError ? <span className="mt-1 block text-danger">{migrateError}</span> : null}
            </Banner>
          ) : null}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span className="min-w-0 truncate">
          Applies to every chat and terminal session of this agent, in every project.
        </span>
        <span className="shrink-0 tabular-nums">{instructionsSummary(text, info.exists)}</span>
      </div>
      <CodeArea
        id="agent-profile-instructions"
        label={fileName}
        value={text}
        minHeight={320}
        placeholder={`# ${fileName}\n\nInstructions every session of this agent reads.`}
        onChange={onChange}
        onSave={onSave}
      />
    </>
  );
};
