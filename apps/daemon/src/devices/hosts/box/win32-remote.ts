/**
 * What a Windows Android device host runs and decides on its machine (constants and pure functions;
 * the host is `win32-android-host.ts`, the executor `win32-executor.ts`). Tailnet machines spec
 * §4.4 item 3: the owner's own Windows machine (a mini PC with a Radeon iGPU) hosts Android
 * emulators accelerated by the Windows Hypervisor Platform (WHPX).
 *
 * - **Toolchain:** pinned Windows archives (official URLs, SHA-256 checked there before use) of
 *   Node, a Temurin JRE (no installer, no administrator), platform-tools, the emulator,
 *   cmdline-tools (avdmanager) and the x86_64 `google_apis` system image, unpacked under
 *   `<profile>\.orquester\devices` of the signed-in user. ffmpeg is not needed: the hub streams
 *   through scrcpy, which encodes on the device.
 * - **PowerShell:** every script is constant text run with `-EncodedCommand` (UTF-16LE base64) and
 *   `-ExecutionPolicy Bypass`; values reach it as `ORQ_*` environment variables, never spliced into
 *   the script, so no quoting or codepage can change what runs. Each prints one JSON line with every
 *   character above `~` escaped as `\uXXXX` (the console's codepage cannot garble it).
 * - **GPU:** the modes a golden snapshot tries, in order: `-gpu host` (the GPU's OpenGL driver) in
 *   the interactive desktop session through orq-agent's desktop-session helper — only while the box
 *   advertises `desktop-session` —, `-gpu angle_indirect` (Direct3D 11 through ANGLE) from the
 *   service session, then software (`swiftshader_indirect`). A hardware mode whose boot renders in
 *   software fails, and is remembered for that GPU, driver and emulator (later goldens skip it).
 * - **Capacity:** from free RAM (each emulator gets 1536 MB of guest RAM), CPUs and disk.
 */

import { posix } from "node:path";

import type { DeviceCapacityBasis, MachineProblem } from "@orquester/api";

import { localCapacity } from "../../android/capacity.ts";
import { type AndroidLayout, buildAndroidEnv } from "../../android/env.ts";
import type { PinnedDownload } from "../../toolchain/download.ts";

// ---------------------------------------------------------------------------
// Paths and command lines
// ---------------------------------------------------------------------------

/** `C:/Users/x` or `C:\Users\x`: an absolute Windows path with a drive. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Host-side paths of a Windows box use `/` (`node:path` joins them on this machine); Windows
 * programs get `\`. A value that is not a drive path (a flag, a name, a URL) is unchanged; a value
 * that starts with one (a path, or a `;`-separated PATH) has every `/` turned into `\`.
 */
