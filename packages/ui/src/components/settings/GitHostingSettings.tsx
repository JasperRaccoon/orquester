import React, { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  Github,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X
} from "lucide-react";
import type { AccountSummary, CreateAccountRequest, GitProviderId } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button, ConfirmDialog, Input, Modal, ModalCloseButton } from "../ui";
import { BitbucketIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { Badge, EmptyState, FormField, Notice, SettingsCard, SettingsPage, SettingsSection } from "./primitives";

/** The three connectable git-hosting providers, in picker order. */
const PROVIDERS: { id: GitProviderId; label: string; description: string }[] = [
  { id: "github", label: "GitHub", description: "github.com, with a personal access token" },
  { id: "bitbucket-cloud", label: "Bitbucket Cloud", description: "bitbucket.org, with a scoped API token" },
  {
    id: "bitbucket-server",
    label: "Bitbucket Data Center",
    description: "Your own instance, with an HTTP access token"
  }
];

const providerLabel = (provider: GitProviderId) => PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

const providerIcon = (provider: GitProviderId, size: number) =>
  provider === "github" ? <Github size={size} /> : <BitbucketIcon size={size} />;

const GITHUB_NEW_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=write:public_key,user:email,read:user,repo,read:org&description=Orquester";
const ATLASSIAN_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Token scopes / permissions as inline chips, so hints stay scannable. */
const Scopes: React.FC<{ items: string[] }> = ({ items }) => (
  <>
    {items.map((s) => (
      <code
        key={s}
        className="mx-0.5 inline-block rounded bg-neutral-800 px-1 py-px font-mono text-[10px] text-neutral-300"
      >
        {s}
      </code>
    ))}
  </>
);

const ExtLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-0.5 text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
  >
    {children}
    <ExternalLink size={10} />
  </a>
);

/** Hint under the connect form's token field: what the token needs, where to make it. */
const CONNECT_TOKEN_HINT: Record<GitProviderId, React.ReactNode> = {
  github: (
    <>
      Classic token with <Scopes items={["write:public_key", "user:email", "read:user"]} />; add{" "}
      <Scopes items={["repo", "read:org"]} /> for repo access. <ExtLink href={GITHUB_NEW_TOKEN_URL}>Create a token</ExtLink>
    </>
  ),
  "bitbucket-cloud": (
    <>
      Scoped API token with{" "}
      <Scopes
        items={[
          "read:repository",
          "write:repository",
          "read:workspace",
          "read:user",
          "read:ssh-key",
          "write:ssh-key"
        ]}
      />
      . <ExtLink href={ATLASSIAN_TOKENS_URL}>Create a scoped API token</ExtLink>
    </>
  ),
  "bitbucket-server": (
    <>
      HTTP access token with <Scopes items={["Repository write"]} /> permission.
    </>
  )
};

/** Hint for the per-account "enable repo access" token field. */
const REPO_TOKEN_HINT: Record<GitProviderId, React.ReactNode> = {
  github: (
    <>
      GitHub personal access token with <Scopes items={["repo", "read:org"]} />.{" "}
      <ExtLink href={GITHUB_NEW_TOKEN_URL}>Create a token</ExtLink>
    </>
  ),
  "bitbucket-cloud": (
    <>
      Scoped Atlassian API token for this account. <ExtLink href={ATLASSIAN_TOKENS_URL}>Create one</ExtLink>
    </>
  ),
  "bitbucket-server": (
    <>
      HTTP access token with <Scopes items={["Repository write"]} /> permission.
    </>
  )
};

/**
 * Whole days until a token expires, or null when the account carries no expiry
 * (GitHub PATs may be non-expiring; Bitbucket tokens always expire). Unparsable
 * values are treated as "no expiry" rather than rendering NaN.
 */
const daysUntilExpiry = (iso?: string): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.ceil((at - Date.now()) / 86_400_000) : null;
};

const TEXTAREA_CLASS =
  "w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

type TestState = { ok: boolean; text: string } | "busy";

