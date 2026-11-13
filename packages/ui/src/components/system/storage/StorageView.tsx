import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  FolderDown,
  FolderOpen,
  FolderTree,
  HardDrive,
  Loader2,
  Pencil,
  ScanSearch,
  ServerOff,
  Trash2,
  X
} from "lucide-react";
import type {
  StorageNode,
  StorageScanSummary,
  StorageStatusResponse,
  StorageTreeResponse,
  StorageVolume
} from "@orquester/api";
import { useApi } from "../../../context/orquester-context";
import { useIsDesktop } from "../../../hooks";
import { cn } from "../../../lib/cn";
import { copyText } from "../../../lib/clipboard";
import { downloadBlob, downloadUrl } from "../../../lib/files";
import type { ApiClient } from "../../../lib/api-client";
import { useAppStore } from "../../../store/app";
import { Button, ContextMenu, type ContextMenuItem } from "../../ui";
import { Badge, EmptyState, Notice } from "../../settings/primitives";
import { SystemUnsupported } from "../SystemResources";
import { barWidth, formatBytes, formatDuration } from "../system-format";
import { StorageDeleteDialog, StorageRenameDialog } from "./StorageDialogs";
import { StorageList } from "./StorageList";
import { StorageTreemap } from "./StorageTreemap";
import { parseStorageStatus, subscribeStorageStatus } from "./storage-status";
import {
  errorStatus,
  errorText,
  isInside,
  parentWithin,
  rebase,
  relativeToVolume,
  storageErrorCode
} from "./storage-paths";

/** One cached subtree per (volume, path); `path` null = the volume root. */
const treeKey = (volume: string, path: string | null) => `${volume}\u0000${path ?? ""}`;

/** "6h 12m ago" / "in 5h 3m" from an ISO time; "just now" under a minute. */
function relativeTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const seconds = (now - at) / 1000;
  if (Math.abs(seconds) < 60) return "just now";
  return seconds > 0 ? `${formatDuration(seconds)} ago` : `in ${formatDuration(-seconds)}`;
}

const absolute = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
};

/**
 * Identifies one state of a saved scan, or null without one. A delete/rename
 * edits the summary but keeps `finishedAt`, so the totals are part of it.
 */
function scanFingerprint(scan: StorageScanSummary | null): string | null {
  if (!scan) return null;
  return [scan.finishedAt, scan.scannedBytes, scan.apparentBytes, scan.items, scan.unreadableDirs, scan.usedBytesAtScan].join("|");
}

/** The volume shown first: one with a saved scan, else the first one. */
function defaultVolume(volumes: StorageVolume[]): StorageVolume | null {
  return volumes.find((v) => v.lastScan !== null) ?? volumes[0] ?? null;
}

async function downloadNode(api: ApiClient, node: StorageNode): Promise<void> {
  const filename = node.kind === "dir" ? `${node.name}.zip` : node.name;
  const url = api.buildStorageDownloadUrl(node.path);
  if (url) {
    downloadUrl(url, filename);
    return;
  }
  const bytes = await api.downloadStorageBytes(node.path);
  downloadBlob(filename, new Blob([bytes], { type: node.kind === "dir" ? "application/zip" : "application/octet-stream" }));
}

/** Leave Settings for the project's Files tab, opened at `node` (a folder expands, a file opens). */
function openInFiles(node: StorageNode): void {
  const project = node.project;
  if (!project) return;
  const store = useAppStore.getState();
  const known = store.projects.find((p) => p.path === project.projectPath) ?? {
    name: project.project,
    workspace: project.workspace,
    path: project.projectPath
  };
  store.openProject(known);
  if (node.path === project.projectPath) store.openFileBrowser();
  else store.revealInFileBrowser(node.path);
  store.setSettingsOpen(false);
}

