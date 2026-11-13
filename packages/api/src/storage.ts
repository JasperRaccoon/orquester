// Host storage — a WizTree-style map of what fills each local filesystem, scanned
// by the pinned `gdu` binary in the background (nightly, or on demand) and acted
// on (delete / rename / download) behind a server-side guard that is separate
// from the /api/fs sandbox. See
// docs/superpowers/specs/2026-11-13-host-storage-treemap-design.md.
//
// Linux-only like the other /api/system routes: off Linux the status answers
// `supported: false` and every other route 501s.

export const storageRoutes = {
  /** GET → StorageStatusResponse. */
  status: "/api/system/storage",
  /** POST StorageScanRequest → StorageStatusResponse (start); DELETE → StorageStatusResponse (cancel). */
  scan: "/api/system/storage/scan",
  /** GET ?volume=&path=&depth= → StorageTreeResponse. */
  tree: "/api/system/storage/tree",
  /** POST StorageDeleteRequest → StorageDeleteResponse. */
  delete: "/api/system/storage/delete",
  /** POST StorageRenameRequest → StorageRenameResponse. */
  rename: "/api/system/storage/rename",
  /**
   * GET ?path= — streams a file, or a folder zipped on the fly, like
   * /api/fs/download (and, like it, also accepts the auth token as ?token= so a
   * native `<a download>` works).
   */
  download: "/api/system/storage/download"
} as const;

/** `/events` channel the storage service publishes on. */
export const STORAGE_EVENTS_CHANNEL = "storage";
/**
 * Event type on {@link STORAGE_EVENTS_CHANNEL}; payload is a full
 * {@link StorageStatusResponse}. Published when a scan starts, finishes, fails
 * or is cancelled, and after a delete/rename changes a saved scan.
 */
export const STORAGE_CHANGED_EVENT = "storage.changed";

/** Error codes in `{ code, message }` error bodies from the storage routes. */
export type StorageErrorCode =
  | "STORAGE_UNSUPPORTED" // 501: not Linux (or, downloading a folder, no zip tool on the server)
  | "STORAGE_SCANNER_MISSING" // 501: gdu is not installed
  | "STORAGE_UNKNOWN_VOLUME" // 404
  | "STORAGE_SCAN_RUNNING" // 409: one scan at a time, host-wide
  | "STORAGE_NO_SCAN" // 404: the volume has never been scanned (or its saved scan is unreadable)
  | "STORAGE_PATH_NOT_FOUND" // 404: path is not in the saved scan, or no longer exists on disk
  | "STORAGE_FORBIDDEN" // 403: the guard refuses this path; `message` is the reason to show
  | "STORAGE_CONFIRM_MISMATCH" // 400: delete outside the workspaces root without the right typed name
  | "STORAGE_EXISTS" // 409: rename onto a name that is already taken (like /api/fs/rename's FS_EXISTS)
  | "INVALID_REQUEST" // 400
  | "STORAGE_ERROR"; // 400: the OS refused (EACCES, EBUSY, ENOTEMPTY…); `message` is the OS's reason

/**
 * A local filesystem that can be scanned. Bind mounts of one device collapse
 * into the mount closest to `/` (so `/etc`, `/usr`, `/var` under systemd's
 * ProtectSystem are one `/` volume). The volume's id IS its mount point.
 */
export interface StorageVolume {
  /** Mount point, e.g. "/" or "/data". Used as `volume` in every request. */
  id: string;
  mountPoint: string;
  /** Mount source, e.g. "/dev/md2". */
  device: string;
  fsType: string;
  /** statfs now; null when it could not be measured. */
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  /** The latest saved scan, or null when there is none. */
  lastScan: StorageScanSummary | null;
}

export type StorageScanTrigger = "manual" | "schedule";

export interface StorageScanSummary {
  /** ISO timestamps. */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: StorageScanTrigger;
  /** gdu's version string, e.g. "v5.39.0". */
  scannerVersion: string;
  /** Disk usage (allocated blocks) of everything readable; hard links counted once. */
  scannedBytes: number;
  /** Apparent (logical) size of the same. */
  apparentBytes: number;
  /** Files + directories seen. */
  items: number;
  /** Directories gdu could not read (their contents are missing from the totals). */
  unreadableDirs: number;
  /** The volume's used bytes (statfs) when the scan finished; null when unknown. */
  usedBytesAtScan: number | null;
  /** max(0, usedBytesAtScan − scannedBytes): space the service user cannot see. */
  unaccountedBytes: number;
}

