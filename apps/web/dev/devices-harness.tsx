/**
 * DEV ONLY — never bundled: `vite build` takes `index.html` alone, and this page lives outside
 * `src/`. Served by the dev server at `/dev/devices.html`.
 *
 * Renders the Device panel (and Settings → Devices) from mocked stores with a fake hub, so the
 * panel's states can be looked at without a daemon:
 *
 *   /dev/devices.html?scene=live-android&theme=dark&layout=dock
 *
 * Scenes: picker, booting-ios, booting-failed, live-android, live-ios, live-fold, lost, suspended,
 * no-transport, settings. Layouts: dock (a 460 px rail beside a mock chat), phone (full width).
 * The fake hub paints a mock app screen: Android through the screenshot transport (WebCodecs is
 * hidden), iOS through an endless MJPEG response; input sockets accept everything.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import "../../../packages/ui/src/styles/globals.css";
import "../src/styles.css";

import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICE_PROFILES,
  DEVICES_ACTION_EVENT,
  type DeviceActionEntry,
  type DeviceHostSummary,
  type DeviceLeaseSummary,
  type DevicesSettings
} from "../../../packages/api/src/index";

import { DevicePanel } from "../../../packages/ui/src/components/device/DevicePanel";
import { DevicesSettings as DevicesSettingsPage } from "../../../packages/ui/src/components/settings/DevicesSettings";
import { applyDevicesEvent, devicesStore } from "../../../packages/ui/src/lib/devices/store";
import { useAppStore } from "../../../packages/ui/src/store/app";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "live-android";
const theme = params.get("theme") === "light" ? "light" : "dark";
const layout = params.get("layout") === "phone" ? "phone" : "dock";

document.documentElement.dataset.mode = theme;
document.documentElement.dataset.scheme = "mono";
document.documentElement.style.colorScheme = theme;

// --- The fake hub ------------------------------------------------------------------------------

// Android takes the screenshot transport, iOS the MJPEG one: no WebCodecs here.
delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;

function paintScreen(width: number, height: number, tick: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const s = width / 400;
  const grad = g.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "#f7f4ef");
  grad.addColorStop(1, "#ece6dc");
  g.fillStyle = grad;
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#1f2937";
  g.font = `${600} ${13 * s}px system-ui, sans-serif`;
  g.fillText("9:41", 26 * s, 34 * s);
  g.font = `${700} ${30 * s}px system-ui, sans-serif`;
  g.fillText("Trips", 24 * s, 104 * s);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.roundRect(20 * s, 124 * s, 360 * s, 44 * s, 14 * s);
  g.fill();
  g.fillStyle = "#9ca3af";
  g.font = `${400} ${15 * s}px system-ui, sans-serif`;
  g.fillText("Search destinations", 54 * s, 152 * s);
  const cards = [
    ["Lisbon", "#f59e0b", "4 nights · from $412"],
    ["Kyoto", "#10b981", "6 nights · from $980"],
    ["Mexico City", "#6366f1", "3 nights · from $305"],
    ["Reykjavík", "#ef4444", "5 nights · from $1,120"]
  ] as const;
  cards.forEach(([name, color, sub], index) => {
    const y = (196 + index * 132) * s;
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.roundRect(20 * s, y, 360 * s, 116 * s, 18 * s);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(32 * s, y + 12 * s, 92 * s, 92 * s, 14 * s);
    g.fill();
    g.fillStyle = "#111827";
    g.font = `${650} ${18 * s}px system-ui, sans-serif`;
    g.fillText(name, 140 * s, y + 44 * s);
    g.fillStyle = "#6b7280";
    g.font = `${400} ${13 * s}px system-ui, sans-serif`;
    g.fillText(sub, 140 * s, y + 68 * s);
  });
  g.fillStyle = "rgba(17,24,39,0.85)";
  g.beginPath();
  g.roundRect(150 * s, height - 22 * s, 100 * s, 5 * s, 3 * s);
  g.fill();
  g.fillStyle = `rgba(99,102,241,${0.25 + 0.2 * Math.sin(tick / 3)})`;
  g.beginPath();
  g.arc(340 * s, 104 * s - 8 * s, 14 * s, 0, Math.PI * 2);
  g.fill();
  return canvas;
}

const blobOf = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), type, 0.86));

const realFetch = window.fetch.bind(window);
let tick = 0;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/vendor/serve-emu/api/screenshot")) {
    tick += 1;
    const fold = url.includes("fold");
    return new Response(await blobOf(paintScreen(fold ? 1080 : 1080, fold ? 1150 : 2400, tick), "image/png"), { headers: { "content-type": "image/png" } });
  }
  if (url.includes("/vendor/serve-emu/api/fold")) {
    const posture = init?.method === "POST" ? (JSON.parse(String(init.body)) as { posture: string }).posture : "opened";
    return new Response(JSON.stringify({ ok: true, fold: { supported: true, posture, hingeAngle: posture === "closed" ? 0 : 180 } }), { headers: { "content-type": "application/json" } });
  }
  if (url.includes("stream.mjpeg")) {
    const boundary = "frame";
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        tick += 1;
        const jpeg = new Uint8Array(await (await blobOf(paintScreen(1206, 2622, tick), "image/jpeg")).arrayBuffer());
        controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`));
        controller.enqueue(jpeg);
        controller.enqueue(encoder.encode("\r\n"));
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });
    return new Response(body, { headers: { "content-type": `multipart/x-mixed-replace; boundary=${boundary}` } });
  }
  return realFetch(input, init);
};

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      if (url.includes("serve-sim")) {
        this.down(0x82, { width: 1206, height: 2622, orientation: "portrait" });
        this.down(0x83, {});
      }
    }, 120);
  }
  private down(tag: number, payload: unknown) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const out = new Uint8Array(json.length + 1);
    out[0] = tag;
    out.set(json, 1);
    this.onmessage?.(new MessageEvent("message", { data: out.buffer }));
  }
  send(data: ArrayBuffer | Uint8Array | string) {
    const bytes = typeof data === "string" ? null : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    if (bytes && bytes[0] === 0x07) {
      const { orientation } = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as { orientation: string };
      this.down(0x82, { width: 1206, height: 2622, orientation });
    }
  }
  close() {
    this.readyState = 3;
  }
}
(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;

// --- Mock data ---------------------------------------------------------------------------------

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function lease(overrides: Partial<DeviceLeaseSummary>): DeviceLeaseSummary {
  return {
    id: "lease-android",
    key: "local/emulator-5554",
    threadId: "chat-1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: iso(600_000),
    lastUsedAt: iso(5_000),
    screen: { width: 412, height: 915, scale: 2.625 },
    stream: { kind: "serve-emu", deviceParam: "emulator-5554" },
    ...overrides
  };
}

const ios = lease({
  id: "lease-ios",
  key: "box:mac1/UDID-1",
  hostId: "box:mac1",
  deviceId: "UDID-1",
  platform: "ios",
  profile: "iphone-17-pro",
  name: "iPhone 17 Pro",
  osVersion: "iOS 26.1",
  controller: "user",
  openedBy: "agent",
  createdAt: iso(300_000),
  screen: { width: 402, height: 874, scale: 3 },
  stream: { kind: "serve-sim", deviceParam: "UDID-1" }
});

const fold = lease({ id: "lease-fold", profile: "pixel-fold", name: "Pixel Fold", key: "local/emulator-5556", deviceId: "emulator-5556", stream: { kind: "serve-emu", deviceParam: "emulator-5556-fold" } });

const localHost: DeviceHostSummary = {
  id: "local",
  kind: "local",
  label: "This machine",
  platforms: ["android"],
  status: "ready",
  statusDetail: null,
  readiness: {
    ready: true,
    checkedAt: iso(60_000),
    checks: [
      { id: "kvm", label: "KVM", state: "ok", detail: "/dev/kvm is usable" },
      { id: "node", label: "Node.js", state: "ok", detail: "v22.12.0" },
      { id: "ffmpeg", label: "ffmpeg with libx264", state: "ok", detail: "7.1" },
      { id: "android-sdk", label: "Android SDK", state: "ok", detail: "platform-tools 36, emulator 35.4" },
      { id: "system-image", label: "System image", state: "ok", detail: "android-35 google_apis x86_64" },
      { id: "avd:pixel-9", label: "Pixel 9 AVD", state: "ok", detail: null },
      { id: "snapshot:pixel-9", label: "Pixel 9 snapshot", state: "missing", detail: "Taken on the first boot", fixActionId: "snapshot:pixel-9" },
      { id: "tool:expo-device-hub", label: "expo-device-hub", state: "ok", detail: "0.19.0-canary-20261023-1357114" },
      { id: "tool:agent-device", label: "agent-device", state: "ok", detail: "0.21.31" }
    ]
  },
  capacity: { used: 1, total: 4 }
};
const macHost: DeviceHostSummary = {
  id: "box:mac1",
  kind: "box",
  label: "Mac host · blacksmith-6vcpu-macos-26",
  platforms: ["ios"],
  status: "ready",
  statusDetail: null,
  readiness: { ready: true, checks: [], checkedAt: iso(60_000) },
  capacity: { used: 1, total: 3 },
  box: { boxId: "mac1", provider: "blacksmith", hourlyUsd: 4.8, startedAt: iso(42 * 60_000), deadlineAt: new Date(now + 3 * 3600_000).toISOString() }
};

const settings: DevicesSettings = structuredClone(DEFAULT_DEVICES_SETTINGS) as DevicesSettings;
settings.android.enabled = true;
settings.ios.enabled = true;

const actions: DeviceActionEntry[] = [
  { id: "a1", leaseId: "lease-android", at: iso(95_000), actor: "agent", kind: "snapshot", summary: "Read the screen (38 elements)", ok: true },
  { id: "a2", leaseId: "lease-android", at: iso(80_000), actor: "agent", kind: "open_app", summary: "Opened com.example.trips", ok: true },
  { id: "a3", leaseId: "lease-android", at: iso(61_000), actor: "agent", kind: "tap", summary: "Tapped @e7 “Search destinations”", target: "@e7 Search destinations", point: { x: 206, y: 150 }, ok: true },
  { id: "a4", leaseId: "lease-android", at: iso(52_000), actor: "agent", kind: "type", summary: "Typed “Lisbon”", ok: true },
  { id: "a5", leaseId: "lease-android", at: iso(40_000), actor: "agent", kind: "tap", summary: "Tapped @e12 “Book”", ok: false, error: "DEVICE_CONTROLLED_BY_USER: the user is controlling this device" },
  { id: "a6", leaseId: "lease-android", at: iso(22_000), actor: "user", kind: "press", summary: "Pressed Back", ok: true },
  { id: "a7", leaseId: "lease-android", at: iso(9_000), actor: "agent", kind: "screenshot", summary: "Took a screenshot", ok: true }
];

const api = {
  connection: { id: "harness" },
  transportKind: scene === "no-transport" ? "unix" : "http",
  deviceSocketUrl: (path: string) => (scene === "no-transport" ? null : `ws://harness.invalid${path}?token=t`),
  deviceMediaUrl: (path: string) => (scene === "no-transport" ? null : `${location.origin}${path}?token=t`),
  devicesState: async () => ({ enabled: true, hosts, leases, profiles: DEVICE_PROFILES, settings, setupJobs: [] }),
  deviceLeaseActions: async (leaseId: string) => ({ leaseId, actions: actions.filter((entry) => entry.leaseId === leaseId) }),
  setDeviceController: async (leaseId: string, controller: "agent" | "user") => {
    const current = devicesStore.getState().leases?.find((entry) => entry.id === leaseId);
    return { lease: { ...current!, controller } };
  },
  openDeviceLease: async (req: { platform: "ios" | "android"; profile?: string }) => ({
    lease: lease({ id: `lease-${Date.now()}`, platform: req.platform, profile: req.profile ?? "pixel-9", name: DEVICE_PROFILES.find((p) => p.id === req.profile)?.label ?? "", state: "starting", key: null, deviceId: null, stream: undefined, createdAt: new Date().toISOString(), progress: { step: req.platform === "ios" ? "rent-host" : "start-device", label: req.platform === "ios" ? "Renting Mac host" : "Starting device", startedAt: new Date().toISOString() } })
  }),
  releaseDeviceLease: async (leaseId: string) => ({ lease: { ...devicesStore.getState().leases!.find((entry) => entry.id === leaseId)!, state: "released" } }),
  updateDevicesSettings: async (patch: Partial<DevicesSettings>) => ({ settings: { ...settings, ...patch } }),
  startDeviceSetup: async () => ({ job: null }),
  uploadSessionFile: async (_id: string, meta: { name: string }) => ({ path: `/tmp/${meta.name}`, name: meta.name, size: 1 }),
  listBoxProviders: async () => ({ providers: [] }),
  getBoxOffers: async () => ({ provider: "blacksmith", kind: "macos", sizes: [{ id: "blacksmith-6vcpu-macos-26", label: "6 vCPU macOS", vcpu: 6, ramGb: 24, diskGb: null, gpu: null, hourlyUsd: 4.8, regions: [] }], regions: [], images: [], priceSource: "table", fetchedAt: iso(0) }),
  destroyDeviceHost: async () => undefined
};

let leases: DeviceLeaseSummary[] = [];
let hosts: DeviceHostSummary[] = [localHost];
switch (scene) {
  case "picker":
    leases = [];
    break;
  case "booting-ios":
    leases = [lease({ ...ios, state: "starting", key: null, deviceId: null, stream: undefined, createdAt: iso(84_000), progress: { step: "prepare-host", label: "Preparing host", startedAt: iso(23_000) } })];
    hosts = [localHost];
    break;
  case "booting-failed":
    leases = [lease({ state: "starting", stream: undefined, createdAt: iso(44_000), error: "The emulator exited during boot (KVM permission denied)", progress: { step: "start-device", label: "Starting device", startedAt: iso(30_000) } })];
    break;
  case "live-ios":
    leases = [lease({}), ios];
    hosts = [localHost, macHost];
    break;
  case "live-fold":
    leases = [fold];
    break;
  case "lost":
    leases = [lease({ state: "lost", error: "Its Mac host was destroyed" })];
    break;
  case "suspended":
    leases = [lease({ ...ios, state: "suspended" })];
    hosts = [localHost, macHost];
    break;
  case "no-transport":
  case "live-android":
  default:
    leases = [lease({}), lease({ ...ios, controller: "agent" })];
    hosts = [localHost, macHost];
}

useAppStore.setState({
  api: api as never,
  sessions: [{ id: "chat-1", kind: "agent-chat", refId: "claude", title: "Book a trip flow", projectPath: "/w/p", cwd: "/w/p", cols: 80, rows: 24, status: "running", order: 0, createdAt: iso(1e6) }] as never,
  registry: { shells: [], agents: [{ id: "claude", name: "Claude" }], ides: [], fileExplorers: [], browsers: [] } as never,
  plugins: [
    { id: "devices", scope: "global", enabled: true },
    { id: "ephemeral-vms", scope: "global", enabled: true }
  ] as never,
  openSettings: (() => console.info("openSettings")) as never
});
devicesStore.setState({ enabled: true, hosts, leases, profiles: DEVICE_PROFILES, settings, setupJobs: {}, pool: null, actions: {} });
if (scene === "booting-ios") {
  devicesStore.setState({ setupJobs: {} });
}

// The agent keeps acting on the Android device: taps, swipes and typing for the overlay.
if (scene === "live-android" || scene === "live-fold") {
  const script: Array<Omit<DeviceActionEntry, "id" | "at" | "leaseId">> = [
    { actor: "agent", kind: "tap", summary: "Tapped @e7 “Search destinations”", target: "@e7 Search destinations", point: { x: 206, y: 150 }, ok: true },
    { actor: "agent", kind: "type", summary: "Typed “Lisbon”", point: { x: 206, y: 150 }, ok: true },
    { actor: "agent", kind: "swipe", summary: "Swiped up", from: { x: 206, y: 760 }, to: { x: 206, y: 360 }, ok: true },
    { actor: "agent", kind: "tap", summary: "Tapped @e14 “Kyoto”", target: "@e14 Kyoto", point: { x: 230, y: 400 }, ok: true },
    { actor: "agent", kind: "press", summary: "Pressed back", ok: true }
  ];
  let step = 0;
  const leaseId = scene === "live-fold" ? "lease-fold" : "lease-android";
  setInterval(() => {
    const next = script[step % script.length]!;
    step += 1;
    applyDevicesEvent({ type: DEVICES_ACTION_EVENT, payload: { leaseId, threadId: "chat-1", entry: { ...next, id: `live-${step}`, leaseId, at: new Date().toISOString() } } });
  }, Number(params.get("every") ?? 1800));
}
localStorage.setItem("orq.device.panel", JSON.stringify({ logOpen: params.get("log") !== "closed" }));

// --- Page (inline sizes: Tailwind does not scan this folder) --------------------------------------------------------------------------------------

function MockChat() {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-neutral-950">
      <div className="flex h-10 items-center border-b border-neutral-800 px-4 text-[13px] text-neutral-300">Book a trip flow · Claude</div>
      <div className="flex-1 space-y-3 overflow-hidden p-6 text-[13px] text-neutral-400">
        <p className="text-neutral-200">Open the app on a Pixel and check the search flow.</p>
        <p>I opened Pixel 9 and I'm driving the search screen.</p>
      </div>
    </div>
  );
}

function App() {
  if (scene === "settings") {
    return (
      <div className="h-full overflow-y-auto bg-neutral-950 px-6 py-6">
        <DevicesSettingsPage />
      </div>
    );
  }
  const panel = <DevicePanel sessionId="chat-1" projectPath="/w/p" variant={layout === "phone" ? "sheet" : "docked"} />;
  if (layout === "phone") {
    return <div className="flex h-full flex-col bg-neutral-950 px-1 pt-2 text-sm">{panel}</div>;
  }
  return (
    <div className="flex h-full bg-neutral-950 text-sm">
      <MockChat />
      <aside className="flex shrink-0 flex-col border-l border-neutral-800 bg-neutral-950" style={{ width: Number(params.get("dock") ?? 460) }}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 text-[13px] font-medium text-neutral-200">Devices</div>
        {panel}
      </aside>
      <div className="shrink-0 border-l border-neutral-800 bg-neutral-950" style={{ width: 44 }} />
    </div>
  );
}

// A fixed frame (`w`, `h` CSS px) scaled by `zoom`, so a small browser window can show a tall layout.
const frameW = Number(params.get("w") ?? (layout === "phone" ? 390 : 1280));
const frameH = Number(params.get("h") ?? (layout === "phone" ? 844 : 860));
const zoom = Number(params.get("zoom") ?? 1);
const root = document.getElementById("root")!;
Object.assign(root.style, { width: `${frameW}px`, height: `${frameH}px`, zoom: String(zoom), overflow: "hidden" });
ReactDOM.createRoot(root).render(<App />);
