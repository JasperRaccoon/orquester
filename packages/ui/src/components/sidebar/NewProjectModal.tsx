import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  FolderGit2,
  FolderPlus,
  GitBranch,
  LayoutTemplate,
  Loader2,
  Lock,
  Search,
  Settings2
} from "lucide-react";
import type { ProjectTemplateSummary, ProjectTemplateVariantSummary } from "@orquester/api";
import { cn } from "../../lib/cn";
import {
  Button,
  Dropdown,
  DropdownEmpty,
  DropdownItem,
  DropdownLabel,
  Input,
  Modal,
  ModalCloseButton,
  Switch
} from "../ui";
import { useAppStore } from "../../store/app";
import { ApiError } from "../../lib/api-client";
import { ProjectSetupError } from "../../lib/project-setup-error";
import type { AccountSummary, OwnerSummary, RepoSummary } from "../../types";

export interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
}

type Mode = "empty" | "clone" | "create" | "template";
type TemplateStep = "browse" | "variant" | "review";
type Visibility = "private" | "public";

/** Paste-a-URL hints per provider — each provider parses its own URL forms. */
const CLONE_PLACEHOLDER: Record<string, string> = {
  github: "https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo",
  "bitbucket-cloud":
    "https://bitbucket.org/workspace/repo, git@bitbucket.org:workspace/repo.git, or workspace/repo",
  "bitbucket-server":
    "https://host/scm/KEY/repo.git, ssh://git@host:7999/KEY/repo.git, a repo browse URL, or KEY/repo"
};

/**
 * Loose shape check for a URL that will be single-quoted into a typed
 * `git clone` line. Rejecting whitespace and `'` is the load-bearing part (the
 * quoting must stay intact); the scheme test only catches obvious typos —
 * anything else fails visibly in the terminal, which is the point of typing it.
 *
 * The printable-ASCII gate closes the residual: a pasted URL carrying ESC/BEL
 * (or any other control byte) would be typed straight into the PTY, where the
 * terminal — not git — interprets it.
 */
function isPlausibleCloneUrl(value: string): boolean {
  const url = value.trim();
  // eslint-disable-next-line no-control-regex -- the point is to reject controls
  if (!url || /\s/.test(url) || url.includes("'") || /[^\x21-\x7e]/.test(url)) {
    return false;
  }
  return /^(https?|git|ssh):\/\/\S+$/.test(url) || /^[\w.-]+@[\w.-]+:\S+$/.test(url);
}

/**
 * Directory-safe name from the last path segment of a git URL. Trailing slashes
 * come off FIRST: `…/repo.git/` must yield `repo`, not `repo.git`.
 */
function nameFromRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "");
}

/**
 * Catalog commands are static data, so the Go template ships the literal module
 * path `project`. Swap in the chosen project name when it is a plain
 * `[A-Za-z0-9._-]` token (anything looser stays on the literal rather than
 * risking shell syntax in a line the user is about to run).
 */
function withProjectName(command: string, projectName: string): string {
  const name = projectName.trim();
  if (command === "go mod init project" && /^[A-Za-z0-9._-]+$/.test(name)) {
    return `go mod init ${name}`;
  }
  return command;
}

/**
 * Monogram stand-in for a template's brand mark. The catalog ships opaque icon
 * ids (`vite`, `rust`, …) and this package has no brand SVGs for them, so each
 * id gets a tinted two-letter tile instead of twelve invented marks.
 *
 * The tints are brand identity, not status, so they get their own `--brand-*`
 * ramp (styles/globals.css) rather than a semantic token — but they are still
 * text, and the shipped -300 shades measure ~1.3:1 on a light surface, so the
 * ramp is per-mode. `nextdotjs` is greyscale and already themed by `neutral`.
 */
