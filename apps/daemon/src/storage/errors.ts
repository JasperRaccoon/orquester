import type { StorageErrorCode } from "@orquester/api";

/** A refusal the storage routes turn into `{ code, message }` with `status`. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export const storageErrors = {
  unsupported: () => new StorageError("STORAGE_UNSUPPORTED", "Storage scans are only available on Linux hosts.", 501),
  scannerMissing: () =>
    new StorageError(
      "STORAGE_SCANNER_MISSING",
      "The gdu scanner is not installed on the server (run the deploy, or `sudo bash deploy/install-gdu.sh`).",
      501
    ),
  unknownVolume: (volume: string) => new StorageError("STORAGE_UNKNOWN_VOLUME", `${volume} is not a scannable volume.`, 404),
  running: (volume: string) => new StorageError("STORAGE_SCAN_RUNNING", `A scan of ${volume} is already running.`, 409),
  noScan: (volume: string) => new StorageError("STORAGE_NO_SCAN", `${volume} has not been scanned yet.`, 404),
  pathNotFound: (path: string) => new StorageError("STORAGE_PATH_NOT_FOUND", `${path} is not in the saved scan.`, 404),
  invalid: (message: string) => new StorageError("INVALID_REQUEST", message, 400),
  os: (message: string) => new StorageError("STORAGE_ERROR", message, 400)
};
