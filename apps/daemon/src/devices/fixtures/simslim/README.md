# simslim fixtures

`--json` answers of simslim 0.13.0 (the release `boxes/github/device-cache.ts` pins), written from
its Go structs (`output.go` `TopOutput`/`TopSim`, `verify.go` `VerifyResult`, `measure.go`
`Measurement`; `Device` embeds `udid`, `name`, `state`, `platform`, `osVersion`, `set`): field names,
`omitempty` fields left out, an empty slice of booted simulators as `null`. UDIDs are made up.

| File | Command |
|---|---|
| `top.json` | `simslim top --json`: a slim lease simulator, the owner's stock one, one that could not be read |
| `top-empty.json` | `simslim top --json` with nothing booted |
| `verify-ok.json` | `simslim verify <udid> --profile <file> --json` (exit 0) |
| `verify-drift.json` | the same with drift (exit 1) |
| `top-captured.json` | `simslim top --json` captured on a Blacksmith `macos-26` 6 vCPU runner (2026-10-27, iOS 27.0): three slim iPhone 17 Pro simulators 45 s after boot (pretty-printed; nothing else edited) |
