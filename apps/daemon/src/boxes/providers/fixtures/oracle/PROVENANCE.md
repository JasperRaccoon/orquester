# Oracle Cloud Infrastructure fixtures

- Built 2026-10-19 (no OCI account was available) from the documented response models of the Core Services and
  Identity APIs (https://docs.oracle.com/en-us/iaas/api/#/en/iaas/20160918/, field names cross-checked against
  https://github.com/oracle/oci-go-sdk `core/*.go` and `identity/availability_domain.go`) and the documented error
  codes (https://docs.oracle.com/en-us/iaas/Content/API/References/apierrors.htm) in OCI's `{code, message}` body;
  `error-out-of-capacity` is the LaunchInstance 500 body commonly reported for A1/E-shape capacity shortages.
  List calls return bare arrays.
- `products.json` is the public price list (https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD,
  `lastUpdated` 2026-10-08), fetched 2026-10-19 and trimmed to the parts the adapter reads plus one unrelated part.
- Redacted/synthetic: every OCID's unique part (`aaaaaaaa` + repeated digits), the AD prefix (`Uocm`), public IPs
  (203.0.113.0/24), the box id and instance name (the test box id); image names and dates are representative.
