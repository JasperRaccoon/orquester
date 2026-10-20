# Vultr fixtures

- Recorded 2026-10-19 from the live API (`https://api.vultr.com/v2`) by the t2 live tests (one Linux and one
  Windows instance): `plans`, `regions`, `os` (trimmed to a few entries each), `create-instance`,
  `create-instance-windows`, `create-startup-script`, `instance-installing`, `instance-running`,
  `instances-managed`, `instances-empty`, `startup-scripts-empty`, `error-not-found`, `error-unauthorized`.
- Redacted: instance and startup-script ids replaced, public IPs moved to 203.0.113.0/24 and 2001:db8::/32, the box
  id and instance name replaced with the test box id, `default_password` and the noVNC console URL token replaced,
  the boot script body replaced.
