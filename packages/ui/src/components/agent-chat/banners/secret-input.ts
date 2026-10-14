/**
 * The hidden-value field both cards use: a question marked `isSecret`
 * (`QuestionCard`) and an agent's `request_secret` (`SecretRequestCard`).
 *
 * Masked, never autocompleted, spell-checked or offered to a password
 * manager (the value is not a login of this app), and never written anywhere
 * by the card: it lives in the card's state until the answer is sent.
 */

/** The card's text-field look. */
export const CARD_INPUT_CLASS =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50";

/** Spread onto the `<input>` of a secret value. */
export const SECRET_INPUT_ATTRIBUTES = {
  type: "password",
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  // Password managers otherwise offer to save or fill the field.
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true
} as const;
