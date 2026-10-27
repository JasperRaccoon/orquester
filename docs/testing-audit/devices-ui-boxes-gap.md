# Devices UI boxes coverage gap

Audited exactly five new cases from`610d3c53` that were absent from prior ownership ledgers. Outcomes: REWRITE3, KEEP2. No declarations added or removed. Earlier audits own other cases in these three files.

The [JSON ledger](devices-ui-boxes-gap.json) contains exact original path/line/name and final aliases, every six-part behavioral-bar justification, independent source and validation command.

The pairing parser contained a real shell-safety gap: the URL wildcard admitted command separators/substitutions within an otherwise valid curl command. The retained security case now holds metadata/expiry valid while rejecting raw embedded shell syntax. The client guard checks captured URL bytes; the boxes owner independently tightened the authoritative generator URL policy. Normal command format is unchanged.

The UI workflow drops exact countdown/copy checks while retaining name validation, command bytes, macOS privilege guidance, live pairing and cancellation. The no-turn selector now isolates an approved-state negative from thread ownership, and its grammar-only indicator assertions are removed. BYO wire compatibility stays.

Exclusive validation completed: the original610d UI parser passes both valid command controls but fails allfive intended rejection assertions for embedded shell syntax; the fixed parser passes7/7. The three affected UI files pass82/82tests (3507.45ms runner time). Restoring the old backend URL policy with a loader fails the intended raw-character rejection; the current complete bootstrap file passes16/16 (946.34ms). Logs and exact commands are in JSON. Repository-wide gates remain parent-owned; no speedup is claimed.

| Original identity | Outcome | Distinct retained contract |
| --- | --- | --- |
| packages/ui/src/components/boxes/settings/boxes-settings.dom.test.ts:451 — Add your machine shows the one-line command and follows the pairing live, then lists the machine | REWRITE | Add-your-machine validates a name, displays the exact one-line pairing command with macOS user-session guidance, follows live pairing and enables the connected device-host control. |
| packages/ui/src/components/boxes/settings/boxes-settings.dom.test.ts:474 — a pairing can be cancelled from the dialog | KEEP | Cancel pairing removes that machine and closes the one-time command dialog. |
| packages/ui/src/components/boxes/surfaces/box-surfaces.logic.test.ts:424 — picks the project row's no-turn pending sets of its box | REWRITE | Project row shows pending config approvals only for its box and changes made outside a chat turn. |
| packages/ui/src/lib/boxes/store.test.ts:525 — keeps the machine purpose, the new states, the device-host flag and the byo fields | KEEP | UI wire parser preserves BYO machine purpose/pairing/offline states, deviceHost boolean and BYO metadata, repairing optional metadata safely. |
| packages/ui/src/lib/boxes/store.test.ts:537 — a pairing answer is kept only with a curl … \| sh command to the pair route | REWRITE | Only an actual curl URL to the pairing route followed by sh is offered; shell-active URL bytes or missing mandatory pairing metadata must be rejected. |
