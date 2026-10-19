import React, { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Image as ImageIcon, Loader2, Smile, Trash2 } from "lucide-react";

import { REPO_FAVICON_DOMAIN_MAX, REPO_ICON_MAX_BYTES, isSingleEmoji, type RepoIdentity } from "@orquester/api";

import { useApi } from "../../context/orquester-context";
import { cn } from "../../lib/cn";
import { repoIdentityErrorText } from "../../lib/repo-identities/errors";
import { useRepoIdentity } from "../../lib/repo-identities/hooks";
import { prepareRepoIconUpload, RepoIconPrepareError, type PreparedRepoIcon } from "../../lib/repo-identities/shrink";
import { formatBytes, IMAGE_UNREADABLE } from "../../lib/repo-identities/shrink.logic";
import { clearRepoIcon, fetchRepoFavicon, setRepoEmoji, uploadRepoIcon } from "../../lib/repo-identities/store";
import { Button, Input, Modal, ModalCloseButton } from "../ui";
import { RepoIcon } from "./RepoIcon";

type Tab = "emoji" | "image" | "website";
type Busy = "emoji" | "prepare" | "image" | "website" | "remove" | null;

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "emoji", label: "Emoji", icon: <Smile size={13} /> },
  { id: "image", label: "Image", icon: <ImageIcon size={13} /> },
  { id: "website", label: "Website", icon: <Globe size={13} /> }
];

function initialTab(identity: RepoIdentity | undefined): Tab {
  const icon = identity?.icon;
  if (icon?.kind === "image") return icon.source ? "website" : "image";
  return "emoji";
}

