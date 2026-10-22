/**
 * Chrome and the desktop stack inside Linux boxes, installed on demand for the box Browser and
 * Desktop tabs. One installer per daemon (`createBoxGuiInstaller`); call `forget(boxId)` when a box
 * is destroyed.
 */

export {
  BoxGuiUnavailableError,
  type BoxBrowserRuntime,
  type BoxGuiFeature,
  type BoxGuiInstaller,
  type BoxGuiInstallerDeps,
  type BoxGuiProgress
} from "./types.ts";
export { CHROME_START_TIMEOUT_MS, INSTALL_TIMEOUT_MS, PROBE_TIMEOUT_MS, createBoxGuiInstaller } from "./installer.ts";