const TEMPLATE_MARKS: Record<string, { text: string; className: string }> = {
  vite: { text: "Vt", className: "text-[color:var(--brand-vite)]" },
  react: { text: "Re", className: "text-[color:var(--brand-react)]" },
  typescript: { text: "TS", className: "text-[color:var(--brand-typescript)]" },
  javascript: { text: "JS", className: "text-[color:var(--brand-javascript)]" },
  vuejs: { text: "Vu", className: "text-[color:var(--brand-vuejs)]" },
  svelte: { text: "Sv", className: "text-[color:var(--brand-svelte)]" },
  astro: { text: "As", className: "text-[color:var(--brand-astro)]" },
  nextdotjs: { text: "Nx", className: "text-neutral-100" },
  nodedotjs: { text: "Nd", className: "text-[color:var(--brand-nodedotjs)]" },
  python: { text: "Py", className: "text-[color:var(--brand-python)]" },
  rust: { text: "Rs", className: "text-[color:var(--brand-rust)]" },
  go: { text: "Go", className: "text-[color:var(--brand-go)]" }
};

const TemplateMark: React.FC<{ icon: string; size?: "sm" | "md" }> = ({ icon, size = "md" }) => {
  const mark = TEMPLATE_MARKS[icon] ?? {
    text: icon.slice(0, 2).replace(/^./, (c) => c.toUpperCase()),
    className: "text-neutral-300"
  };
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 font-semibold",
        size === "sm" ? "h-7 w-7 text-[11px]" : "h-10 w-10 text-sm",
        mark.className
      )}
    >
      {mark.text}
    </span>
  );
};

