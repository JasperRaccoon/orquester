/** Display form of a managed-account label: drop the email domain so tabs, the
 *  launch picker and the usage panel show "jaspersitouwu", not the full address.
 *  Non-email labels (user-typed Claude names) pass through unchanged. */
export function shortAccountLabel(label: string | undefined | null): string {
  if (!label) return "";
  const at = label.indexOf("@");
  return at > 0 ? label.slice(0, at) : label;
}