export const GitHostingSettings: React.FC = () => {
  const accounts = useAppStore((s) => s.accounts);
  const loadAccounts = useAppStore((s) => s.loadAccounts);
  const addAccount = useAppStore((s) => s.addAccount);
  const removeAccount = useAppStore((s) => s.removeAccount);
  const testAccount = useAppStore((s) => s.testAccount);
  const setAccountToken = useAppStore((s) => s.setAccountToken);

  const [adding, setAdding] = useState(false);
  // Data Center instances that refuse token key-upload return a pending account;
  // this drives the manual paste-the-key modal.
  const [keyModalFor, setKeyModalFor] = useState<AccountSummary | null>(null);
  // Per-account test state, keyed by id.
  const [tests, setTests] = useState<Record<string, TestState>>({});
  // Per-account "enable repo access" token entry: which row is open.
  const [repoTokenFor, setRepoTokenFor] = useState<string | null>(null);
  // Disconnect: the account awaiting confirmation, the one in flight, and
  // per-account failures (e.g. 409 while a workspace still uses it).
  const [confirmRemove, setConfirmRemove] = useState<AccountSummary | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  // Accounts load on connect; refresh on open in case another client changed them.
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "busy" }));
    let next: TestState;
    try {
      const result = await testAccount(id);
      next = { ok: result.ok, text: result.ok ? `Connected as ${result.login}` : result.message ?? "Failed" };
    } catch (err) {
      next = { ok: false, text: err instanceof Error ? err.message : "Failed" };
    }
    setTests((t) => ({ ...t, [id]: next }));
  };

  const disconnect = async (id: string) => {
    setRemoving(id);
    setRemoveErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    try {
      await removeAccount(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not disconnect.";
      setRemoveErrors((e) => ({ ...e, [id]: message }));
    } finally {
      setRemoving(null);
    }
  };

  const addButton = (
    <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
      <Plus size={13} /> Add account
    </Button>
  );

  return (
    <SettingsPage
      title="Git hosting"
      description="Connected accounts supply SSH keys and a git identity for workspaces, and optionally repo access to browse and create repositories."
      actions={!adding && accounts.length > 0 ? addButton : undefined}
    >
      {adding && (
        <ConnectAccountForm
          onCancel={() => setAdding(false)}
          onConnect={async (req) => {
            const summary = await addAccount(req);
            setAdding(false);
            // Key upload was rejected by the instance — walk the user into the
            // manual paste flow instead of leaving a half-set-up account behind.
            if (summary.keyPending) {
              setKeyModalFor(summary);
            }
          }}
        />
      )}

      {accounts.length === 0 ? (
        !adding && (
          <SettingsCard>
            <EmptyState
              icon={<GitBranch size={18} />}
              title="No accounts connected"
              description="Connect GitHub or Bitbucket to give workspaces an SSH key and commit identity, and to clone or create repositories."
              action={
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus size={13} /> Add account
                </Button>
              }
            />
          </SettingsCard>
        )
      ) : (
        <SettingsSection
          title="Accounts"
          description="Pick one when creating a workspace; its projects commit and push as that identity."
        >
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              test={tests[account.id]}
              onTest={() => void runTest(account.id)}
              editingToken={repoTokenFor === account.id}
              onEditToken={(open) => setRepoTokenFor(open ? account.id : null)}
              saveToken={(token, expiresAt) => setAccountToken(account.id, token, expiresAt)}
              onFinishSetup={() => setKeyModalFor(account)}
              removing={removing === account.id}
              removeError={removeErrors[account.id]}
              onRemove={() => setConfirmRemove(account)}
            />
          ))}
        </SettingsSection>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Disconnect ${confirmRemove?.label ?? "account"}?`}
        message={
          confirmRemove && (
            <p>
              Its SSH key and stored token are deleted from this server, and the key is removed from{" "}
              {confirmRemove.provider === "bitbucket-server" ? confirmRemove.host : providerLabel(confirmRemove.provider)}{" "}
              when possible. An account still used by a workspace can&apos;t be disconnected.
            </p>
          )
        }
        confirmLabel="Disconnect"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          const target = confirmRemove;
          setConfirmRemove(null);
          if (target) {
            void disconnect(target.id);
          }
        }}
      />

      {keyModalFor && <ManualKeyModal account={keyModalFor} onClose={() => setKeyModalFor(null)} />}
    </SettingsPage>
  );
};

/** One connected account: identity, status badges, actions and inline sub-flows. */
const AccountRow: React.FC<{
  account: AccountSummary;
  test: TestState | undefined;
  onTest: () => void;
  editingToken: boolean;
  onEditToken: (open: boolean) => void;
  saveToken: (token: string, expiresAt?: string) => Promise<void>;
  onFinishSetup: () => void;
  removing: boolean;
  removeError: string | undefined;
  onRemove: () => void;
}> = ({
  account,
  test,
  onTest,
  editingToken,
  onEditToken,
  saveToken,
  onFinishSetup,
  removing,
  removeError,
  onRemove
}) => {
  const days = daysUntilExpiry(account.tokenExpiresAt);
  const expiryTitle = account.tokenExpiresAt
    ? `Token expires ${new Date(account.tokenExpiresAt).toLocaleDateString()}`
    : undefined;
  const meta = [
    `@${account.login}`,
    account.provider === "bitbucket-server" ? account.host : providerLabel(account.provider),
    account.gitEmail
  ].filter(Boolean);

  return (
    <div className="space-y-3 px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-neutral-300">
          {providerIcon(account.provider, 17)}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="mr-0.5 truncate text-sm font-medium text-neutral-100">{account.label}</p>
            {account.repoAccess ? (
              <Badge tone="ok" icon={<Check size={10} />}>
                Repo access
              </Badge>
            ) : (
              <Badge>No repo access</Badge>
            )}
            {days !== null && (
              <Badge tone={days <= 0 ? "danger" : days <= 30 ? "warn" : "neutral"} title={expiryTitle}>
                {days <= 0 ? "Token expired" : `Expires in ${days}d`}
              </Badge>
            )}
            {account.keyPending && <Badge tone="warn">SSH key pending</Badge>}
          </div>
          <p className="mt-0.5 break-words text-xs text-neutral-500">{meta.join(" · ")}</p>
          {test && test !== "busy" && (
            <p className={cn("mt-1 flex items-start gap-1 text-xs", test.ok ? "text-ok" : "text-danger")}>
              {test.ok ? <Check size={12} className="mt-px shrink-0" /> : <X size={12} className="mt-px shrink-0" />}
              <span className="min-w-0 break-words">{test.text}</span>
            </p>
          )}
        </div>
        {/* On phones the actions wrap below the identity, aligned with its text. */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-12 sm:pl-0">
          {!account.repoAccess && !editingToken && (
            <Button size="sm" variant="outline" onClick={() => onEditToken(true)}>
              <KeyRound size={13} /> Enable repo access
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={test === "busy"} onClick={onTest}>
            {test === "busy" && <Loader2 size={13} className="animate-spin" />} Test
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Disconnect ${account.label}`}
            title="Disconnect"
            disabled={removing}
            className="text-neutral-500 hover:text-danger"
            onClick={onRemove}
          >
            {removing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          </Button>
        </div>
      </div>

      {(account.keyPending || editingToken || removeError) && (
        <div className="space-y-2 sm:pl-12">
          {account.keyPending && (
            <Notice
              tone="warn"
              title="SSH key not installed yet"
              action={
                <Button size="sm" variant="outline" onClick={onFinishSetup}>
                  <KeyRound size={13} /> Finish setup
                </Button>
              }
            >
              The instance would not accept it from the token. Add it on the instance to finish.
            </Notice>
          )}
          {removeError && <Notice tone="danger">{removeError}</Notice>}
          {editingToken && (
            <RepoTokenForm account={account} onDone={() => onEditToken(false)} save={saveToken} />
          )}
        </div>
      )}
    </div>
  );
};