const VolumeChip: React.FC<{ volume: StorageVolume; active: boolean; onSelect: () => void }> = ({
  volume,
  active,
  onSelect
}) => {
  const share = volume.totalBytes && volume.usedBytes !== null ? (volume.usedBytes / volume.totalBytes) * 100 : null;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      title={`${volume.device} · ${volume.fsType}`}
      className={cn(
        "flex min-w-[9rem] flex-col gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        active ? "border-neutral-500 bg-neutral-800/70" : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm text-neutral-200">
        <HardDrive size={13} className="text-neutral-500" />
        <span className="truncate font-mono text-xs">{volume.mountPoint}</span>
      </span>
      <span className="text-[11px] tabular-nums text-neutral-500">
        {formatBytes(volume.usedBytes)} / {formatBytes(volume.totalBytes)}
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
        <span
          className={cn("block h-full rounded-full", share !== null && share >= 90 ? "bg-danger" : "bg-neutral-400")}
          style={{ width: barWidth(share) }}
        />
      </span>
    </button>
  );
};

/** Elapsed vs the previous scan's duration (gdu reports no live progress); indeterminate without one. */
const ScanProgress: React.FC<{ scan: Extract<StorageStatusResponse["scan"], { state: "scanning" }>; now: number }> = ({
  scan,
  now
}) => {
  const elapsedMs = Math.max(0, now - Date.parse(scan.startedAt));
  const expected = scan.expectedDurationMs;
  const percent = expected ? Math.min(99, (elapsedMs / expected) * 100) : null;
  return (
    <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-neutral-300">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
          Scanning <code className="text-neutral-200">{scan.volume}</code>
          {scan.trigger === "schedule" && <Badge>Scheduled</Badge>}
        </span>
        <span className="tabular-nums text-neutral-500">
          {formatDuration(elapsedMs / 1000)}
          {expected ? ` of about ${formatDuration(expected / 1000)}` : " elapsed"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Scanning ${scan.volume}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
      >
        <div
          className={cn(
            "h-full rounded-full bg-neutral-300",
            percent === null && "w-1/3 animate-pulse motion-reduce:animate-none"
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {scan.queued.length > 0 && (
        <p className="text-[11px] text-neutral-500">
          Queued: {scan.queued.map((v) => <code key={v} className="mr-1.5 text-neutral-400">{v}</code>)}
        </p>
      )}
    </div>
  );
};

/**
 * Settings → Host status → Storage: a WizTree-style map of one volume's latest
 * scan. Not polled: the status is read once when the tab opens and then kept
 * current by `storage.changed` events; the map is read per (volume, folder)
 * and read again when that volume's scan changes or after a delete/rename.
 */
export const StorageView: React.FC = () => {
  const api = useApi();
  const isDesktop = useIsDesktop();

  const [status, setStatus] = useState<StorageStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [tree, setTree] = useState<{ key: string; data: StorageTreeResponse } | null>(null);
  const [treeError, setTreeError] = useState<{ key: string; message: string; noScan: boolean } | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map<string, StorageTreeResponse>());

  const [menu, setMenu] = useState<{ node: StorageNode; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<StorageNode | null>(null);
  const [renaming, setRenaming] = useState<StorageNode | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /**
   * Take a status (route answer or event). A volume whose saved scan changed —
   * a new scan, or a delete/rename (from any window) that edited it in place —
   * drops its cached subtrees; the tree effect, keyed on that scan, reads again.
   */
  const scanSeen = useRef(new Map<string, string | null>());
  const adoptStatus = useCallback((next: StorageStatusResponse) => {
    for (const volume of next.volumes) {
      const seen = scanFingerprint(volume.lastScan);
      const before = scanSeen.current.get(volume.id);
      if (before !== undefined && before !== seen) {
        for (const key of [...cache.current.keys()]) {
          if (key.startsWith(`${volume.id}\u0000`)) cache.current.delete(key);
        }
      }
      scanSeen.current.set(volume.id, seen);
    }
    // Pin the first pick, so a later scan of an earlier volume doesn't switch the map under the user.
    setVolumeId((current) => current ?? defaultVolume(next.volumes)?.id ?? null);
    setStatus(next);
  }, []);

  // Subscribe before reading, so an event racing the read is not lost; a read
  // answered after an event is older than it and is dropped.
  const eventSeen = useRef(false);
  const loadStatus = useCallback(() => {
    eventSeen.current = false;
    setStatusError(null);
    api.storageStatus().then(
      (raw) => {
        if (eventSeen.current) return;
        const parsed = parseStorageStatus(raw);
        if (parsed) adoptStatus(parsed);
        else setStatusError("The daemon sent a storage status this app cannot read.");
      },
      (error: unknown) => {
        // An older daemon has no such route: its 404 carries no storage code
        // (remote: NOT_FOUND; the socket: Fastify's default body).
        if (errorStatus(error) === 404 && !storageErrorCode(error)?.startsWith("STORAGE_")) setUnavailable(true);
        else setStatusError(errorText(error));
      }
    );
  }, [api, adoptStatus]);

  useEffect(() => {
    const stop = subscribeStorageStatus((next) => {
      eventSeen.current = true;
      adoptStatus(next);
    });
    loadStatus();
    return stop;
  }, [adoptStatus, loadStatus]);

  const scanning = status?.scan.state === "scanning" ? status.scan : null;
  // The local clock behind "Scanned 6h ago" and the progress bar (never a
  // daemon read): every second while a scan runs, else once a minute.
  const ticking = scanning !== null;
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [ticking]);

  const volumes = status?.volumes ?? [];
  const volume = volumes.find((v) => v.id === volumeId) ?? defaultVolume(volumes);
  const shownScan = scanFingerprint(volume?.lastScan ?? null);
  const currentKey = volume ? treeKey(volume.id, path) : null;

  useEffect(() => {
    if (!volume || shownScan === null) return undefined;
    const key = treeKey(volume.id, path);
    const cached = cache.current.get(key);
    if (cached) {
      setTree({ key, data: cached });
      setTreeError(null);
      setTreeLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setTreeLoading(true);
    api.storageTree(volume.id, path ?? undefined, undefined, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        cache.current.set(key, data);
        setTree({ key, data });
        setTreeError(null);
        setTreeLoading(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setTreeLoading(false);
        const code = storageErrorCode(error);
        // The folder is gone (deleted, renamed, or not in a newer scan): step up until one exists.
        if (code === "STORAGE_PATH_NOT_FOUND" && path !== null) {
          setPath(parentWithin(volume.id, path));
          return;
        }
        setTreeError({ key, message: errorText(error), noScan: code === "STORAGE_NO_SCAN" });
      }
    );
    return () => controller.abort();
    // `volume` is read through its id; a new status object for the same volume must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, volume?.id, path, shownScan, revision]);

  const navigate = (target: string) => {
    if (!volume) return;
    setPath(target === volume.id ? null : target);
  };

  const selectVolume = (id: string) => {
    setVolumeId(id);
    setPath(null);
  };

  const startScan = async (target: string) => {
    setActionError(null);
    try {
      const next = parseStorageStatus(await api.startStorageScan({ volume: target }));
      if (next) adoptStatus(next);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const cancelScan = async () => {
    setActionError(null);
    try {
      const next = parseStorageStatus(await api.cancelStorageScan());
      if (next) adoptStatus(next);
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  /** After a delete or rename: every cached subtree may hold the old entry. */
  const reloadTree = () => {
    cache.current.clear();
    setRevision((r) => r + 1);
  };

  const onDeleted = (node: StorageNode, freedBytes: number) => {
    setDeleting(null);
    setDone(`Deleted ${node.path} — freed ${formatBytes(freedBytes)}.`);
    if (volume && path !== null && isInside(node.path, path)) setPath(parentWithin(volume.id, node.path));
    reloadTree();
  };

  const onRenamed = (node: StorageNode, newPath: string) => {
    setRenaming(null);
    setDone(`Renamed ${node.path} to ${newPath}.`);
    if (path !== null) setPath(rebase(path, node.path, newPath));
    reloadTree();
  };

  if (unavailable) {
    return (
      <EmptyState
        className="rounded-xl border border-dashed border-neutral-800"
        icon={<ServerOff size={18} />}
        title="This daemon does not report host storage"
        description={
          <>
            It predates the <code className="text-neutral-400">/api/system/storage</code> routes — update it to see what
            fills each disk here.
          </>
        }
      />
    );
  }

  if (!status) {
    return statusError ? (
      <Notice
        tone="danger"
        title="Could not read host storage"
        action={
          <Button size="sm" variant="outline" onClick={loadStatus}>
            Retry
          </Button>
        }
      >
        <p className="break-words">{statusError}</p>
      </Notice>
    ) : (
      <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-xs text-neutral-500">
        <Loader2 size={13} className="animate-spin" />
        Reading host storage…
      </div>
    );
  }

  if (!status.supported) {
    return <SystemUnsupported what="Storage" />;
  }

  if (!status.scanner.installed) {
    return (
      <EmptyState
        className="rounded-xl border border-dashed border-neutral-800"
        icon={<ScanSearch size={18} />}
        title="The disk scanner is not installed"
        description={
          <>
            Storage maps are built by <code className="text-neutral-400">gdu</code>. Install it on the server with{" "}
            <code className="text-neutral-400">sudo bash deploy/install-gdu.sh</code>, or run the deploy, which installs
            it.
          </>
        }
      />
    );
  }

  if (!volume) {
    return (
      <EmptyState
        className="rounded-xl border border-dashed border-neutral-800"
        icon={<HardDrive size={18} />}
        title="No local filesystems to scan"
      />
    );
  }

  const lastScan = volume.lastScan;
  const scanningThis = scanning?.volume === volume.id;
  const shown = tree && tree.data.volume === volume.id ? tree.data : null;
  const stale = shown !== null && tree?.key !== currentKey;
  const errorHere = treeError && treeError.key === currentKey ? treeError : null;

  const menuItems = (node: StorageNode): ContextMenuItem[] => {
    // Synthetic blocks ("smaller", "other", "unaccounted") stand for their folder: only its path.
    if (node.kind !== "dir" && node.kind !== "file") {
      return [{ label: "Copy Folder Path", icon: <ClipboardCopy size={14} />, onClick: () => void copyText(node.path) }];
    }
    const actions = node.actions;
    const refused = (reason: string | null | undefined) =>
      actions ? (reason ? { disabled: true, description: reason } : {}) : { disabled: true, description: "Not available" };
    const items: ContextMenuItem[] = [];
    if (node.kind === "dir") {
      items.push({
        label: "Open",
        icon: <FolderOpen size={14} />,
        onClick: () => navigate(node.path),
        ...(node.hasChildren ? {} : { disabled: true, description: "Empty in the saved scan" })
      });
    }
    if (node.project) {
      items.push({ label: "Open in Files", icon: <FolderTree size={14} />, onClick: () => openInFiles(node) });
    }
    items.push(
      {
        label: node.kind === "dir" ? "Download as Zip" : "Download",
        icon: node.kind === "dir" ? <FolderDown size={14} /> : <Download size={14} />,
        onClick: () => void downloadNode(api, node).catch((error: unknown) => setActionError(errorText(error))),
        ...refused(actions?.download)
      },
      {
        label: "Copy Relative Path",
        icon: <Copy size={14} />,
        onClick: () => void copyText(relativeToVolume(volume.id, node.path))
      },
      { label: "Copy Full Path", icon: <ClipboardCopy size={14} />, onClick: () => void copyText(node.path) },
      { label: "Rename", icon: <Pencil size={14} />, onClick: () => setRenaming(node), ...refused(actions?.rename) },
      {
        label: "Delete",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => setDeleting(node),
        ...refused(actions?.delete)
      }
    );
    return items;
  };

  const mapProps = shown
    ? {
        root: shown.root,
        onOpen: (node: StorageNode) => {
          if (node.kind === "dir" && node.hasChildren) navigate(node.path);
        },
        onContextMenu: (node: StorageNode, at: { x: number; y: number }) => setMenu({ node, x: at.x, y: at.y })
      }
    : null;

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Volumes" className="flex flex-wrap gap-2">
        {volumes.map((v) => (
          <VolumeChip key={v.id} volume={v} active={v.id === volume.id} onSelect={() => selectVolume(v.id)} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          {lastScan ? (
            <span title={`Finished ${absolute(lastScan.finishedAt)} · gdu ${lastScan.scannerVersion}`}>
              Scanned {relativeTime(lastScan.finishedAt, now)} · took {formatDuration(lastScan.durationMs / 1000)}
            </span>
          ) : (
            <span>Not scanned yet</span>
          )}
          {status.nextScheduledAt && (
            <span title={absolute(status.nextScheduledAt)}>Next scan {relativeTime(status.nextScheduledAt, now)}</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {scanning && (
            <Button size="sm" variant="outline" onClick={() => void cancelScan()}>
              <X size={13} />
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={scanning !== null}
            title={scanning ? "One scan runs at a time" : `Scan ${volume.mountPoint} now`}
            onClick={() => void startScan(volume.id)}
          >
            <ScanSearch size={13} />
            Scan now
          </Button>
        </div>
      </div>

      {scanning && <ScanProgress scan={scanning} now={now} />}

      {status.lastError && (
        <Notice
          tone="danger"
          title={
            <>
              The scan of <code>{status.lastError.volume}</code> failed
            </>
          }
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={scanning !== null}
              onClick={() => void startScan(status.lastError!.volume)}
            >
              Retry
            </Button>
          }
        >
          <p className="break-words">{status.lastError.message}</p>
          <p className="text-neutral-500" title={absolute(status.lastError.at)}>
            {relativeTime(status.lastError.at, now)}
          </p>
        </Notice>
      )}

      {actionError && (
        <Notice
          tone="danger"
          action={
            <button type="button" aria-label="Dismiss" onClick={() => setActionError(null)} className="text-neutral-500 hover:text-neutral-200">
              <X size={13} />
            </button>
          }
        >
          <p className="break-words">{actionError}</p>
        </Notice>
      )}

      {done && (
        <Notice
          tone="ok"
          action={
            <button type="button" aria-label="Dismiss" onClick={() => setDone(null)} className="text-neutral-500 hover:text-neutral-200">
              <X size={13} />
            </button>
          }
        >
          <p className="break-all">{done}</p>
        </Notice>
      )}

      {!lastScan || errorHere?.noScan ? (
        <EmptyState
          className="rounded-xl border border-dashed border-neutral-800"
          icon={scanningThis ? <Loader2 size={18} className="animate-spin" /> : <HardDrive size={18} />}
          title={
            scanningThis ? (
              <>
                Scanning <code>{volume.mountPoint}</code> for the first time…
              </>
            ) : (
              <>
                <code>{volume.mountPoint}</code> has not been scanned yet
              </>
            )
          }
          description="A scan reads every folder on the volume to map what takes the space. Large disks can take several minutes."
          action={
            scanningThis ? undefined : (
              <Button disabled={scanning !== null} onClick={() => void startScan(volume.id)}>
                <ScanSearch size={14} />
                Scan now
              </Button>
            )
          }
        />
      ) : errorHere ? (
        <Notice
          tone="danger"
          title="Could not read the scan"
          action={
            <Button size="sm" variant="outline" onClick={reloadTree}>
              Retry
            </Button>
          }
        >
          <p className="break-words">{errorHere.message}</p>
        </Notice>
      ) : shown && mapProps ? (
        <>
          <nav aria-label="Folder path" className="flex min-w-0 items-center gap-2">
            <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-xs">
              {shown.ancestors.map((crumb) => (
                <li key={crumb.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => navigate(crumb.path)}
                    className="rounded px-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                  >
                    {crumb.name}
                  </button>
                  <ChevronRight size={12} className="text-neutral-600" />
                </li>
              ))}
              <li aria-current="page" className="px-1 text-neutral-100">
                {shown.root.name}
              </li>
            </ol>
            {(treeLoading || stale) && <Loader2 size={12} className="shrink-0 animate-spin text-neutral-500" />}
          </nav>

          <div className={cn("space-y-3", stale && "opacity-60")}>
            {isDesktop && (
              <StorageTreemap {...mapProps} className="h-[420px] w-full overflow-hidden rounded-xl border border-neutral-800" />
            )}
            <StorageList {...mapProps} className="w-full" />
          </div>

          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-800 pt-3 text-[11px] tabular-nums text-neutral-500">
            {shown.root.path !== volume.id && (
              <span>
                This folder: {formatBytes(shown.root.sizeBytes)} · {shown.root.items.toLocaleString()} items
              </span>
            )}
            <span title={`Apparent size ${formatBytes(shown.scan.apparentBytes)}`}>
              {formatBytes(shown.scan.scannedBytes)} scanned · {shown.scan.items.toLocaleString()} items
            </span>
            <span title="Used space the scan could not see: unreadable folders and other users' files">
              {formatBytes(shown.scan.unaccountedBytes)} unaccounted
            </span>
            {shown.scan.unreadableDirs > 0 && (
              <span>{shown.scan.unreadableDirs.toLocaleString()} unreadable folders</span>
            )}
          </footer>
        </>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-6 text-xs text-neutral-500">
          <Loader2 size={13} className="animate-spin" />
          Reading the map…
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />}
      <StorageDeleteDialog node={deleting} onCancel={() => setDeleting(null)} onDeleted={onDeleted} />
      <StorageRenameDialog node={renaming} onCancel={() => setRenaming(null)} onRenamed={onRenamed} />
    </div>
  );
};