export function toWindowsPath(value: string): string {
  return DRIVE_PATH.test(value) ? value.replace(/\//g, "\\") : value;
}

/** A path Windows reported (`C:\Users\x`), spelled the way this host's code joins it (`C:/Users/x`). */
export function fromWindowsPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * One argument quoted for a Windows command line, the way `CommandLineToArgvW` and the MSVC runtime
 * split it back: bare when it has no space, tab or quote; else in quotes, with backslashes doubled
 * before a quote or the closing quote and each quote escaped.
 */
export function windowsQuoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** The arguments of a program as one Windows command line tail (`Start-Process -ArgumentList`). */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map(windowsQuoteArg).join(" ");
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

/**
 * Before every script: stop on cmdlet errors, no progress records (they arrive as CLIXML on
 * stderr), `Write-OrqJson` (one ASCII JSON line), `Invoke-Native` (a program's exit code and
 * output; its stderr is not turned into a terminating error).
 */
export const POWERSHELL_PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Write-OrqJson($value) {
  $json = ConvertTo-Json -InputObject $value -Compress -Depth 8
  if ($json -match '[^\x00-\x7e]') {
    $out = New-Object System.Text.StringBuilder
    foreach ($c in $json.ToCharArray()) {
      if ([int]$c -gt 126) { [void]$out.AppendFormat('\u{0:x4}', [int]$c) } else { [void]$out.Append($c) }
    }
    $json = $out.ToString()
  }
  Write-Output $json
}
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $exe @arguments 2>&1 | ForEach-Object { "$_" }) -join [char]10
    return @{ exitCode = $LASTEXITCODE; output = [string]$text }
  } finally {
    $ErrorActionPreference = $saved
  }
}
`;

/** `powershell.exe` and its arguments for `script` (constant text; values travel as `ORQ_*` env). */
export function powershellCommand(script: string): { command: string; args: string[] } {
  const encoded = Buffer.from(`${POWERSHELL_PRELUDE}${script}`, "utf16le").toString("base64");
  return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded] };
}

/** The last JSON object line a script printed (PowerShell may add other lines), or null. */
export function parsePowerShellJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // not the line we want
    }
  }
  return null;
}

/**
 * The probe: who orq-agent runs as, the user profile the device root lives in (orq-agent's own, or
 * — as the LocalSystem service — the console user's, else the most recently used one), memory,
 * CPUs, disk under the root, Windows Hypervisor Platform and whether the hypervisor runs, the
 * GPUs, the desktop sessions (an `explorer.exe` outside session 0), what of the toolchain is
 * there, and `emulator -accel-check` once the emulator is. No secrets.
 */
export const WIN_PROBE_SCRIPT = String.raw`$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$service = @('S-1-5-18', 'S-1-5-19', 'S-1-5-20') -contains $sid
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$feature = Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'"
$console = [string]$cs.UserName
$profilePath = $null
$profileSource = $null
if (-not $service) {
  $profilePath = $env:USERPROFILE
  $profileSource = 'self'
} else {
  if ($console) {
    try {
      $consoleSid = (New-Object Security.Principal.NTAccount($console)).Translate([Security.Principal.SecurityIdentifier]).Value
      $entry = Get-CimInstance Win32_UserProfile -Filter "SID='$consoleSid'"
      if ($entry -and $entry.LocalPath) { $profilePath = [string]$entry.LocalPath; $profileSource = 'console' }
    } catch { }
  }
  if (-not $profilePath) {
    $entry = Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } | Sort-Object LastUseTime -Descending | Select-Object -First 1
    if ($entry) { $profilePath = [string]$entry.LocalPath; $profileSource = 'recent' }
  }
}
$root = $null
if ($profilePath) { $root = Join-Path $profilePath '.orquester\devices' }
$base = $root
if (-not $base) { $base = $env:SystemDrive + '\' }
$drive = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + (Split-Path -Qualifier $base) + "'")
$sessions = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object { [int]$_.SessionId } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = [string]$_.Name; driver = [string]$_.DriverVersion; status = [string]$_.Status } })
$node = $null
$java = $false
$accel = $null
if ($root) {
  $nodeExe = Join-Path $root 'node\node.exe'
  if (Test-Path -LiteralPath $nodeExe) { $node = @{ path = $nodeExe; version = (Invoke-Native $nodeExe @('--version')).output.Trim() } }
  $java = Test-Path -LiteralPath (Join-Path $root 'jre\bin\java.exe')
  $emulator = Join-Path $root 'android-sdk\emulator\emulator.exe'
  if (Test-Path -LiteralPath $emulator) { $accel = Invoke-Native $emulator @('-accel-check') }
}
$firmware = $null
if ($cpu -and $null -ne $cpu.VirtualizationFirmwareEnabled) { $firmware = [bool]$cpu.VirtualizationFirmwareEnabled }
$hvp = $null
if ($feature) { $hvp = [int]$feature.InstallState }
Write-OrqJson @{
  os = 'win32'
  caption = [string]$os.Caption
  build = [string]$os.BuildNumber
  user = [string]$identity.Name
  service = $service
  consoleUser = $console
  desktopSessions = $sessions
  profile = $profilePath
  profileSource = $profileSource
  root = $root
  cpus = [int]$cs.NumberOfLogicalProcessors
  totalMemBytes = [int64]$cs.TotalPhysicalMemory
  freeMemBytes = [int64]$os.FreePhysicalMemory * 1024
  diskFreeBytes = $(if ($drive) { [int64]$drive.FreeSpace } else { $null })
  hypervisorPlatform = $hvp
  hypervisorPresent = [bool]$cs.HypervisorPresent
  firmwareVirtualization = $firmware
  gpus = $gpus
  path = [string]$env:Path
  node = $node
  java = $java
  accel = $accel
}
`;

/**
 * A pinned archive into place: `ORQ_URL` downloaded (curl.exe, else Invoke-WebRequest) to
 * `ORQ_ZIP` unless it is there with SHA-256 `ORQ_SHA256`, checked, unpacked (tar.exe, else
 * Expand-Archive) into a staging dir, its `ORQ_INNER` dir (which must hold `ORQ_CHECK`) moved to
 * `ORQ_DEST`, the pin recorded in `ORQ_DEST\.orq-pin`, the archive removed. Already there with
 * that pin: nothing to do. Prints `{ok, cached}` or `{ok: false, error}` (the exit code says nothing).
 */
export const WIN_INSTALL_ARCHIVE_SCRIPT = String.raw`try {
  $sha = $env:ORQ_SHA256.ToLowerInvariant()
  $zip = $env:ORQ_ZIP
  $dest = $env:ORQ_DEST
  $pin = Join-Path $dest '.orq-pin'
  if ((Test-Path -LiteralPath $pin) -and ((Get-Content -LiteralPath $pin -Raw).Trim() -eq $sha) -and (Test-Path -LiteralPath (Join-Path $dest $env:ORQ_CHECK))) {
    Write-OrqJson @{ ok = $true; cached = $true }
  } else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $zip) | Out-Null
  $pinned = { param($file) (Test-Path -LiteralPath $file) -and ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $sha) }
  if (-not (& $pinned $zip)) {
    $part = $zip + '.part'
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
      $run = Invoke-Native $curl @('-fsSL', '--retry', '3', '-o', $part, $env:ORQ_URL)
      if ($run.exitCode -ne 0) { throw ('downloading ' + $env:ORQ_URL + ' failed (curl exit ' + $run.exitCode + '): ' + $run.output.Trim()) }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $env:ORQ_URL -OutFile $part
    }
    if (-not (& $pinned $part)) {
      Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
      throw ('the download of ' + $env:ORQ_URL + ' did not match its pinned checksum')
    }
    Move-Item -LiteralPath $part -Destination $zip -Force
  }
  $staging = $dest + '.staging'
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path -LiteralPath $tar) {
    $run = Invoke-Native $tar @('-xf', $zip, '-C', $staging)
    if ($run.exitCode -ne 0) { throw ('unpacking ' + $zip + ' failed: ' + $run.output.Trim()) }
  } else {
    Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
  }
  $unpacked = Join-Path $staging $env:ORQ_INNER
  if (-not (Test-Path -LiteralPath (Join-Path $unpacked $env:ORQ_CHECK))) { throw ('the archive has no ' + $env:ORQ_INNER + '\' + $env:ORQ_CHECK) }
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Move-Item -LiteralPath $unpacked -Destination $dest
  Remove-Item -LiteralPath $staging -Recurse -Force
  Set-Content -LiteralPath $pin -Value $sha -Encoding Ascii
  Remove-Item -LiteralPath $zip -Force
  Write-OrqJson @{ ok = $true; cached = $false }
  }
} catch {
  Write-OrqJson @{ ok = $false; error = $_.Exception.Message }
}
`;

/** A pinned file to `ORQ_DEST` unless it is there with SHA-256 `ORQ_SHA256` (scrcpy-server). Prints `{ok}` or `{ok: false, error}`. */
export const WIN_DOWNLOAD_SCRIPT = String.raw`try {
  $sha = $env:ORQ_SHA256.ToLowerInvariant()
  $dest = $env:ORQ_DEST
  $pinned = { param($file) (Test-Path -LiteralPath $file) -and ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $sha) }
  if (-not (& $pinned $dest)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $part = $dest + '.part'
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
      $run = Invoke-Native $curl @('-fsSL', '--retry', '3', '-o', $part, $env:ORQ_URL)
      if ($run.exitCode -ne 0) { throw ('downloading ' + $env:ORQ_URL + ' failed (curl exit ' + $run.exitCode + ')') }
    } else {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $env:ORQ_URL -OutFile $part
    }
    if (-not (& $pinned $part)) {
      Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
      throw ('the download of ' + $env:ORQ_URL + ' did not match its pinned checksum')
    }
    Move-Item -LiteralPath $part -Destination $dest -Force
  }
  Write-OrqJson @{ ok = $true }
} catch {
  Write-OrqJson @{ ok = $false; error = $_.Exception.Message }
}
`;

/**
 * Start `ORQ_EXE` with the command line tail `ORQ_ARGS` detached (`Start-Process`: no window, its
 * own process outside this script; orq-agent lets it outlive the exec), stdout to `ORQ_LOG` and
 * stderr to `ORQ_LOG.err` (Start-Process cannot send both to one file), in `ORQ_CWD` when set; the
 * `ORQ_*` variables are dropped first so the program does not inherit them. Prints `{pid}`.
 */
export const WIN_DETACH_SCRIPT = String.raw`$exe = $env:ORQ_EXE
$argumentLine = $env:ORQ_ARGS
$log = $env:ORQ_LOG
$cwd = $env:ORQ_CWD
foreach ($name in @('ORQ_EXE', 'ORQ_ARGS', 'ORQ_LOG', 'ORQ_CWD')) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
$start = @{ FilePath = $exe; PassThru = $true; WindowStyle = 'Hidden'; RedirectStandardOutput = $log; RedirectStandardError = ($log + '.err') }
if ($argumentLine) { $start['ArgumentList'] = $argumentLine }
if ($cwd) { $start['WorkingDirectory'] = $cwd }
$process = Start-Process @start
Write-OrqJson @{ pid = [int]$process.Id }
`;

/**
 * Processes: one (`ORQ_PID`, with its command line) or all. Each row is
 * `[pid, parentPid, name, startedMs, cpu100ns, executablePath, commandLine]` (`cpu100ns`: kernel +
 * user time in 100 ns units; `startedMs`: the creation time in Unix milliseconds).
 */
export const WIN_PROCESSES_SCRIPT = String.raw`$one = [bool]$env:ORQ_PID
if ($one) { $list = @(Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:ORQ_PID)) } else { $list = @(Get-CimInstance Win32_Process) }
$rows = @($list | ForEach-Object {
  $started = 0
  if ($_.CreationDate) { $started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
  $line = $null
  if ($one) { $line = [string]$_.CommandLine }
  ,@([int]$_.ProcessId, [int]$_.ParentProcessId, [string]$_.Name, [int64]$started, ([int64]$_.KernelModeTime + [int64]$_.UserModeTime), [string]$_.ExecutablePath, $line)
})
Write-OrqJson @{ processes = $rows }
`;

/** Listening and established TCP sockets: rows `[localAddress, localPort, remoteAddress, remotePort, state]`. */
export const WIN_TCP_SCRIPT = String.raw`$rows = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' -or $_.State -eq 'Established' } | ForEach-Object { ,@([string]$_.LocalAddress, [int]$_.LocalPort, [string]$_.RemoteAddress, [int]$_.RemotePort, [string]$_.State) })
Write-OrqJson @{ sockets = $rows }
`;

/** Available physical memory (what Task Manager calls Available), in bytes. */
export const WIN_MEMORY_SCRIPT = String.raw`Write-OrqJson @{ freeMemBytes = [int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024 }
`;

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface WindowsGpuAdapter {
  name: string;
  driver: string;
  status: string;
}

/** `emulator -accel-check`: `accel:` / status (0 = usable) / message lines / `accel`. */
export interface AccelCheck {
  status: number | null;
  message: string;
  /** The hypervisor it names. */
  hypervisor: "whpx" | "aehd" | "haxm" | "kvm" | null;
}

export interface WindowsAndroidProbe {
  caption: string;
  build: string;
  /** `MACHINE\user` orq-agent runs as. */
  user: string;
  /** orq-agent runs as a service account (LocalSystem): the device root is a user's profile. */
  service: boolean;
  /** `MACHINE\user` signed in at the console; null when nobody is. */
  consoleUser: string | null;
  /** Sessions with a desktop (`explorer.exe`), session 0 excluded. */
  desktopSessions: number[];
  profile: string | null;
  profileSource: "self" | "console" | "recent" | null;
  /** The device root (`<profile>\.orquester\devices`, `/` separators here); null without a profile. */
  root: string | null;
  cpus: number;
  totalMemBytes: number | null;
  freeMemBytes: number | null;
  diskFreeBytes: number | null;
  /** Win32_OptionalFeature InstallState of HypervisorPlatform: 1 enabled, 2 disabled, 3 absent; null unknown. */
  hypervisorPlatform: number | null;
  hypervisorPresent: boolean;
  firmwareVirtualization: boolean | null;
  gpus: WindowsGpuAdapter[];
  /** The PATH processes get there (`;`-separated, Windows spelling). */
  path: string;
  node: { path: string; version: string; major: number | null } | null;
  java: boolean;
  /** Null until the emulator is installed. */
  accel: AccelCheck | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** `emulator -accel-check` output. */
export function parseAccelCheck(output: string): AccelCheck {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const start = lines.indexOf("accel:");
  const end = start >= 0 ? lines.indexOf("accel", start + 1) : -1;
  const body = start >= 0 ? lines.slice(start + 1, end > start ? end : undefined) : lines;
  const status = start >= 0 && /^\d+$/.test(body[0] ?? "") ? Number(body[0]) : null;
  const message = (status !== null ? body.slice(1) : body).filter(Boolean).join(" ");
  const hypervisor = /\bWHPX\b/i.test(message) ? "whpx" : /\b(AEHD|GVM)\b/i.test(message) ? "aehd" : /\bHAXM\b/i.test(message) ? "haxm" : /\bKVM\b/.test(message) ? "kvm" : null;
  return { status, message, hypervisor };
}

/** The probe's JSON line; throws when it is not one. */
export function parseWindowsProbe(stdout: string): WindowsAndroidProbe {
  const value = parsePowerShellJson(stdout);
  if (!value || value.os !== "win32") throw new Error("the Windows probe printed no result");
  const node = value.node !== null && typeof value.node === "object" ? (value.node as Record<string, unknown>) : null;
  const nodePath = str(node?.path);
  const nodeVersion = str(node?.version);
  const accel = value.accel !== null && typeof value.accel === "object" ? (value.accel as Record<string, unknown>) : null;
  const sessions = Array.isArray(value.desktopSessions) ? value.desktopSessions : typeof value.desktopSessions === "number" ? [value.desktopSessions] : [];
  const gpus = (Array.isArray(value.gpus) ? value.gpus : value.gpus && typeof value.gpus === "object" ? [value.gpus] : []).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const gpu = entry as Record<string, unknown>;
    const name = str(gpu.name);
    return name ? [{ name, driver: str(gpu.driver) ?? "", status: str(gpu.status) ?? "" }] : [];
  });
  const root = str(value.root);
  const source = value.profileSource;
  const major = nodeVersion ? Number(/^v?(\d+)\./.exec(nodeVersion)?.[1]) : NaN;
  return {
    caption: str(value.caption) ?? "Windows",
    build: str(value.build) ?? "",
    user: str(value.user) ?? "",
    service: value.service === true,
    consoleUser: str(value.consoleUser),
    desktopSessions: sessions.filter((entry: unknown): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry > 0),
    profile: str(value.profile),
    profileSource: source === "self" || source === "console" || source === "recent" ? source : null,
    root: root ? fromWindowsPath(root) : null,
    cpus: Math.max(1, num(value.cpus) ?? 1),
    totalMemBytes: num(value.totalMemBytes),
    freeMemBytes: num(value.freeMemBytes),
    diskFreeBytes: num(value.diskFreeBytes),
    hypervisorPlatform: num(value.hypervisorPlatform),
    hypervisorPresent: value.hypervisorPresent === true,
    firmwareVirtualization: typeof value.firmwareVirtualization === "boolean" ? value.firmwareVirtualization : null,
    gpus,
    path: str(value.path) ?? "C:\\Windows\\System32;C:\\Windows",
    node: nodePath && nodeVersion ? { path: fromWindowsPath(nodePath), version: nodeVersion, major: Number.isFinite(major) ? major : null } : null,
    java: value.java === true,
    accel: accel ? parseAccelCheck(typeof accel.output === "string" ? accel.output : "") : null
  };
}

/** Whether emulators get WHPX now: the feature on and the hypervisor running (and the emulator agreeing, once it is installed). */
export function whpxReady(probe: Pick<WindowsAndroidProbe, "hypervisorPlatform" | "hypervisorPresent" | "accel">): boolean {
  if (probe.hypervisorPlatform !== 1 || !probe.hypervisorPresent) return false;
  return probe.accel === null || probe.accel.status === 0;
}

/** Whose profile the device root is in (the account orq-agent runs as, or the profile's folder name). */
function profileOwner(probe: Pick<WindowsAndroidProbe, "service" | "user" | "profile">): string {
  if (!probe.service) return windowsUserName(probe.user);
  return probe.profile ? posix.basename(fromWindowsPath(probe.profile)) : "the machine's user";
}

/** The account name without its machine or domain (`DESKTOP-1\user` → `user`). */
export function windowsUserName(account: string | null): string {
  if (!account) return "user";
  return account.split("\\").at(-1) || "user";
}

// ---------------------------------------------------------------------------
// Pinned toolchain
// ---------------------------------------------------------------------------

/** One pinned Windows archive and where it goes under the device root. */
export interface WindowsArtifact extends PinnedDownload {
  id: "node" | "jre" | "platform-tools" | "emulator" | "cmdline-tools" | "system-image";
  label: string;
  /** Where its inner dir goes, relative to the device root (`/`-separated). */
  dest: string;
  /** The top-level dir inside the archive. */
  inner: string;
  /** A file inside `dest` that marks it installed. */
  check: string;
  /** The version it pins (shown in readiness). */
  version: string;
}

/**
 * The pins (SHA-256 measured from the official archives; Google's SHA-1 in its repository manifest
 * matched too). The emulator and system image are those the Linux hosts' sdkmanager installs as
 * stable today (emulator 37.3.10; `system-images;android-35;google_apis;x86_64` revision 9).
 */
export const WINDOWS_ANDROID_ARTIFACTS: readonly WindowsArtifact[] = [
  {
    id: "node",
    label: "Node.js",
    version: "24.22.3",
    url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip",
    sha256: "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f",
    size: 37_762_649,
    dest: "node",
    inner: "node-v24.22.3-win-x64",
    check: "node.exe"
  },
  {
    id: "jre",
    label: "Java runtime (Temurin 17)",
    version: "17.0.21.1+2",
    url: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21.1%2B2/OpenJDK17U-jre_x64_windows_hotspot_17.0.21.1_2.zip",
    sha256: "739d8f2fd286dc2736d55cc8c9260980baefd275ad48cda242335bb0f08e0795",
    size: 43_874_958,
    dest: "jre",
    inner: "jdk-17.0.21.1+2-jre",
    check: "bin/java.exe"
  },
  {
    id: "platform-tools",
    label: "Android platform-tools",
    version: "37.0.3",
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.3-win.zip",
    sha256: "89d108360a3bf2924d3bea837239edaccc22fd6ff5befd3787c4348a9fe4f09d",
    size: 8_188_601,
    dest: "android-sdk/platform-tools",
    inner: "platform-tools",
    check: "adb.exe"
  },
  {
    id: "emulator",
    label: "Android emulator",
    version: "37.3.10",
    url: "https://dl.google.com/android/repository/emulator-windows_x64-16970787.zip",
    sha256: "d069eab462ea1da4a18e21b0887c4f95ea240ffba26a1760db056a6f1b0c0338",
    size: 456_613_348,
    dest: "android-sdk/emulator",
    inner: "emulator",
    check: "emulator.exe"
  },
  {
    id: "cmdline-tools",
    label: "Android command-line tools",
    version: "23.0",
    url: "https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip",
    sha256: "e5885e2e59038c0778a85fc19f01de7ce7c567c105553f7617b936b1e0e87b2b",
    size: 154_957_218,
    dest: "android-sdk/cmdline-tools/latest",
    inner: "cmdline-tools",
    check: "bin/avdmanager.bat"
  },
  {
    id: "system-image",
    label: "Android 15 system image (Google APIs, x86_64)",
    version: "35 r9",
    url: "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip",
    sha256: "c67b9ba0ff5bc0eb6d046871bfa228af14d4d47b02f0cdae94f048e511b7566e",
    size: 1_738_815_903,
    dest: "android-sdk/system-images/android-35/google_apis/x86_64",
    inner: "x86_64",
    check: "system.img"
  }
];

/**
 * avdmanager finds the system image by its `source.properties`, but the emulator only by a
 * `package.xml` (sdkmanager writes one; the archive has none): this one, written beside it.
 */
export const WINDOWS_EMULATOR_PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns5="http://schemas.android.com/repository/android/generic/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="emulator" obsolete="false"><type-details xsi:type="ns5:genericDetailsType"/><revision><major>37</major><minor>3</minor><micro>10</micro></revision><display-name>Android Emulator</display-name></localPackage></ns2:repository>
`;

/** The archive's download path, under the device root's download cache. */
export function windowsArtifactZip(layout: Pick<AndroidLayout, "downloads">, artifact: WindowsArtifact): string {
  return posix.join(layout.downloads, posix.basename(new URL(artifact.url).pathname));
}

/** Free disk an install of every archive needs (downloads and unpacked, with room to spare). */
export const WINDOWS_TOOLCHAIN_DISK_BYTES = 12 * 1024 ** 3;

/** The device root's Node and JRE. */
export function windowsNodePath(root: string): string {
  return posix.join(root, "node", "node.exe");
}

export function windowsJavaHome(root: string): string {
  return posix.join(root, "jre");
}

/** npm's CLI in the pinned Node (run with node.exe: no `.cmd` shim in between). */
export function windowsNpmCli(root: string): string {
  return posix.join(root, "node", "node_modules", "npm", "bin", "npm-cli.js");
}

/**
 * The environment of the Android tools there: the shared one (`buildAndroidEnv`: the SDK, AVD,
 * adb port, hub and agent-device dirs) with a Windows PATH (`;`, Node, the SDK tools and the JRE
 * first, then the machine's), `JAVA_HOME`, `TEMP`/`TMP`, and no XDG variables. orq-agent merges it
 * over its own environment (`SystemRoot`, `PATHEXT`, … stay).
 */
export function buildWindowsAndroidEnv(layout: AndroidLayout, probe: Pick<WindowsAndroidProbe, "path" | "user">, options: { root: string; adbPort: number }): NodeJS.ProcessEnv {
  const nodePath = windowsNodePath(options.root);
  const javaHome = windowsJavaHome(options.root);
  const env = buildAndroidEnv(layout, {}, { user: windowsUserName(probe.user), nodePath, adbPort: options.adbPort });
  for (const key of Object.keys(env)) if (key.startsWith("XDG_")) delete env[key];
  const own = [posix.dirname(nodePath), posix.join(layout.sdk, "platform-tools"), posix.join(layout.sdk, "emulator"), posix.join(layout.sdk, "cmdline-tools", "latest", "bin"), posix.join(javaHome, "bin")].map(toWindowsPath);
  return { ...env, PATH: [...own, probe.path].join(";"), JAVA_HOME: javaHome, TEMP: layout.tmp, TMP: layout.tmp };
}

// ---------------------------------------------------------------------------
// AVDs
// ---------------------------------------------------------------------------

/** Guest RAM of a Windows host's emulators (the mini PC fits one beside Windows). */
export const WINDOWS_AVD_RAM_MB = 1536;

/** The AVD's `config.ini` with {@link WINDOWS_AVD_RAM_MB} of guest RAM (the snapshot is saved with it, so every boot gets it). */
export function patchWindowsAvdConfig(config: string): string {
  const line = `hw.ramSize=${WINDOWS_AVD_RAM_MB}`;
  if (/^hw\.ramSize\s*=.*$/m.test(config)) return config.replace(/^hw\.ramSize\s*=.*$/m, line);
  return `${config.replace(/\n?$/, "\n")}${line}\n`;
}

/** Whether the AVD's config already has the Windows guest RAM. */
export function hasWindowsAvdRam(config: string): boolean {
  return new RegExp(`^hw\\.ramSize\\s*=\\s*${WINDOWS_AVD_RAM_MB}M?\\s*$`, "m").test(config);
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

/** The Windows GPU modes, best first. */
export const WINDOWS_HOST_GPU_MODE = "host";
export const WINDOWS_ANGLE_GPU_MODE = "angle_indirect";
export const WINDOWS_SOFTWARE_GPU_MODE = "swiftshader_indirect";

export type WindowsGpuMode = typeof WINDOWS_HOST_GPU_MODE | typeof WINDOWS_ANGLE_GPU_MODE | typeof WINDOWS_SOFTWARE_GPU_MODE;

/** Where an emulator runs: orq-agent's service session, or the signed-in user's desktop through its helper. */
export type WindowsSession = "service" | "desktop";

/** One way to try: a GPU mode, the session it needs, and whether its boot must render on hardware. */
export interface WindowsGpuAttempt {
  gpu: WindowsGpuMode;
  session: WindowsSession;
  hardware: boolean;
}

/** Adapters that are no GPU to render on: Microsoft's software ones, remote and virtual displays. */
const NOT_A_GPU = /microsoft basic|basic render|remote display|remotefx|virtual|hyper-v|parsec|citrix|vmware|virtualbox|mirage|displaylink|spacedesk/i;
const GPU_VENDOR = /\b(amd|radeon|ati|nvidia|geforce|quadro|rtx|intel|arc|iris|uhd|hd graphics|adreno|qualcomm)\b/i;

/** The machine's real GPU (working, from a known vendor; virtual and software adapters skipped), or null. */
export function windowsHostGpu(adapters: readonly WindowsGpuAdapter[]): WindowsGpuAdapter | null {
  return adapters.find((adapter) => GPU_VENDOR.test(adapter.name) && !NOT_A_GPU.test(adapter.name) && (adapter.status === "" || /^ok$/i.test(adapter.status))) ?? null;
}

/** What a failed hardware mode is remembered by: a new driver or emulator tries it again. */
export function windowsGpuSignature(gpu: WindowsGpuAdapter, emulatorRevision: string | null): string {
  return `${gpu.name} ${gpu.driver} · emulator ${emulatorRevision ?? "unknown"}`;
}

/** The hardware modes that failed, per mode, as remembered in the host's state file. */
export type WindowsGpuFailures = Partial<Record<typeof WINDOWS_HOST_GPU_MODE | typeof WINDOWS_ANGLE_GPU_MODE, string>>;

/** The remembered failures from the state file's `windowsGpuFailed` (tolerant of anything else). */
export function readGpuFailures(value: unknown): WindowsGpuFailures {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const failures: WindowsGpuFailures = {};
  for (const mode of [WINDOWS_HOST_GPU_MODE, WINDOWS_ANGLE_GPU_MODE] as const) if (typeof record[mode] === "string") failures[mode] = record[mode] as string;
  return failures;
}

/**
 * The modes a golden snapshot tries, best first: `host` in the desktop session (only while the box
 * has the desktop-session helper), `angle_indirect` from the service session (Direct3D 11 may
 * reach the GPU there too), both only with a real GPU and unless they failed on this GPU, driver
 * and emulator; then software, always.
 */
export function windowsGpuPlan(input: { desktopSession: boolean; gpu: WindowsGpuAdapter | null; failed: WindowsGpuFailures; emulatorRevision: string | null }): WindowsGpuAttempt[] {
  const plan: WindowsGpuAttempt[] = [];
  const signature = input.gpu ? windowsGpuSignature(input.gpu, input.emulatorRevision) : null;
  if (input.gpu && input.desktopSession && input.failed.host !== signature) plan.push({ gpu: WINDOWS_HOST_GPU_MODE, session: "desktop", hardware: true });
  if (input.gpu && input.failed.angle_indirect !== signature) plan.push({ gpu: WINDOWS_ANGLE_GPU_MODE, session: "service", hardware: true });
  plan.push({ gpu: WINDOWS_SOFTWARE_GPU_MODE, session: "service", hardware: false });
  return plan;
}

/** The session an emulator command line needs: `-gpu host` renders with the desktop's OpenGL driver. */
export function windowsLaunchSession(args: readonly string[]): WindowsSession {
  const at = args.indexOf("-gpu");
  return at >= 0 && args[at + 1] === WINDOWS_HOST_GPU_MODE ? "desktop" : "service";
}

/**
 * How a lease boots: from the golden snapshot with its GPU mode, unless that mode needs the desktop
 * session and the box has none now — then cold with the best mode the service session can run
 * (a snapshot loads only with the mode it was saved with).
 */
export function windowsLeaseLaunch(golden: { gpu: string; snapshot: string } | null, plan: readonly WindowsGpuAttempt[], desktopSession: boolean): { gpu: string; snapshot?: string; coldBoot?: true } {
  if (golden && (golden.gpu !== WINDOWS_HOST_GPU_MODE || desktopSession)) return { gpu: golden.gpu, snapshot: golden.snapshot };
  const usable = plan.find((attempt) => attempt.session === "service" || desktopSession) ?? { gpu: WINDOWS_SOFTWARE_GPU_MODE };
  return { gpu: usable.gpu, coldBoot: true };
}

/** A desktop-session launch the box cannot run now (no helper connected): not a GPU failure, nothing is remembered. */
export class NoDesktopSessionError extends Error {
  readonly code = "NO_DESKTOP_SESSION";
  constructor(message = "the desktop-session helper is not connected") {
    super(message);
    this.name = "NoDesktopSessionError";
  }
}

/**
 * Try `plan` in order until one attempt works: a failed hardware mode is reported to `remember`
 * (later goldens skip it), a missing desktop session only moves on. Resolves the attempt that
 * worked; rejects with every failure when none did, or at once when `signal` aborted.
 */
export async function tryGpuModes(
  plan: readonly WindowsGpuAttempt[],
  attempt: (entry: WindowsGpuAttempt) => Promise<void>,
  remember: (entry: WindowsGpuAttempt, failed: boolean) => Promise<void>,
  signal: AbortSignal
): Promise<WindowsGpuAttempt> {
  const failures: string[] = [];
  for (const entry of plan) {
    try {
      await attempt(entry);
      if (entry.hardware) await remember(entry, false);
      return entry;
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${entry.gpu}: ${message}`);
      if (entry.hardware && !(error instanceof NoDesktopSessionError)) await remember(entry, true);
    }
  }
  throw new Error(failures.join("; "));
}

/** Software rasterizers a renderer string names: SwiftShader, Mesa's, and Microsoft's (WARP / Basic Render Driver, GDI Generic). */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|microsoft basic|\bwarp\b|gdi generic/i;

/**
 * Whether the guest renders in software: `SurfaceFlinger`'s `GLES:` line, or — when the dump has
 * none — the emulator's own `Graphics Adapter` / `Renderer` log lines. Null when neither says.
 */
export function windowsRendersInSoftware(surfaceFlingerDump: string, emulatorLog = ""): boolean | null {
  const gles = surfaceFlingerDump.split(/\r?\n/).find((line) => /^\s*GLES:/.test(line));
  if (gles !== undefined) return SOFTWARE_RENDERER.test(gles);
  const lines = emulatorLog.split(/\r?\n/).filter((line) => /graphics adapter|renderer/i.test(line));
  return lines.length > 0 ? lines.some((line) => SOFTWARE_RENDERER.test(line)) : null;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;
/** One emulator: its guest RAM plus the emulator's own (QEMU, the GPU pipe, buffers). */
export const WINDOWS_EMULATOR_BYTES = WINDOWS_AVD_RAM_MB * 1024 ** 2 + 0.75 * GB;
/** Free RAM left to Windows and the hub. */
export const WINDOWS_RESERVED_BYTES = 1.5 * GB;
const WINDOWS_HARD_CAP = 16;
const VCPUS_PER_EMULATOR = 2;
const EMULATOR_DISK_BYTES = 2 * GB;
const DISK_RESERVED_BYTES = 4 * GB;

/**
 * How many emulators a Windows host may run: the least of the CPU formula (one per two logical
 * CPUs), the memory formula (the running ones plus what fits in the available RAM above a 1.5 GB
 * reserve, {@link WINDOWS_EMULATOR_BYTES} each), the disk formula and the hard cap of 16. The mini
 * PC (16 threads, 6.9 GB usable, ~4.6 GB available at idle) gets one.
 */
export function windowsAndroidCapacity(input: { cpus: number; freeMemBytes: number | null; running: number; freeDiskBytes: number | null }): number {
  const byCpu = Math.max(1, Math.floor(input.cpus / VCPUS_PER_EMULATOR));
  const byDisk = input.freeDiskBytes === null ? WINDOWS_HARD_CAP : input.running + Math.max(0, Math.floor((input.freeDiskBytes - DISK_RESERVED_BYTES) / EMULATOR_DISK_BYTES));
  return localCapacity({
    maxLocalDevices: Math.min(WINDOWS_HARD_CAP, byCpu, byDisk),
    memAvailableBytes: input.freeMemBytes,
    running: input.running,
    threads: input.cpus,
    reservedBytes: WINDOWS_RESERVED_BYTES,
    emulatorBytes: WINDOWS_EMULATOR_BYTES
  }).total;
}

/** What the capacity was measured from (`DeviceCapacity.basis`). */
export function windowsCapacityBasis(probe: WindowsAndroidProbe, freeMemBytes: number | null, probedAt: string): DeviceCapacityBasis {
  return { cpus: probe.cpus, freeMemBytes: freeMemBytes ?? probe.freeMemBytes ?? 0, freeDiskBytes: probe.diskFreeBytes, accel: whpxReady(probe) ? "whpx" : null, probedAt };
}

// ---------------------------------------------------------------------------
// Environment problems
// ---------------------------------------------------------------------------

/** The command that turns WHPX on (an administrator PowerShell; a restart finishes it). */
export const ENABLE_WHPX_COMMAND = "Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All";

/** Why WHPX is not usable, with the fix; null when it is. */
export function whpxProblem(probe: WindowsAndroidProbe, machine: string): MachineProblem | null {
  if (whpxReady(probe)) return null;
  const restartFix = `Restart ${machine} to finish turning on Windows Hypervisor Platform.`;
  if (probe.hypervisorPlatform !== 1) {
    return {
      code: "whpx-off",
      message: `Windows Hypervisor Platform is off on ${machine}, so its Android emulators can't use hardware acceleration.`,
      fix: `In an administrator PowerShell on ${machine}: ${ENABLE_WHPX_COMMAND}, then restart ${machine}.`
    };
  }
  if (!probe.hypervisorPresent) {
    return {
      code: "whpx-off",
      message: `The Windows hypervisor is not running on ${machine}, so its Android emulators can't use hardware acceleration.`,
      fix: probe.firmwareVirtualization === false ? `Turn on CPU virtualization (AMD SVM or Intel VT-x) in ${machine}'s firmware settings, then start Windows again.` : restartFix
    };
  }
  return {
    code: "whpx-off",
    message: `The Android emulator on ${machine} can't use Windows Hypervisor Platform: ${probe.accel?.message || "its accel check failed"}.`,
    fix: `In an administrator PowerShell on ${machine}: ${ENABLE_WHPX_COMMAND}, then restart ${machine}.`
  };
}

/**
 * The owner's Windows machine's problems for devices: WHPX ({@link whpxProblem}), and no desktop
 * session — the box lacks the desktop-session helper, so `-gpu host` can't run — unless the
 * golden snapshot already renders on the GPU from the service session (`angle_indirect`).
 */
export function windowsProbeProblems(probe: WindowsAndroidProbe, input: { machine: string; desktopSession: boolean; goldenGpu: string | null }): MachineProblem[] {
  const problems: MachineProblem[] = [];
  const whpx = whpxProblem(probe, input.machine);
  if (whpx) problems.push(whpx);
  if (!input.desktopSession && input.goldenGpu !== WINDOWS_ANGLE_GPU_MODE && input.goldenGpu !== WINDOWS_HOST_GPU_MODE) {
    const machine = input.machine;
    problems.push(
      probe.consoleUser
        ? {
            code: "no-desktop-session",
            message: `${machine}'s desktop-session helper is not connected, so its emulators can't render on its GPU through the desktop (they use Direct3D through ANGLE, or software).`,
            fix: `Sign out of ${machine} and back in (the helper starts at sign-in), or pair ${machine} again to reinstall the helper.`
          }
        : {
            code: "no-desktop-session",
            message: `Nobody is signed in at ${machine}'s screen, so its emulators can't render on its GPU through the desktop session (they use Direct3D through ANGLE, or software).`,
            fix: `Turn on automatic sign-in for ${profileOwner(probe)} on ${machine}: run Sysinternals Autologon (autologon.exe), or set AutoAdminLogon=1, DefaultUserName and DefaultPassword under HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon; then restart ${machine}.`
          }
    );
  }
  return problems;
}