/** The host a typed domain names, for messages: `https://a.com/x` → `a.com`. */
function shownDomain(input: string): string {
  const trimmed = input.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

interface PreparedPreview {
  prepared: PreparedRepoIcon;
  url: string;
  note: string | null;
}

function preparedNote(prepared: PreparedRepoIcon): string | null {
  if (!prepared.shrunk) return null;
  const sizes = `${formatBytes(prepared.originalBytes)} → ${formatBytes(prepared.blob.size)}`;
  return prepared.originalBytes > REPO_ICON_MAX_BYTES ? `Compressed ${sizes}` : `Converted ${sizes}`;
}

/**
 * "Change icon…" for one repo: an emoji, an uploaded image (shrunk to fit
 * first) or a website's favicon (spec 2026-10-18 §3, §3a, §3b).
 *
 * Every change is applied to the shared identity store as soon as the daemon
 * answers — even when the dialog was closed meanwhile; only the dialog's own
 * feedback for a late answer is dropped.
 */
export const RepoIconDialog: React.FC<{
  open: boolean;
  repoKey: string;
  /** The repo's label as shown (its custom label or `owner/repo`), for the title. */
  repoLabel: string;
  onClose: () => void;
}> = ({ open, repoKey, repoLabel, onClose }) => (
  <Modal open={open} onClose={onClose} className="max-w-md">
    {open && <RepoIconDialogBody key={repoKey} repoKey={repoKey} repoLabel={repoLabel} onClose={onClose} />}
  </Modal>
);

const RepoIconDialogBody: React.FC<{ repoKey: string; repoLabel: string; onClose: () => void }> = ({
  repoKey,
  repoLabel,
  onClose
}) => {
  const api = useApi();
  const identity = useRepoIdentity(repoKey);
  const icon = identity?.icon;
  const [tab, setTab] = useState<Tab>(() => initialTab(identity));
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(() => (icon?.kind === "emoji" ? icon.value : ""));
  const [domain, setDomain] = useState(() => (icon?.kind === "image" && icon.source ? icon.source.domain : ""));
  const [preview, setPreview] = useState<PreparedPreview | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // A request's UI feedback lands only while this body is mounted and the
  // request is still the latest one; the store applies the answer regardless.
  const requestRef = useRef(0);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const previewUrlRef = useRef<string | null>(null);
  const replacePreview = useCallback((next: PreparedPreview | null) => {
    if (previewUrlRef.current !== null) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = next?.url ?? null;
    setPreview(next);
  }, []);
  useEffect(() => () => {
    if (previewUrlRef.current !== null) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<string | null | void>, failureDomain = "") => {
    const token = ++requestRef.current;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      if (!liveRef.current || token !== requestRef.current) return;
      setBusy(null);
      if (typeof message === "string") setNotice(message);
    } catch (failure) {
      if (!liveRef.current || token !== requestRef.current) return;
      setBusy(null);
      setError(failure instanceof RepoIconPrepareError ? failure.message : repoIdentityErrorText(failure, failureDomain));
    }
  };

  const submitEmoji = () => {
    const value = emoji.trim();
    if (!isSingleEmoji(value)) {
      setError("Enter exactly one emoji.");
      return;
    }
    void run("emoji", async () => {
      await setRepoEmoji(api, repoKey, value);
      if (liveRef.current) onClose();
    });
  };

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    replacePreview(null);
    void run("prepare", async () => {
      let prepared: PreparedRepoIcon;
      try {
        prepared = await prepareRepoIconUpload(file);
      } catch (failure) {
        throw failure instanceof RepoIconPrepareError ? failure : new RepoIconPrepareError(IMAGE_UNREADABLE);
      }
      if (!liveRef.current) return;
      replacePreview({ prepared, url: URL.createObjectURL(prepared.blob), note: preparedNote(prepared) });
    });
  };

  const submitImage = () => {
    if (!preview) return;
    const { blob, contentType } = preview.prepared;
    void run("image", async () => {
      await uploadRepoIcon(api, repoKey, contentType, blob);
      if (liveRef.current) onClose();
    });
  };

  const submitWebsite = () => {
    const value = domain.trim();
    if (value.length === 0) {
      setError("Enter a website domain, like example.com.");
      return;
    }
    if (value.length > REPO_FAVICON_DOMAIN_MAX) {
      setError("That domain is too long.");
      return;
    }
    const host = shownDomain(value);
    void run(
      "website",
      async () => {
        const answered = await fetchRepoFavicon(api, repoKey, value);
        const source = answered?.icon?.kind === "image" ? answered.icon.source?.domain : undefined;
        return `Using the icon from ${source ?? host}.`;
      },
      host
    );
  };

  const remove = () => {
    void run("remove", async () => {
      await clearRepoIcon(api, repoKey);
      return "Back to the default icon.";
    });
  };

  const disabled = busy !== null;
  const switchTab = (next: Tab) => {
    if (disabled || next === tab) return;
    setTab(next);
    setError(null);
    setNotice(null);
  };
  const onEnter = (submit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!disabled) submit();
    }
  };
  const spinner = <Loader2 size={13} className="animate-spin" aria-hidden />;

  return (
    <div className="flex max-h-[90vh] w-full flex-col overflow-y-auto p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-3">
        <RepoIcon repoKey={repoKey} size={40} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100" title={repoLabel}>
          Repo icon — {repoLabel}
        </h2>
        <ModalCloseButton onClose={onClose} />
      </div>

      <div role="tablist" aria-label="Icon source" className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-neutral-950/60 p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            disabled={disabled && tab !== item.id}
            onClick={() => switchTab(item.id)}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50",
              tab === item.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="space-y-3">
        {tab === "emoji" && (
          <>
            <div className="flex gap-2">
              <Input
                autoFocus
                aria-label="Emoji"
                value={emoji}
                placeholder="🦝"
                disabled={disabled}
                onChange={(event) => {
                  setEmoji(event.target.value);
                  setError(null);
                }}
                onKeyDown={onEnter(submitEmoji)}
                className="h-9 flex-1 text-center text-lg"
              />
              <Button onClick={submitEmoji} disabled={disabled || emoji.trim().length === 0} className="h-9">
                {busy === "emoji" && spinner}
                Use emoji
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              One emoji. Your system's emoji picker works here (Win + . on Windows, Ctrl + Cmd + Space on
              macOS, the emoji key on a phone keyboard).
            </p>
          </>
        )}

        {tab === "image" && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div className="flex items-center gap-3">
              <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/60">
                {preview ? (
                  <img src={preview.url} alt="Chosen image" draggable={false} className="h-full w-full object-cover" />
                ) : busy === "prepare" ? (
                  <Loader2 size={16} className="animate-spin text-neutral-500" aria-hidden />
                ) : (
                  <ImageIcon size={18} className="text-neutral-600" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <Button variant="outline" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
                  {preview ? "Choose another…" : "Choose image…"}
                </Button>
                <p className="text-xs text-neutral-500">
                  {busy === "prepare"
                    ? "Preparing…"
                    : (preview?.note ?? "Any image your browser can open. Large ones are shrunk to fit.")}
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={submitImage} disabled={disabled || preview === null}>
                {busy === "image" && spinner}
                Use image
              </Button>
            </div>
          </>
        )}

        {tab === "website" && (
          <>
            <div className="flex gap-2">
              <Input
                autoFocus
                aria-label="Website domain"
                value={domain}
                placeholder="example.com"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={REPO_FAVICON_DOMAIN_MAX + 16}
                disabled={disabled}
                onChange={(event) => {
                  setDomain(event.target.value);
                  setError(null);
                }}
                onKeyDown={onEnter(submitWebsite)}
                className="h-9 flex-1 text-base sm:text-sm"
              />
              <Button onClick={submitWebsite} disabled={disabled || domain.trim().length === 0} className="h-9">
                {busy === "website" && spinner}
                {icon?.kind === "image" && icon.source && shownDomain(domain) === icon.source.domain
                  ? "Refresh icon"
                  : "Fetch icon"}
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              {busy === "website" ? `Fetching the icon from ${shownDomain(domain)}…` : "Uses the site's own favicon."}
            </p>
          </>
        )}

        {error !== null && (
          <p role="alert" className="text-xs text-danger-300">
            {error}
          </p>
        )}
        {notice !== null && error === null && (
          <p role="status" className="text-xs text-neutral-300">
            {notice}
          </p>
        )}
      </div>

      {icon !== undefined && (
        <div className="mt-4 flex border-t border-neutral-800 pt-3">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={remove} className="text-danger-300">
            {busy === "remove" ? spinner : <Trash2 size={13} aria-hidden />}
            Remove icon
          </Button>
        </div>
      )}
    </div>
  );
};