export type StorageScanState =
  | { state: "idle" }
  | {
      state: "scanning";
      volume: string;
      trigger: StorageScanTrigger;
      startedAt: string;
      /**
       * The previous scan of this volume's duration, for an elapsed-vs-expected
       * progress bar (gdu reports no live progress while exporting); null when
       * there is no previous scan.
       */
      expectedDurationMs: number | null;
      /** Volumes still queued behind this one in the same (scheduled) run. */
      queued: string[];
    };

export interface StorageStatusResponse {
  /** False off Linux; everything below is then empty. */
  supported: boolean;
  scanner: {
    installed: boolean;
    /** e.g. "v5.39.0"; null when not installed or unreadable. */
    version: string | null;
    /** Resolved binary path; null when not installed. */
    path: string | null;
  };
  volumes: StorageVolume[];
  scan: StorageScanState;
  /** The most recent failed scan (cleared by the next successful scan of that volume). */
  lastError: { volume: string; message: string; at: string } | null;
  /** When the next scheduled scan runs (ISO), or null when none is scheduled. */
  nextScheduledAt: string | null;
}

export interface StorageScanRequest {
  volume: string;
}

/**
 * - `dir` / `file`: a real entry (`file` also covers symlinks, sockets and other
 *   non-directories).
 * - `smaller`: synthetic — the entries of one directory too small to keep in the
 *   saved scan, folded together (`items` counts everything inside them, like a
 *   folder's). Path = the parent's.
 * - `other`: synthetic — children folded together by the tree query because
 *   they are too small to draw at this zoom (`items` counts everything inside
 *   them; the name counts the folded entries). Path = the parent's.
 * - `unaccounted`: synthetic, only a child of the volume root — used space the
 *   scan could not see (unreadable dirs, other users' files, systemd's hidden
 *   /home and /root). Path = the volume root.
 */
export type StorageNodeKind = "dir" | "file" | "smaller" | "other" | "unaccounted";

/** Per action: null = allowed, otherwise the reason it is refused (shown to the user). */
export interface StorageNodeActions {
  delete: string | null;
  rename: string | null;
  download: string | null;
  /** Delete needs the entry's name typed back (outside the workspaces root). */
  confirmDelete: boolean;
}

export interface StorageNode {
  /** Basename; for the volume root, the mount point. Synthetic nodes get a display label. */
  name: string;
  /** Absolute path (synthetic nodes: see {@link StorageNodeKind}). */
  path: string;
  kind: StorageNodeKind;
  /** Disk usage in bytes (what deleting frees, modulo hard links elsewhere). */
  sizeBytes: number;
  apparentBytes: number;
  /** Entries under a dir (recursive), or folded entries for `smaller`/`other`. */
  items: number;
  /** A dir gdu could not (fully) read. */
  unreadable?: boolean;
  /**
   * Present on a `dir` within the requested depth (sorted by sizeBytes desc);
   * absent beyond it — fetch the subtree with `path` to see more.
   */
  children?: StorageNode[];
  /** True when the dir has children in the saved scan (whether or not they were returned). */
  hasChildren: boolean;
  /** Only on `dir` and `file` nodes. */
  actions?: StorageNodeActions;
  /** Set when the path is inside a project (`<workspacesRoot>/<workspace>/<project>/…`). */
  project?: { workspace: string; project: string; projectPath: string };
}

export interface StorageTreeResponse {
  volume: string;
  scan: StorageScanSummary;
  /** The requested subtree; `root.path` = the requested path (default: the volume root). */
  root: StorageNode;
  /** Breadcrumb from the volume root down to (excluding) `root`. */
  ancestors: Array<{ name: string; path: string }>;
}

/** Defaults/limits for `depth` on the tree route. */
export const STORAGE_TREE_DEFAULT_DEPTH = 3;
export const STORAGE_TREE_MAX_DEPTH = 6;

export interface StorageDeleteRequest {
  path: string;
  /** The entry's basename, required when the node's `actions.confirmDelete` is true. */
  confirm?: string;
}

export interface StorageDeleteResponse {
  ok: true;
  /** The size the saved scan had for it (0 when it wasn't in the scan). */
  freedBytes: number;
}

export interface StorageRenameRequest {
  path: string;
  /** A single path segment (no "/", not "." or ".."). */
  newName: string;
}

export interface StorageRenameResponse {
  ok: true;
  /** The new absolute path. */
  path: string;
}
