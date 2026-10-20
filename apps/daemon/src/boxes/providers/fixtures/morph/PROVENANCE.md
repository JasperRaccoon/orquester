# Morph Cloud fixtures

- Built 2026-10-19 from the schemas and examples in https://cloud.morph.so/api/openapi.json (`ImageModelCollection`,
  `SnapshotModel`, `InstanceModel`, `InstanceExecResponse`, FastAPI `detail` errors) and
  https://cloud.morph.so/docs/api-reference; no key was available, so no response is a live capture.
- `error-unauthorized` is the body (`text/plain` `unauthorized`) the live API returned 2026-10-19 without a key.
- Synthesized: the `morphvm-sandbox` image, the second and third instances in `instances-managed`, and the wording of
  `error-not-found`, `error-unavailable` and `error-rate-limit`.
- Redacted: snapshot and instance ids renumbered (`…_11111111`), the box id and names replaced with the test box id,
  internal IP set to 10.0.0.2; no organization ids or emails.
