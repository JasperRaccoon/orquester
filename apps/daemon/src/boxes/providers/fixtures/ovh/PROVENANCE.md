# OVHcloud fixtures

- Shapes follow the API schema `https://eu.api.ovh.com/1.0/cloud.json` (models `cloud.flavor.Flavor`, `cloud.image.Image`, `cloud.instance.Instance`, `cloud.sshkey.SshKeyDetail`), read 2026-10-19; flavor `ram` in MB as the live API reports it.
- `catalog.json` is trimmed from the unsigned public catalog `https://eu.api.ovh.com/1.0/order/catalog/public/cloud?ovhSubsidiary=FR` fetched 2026-10-19: ten addons kept with their real prices (10⁻⁸ EUR), other addons, plans and products removed.
- `auth-time.json` is a fixed `GET /auth/time` value (2026-10-19T00:00:00Z). Error bodies follow OVH's `{ class|errorCode, message }` shape.
- Redacted: project id `1111…`, instance ids `2222…`, flavor ids `3333…`, image ids `4444…`, network ids `5555…`, SSH key ids (base64 of the key name), IPs from 203.0.113.0/24 and 2001:db8::/32; no account names or emails.
