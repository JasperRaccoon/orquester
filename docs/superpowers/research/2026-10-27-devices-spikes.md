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

## 2. Android emulators on the Orquester host (Ryzen 7 7700, 16 threads, 61 GB, no GPU)

Measured while other workloads ran (load 3–17): timings are ranges.

- **Versions:** cmdline-tools 15859902 (rev 22.0), platform-tools 37.0.1, emulator 37.2.12 (stable), `system-images;android-35;google_apis;x86_64` rev 9. Download 2.28 GB (~50 s), 4.6 GB on disk; an AVD + snapshot ≈ 3.8 GB.
- **KVM access:** an ACL on `/dev/kvm` is wiped when udev re-creates the node (`70-uaccess.rules`); a rule must sort after it (`99-…`). The robust fix is `SupplementaryGroups=kvm` on the daemon unit (drop-in `orquester.service.d/kvm.conf`). Until the daemon restarts with it, launch emulators via `sg kvm -c` when the process lacks the group but `/etc/group` lists the user. Probe with `emulator -accel-check`.
- **avdmanager 22 quirks:** writes placeholders `avd.id=<build>`, `avd.name=<build>`, `disk.dataPartition.path=<temp>` — patch after create. The emulator raises guest RAM to a 2560 MB minimum.
- **GPU:** `-gpu swangle_indirect` is best (cold boot 24–35 s); `swiftshader_indirect` 34–108 s; `auto`/`software` 44–46 s; `guest` 85 s and hangs on kill; `host` fails.
- **Golden snapshot:** a fresh AVD burns 200–400 % CPU for ~3.5 min after first boot; snapshot after it settles with animations 0, `screen_off_timeout 2147483647`, `svc power stayon true`, `hide_error_dialogs 1` (otherwise "System UI isn't responding"). Save 4–6 s, ~2.2 GB.
- **Boot from snapshot** (720×1280 @320, `-read-only`): 4–7 s alone; 4 concurrent ~38 s each; cold `-no-snapshot-load` 21.5 s. Snapshot RAM is not shared (≈3.1 GB private per instance).
- **Multi-instance:** every instance of one AVD must be `-read-only` (a writable one blocks the rest). Overlays live in `/tmp/android-$USER/` and vanish on exit — set `USER`/`TMPDIR`.
- **Discovery:** `$XDG_RUNTIME_DIR/avd/running/pid_<pid>.ini` exists only with gRPC on; `grpc.token` only with `-grpc-use-token`.
- **Isolation:** `ANDROID_ADB_SERVER_PORT` is honored by the emulator, the hub and agent-device → use a private adb server per Orquester appdir.
- **expo-device-hub (Android):** `POST /api/devices/boot` blocks until ready (55 s cold / 13–21 s snapshot) but launches with `-gpu auto` and camera args (forcing cold boots unless `EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS` adds `-camera-back none -camera-front none`; the last flag wins), captures no logs, and **handles only one instance per AVD name**. Streaming by serial works for any emulator, including ones it didn't launch. → **Orquester launches and supervises emulators itself; the hub is used only for streaming and input by serial**, with `--require-token`.
  - Downloads scrcpy-server v4.0 (732 KB) from GitHub on first stream into `<pkg>/vendor/serve-emu/vendor/` — pre-seed it.
  - SEMU header: hub v1 = 16 bytes; the vendored Bun server writes v2 = 24 bytes (adds u64 send time) — parse both.
  - H.264 Baseline 720×1280 (576×1280 for 1080×2400). Frames only on change; on a still screen ffmpeg restarts every ~1 s for a keyframe.
  - 720p scrolling: 10–13 fps, 1.6–2 Mbit/s, emulator 590–740 % CPU, ffmpeg ≤166 %, hub 63 %; still: 2 fps, 0.09 Mbit/s. 1080p: 7.8 fps at 1040 % — use 720p.
  - Capture sessions linger >2 min after the last viewer leaves — Orquester must recycle them.
