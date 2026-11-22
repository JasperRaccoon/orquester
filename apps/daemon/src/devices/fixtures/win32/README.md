# Windows Android host fixtures

Output of the PowerShell scripts in `hosts/box/win32-remote.ts`, captured 2026-11-22 read-only on
the owner's mini PC (Windows 10 Pro 22H2 build 19045, Ryzen 7 4800U, Radeon iGPU, WHPX on, `user`
signed in at the console, no Android SDK, Java or Node), run over SSH as `user` (so
`profileSource` is `self`; as orq-agent's LocalSystem service it is `console`).

| File | Script | Redaction |
|---|---|---|
| `probe-minipc.txt` | `WIN_PROBE_SCRIPT` | host name → `DESKTOP-EXAMPLE` |
| `processes-one.txt` | `WIN_PROCESSES_SCRIPT` with `ORQ_PID` (explorer.exe) | none |
| `processes-all.txt` | `WIN_PROCESSES_SCRIPT`, five of its 141 rows | rows dropped |
| `tcp.txt` | `WIN_TCP_SCRIPT`, four of its rows | addresses → documentation / tailnet examples |
| `accel-check-kvm.txt` | `emulator -accel-check` (emulator 37.2.12 on a Linux host; the Windows build prints the same frame with a WHPX line) | none |
