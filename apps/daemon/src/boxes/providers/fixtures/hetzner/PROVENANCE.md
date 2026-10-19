# Hetzner Cloud fixtures

- Recorded 2026-10-19 from the live API (`https://api.hetzner.cloud/v1`) by the t2 live test: `server-types`,
  `locations`, `images`, `pricing` (trimmed to a few entries), `create-server`, `server-running`, `servers-managed`,
  `delete-server`, `error-not-found`, `error-unauthorized`, `servers-empty`.
- Redacted: server, IP and action ids renumbered; public IPs moved to 203.0.113.0/24 and 2001:db8::/32; the box id
  and instance name replaced with the test box id; `root_password` replaced. `servers-managed` has a second,
  synthesized server.
- From the documented error shape (https://docs.hetzner.cloud/reference/cloud#errors): `error-unavailable`,
  `error-rate-limit`.
