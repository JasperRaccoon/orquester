# agent-device fixtures

`--json` answers of agent-device 0.21.31 (the version `../../tool-versions.json` pins), captured on
2026-10-27 against an Android 15 emulator (`sdk_gphone64_x86_64`, 720×1280 @ 2×) from the devices
spike stack: `agent-device --config <file> --session <s> --platform android --serial emulator-5610
--json <command> …`. Host paths were rewritten to `/tmp/orq-smoke` and `/home/user`; `fill` already
redacts its text. Nothing else was edited.

| File | Command |
|---|---|
| `devices.json` | `devices` |
| `snapshot-noopen.json` | `snapshot -i` (launcher, no `open` before it) |
| `click-settle.json` | `click @e10 --settle` (the settle stalled on a loaded host) |
| `fill-settle.json` | `fill @e64 --text-stdin --settle` |
| `scroll.json` | `scroll down --settle` |
| `swipe.json` | `swipe 360 900 360 400` |
| `screenshot.json` | `screenshot <path>` |
| `open-settings.json` | `open com.android.settings` |
| `appstate.json` | `appstate` |
| `perm-deny.json` | `settings permission deny camera --app com.android.camera2` |
| `err-ref.json` | `click @e999` (a ref outside the frame) |
| `err-cmd.json` | `bogus` (INVALID_ARGS) |
| `home3.json` | `home` after `close <app>` ended the session (SESSION_NOT_FOUND) |