- **agent-device:** state confined by `AGENT_DEVICE_STATE_DIR`/`AGENT_DEVICE_HOME`/`AGENT_DEVICE_CLAIMS_DIR`; daemon auto-starts on a random loopback port, writes `daemon.json` (0600, token), exits after 5 idle min (`AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS=0` disables). `devices --json` 3.3 s; `snapshot -i` 6.1 s first (installs snapshot helper) then 0.45 s; `open` 1.8 s (refs expire); `click --settle` 1.8 s; `fill --settle` ~1.5 s (installs/switches an IME helper; `close` restores); `screenshot` 0.54 s.
- **Density:** per instance ≈3.0–3.2 GB RAM, ~5 % CPU idle; one actively streamed+driven device costs 6–10 threads. Formulas: `maxBooted = floor((MemAvailable − 8 GB) / 3.2 GB)`, `maxActive = floor(threads / 8)` → this host: 8 booted, 2 heavily active.
- **Emulator flags:** `-read-only -no-window -no-audio -no-boot-anim -no-metrics -accel on -gpu swangle_indirect -no-snapshot-save -port <even 5554–5682> -grpc <port> -grpc-use-token -camera-back none -camera-front none`; stop with `adb emu kill` → SIGTERM → SIGKILL.

## 3. Android emulators on Blacksmith x64 Linux runners

Workflow `orquester-spike-android.yml`, runs 40441392093, 40444613315, 40445394929, 40447268028 (80 billed minutes ≈ $3.84). Queue latency 9–10 s.

- **Labels/prices:** `blacksmith-{2,4,8,16,32}vcpu-ubuntu-2404` (8–128 GB), $0.004/min per 2 vCPU (16 vCPU $1.92/h, 32 vCPU $3.84/h). Nested virtualization on x64 only.
- **KVM:** AMD EPYC KVM guest with `kvm_amd nested=1`; `/dev/kvm` needs the udev rule (`99-kvm4all.rules`, mode 0666), then `emulator -accel-check` is happy. `-gpu swiftshader_indirect` works.
- **Image:** has an Android SDK at `/usr/local/lib/android/sdk` but no emulator/system images. Fresh: emulator 335 MB in ~5 s, API 35 image 1.67 GB in 14.7 s, ffmpeg via apt 15–18 s. `actions/cache` restores: system image 1.57 GB in 7–11 s, AVD+snapshot 2.05 GB in 6.5–9 s.
- **Boot:** cold 21–24 s; snapshot 4–5 s (also `-read-only`); a snapshot made on one runner and restored from cache loads on other runners of both sizes; 8 concurrent read-only boots 9–10 s (16 vCPU), 16 in 17–19 s (32 vCPU).
- **Density:** ~3.5–3.6 GB host RAM per emulator (2 GB raised to 2.5 GB, no sharing); idle 0.2–0.4 cores; worst-case continuous swiping ~1.8 cores each. **Hard cap 16 emulators per host**: the 17th aborts right after snapshot load and may take running ones down; adb discovers only 16 unless `ADB_LOCAL_TRANSPORT_MAX_PORT` is raised. Root cause unknown (suspect per-user `netsimd`). Applies to every host: never exceed 16 per host (per adb/user namespace).
- **Streaming via expo-device-hub:** per stream one host-side ffmpeg libx264 at 60 fps; swiping 55 fps 7.6 Mbit/s, still 5.5 fps 0.3 Mbit/s; ≈1.75–1.9 cores per stream (≈1.45 each with 4 streams). Pool hosts should cap hub fps/bitrate (`--video-fps 30`, `--video-bitrate`) for viewers.

**Decisions:** device-pool boxes default to `blacksmith-16vcpu-ubuntu-2404` with 8 emulators (12 when mostly idle; never > 16); a scheduled cache-warm job bakes system image + AVD snapshot + ffmpeg keyed on emulator version, image revision and AVD config hash (refresh at least weekly — unused entries are evicted after 7 days); fall back to a cold boot when a snapshot fails to load. Expect ~30–40 s from job start to 8 ready devices.
