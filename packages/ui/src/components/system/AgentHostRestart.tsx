import React, { useState } from "react";
import { Loader2, RotateCcw, Square } from "lucide-react";
import type { AgentHostRestartBlocker } from "@orquester/api/agent-chat";
import { useApi } from "../../context/orquester-context";
import { Badge, Notice, SettingsSection } from "../settings/primitives";
import { Button, ConfirmDialog } from "../ui";
import {
  blockerAgeSeconds,
  blockerKindLabel,
  blockerName,
  blockerStopAction,
  groupRestartBlockers,
  restartNowConsequences,
  retiringGroups,
  type RestartBlockerGroup,
  shortCodeStamp
} from "./agent-host-restart";
import { formatDuration } from "./system-format";
import { useAgentHostStatus } from "./use-system-status";

function failureText(error: unknown): string {
  const message = (error as { serverMessage?: string | null } | null)?.serverMessage;
  if (typeof message === "string" && message) return message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings → Host status: the agent host, and the restart a deploy left pending. A pending
 * restart waits until no chat has a turn running or background work live, for at most the update
 * grace on a host that resumes the chats it interrupts (spec 2026-11-01 P1.4 R12–R14), and
 * without limit on one that cannot. This says what it waits on, per chat, with a Stop for each
 * task, when it goes ahead anyway, and restarts at once on request.
 */
export const AgentHostRestart: React.FC<{ live: boolean }> = ({ live }) => {
  const api = useApi();
  const status = useAgentHostStatus(live);
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmSession, setConfirmSession] = useState<{ threadId: string; label: string } | null>(null);
  const [restarting, setRestarting] = useState(false);

  if (status.unavailable) return null;
  const data = status.data;
  const pending = data?.pendingRestart ?? null;
  const retiring = data?.retiringHosts ?? [];
  const stuck = data?.stuckAdoptions ?? [];
  const now = Date.now();

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setStopping((current) => new Set(current).add(key));
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      status.refresh();
    }
  };

  const stopButton = (blocker: AgentHostRestartBlocker, label: string): React.ReactNode => {
    const action = blockerStopAction(blocker);
    if (action === null) return null;
    const key = action === "task" ? `task:${blocker.threadId}:${blocker.taskId}` : `session:${blocker.threadId}`;
    const busy = stopping.has(key);
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          action === "task"
            ? void run(key, () => api.stopAgentTask(blocker.threadId, blocker.taskId!))
            : setConfirmSession({ threadId: blocker.threadId, label })
        }
        title={action === "task" ? "Stop this task alone" : "End this chat's session, and everything it runs"}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />}
        {action === "task" ? "Stop it" : "Stop session"}
      </Button>
    );
  };

  const blockerList = (groups: RestartBlockerGroup[], label: string): React.ReactNode => (
    <ul className="space-y-2" aria-label={label}>
      {groups.map((group) => (
        <li key={group.threadId} className="rounded-lg border border-neutral-800 px-3 py-2">
          <p className="mb-1 truncate font-medium text-neutral-200" title={group.threadId}>
            {group.label}
          </p>
          {group.blockers.length === 0 ? (
            <p className="text-neutral-500">Finishing up</p>
          ) : (
            <ul className="space-y-1.5">
              {group.blockers.map((blocker, index) => {
                const name = blockerName(blocker);
                const age = blockerAgeSeconds(blocker, now);
                return (
                  <li key={`${blocker.kind}:${blocker.taskId ?? index}`} className="flex flex-wrap items-center gap-2">
                    <span className="text-neutral-400">{blockerKindLabel(blocker)}</span>
                    {name !== null && blocker.kind !== "turn" && <span className="text-neutral-200">{name}</span>}
                    {age !== null && <span className="tabular-nums text-neutral-500">{formatDuration(age)}</span>}
                    {blocker.command !== undefined && blocker.command !== name && (
                      <code className="max-w-full truncate rounded bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-400">
                        {blocker.command}
                      </code>
                    )}
                    <span className="ml-auto">{stopButton(blocker, group.label)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <SettingsSection
      bare
      title="Agent host"
      description="The process that runs every agent chat. It updates automatically after a deploy, without stopping the chats that are working."
      actions={
        <Button variant="outline" size="sm" disabled={!data || restarting} onClick={() => setConfirmRestart(true)}>
          {restarting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          Restart agent host now
        </Button>
      }
    >
      <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-xs text-neutral-300">
        {data ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.state === "healthy" ? "ok" : "warn"}>{data.state}</Badge>
            {data.pid !== null && <span className="tabular-nums text-neutral-500">pid {data.pid}</span>}
            <span className="text-neutral-500">
              code <code className="text-neutral-300">{shortCodeStamp(data.codeStamp)}</code>
              {pending && (
                <>
                  {" "}→ <code className="text-neutral-300">{shortCodeStamp(data.checkoutCodeStamp)}</code>
                </>
              )}
            </span>
          </div>
        ) : status.error ? (
          <p className="text-danger">Could not read the agent host's status: {status.error}</p>
        ) : (
          <p className="flex items-center gap-2 text-neutral-500">
            <Loader2 size={12} className="animate-spin" /> Reading the agent host…
          </p>
        )}

        {/* "starting" names the step under way (an update's switch takes seconds), not a problem. */}
        {data?.reason && data.state !== "starting" && (
          <Notice tone={data.state === "error" ? "danger" : "warn"} title="Agent host problem">
            <p>{data.reason}</p>
          </Notice>
        )}

        {stuck.length > 0 && (
          <Notice tone="danger" title="Chats that cannot move to the current host">
            <p>These chats are unavailable until the current host takes them. It keeps trying.</p>
            <ul className="mt-1 space-y-0.5">
              {stuck.map((item) => (
                <li key={item.threadId} title={item.threadId}>
                  <span className="text-neutral-200">{item.threadTitle?.trim() ? item.threadTitle : item.threadId}</span>
                  <span className="text-neutral-500">
                    {" "}
                    — {item.attempts} attempts since {new Date(item.since).toLocaleString()}
                    {item.error ? `: ${item.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {pending && (
          <Notice tone="warn" title="A restart is pending">
            <p>
              The agent host runs older code than this checkout. It updates automatically as soon as nothing below is
              running
              {pending.since ? ` (waiting since ${new Date(pending.since).toLocaleString()})` : ""}
              {pending.restartsAt
                ? `, and at ${new Date(pending.restartsAt).toLocaleString()} at the latest. Chats still working then are resumed on the new host, and their subagents relaunched.`
                : data?.restartResumesChats === false
                  ? ". This host cannot resume the chats a restart interrupts, so it waits for them however long they run."
                  : ". Chats still working when it restarts are resumed on the new host, and their subagents relaunched."}
            </p>
          </Notice>
        )}

        {pending && pending.blockers.length > 0 && blockerList(groupRestartBlockers(pending.blockers), "What the restart waits on")}

        {retiring.length > 0 && !pending && (
          <Notice tone="info" title="The update is applied">
            <p>
              New chats and every idle chat run on the current code. The chats that were working keep running on the
              previous version, and each moves over on its own as soon as it finishes.
            </p>
          </Notice>
        )}

        {retiring.map((host) => {
          const groups = retiringGroups(host);
          return (
            <section
              key={host.generation}
              className="space-y-2 rounded-lg border border-neutral-800 px-3 py-2"
              aria-label={`Previous version ${host.generation}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-neutral-200">
                  Previous version, finishing {host.threads.length} {host.threads.length === 1 ? "chat" : "chats"}
                </span>
                {host.pid !== null && <span className="tabular-nums text-neutral-500">pid {host.pid}</span>}
                <span className="text-neutral-500">
                  code <code className="text-neutral-300">{shortCodeStamp(host.codeStamp)}</code>
                </span>
              </div>
              {host.stopUnconfirmedSince && (
                <p className="text-danger">
                  Being stopped since {new Date(host.stopUnconfirmedSince).toLocaleString()}, but its process cannot be
                  confirmed gone. Its chats stay on it until it is.
                </p>
              )}
              {host.endsAt && !host.stopUnconfirmedSince && (
                <p className="text-neutral-500">
                  Chats still working there at {new Date(host.endsAt).toLocaleString()} are interrupted, and resumed on the
                  current host.
                </p>
              )}
              {blockerList(groups, `What still runs on previous version ${host.generation}`)}
            </section>
          );
        })}

        {failure !== null && <p className="text-danger">{failure}</p>}
      </div>

      <ConfirmDialog
        open={confirmRestart}
        title="Restart the agent host now?"
        confirmLabel="Restart now"
        message={
          <>
            <p className="mb-2">
              {data?.restartResumesChats === true
                ? "Every agent chat's provider process is restarted. The chats working now are resumed on the new host and their subagents relaunched, not stopped:"
                : "Every agent chat's provider process is restarted. This host cannot resume chats, so this stops, without resuming:"}
              {retiring.length > 0 &&
                " The previous-version hosts end too; their chats are resumed on the current host."}
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {restartNowConsequences(data).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        }
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          setRestarting(true);
          void run("restart", () => api.restartAgentHost()).finally(() => setRestarting(false));
        }}
      />
      <ConfirmDialog
        open={confirmSession !== null}
        title="End this chat's session?"
        confirmLabel="Stop session"
        message={`"${confirmSession?.label ?? ""}" — its provider process and everything it runs in the background stop. The chat stays; its next message starts a new session.`}
        onCancel={() => setConfirmSession(null)}
        onConfirm={() => {
          const target = confirmSession;
          setConfirmSession(null);
          if (target !== null) void run(`session:${target.threadId}`, () => api.stopAgentSession(target.threadId));
        }}
      />
    </SettingsSection>
  );
};