/** Inline "enable repo access" form for an account connected without a stored token. */
const RepoTokenForm: React.FC<{
  account: AccountSummary;
  onDone: () => void;
  save: (token: string, expiresAt?: string) => Promise<void>;
}> = ({ account, onDone, save }) => {
  const [token, setToken] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenId = `repo-token-${account.id}`;
  const expiryId = `repo-token-expiry-${account.id}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The token is only sent — never read back. setAccountToken refetches
      // accounts so `repoAccess` flips on success.
      await save(token, expiresAt || undefined);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable repo access.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <FormField label="Access token" htmlFor={tokenId} hint={REPO_TOKEN_HINT[account.provider]}>
          <Input
            id={tokenId}
            autoFocus
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </FormField>
        {account.provider !== "github" && (
          <FormField label="Expires (optional)" htmlFor={expiryId}>
            <Input
              id={expiryId}
              className="sm:w-40"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </FormField>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Stored securely on the daemon to list and create repositories. It is never displayed again and never
        used on a clone command line.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !token.trim()}>
          {busy && <Loader2 size={13} className="animate-spin" />} Save token
        </Button>
      </div>
    </form>
  );
};

/** "Connect an account": provider picker + the provider's credential fields. */
const ConnectAccountForm: React.FC<{
  onConnect: (req: CreateAccountRequest) => Promise<void>;
  onCancel: () => void;
}> = ({ onConnect, onCancel }) => {
  const [provider, setProvider] = useState<GitProviderId>("github");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  // Bitbucket-only connect fields (cloud: email; Data Center: baseUrl/username/CA).
  const [email, setEmail] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [caCertPem, setCaCertPem] = useState("");
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConnect =
    label.trim().length > 0 &&
    token.trim().length > 0 &&
    (provider !== "bitbucket-cloud" || email.trim().length > 0) &&
    (provider !== "bitbucket-server" || (baseUrl.trim().length > 0 && username.trim().length > 0));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConnect) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Discriminated on `provider` — the daemon picks the GitProvider from it.
      const req: CreateAccountRequest =
        provider === "bitbucket-cloud"
          ? { provider, label, token, email: email.trim(), tokenExpiresAt: tokenExpiresAt || undefined }
          : provider === "bitbucket-server"
            ? {
                provider,
                label,
                token,
                baseUrl: baseUrl.trim(),
                username: username.trim(),
                caCertPem: caCertPem.trim() || undefined,
                tokenExpiresAt: tokenExpiresAt || undefined
              }
            : { label, token };
      // On success the parent unmounts this form, so only reset busy on failure.
      await onConnect(req);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the account.");
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Connect an account" bare>
      <form onSubmit={(e) => void submit(e)}>
        <SettingsCard>
          <div className="space-y-5 p-4">
            <div role="radiogroup" aria-label="Provider" className="grid gap-2 sm:grid-cols-3">
              {PROVIDERS.map((p) => {
                const selected = provider === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                      selected
                        ? "border-neutral-500 bg-neutral-800/70"
                        : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/30"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                        selected ? "bg-neutral-700 text-neutral-100" : "bg-neutral-800/80 text-neutral-400"
                      )}
                    >
                      {providerIcon(p.id, 15)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-neutral-100">{p.label}</span>
                      <span className="block text-[11px] leading-snug text-neutral-500">{p.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Label" htmlFor="git-connect-label" hint="Shown when picking an account for a workspace.">
                <Input
                  id="git-connect-label"
                  autoFocus
                  placeholder="e.g. work"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </FormField>

              {provider === "bitbucket-cloud" && (
                <FormField label="Atlassian account email" htmlFor="git-connect-email">
                  <Input
                    id="git-connect-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </FormField>
              )}

              {provider === "bitbucket-server" && (
                <>
                  <FormField label="Username" htmlFor="git-connect-username" hint="Your username on the instance.">
                    <Input
                      id="git-connect-username"
                      autoComplete="off"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </FormField>
                  <FormField label="Server URL" htmlFor="git-connect-url" className="sm:col-span-2">
                    <Input
                      id="git-connect-url"
                      type="url"
                      placeholder="https://bitbucket.example.com/bitbucket"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                  </FormField>
                </>
              )}

              <FormField
                label="Access token"
                htmlFor="git-connect-token"
                hint={CONNECT_TOKEN_HINT[provider]}
                className="sm:col-span-2"
              >
                <Input
                  id="git-connect-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </FormField>

              {provider !== "github" && (
                <FormField
                  label={provider === "bitbucket-cloud" ? "Token expires" : "Token expires (optional)"}
                  htmlFor="git-connect-expiry"
                  hint={
                    provider === "bitbucket-cloud"
                      ? "Atlassian tokens expire (max 1 year) — enter the expiry you chose."
                      : "Used for the countdown badge."
                  }
                  className="sm:col-span-2"
                >
                  <Input
                    id="git-connect-expiry"
                    className="sm:w-44"
                    type="date"
                    value={tokenExpiresAt}
                    onChange={(e) => setTokenExpiresAt(e.target.value)}
                  />
                </FormField>
              )}
            </div>

            {provider === "bitbucket-server" && (
              <details className="group rounded-lg border border-neutral-800">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
                  Advanced
                  {caCertPem.trim() && <Badge className="ml-1">CA bundle set</Badge>}
                </summary>
                <div className="border-t border-neutral-800 p-3">
                  <FormField
                    label="CA bundle (PEM)"
                    htmlFor="git-connect-ca"
                    hint="Only for instances behind a self-signed or internal certificate."
                  >
                    <textarea
                      id="git-connect-ca"
                      rows={4}
                      spellCheck={false}
                      placeholder="-----BEGIN CERTIFICATE-----"
                      value={caCertPem}
                      onChange={(e) => setCaCertPem(e.target.value)}
                      className={TEXTAREA_CLASS}
                    />
                  </FormField>
                </div>
              </details>
            )}

            <p className="text-[11px] leading-relaxed text-neutral-500">
              {provider === "github" ? (
                <>
                  The token uploads an SSH key and reads your identity. With the <Scopes items={["repo"]} /> and{" "}
                  <Scopes items={["read:org"]} /> scopes it is also stored securely on the daemon to list and create
                  repositories. It is never displayed again.
                </>
              ) : (
                <>
                  The token uploads an SSH key, reads your identity, and is stored securely on the daemon to list and
                  create repositories. It is never displayed again.
                </>
              )}
            </p>

            {error && <Notice tone="danger">{error}</Notice>}
          </div>

          <div className="flex justify-end gap-2 bg-neutral-900/40 px-4 py-3">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !canConnect}>
              {busy && <Loader2 size={13} className="animate-spin" />} Connect
            </Button>
          </div>
        </SettingsCard>
      </form>
    </SettingsSection>
  );
};

/**
 * Data Center fallback: the instance refused to install the SSH key from the
 * token, so the user pastes the public key on the instance and we verify it
 * landed (`POST /api/accounts/:id/confirm-key`).
 */
const ManualKeyModal: React.FC<{ account: AccountSummary; onClose: () => void }> = ({ account, onClose }) => {
  const confirmAccountKey = useAppStore((s) => s.confirmAccountKey);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(account.publicKey);
      setCopied(true);
    } catch {
      setError("Could not copy — select the key above and copy it manually.");
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmAccountKey(account.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The key is not on the server yet.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} className="w-full max-w-xl">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-100">Add the SSH key manually</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {account.label} (@{account.login}) on {account.host}
            </p>
          </div>
          <ModalCloseButton onClose={onClose} />
        </div>
        <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-neutral-400">
          <li>The token could not install the key, so copy this public key.</li>
          <li>
            Add it on the instance&apos;s SSH keys page
            {account.manualKeyUrl && (
              <>
                {" "}
                (<ExtLink href={account.manualKeyUrl}>open it</ExtLink>)
              </>
            )}
            .
          </li>
          <li>Come back and confirm — we check that the key landed.</li>
        </ol>
        <div className="space-y-2">
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs text-neutral-300">
            {account.publicKey}
          </pre>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy key"}
          </Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Later
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2 size={13} className="animate-spin" />} I&apos;ve added it
          </Button>
        </div>
      </div>
    </Modal>
  );
};
