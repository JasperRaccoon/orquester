import React, { useEffect, useMemo, useState } from "react";
import { Check, FolderGit2, FolderPlus, GitBranch, Loader2, Lock, Search, Settings2 } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  Button,
  Dropdown,
  DropdownEmpty,
  DropdownItem,
  DropdownLabel,
  Input,
  Modal,
  ModalCloseButton
} from "../ui";
import { useAppStore } from "../../store/app";
import type { AccountSummary, RepoSummary } from "../../types";

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
}

type Mode = "empty" | "clone" | "create";
type Visibility = "private" | "public";

/**
 * Create-project modal mirroring {@link WorkspaceList}'s Modal + Dropdown
 * patterns. Three modes:
 * - **Empty** — a plain directory (always available).
 * - **Clone** — pick a repo the workspace's account can reach, or paste a URL.
 * - **Create new** — make a GitHub repo (under the account or one of its orgs)
 *   and clone it.
 *
 * Repo modes require the current workspace to be linked to a git account that
 * has repo access (a persisted token). Repos/orgs load lazily when the modal
 * opens. The token is never read here — only `repoAccess` gates the UI.
 */
export const NewProjectModal: React.FC<NewProjectModalProps> = ({ open, onClose }) => {
  const workspaces = useAppStore((s) => s.workspaces);
  const accounts = useAppStore((s) => s.accounts);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const createProject = useAppStore((s) => s.createProject);
  const listRepos = useAppStore((s) => s.listRepos);
  const listOrgs = useAppStore((s) => s.listOrgs);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  // Resolve the workspace's linked account (the only one repo features use).
  const account = useMemo<AccountSummary | null>(() => {
    const ws = workspaces.find((w) => w.name === currentWorkspace);
    const id = ws?.gitAccountId;
    return (id && accounts.find((a) => a.id === id)) || null;
  }, [workspaces, accounts, currentWorkspace]);

  const repoAccess = account?.repoAccess ?? false;

  const [mode, setMode] = useState<Mode>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empty / clone-override / create name.
  const [name, setName] = useState("");

  // Clone mode.
  const [url, setUrl] = useState("");
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [picked, setPicked] = useState<RepoSummary | null>(null);

  // Create mode.
  const [orgs, setOrgs] = useState<string[] | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [description, setDescription] = useState("");

  const reset = () => {
    setMode("empty");
    setBusy(false);
    setError(null);
    setName("");
    setUrl("");
    setRepos(null);
    setReposLoading(false);
    setReposError(null);
    setRepoQuery("");
    setPicked(null);
    setOrgs(null);
    setOwner(null);
    setVisibility("private");
    setDescription("");
  };

  const close = () => {
    reset();
    onClose();
  };

  // Lazily load repos + orgs when the modal opens with repo access. Reset to
  // Empty mode each open (account/access may have changed since last time).
  useEffect(() => {
    if (!open) {
      return;
    }
    setMode("empty");
    if (!account || !repoAccess) {
      return;
    }
    let active = true;
    setReposLoading(true);
    setReposError(null);
    listRepos(account.id)
      .then((list) => {
        if (active) setRepos(list);
      })
      .catch((err) => {
        if (active) setReposError(err instanceof Error ? err.message : "Could not load repositories.");
      })
      .finally(() => {
        if (active) setReposLoading(false);
      });
    listOrgs(account.id)
      .then((list) => {
        if (active) setOrgs(list);
      })
      .catch(() => {
        if (active) setOrgs([]);
      });
    return () => {
      active = false;
    };
  }, [open, account, repoAccess, listRepos, listOrgs]);

  // Owner options for create mode: the account login + any orgs it belongs to.
  const owners = useMemo(
    () => (account ? [account.githubLogin, ...(orgs ?? [])] : []),
    [account, orgs]
  );
  const resolvedOwner = owner ?? account?.githubLogin ?? null;

  const filteredRepos = useMemo(() => {
    const list = repos ?? [];
    const q = repoQuery.trim().toLowerCase();
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [repos, repoQuery]);

  const openGitHubSettings = () => {
    close();
    setSettingsOpen(true);
  };

  const submit = async () => {
    setError(null);
    let req:
      | { source?: "empty"; name: string }
      | { source: "clone"; url: string; name?: string }
      | { source: "create"; owner: string; name: string; visibility: Visibility; description?: string }
      | null = null;

    if (mode === "empty") {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      req = { source: "empty", name: trimmed };
    } else if (mode === "clone") {
      const override = name.trim();
      if (picked) {
        req = { source: "clone", url: picked.sshUrl, ...(override ? { name: override } : {}) };
      } else {
        const trimmedUrl = url.trim();
        if (!trimmedUrl) {
          return;
        }
        req = { source: "clone", url: trimmedUrl, ...(override ? { name: override } : {}) };
      }
    } else {
      const trimmed = name.trim();
      if (!trimmed || !resolvedOwner) {
        return;
      }
      const trimmedDesc = description.trim();
      req = {
        source: "create",
        owner: resolvedOwner,
        name: trimmed,
        visibility,
        ...(trimmedDesc ? { description: trimmedDesc } : {})
      };
    }

    setBusy(true);
    try {
      await createProject(req);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = (() => {
    if (busy) {
      return false;
    }
    if (mode === "empty") {
      return name.trim().length > 0;
    }
    if (mode === "clone") {
      return picked !== null || url.trim().length > 0;
    }
    return name.trim().length > 0 && resolvedOwner !== null;
  })();

  const tabs: { id: Mode; label: string; icon: React.ReactNode }[] = [
    { id: "empty", label: "Empty", icon: <FolderPlus size={13} /> },
    { id: "clone", label: "Clone", icon: <FolderGit2 size={13} /> },
    { id: "create", label: "Create new", icon: <GitBranch size={13} /> }
  ];

  const pickedRepoLabel = picked ? picked.fullName : "Select a repository…";
  const ownerLabel = resolvedOwner ?? "Select owner…";

  return (
    <Modal open={open} onClose={close} className="max-w-md">
      <div className="flex w-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <span className="text-sm font-medium text-neutral-100">New project</span>
          <ModalCloseButton onClose={close} />
        </div>

        <div className="space-y-3 p-4">
          {/* Mode switch (repo modes disabled without account + repo access). */}
          <div className="inline-flex rounded-lg bg-neutral-800/60 p-0.5 text-xs">
            {tabs.map((t) => {
              const repoMode = t.id !== "empty";
              const disabled = repoMode && (!account || !repoAccess);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setMode(t.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                    mode === t.id ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Gating hints for the repo modes. */}
          {!account && (
            <p className="text-[11px] text-neutral-500">
              Link this workspace to a git account to clone or create repositories. Empty projects
              are always available.
            </p>
          )}
          {account && !repoAccess && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-3">
              <p className="text-[11px] text-neutral-400">
                Repo access is off for <span className="text-neutral-200">{account.label}</span>. Add a
                GitHub token to clone or create repositories.
              </p>
              <Button size="sm" variant="outline" className="shrink-0" onClick={openGitHubSettings}>
                <Settings2 size={13} /> Enable repo access
              </Button>
            </div>
          )}

          {mode === "empty" && (
            <div className="space-y-1.5">
              <label className="text-xs text-neutral-400">Name</label>
              <Input
                autoFocus
                placeholder="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && void submit()}
              />
            </div>
          )}

          {mode === "clone" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Repository</label>
                <Dropdown
                  width="w-[26rem]"
                  trigger={
                    <span className="flex h-8 w-[26rem] items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
                      <span className="truncate">{pickedRepoLabel}</span>
                    </span>
                  }
                >
                  <div className="px-1 pb-1 pt-0.5">
                    <div className="flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-900 px-2">
                      <Search size={13} className="shrink-0 text-neutral-500" />
                      <input
                        autoFocus
                        value={repoQuery}
                        placeholder="Search repositories…"
                        onChange={(e) => setRepoQuery(e.target.value)}
                        className="h-7 w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
                      />
                    </div>
                  </div>
                  {reposLoading && (
                    <DropdownEmpty>
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> Loading…
                      </span>
                    </DropdownEmpty>
                  )}
                  {!reposLoading && reposError && <DropdownEmpty>{reposError}</DropdownEmpty>}
                  {!reposLoading && !reposError && filteredRepos.length === 0 && (
                    <DropdownEmpty>No repositories found</DropdownEmpty>
                  )}
                  {!reposLoading &&
                    !reposError &&
                    filteredRepos.map((repo) => (
                      <DropdownItem
                        key={repo.fullName}
                        icon={
                          picked?.fullName === repo.fullName ? (
                            <Check size={14} />
                          ) : repo.private ? (
                            <Lock size={12} />
                          ) : (
                            <FolderGit2 size={12} />
                          )
                        }
                        onClick={() => {
                          setPicked(repo);
                          setUrl("");
                        }}
                      >
                        {repo.fullName}
                      </DropdownItem>
                    ))}
                </Dropdown>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">…or paste a URL</label>
                <Input
                  placeholder="https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (e.target.value.trim()) setPicked(null);
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Folder name (optional)</label>
                <Input
                  placeholder="defaults to the repo name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
          )}

          {mode === "create" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Owner</label>
                <Dropdown
                  width="w-[26rem]"
                  trigger={
                    <span className="flex h-8 w-[26rem] items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
                      <span className="truncate">{ownerLabel}</span>
                    </span>
                  }
                >
                  <DropdownLabel>Owner</DropdownLabel>
                  {owners.map((o) => (
                    <DropdownItem
                      key={o}
                      icon={resolvedOwner === o ? <Check size={14} /> : <span className="h-2 w-2" />}
                      onClick={() => setOwner(o)}
                    >
                      {o}
                      {account && o === account.githubLogin && (
                        <span className="ml-1 text-neutral-500">(you)</span>
                      )}
                    </DropdownItem>
                  ))}
                </Dropdown>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Name</label>
                <Input
                  placeholder="repo-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Visibility</label>
                <div className="inline-flex rounded-lg bg-neutral-800/60 p-0.5 text-xs">
                  {(["private", "public"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVisibility(v)}
                      className={cn(
                        "rounded-md px-3 py-1 capitalize transition-colors",
                        visibility === v
                          ? "bg-neutral-700 text-neutral-100"
                          : "text-neutral-400 hover:text-neutral-200"
                      )}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Description (optional)</label>
                <Input
                  placeholder="A short description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? (
                <>
                  <Loader2 size={13} className="animate-spin" />{" "}
                  {mode === "empty" ? "Creating…" : mode === "clone" ? "Cloning…" : "Creating…"}
                </>
              ) : mode === "clone" ? (
                "Clone"
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
