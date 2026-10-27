# Devices spikes (2026-10-27)

Facts measured on real machines for the device specs in `docs/superpowers/specs/2026-10-27-devices-phase-*.md`.
Raw artifacts were kept outside the repo under `/var/lib/orquester/tmp/{ios-spike,android-spike,blacksmith-linux-spike}`.

## 1. iOS simulator on a Blacksmith macOS runner (`blacksmith-6vcpu-macos-26`)

Workflow: `Arakuma-Studio/orquester-macos-boxes/.github/workflows/orquester-spike-ios.yml`, runs 40441223754 and 40442062841 (4m10s, 5m20s).

- **Machine:** a VM (`kern.hv_vmm_present=1`, VirtualMac2,1, "Apple M4 Pro (Virtual)"), 6 vCPU, 24 GB, ~152 GB free, macOS 26.3, fresh boot per job (Anka-like). `sudo -n` works; SIP disabled. GPU and VideoToolbox are paravirtual.
- **GUI session:** yes. Aqua, `gui/501` login session, user `runner` auto-logged in, WindowServer/Dock/Finder up. `open -a Simulator` and `screencapture -x` work; TCC grants ScreenCapture/Accessibility/PostEvent to Runner.Listener and bash. A "find devices on local networks" dialog for Runner.Listener stays on screen (loopback unaffected, but it covers the Simulator window → agent-device flags nodes `[covered]`; keep Simulator.app closed — serve-sim doesn't need it).
- **Xcode:** 26.6 selected; 18 Xcodes 26.0–27.0 installed. iOS runtimes 26.2, 26.4.1, 26.5, 27.0 ready. No iOS devices pre-created. **No install needed.**
- **Boot (iPhone 17 Pro, iOS 27.0):** create 0.3 s; cold boot to `bootstatus -b` 31 s, to a rendered home screen 37.7 s; warm boot 4.5 s / 10.7 s; shutdown 3.4 s. `bootstatus` finishes while the Apple logo is still showing — wait for a real frame.
- **expo-device-hub 0.19.0-canary-20261023-1357114:** install 4–7 s; `/healthz` ready 0.55 s; `/api/devices`, boot, `grid/api/start` (~6 s first time) work; capture is headless (framebuffer 1206×2622).
  - **Input works:** helper WS sends `0x83` (admitted) then `0x82` (screen config) within 7 ms; center tap, home and swipe take effect.
  - **MJPEG works:** default 5 fps idle / 10–12 fps active (8–30 Mbit/s); with `--max-dimension 1000 --mjpeg-quality 0.6` 5–7 fps, ~2–2.4 Mbit/s; hub CPU 2–9 %, RSS 150–195 MB.
  - **H.264 `stream.avcc` does NOT work in this VM:** only a JPEG seed envelope arrives; hub logs "low-latency encode failed … encode timed out … encodingFailed". VideoToolbox probe: no hardware H.264 encoder (required-HW fails −12903; low-latency session frames fail −12915); **software H.264 works** (60/60 frames, 70–120 fps synthetic); a paravirtual HEVC encoder exists.
  - Stop the hub before shutting the simulator down (otherwise "Could not disarm the capability loader").
- **agent-device 0.21.31:** `devices --json` 4.1 s; `snapshot -i` needs an `open <bundle>` first (SESSION_NOT_FOUND otherwise); first use ~27–30 s (runner build+launch) cached in `~/.agent-device/apple-runner/derived/ios-simulator/cache-<hash>/` (25 MB); afterwards snapshot 0.16–0.2 s, `click --settle` 2.5 s, screenshot 1.8 s (402×874), Safari snapshot 3.1 s. Snapshot quality good (`@e7 [cell] "General"`, correct diffs).

**Decisions:** iOS hosts stream MJPEG (`--max-dimension 1000 --mjpeg-quality 0.6`, raised for the focused viewer) decoded into the same canvas the 3D viewer textures; H.264 stays the preferred transport where the encoder works (BYO physical Macs). Warm the agent-device runner right after a host is ready; cache `~/.agent-device/apple-runner` in phase 2.
