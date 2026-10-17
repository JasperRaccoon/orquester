/**
 * Settings › Agent tools (unified MCP §7.6): every Orquester tool is available in every agent chat
 * — there is nothing to switch on or off — so this page is about what chats may do without asking:
 * every grant, with Revoke and Revoke all.
 */

import React from "react";
import { KeyRound, Wrench } from "lucide-react";

import { relativeTime } from "../../lib/relative-time";
import { useAgentToolsSettings } from "../../lib/agent-tools/hooks";
import { failureMessage, revokeAgentToolGrant, revokeAgentToolGrants } from "../../lib/agent-tools/store";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog } from "../ui";
import { describeGrant } from "./agent-tools-settings.logic";
import { EmptyState, Notice, SettingRow, SettingsPage, SettingsSection } from "./primitives";

/** A refused change, in words — never the request. */
function changeFailureText(error: unknown): string {
  return failureMessage(error) ?? "The change did not go through. Try again.";
}

export const AgentToolsSettings: React.FC = () => {
  const api = useAppStore((state) => state.api);
  const sessions = useAppStore((state) => state.sessions);
  const { settings, settingsLoading, settingsError, settingsUnsupported } = useAgentToolsSettings();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  const run = (action: () => Promise<unknown>): void => {
    if (busy || !api) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(changeFailureText(failure)))
      .finally(() => setBusy(false));
  };

  const page = (children: React.ReactNode): React.ReactElement => (
    <SettingsPage
      title="Agent tools"
      description="Every Orquester tool is available in every agent chat. Admin tools ask for your approval with a card; grants let later calls of the same kind skip it."
    >
      {children}
    </SettingsPage>
  );

  if (settingsUnsupported) {
    return page(
      <EmptyState
        icon={<Wrench size={18} />}
        title="Not available on this daemon"
        description="This Orquester daemon predates agent tool grants. Update it to see and revoke them here."
      />
    );
  }
  if (settings === null) {
    return page(
      settingsError ? (
        <Notice tone="danger" title="Could not load the agent tools">
          {settingsError}
        </Notice>
      ) : (
        <p className="text-sm text-neutral-500">{settingsLoading ? "Loading…" : ""}</p>
      )
    );
  }

  const titleOf = (threadId: string): string | null => sessions.find((session) => session.id === threadId)?.title ?? null;

  return page(
    <>
      {error ? (
        <Notice tone="warn" title="Not saved">
          {error}
        </Notice>
      ) : null}

      <SettingsSection
        title="Grants"
        description="Approvals you extended to later calls of the same kind. A chat grant ends when its chat closes; a project grant lasts until you revoke it. Revoking takes effect at the agent's next call."
        actions={
          settings.grants.length > 0 ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRevokeAll(true)}>
              Revoke all
            </Button>
          ) : null
        }
      >
        {settings.grants.length === 0 ? (
          <EmptyState icon={<KeyRound size={16} />} title="No grants" description="Every call that needs your approval asks with a card in its chat." />
        ) : (
          settings.grants.map((grant) => {
            const line = describeGrant(grant, titleOf);
            return (
              <SettingRow
                key={grant.id}
                label={line.what}
                description={
                  <span data-grant-id={grant.id}>
                    {line.where}
                    {line.detail ? ` · ${line.detail}` : ""} · granted {relativeTime(grant.createdAt)}
                    {grant.lastUsedAt ? ` · last used ${relativeTime(grant.lastUsedAt)}` : " · not used yet"}
                  </span>
                }
              >
                <Button variant="outline" size="sm" disabled={busy || !api} onClick={() => api && run(() => revokeAgentToolGrant(api, grant.id))}>
                  Revoke
                </Button>
              </SettingRow>
            );
          })
        )}
      </SettingsSection>

      <ConfirmDialog
        open={confirmRevokeAll}
        title="Revoke every grant?"
        message="Every chat and project grant goes; the next call of each kind asks you again with a card."
        confirmLabel="Revoke all"
        onCancel={() => setConfirmRevokeAll(false)}
        onConfirm={() => {
          setConfirmRevokeAll(false);
          if (api) run(() => revokeAgentToolGrants(api));
        }}
      />
    </>
  );
};
