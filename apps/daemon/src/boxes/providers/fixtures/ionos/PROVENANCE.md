# IONOS Cloud fixtures

- Built 2026-10-19 from the Cloud API v6 reference (https://api.ionos.com/docs/cloud/v6/ and the per-endpoint pages under
  https://docs.ionos.com/cloud/api-reference/cloud-api-v6/: Get Locations, Create a Server, Retrieve request status) and
  the `@ionos-cloud/sdk-nodejs` 6.1.5 models; no account was used.
- `error-unauthorized` is the body the API returned to an unauthenticated `/locations` call on 2026-10-19; the other
  error bodies follow the documented `{httpStatus, messages: [{errorCode, message}]}` shape.
- The image aliases in `locations` are illustrative values in the documented `os:version` form; `us/ewr` lists no
  `ubuntu:24.04` on purpose.
- Redacted: data center, server, volume, NIC, request and user ids are `1111…`-style UUIDs; user names and emails are
  omitted; public IPs are in 203.0.113.0/24; the box id and name are the test box's.