const CategoryChip: React.FC<{ label: string; selected: boolean; onClick: () => void }> = ({
  label,
  selected,
  onClick
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    className={cn(
      "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
      selected
        ? "border-neutral-500 bg-neutral-700 text-neutral-100"
        : "border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
    )}
  >
    {label}
  </button>
);

const TemplateCard: React.FC<{
  name: string;
  icon: string;
  subtitle?: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}> = ({ name, icon, subtitle, disabled, disabledReason, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    title={disabledReason}
    className={cn(
      "flex flex-col items-center gap-2 rounded-lg border border-neutral-800 px-2 py-3 text-center transition-colors",
      disabled ? "cursor-not-allowed opacity-40" : "hover:border-neutral-600 hover:bg-neutral-800/40"
    )}
  >
    <TemplateMark icon={icon} />
    <span className="text-xs text-neutral-100">{name}</span>
    {subtitle && <span className="text-[10px] text-neutral-500">{subtitle}</span>}
  </button>
);

/**
 * Create-project modal mirroring {@link WorkspaceList}'s Modal + Dropdown
 * patterns. Four modes:
 * - **Empty** — a plain directory (always available).
 * - **Clone** — pick a repo the workspace's account can reach, or paste a URL.
 *   With a token-bearing account the daemon clones server-side (private repos,
 *   the account's own credentials). Without one, the fallback creates the
 *   directory and TYPES `git clone …` into a shell tab after a review step.
 * - **New repo** — make a repo on the bound account's provider (under the
 *   account itself or one of its orgs/workspaces/projects) and clone it.
 * - **Template** — pick a scaffolder from the daemon's catalog (unavailable ones
 *   stay visible, disabled, naming the missing tool), choose a variant and its
 *   boolean options, review the exact assembled command, then create.
 *
 * Template (and the fallback clone) are never EXECUTED daemon-side: the project
 * directory is created through the normal API, then the command is typed into a
 * fresh terminal tab (by the daemon, via `initialCommand`) so the user watches
 * it run and answers its interactive prompts.
 *
 * The "New repo" mode and the server-side clone require the current workspace to
 * be linked to a git account that has repo access (a persisted token). Repos and
 * owners load lazily when the modal opens; templates load when that tab is first
 * opened. The token is never read here — only `repoAccess` gates the UI.
 */
export const NewProjectModal: React.FC<NewProjectModalProps> = ({ open, onClose }) => {
  const workspaces = useAppStore((s) => s.workspaces);
  const accounts = useAppStore((s) => s.accounts);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const projects = useAppStore((s) => s.projects);
  const createProject = useAppStore((s) => s.createProject);
  const createProjectWithCommand = useAppStore((s) => s.createProjectWithCommand);
  const setNotice = useAppStore((s) => s.setNotice);
  const listRepos = useAppStore((s) => s.listRepos);
  const listOwners = useAppStore((s) => s.listOwners);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const api = useAppStore((s) => s.api);

  // Resolve the workspace's linked account (the only one repo features use).
  const account = useMemo<AccountSummary | null>(() => {
    const ws = workspaces.find((w) => w.name === currentWorkspace);
    const id = ws?.gitAccountId;
    return (id && accounts.find((a) => a.id === id)) || null;
  }, [workspaces, accounts, currentWorkspace]);

  const repoAccess = account?.repoAccess ?? false;
  /** The daemon can only clone for us when it has the account's credentials. */
  const canServerClone = !!account && repoAccess;

  const [mode, setMode] = useState<Mode>("empty");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empty / clone-override / create name.
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  // Clone mode.
  const [url, setUrl] = useState("");
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [picked, setPicked] = useState<RepoSummary | null>(null);
  /** Review gate for the typed (no-account) clone — there is a command to show. */
  const [cloneReview, setCloneReview] = useState(false);
  /**
   * Arms the confirm button a beat after a review step appears. The review and
   * its trigger share the footer slot, so without this a double-click on
   * "Review" lands its second click on "Clone" and skips the review entirely.
   */
  const [reviewArmed, setReviewArmed] = useState(false);
  const confirmRef = React.useRef<HTMLButtonElement>(null);

  // Create mode.
  const [owners, setOwners] = useState<OwnerSummary[] | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [description, setDescription] = useState("");

  // Template mode.
  const [templates, setTemplates] = useState<ProjectTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  /** Bumped by the retry button to re-run the fetch effect. */
  const [templatesAttempt, setTemplatesAttempt] = useState(0);
  const [templateStep, setTemplateStep] = useState<TemplateStep>("browse");
  const [templateQuery, setTemplateQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [optionOverrides, setOptionOverrides] = useState<Record<string, boolean>>({});

  const reset = () => {
    setMode("empty");
    setBusy(false);
    setError(null);
    setName("");
    setNameTouched(false);
    setUrl("");
    setRepos(null);
    setReposLoading(false);
    setReposError(null);
    setRepoQuery("");
    setPicked(null);
    setCloneReview(false);
    setReviewArmed(false);
    setOwners(null);
    setOwner(null);
    setVisibility("private");
    setDescription("");
    // Dropped, not kept: `available` is host state, so a tool installed from a
    // terminal since the last open must be re-probed rather than served stale.
    setTemplates(null);
    setTemplatesError(null);
    setTemplatesAttempt(0);
    setTemplateStep("browse");
    setTemplateQuery("");
    setCategory("all");
    setTemplateId(null);
    setVariantId(null);
    setOptionOverrides({});
  };

  const close = () => {
    reset();
    onClose();
  };

  /**
   * User-initiated close (Escape, backdrop, the X, Cancel). Refused mid-flight:
   * the create is already running server-side, and dismissing the modal there
   * would hide both the outcome and the error. `close()` itself stays available
   * to the flows that finish the work.
   */
  const requestClose = () => {
    if (busy) {
      return;
    }
    close();
  };

  // Lazily load repos + owners when the modal opens with repo access. Reset to
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
    listOwners(account.id)
      .then((list) => {
        if (active) setOwners(list);
      })
      .catch(() => {
        if (active) setOwners([]);
      });
    return () => {
      active = false;
    };
  }, [open, account, repoAccess, listRepos, listOwners]);

  // Templates are host state (which scaffolders are on PATH), so fetch them the
  // first time the tab is opened rather than on every modal open. A daemon too
  // old to know the route answers with the SPA fallback, which `send` rejects —
  // surfaced as a message instead of an empty, unexplained grid.
  useEffect(() => {
    if (!open || mode !== "template" || !api || templates) {
      return;
    }
    let active = true;
    setTemplatesError(null);
    api
      .listProjectTemplates()
      .then((res) => {
        if (!active) return;
        // Wire data from a possibly-older daemon: never let a missing array
        // reach the render path.
        setTemplates(
          (res?.templates ?? []).map((t) => ({
            ...t,
            category: t.category || "Other",
            requires: t.requires ?? [],
            missing: t.missing ?? [],
            variants: (t.variants ?? []).map((v) => ({ ...v, options: v.options ?? [] }))
          }))
        );
      })
      .catch(() => {
        // Could equally be a blip as an older daemon, so the message stays
        // hedged and the panel offers a retry rather than a dead end.
        if (active) setTemplatesError("Could not load templates from this server.");
      });
    return () => {
      active = false;
    };
  }, [open, mode, api, templates, templatesAttempt]);

  // Owner choices for create mode. The daemon returns the account's own
  // namespace (GitHub user / DC personal project, `kind: "user"`) plus its
  // orgs/workspaces/projects. Bitbucket Cloud has no personal entry — repos
  // always live in a workspace — so fall back to the first owner there.
  const ownerList = owners ?? [];
  const defaultOwner = useMemo(() => {
    const list = owners ?? [];
    return list.find((o) => o.kind === "user")?.id ?? list[0]?.id ?? null;
  }, [owners]);
  const resolvedOwner = owner ?? defaultOwner;

  const filteredRepos = useMemo(() => {
    const list = repos ?? [];
    const q = repoQuery.trim().toLowerCase();
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [repos, repoQuery]);

  const categories = useMemo(
    () => Array.from(new Set((templates ?? []).map((t) => t.category))).sort(),
    [templates]
  );

  const filteredTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase();
    return (templates ?? []).filter((t) => {
      if (category !== "all" && t.category !== category) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        t.name.toLowerCase().includes(query) ||
        t.category.toLowerCase().includes(query) ||
        t.variants.some((v) => v.name.toLowerCase().includes(query))
      );
    });
  }, [templates, templateQuery, category]);

  const selectedTemplate = (templates ?? []).find((t) => t.id === templateId) ?? null;
  const selectedVariant = selectedTemplate?.variants.find((v) => v.id === variantId) ?? null;

  /** A step that shows the exact command and asks for a deliberate confirm. */
  const inReview =
    (mode === "clone" && cloneReview) || (mode === "template" && templateStep === "review");

  // Arm the confirm a beat after a review appears, and move focus onto it. The
  // step that OPENS the review shares the footer slot with the confirm (Review →
  // Clone) or sits under the pointer (a single-variant template card), so the
  // second click of a double-click would otherwise sail straight through the
  // review it was meant to stop at.
  useEffect(() => {
    if (!inReview) {
      setReviewArmed(false);
      return;
    }
    setReviewArmed(false);
    const timer = setTimeout(() => {
      setReviewArmed(true);
      // Never steal focus from a field the user may already be typing in (the
      // template review autofocuses its name input).
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement)) {
        confirmRef.current?.focus();
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [inReview]);

  const templateCommand = useMemo(() => {
    if (!selectedVariant) {
      return "";
    }
    const flags = selectedVariant.options
      .map((opt) => ((optionOverrides[opt.id] ?? opt.defaultOn) ? opt.flagOn : opt.flagOff))
      .filter(Boolean);
    return [withProjectName(selectedVariant.command, name), ...flags].join(" ");
  }, [selectedVariant, optionOverrides, name]);

  // Single-quoted so the URL can never break out of the typed line; the field
  // already refuses `'`, whitespace and control bytes.
  const cloneCommand = `git clone '${url.trim()}' .`;

  /**
   * The directory name this submit would create. On the typed-clone path it is
   * derived from the URL when the folder field is left blank; the server-side
   * clone derives its own (better) name daemon-side, so only an explicit
   * override is knowable here.
   */
  const intendedName = useMemo(() => {
    if (mode === "clone" && !canServerClone) {
      return (name.trim() || nameFromRepoUrl(url)).trim();
    }
    return name.trim();
  }, [mode, canServerClone, name, url]);

  /**
   * Pre-warn on a name the workspace already has. The daemon refuses to
   * scaffold into a non-empty directory (409), and the empty-directory case
   * would silently adopt someone else's folder — neither is what "new project"
   * means, so say it before the click rather than after.
   */
  const nameCollision = Boolean(intendedName) && projects.some((p) => p.name === intendedName);
  const collisionNote = nameCollision ? (
    <p className="text-[11px] text-warn">
      This workspace already has a project called{" "}
      <span className="text-warn-300">{intendedName}</span>. Pick another name.
    </p>
  ) : null;

  /** Message for a failed create — the daemon's own wording wins when it sent one. */
  const describeCreateError = (err: unknown): string => {
    if (err instanceof ApiError) {
      return (
        err.serverMessage ??
        (err.status === 409
          ? `A folder named "${intendedName}" is already here and is not empty.`
          : "Could not create the project.")
      );
    }
    return err instanceof Error ? err.message : "Could not create the project.";
  };

  /**
   * The project directory exists and is open; only its setup command failed.
   * Say so from the toast (the modal has closed onto the new project) instead
   * of leaving a "could not create" error over a modal whose retry would try to
   * create the same directory again.
   */
  const reportSetupFailure = (err: ProjectSetupError) => {
    setNotice({
      title: `${err.project.name} was created`,
      message: `Its setup command did not start (${err.message}). Open a terminal in the project and run it yourself.`
    });
    close();
  };

  const pickTemplate = (template: ProjectTemplateSummary) => {
    if (!template.available || template.variants.length === 0) {
      return;
    }
    setTemplateId(template.id);
    setOptionOverrides({});
    if (template.variants.length > 1) {
      setTemplateStep("variant");
      setVariantId(null);
    } else {
      setVariantId(template.variants[0]?.id ?? null);
      setTemplateStep("review");
    }
  };

  const pickVariant = (variant: ProjectTemplateVariantSummary) => {
    setVariantId(variant.id);
    setOptionOverrides({});
    setTemplateStep("review");
  };

  const templateBack = () => {
    if (templateStep === "review" && selectedTemplate && selectedTemplate.variants.length > 1) {
      setTemplateStep("variant");
      return;
    }
    setTemplateStep("browse");
    setTemplateId(null);
    setVariantId(null);
  };

  const submit = async () => {
    setError(null);

    if (mode === "clone" && !canServerClone) {
      // Typed clone: mandatory review of the exact command before it runs.
      if (!isPlausibleCloneUrl(url)) {
        setError("Enter a clone URL (https://…, ssh://… or git@host:owner/repo.git).");
        return;
      }
      const dir = (name.trim() || nameFromRepoUrl(url)).trim();
      if (!dir || dir.startsWith(".") || dir.includes("/") || dir.includes("\\")) {
        setError("Enter a folder name (no slashes, not starting with a dot).");
        return;
      }
      if (!cloneReview) {
        setName(dir);
        setCloneReview(true);
        return;
      }
      setBusy(true);
      try {
        await createProjectWithCommand({ source: "empty", name: dir }, cloneCommand);
        close();
      } catch (err) {
        if (err instanceof ProjectSetupError) {
          reportSetupFailure(err);
          return;
        }
        setError(describeCreateError(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (mode === "template") {
      const trimmed = name.trim();
      if (!selectedVariant || !trimmed) {
        return;
      }
      setBusy(true);
      try {
        await createProjectWithCommand({ source: "empty", name: trimmed }, templateCommand);
        close();
      } catch (err) {
        if (err instanceof ProjectSetupError) {
          reportSetupFailure(err);
          return;
        }
        setError(describeCreateError(err));
      } finally {
        setBusy(false);
      }
      return;
    }

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
      setError(describeCreateError(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = (() => {
    if (busy || (inReview && !reviewArmed)) {
      return false;
    }
    if (mode === "empty") {
      return name.trim().length > 0;
    }
    if (mode === "clone") {
      return canServerClone ? picked !== null || url.trim().length > 0 : url.trim().length > 0;
    }
    if (mode === "template") {
      return templateStep === "review" && !!selectedVariant && name.trim().length > 0;
    }
    return name.trim().length > 0 && resolvedOwner !== null;
  })();

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSubmit) {
      e.preventDefault();
      void submit();
    }
  };

  const tabs: { id: Mode; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { id: "empty", label: "Empty", icon: <FolderPlus size={13} /> },
    { id: "clone", label: "Clone", icon: <FolderGit2 size={13} /> },
    { id: "create", label: "New repo", icon: <GitBranch size={13} />, disabled: !canServerClone },
    { id: "template", label: "Template", icon: <LayoutTemplate size={13} /> }
  ];

  const pickedRepoLabel = picked ? picked.fullName : "Select a repository…";
  const ownerLabel =
    ownerList.find((o) => o.id === resolvedOwner)?.label ?? resolvedOwner ?? "Select owner…";
  const browsing = mode === "template" && templateStep !== "review";
  // In a review step the confirm reads as its own act ("Create & run") rather
  // than repeating the label of the button that opened the review.
  const submitLabel =
    mode === "clone" && !cloneReview && !canServerClone
      ? "Review"
      : inReview
        ? "Create & run"
        : mode === "clone"
          ? "Clone"
          : "Create";

  return (
    <Modal
      open={open}
      onClose={requestClose}
      className={browsing ? "max-h-[80vh] max-w-2xl" : "max-w-md"}
    >
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <span className="text-sm font-medium text-neutral-100">New project</span>
          <ModalCloseButton onClose={requestClose} />
        </div>

        {/* Browsing owns its own scroll region (the card grid); every other
            step is short enough to scroll as one block. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-3 p-4",
            browsing ? "overflow-hidden" : "overflow-y-auto"
          )}
        >
          {/* Mode switch. Wraps rather than overflowing on a phone-width modal. */}
          <div className="flex flex-wrap gap-0.5 self-start rounded-lg bg-neutral-800/60 p-0.5 text-xs">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                disabled={t.disabled}
                aria-pressed={mode === t.id}
                onClick={() => {
                  setMode(t.id);
                  setError(null);
                  setCloneReview(false);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  mode === t.id ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* Gating hints for the account-backed repo modes. */}
          {mode === "create" && !account && (
            <p className="text-[11px] text-neutral-500">
              Link this workspace to a git account to create repositories. Empty, cloned and
              templated projects are always available.
            </p>
          )}
          {(mode === "clone" || mode === "create") && account && !repoAccess && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-3">
              <p className="text-[11px] text-neutral-400">
                Repo access is off for <span className="text-neutral-200">{account.label}</span>. Add a{" "}
                {account.provider === "github" ? "GitHub" : "Bitbucket"} token to browse and create
                repositories.
              </p>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => { close(); setSettingsOpen(true); }}>
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
                onKeyDown={onEnter}
              />
              {collisionNote}
            </div>
          )}

          {mode === "clone" && !cloneReview && (
            <div className="space-y-3">
              {canServerClone && (
                <div className="space-y-1.5">
                  <label className="text-xs text-neutral-400">Repository</label>
                  <Dropdown
                    width="w-[26rem]"
                    trigger={
                      <span className="flex h-8 w-full max-w-[26rem] items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
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
              )}

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">
                  {canServerClone ? "…or paste a URL" : "Repository URL"}
                </label>
                <Input
                  autoFocus={!canServerClone}
                  placeholder={
                    canServerClone
                      ? CLONE_PLACEHOLDER[account?.provider ?? "github"]
                      : "https://github.com/owner/repo.git"
                  }
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (e.target.value.trim()) setPicked(null);
                    // Only the typed path NEEDS a directory name up front. On the
                    // server-side path `name` is an override, and the daemon's
                    // provider parsers derive a better one than the last path
                    // segment does (a Bitbucket DC browse URL ends in "/browse").
                    if (!canServerClone && !nameTouched) setName(nameFromRepoUrl(e.target.value));
                  }}
                  onKeyDown={onEnter}
                />
                {!canServerClone && (
                  <p className="text-[11px] text-neutral-500">
                    No git account is linked to this workspace, so the clone runs in a terminal tab
                    with the server's own git credentials. Public repositories work as-is.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">
                  Folder name{canServerClone ? " (optional)" : ""}
                </label>
                <Input
                  placeholder="defaults to the repo name"
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value);
                  }}
                  onKeyDown={onEnter}
                />
                {collisionNote}
              </div>
            </div>
          )}

          {mode === "clone" && cloneReview && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setCloneReview(false)}
                className="flex items-center gap-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-200"
              >
                <ArrowLeft size={12} /> Back
              </button>
              <p className="text-[11px] text-neutral-500">
                <span className="text-neutral-300">{name}</span> will be created, then this runs in a
                terminal tab so you can watch it and answer any prompts:
              </p>
              <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-300">
                <code>{cloneCommand}</code>
              </pre>
            </div>
          )}

          {mode === "create" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Owner</label>
                <Dropdown
                  width="w-[26rem]"
                  trigger={
                    <span className="flex h-8 w-full max-w-[26rem] items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
                      <span className="truncate">{ownerLabel}</span>
                    </span>
                  }
                >
                  <DropdownLabel>Owner</DropdownLabel>
                  {ownerList.map((o) => (
                    <DropdownItem
                      key={o.id}
                      icon={resolvedOwner === o.id ? <Check size={14} /> : <span className="h-2 w-2" />}
                      onClick={() => setOwner(o.id)}
                    >
                      {o.label}
                      {o.kind === "user" && <span className="ml-1 text-neutral-500">(you)</span>}
                    </DropdownItem>
                  ))}
                </Dropdown>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Name</label>
                <Input placeholder="repo-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
                {collisionNote}
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
                        visibility === v ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
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
                  onKeyDown={onEnter}
                />
              </div>
            </div>
          )}

          {mode === "template" && templateStep === "browse" && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
                <Input
                  autoFocus
                  placeholder="Search templates…"
                  value={templateQuery}
                  onChange={(e) => setTemplateQuery(e.target.value)}
                  className="pl-8"
                />
              </div>

              {categories.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  <CategoryChip label="All" selected={category === "all"} onClick={() => setCategory("all")} />
                  {categories.map((c) => (
                    <CategoryChip key={c} label={c} selected={category === c} onClick={() => setCategory(c)} />
                  ))}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {templatesError && (
                  <div className="flex items-center gap-3 px-1 py-3">
                    <p className="text-xs text-danger">{templatesError}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTemplatesError(null);
                        setTemplatesAttempt((n) => n + 1);
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {!templatesError && !templates && (
                  <div className="flex items-center gap-2 px-1 py-3 text-xs text-neutral-500">
                    <Loader2 size={13} className="animate-spin" /> Loading templates…
                  </div>
                )}
                {templates && filteredTemplates.length === 0 && (
                  <p className="px-1 py-3 text-xs text-neutral-600">No templates match.</p>
                )}
                {filteredTemplates.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {filteredTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        name={template.name}
                        icon={template.icon}
                        subtitle={
                          !template.available
                            ? `needs ${template.missing.join(", ")}`
                            : template.variants.length > 1
                              ? `${template.variants.length} variants`
                              : undefined
                        }
                        disabled={!template.available}
                        disabledReason={
                          !template.available
                            ? `${template.missing.join(", ")} not found on the server's PATH`
                            : undefined
                        }
                        onClick={() => pickTemplate(template)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === "template" && templateStep === "variant" && selectedTemplate && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <button
                type="button"
                onClick={templateBack}
                className="flex items-center gap-1.5 self-start text-xs text-neutral-400 transition-colors hover:text-neutral-200"
              >
                <ArrowLeft size={12} /> Back to templates
              </button>
              <div className="flex items-center gap-2">
                <TemplateMark icon={selectedTemplate.icon} size="sm" />
                <span className="text-sm text-neutral-200">{selectedTemplate.name} — choose a flavor</span>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
                {selectedTemplate.variants.map((variant) => (
                  <TemplateCard
                    key={variant.id}
                    name={variant.name}
                    icon={variant.icon}
                    onClick={() => pickVariant(variant)}
                  />
                ))}
              </div>
            </div>
          )}

          {mode === "template" && templateStep === "review" && selectedTemplate && selectedVariant && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={templateBack}
                className="flex items-center gap-1.5 text-xs text-neutral-400 transition-colors hover:text-neutral-200"
              >
                <ArrowLeft size={12} /> Back
              </button>

              <div className="flex items-center gap-2 rounded-md border border-neutral-800 px-3 py-2">
                <TemplateMark icon={selectedVariant.icon} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">
                  {selectedTemplate.name}
                  {selectedVariant.name !== "Default" && (
                    <span className="text-neutral-400"> · {selectedVariant.name}</span>
                  )}
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Project name</label>
                <Input
                  autoFocus
                  placeholder="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={onEnter}
                />
                {collisionNote}
              </div>

              {selectedVariant.options.length > 0 && (
                <div className="space-y-2">
                  {selectedVariant.options.map((opt) => (
                    <div key={opt.id} className="flex items-center justify-between gap-3 text-xs text-neutral-300">
                      <span className="min-w-0 flex-1">{opt.label}</span>
                      <Switch
                        checked={optionOverrides[opt.id] ?? opt.defaultOn}
                        onChange={(checked) => setOptionOverrides((prev) => ({ ...prev, [opt.id]: checked }))}
                        label={opt.label}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400">Runs in a terminal tab</label>
                <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-300">
                  <code>{templateCommand}</code>
                </pre>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={requestClose}>
            Cancel
          </Button>
          {!browsing && (
            <Button ref={confirmRef} size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Creating…
                </>
              ) : (
                submitLabel
              )}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
