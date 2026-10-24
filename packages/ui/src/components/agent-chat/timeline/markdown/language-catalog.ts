/**
 * The grammar catalog behind `languages.ts`: `@codemirror/language-data`'s
 * `LanguageDescription`s, by name, alias and extension. Its own chunk, loaded
 * with the first fenced code block — `@codemirror/language` reaches
 * `@codemirror/view`, which no first paint should wait on.
 */

import type { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

import type { LanguageEntry } from "./highlight-core";

export type CatalogEntry = LanguageEntry & { description: LanguageDescription };

export const ENTRIES: readonly CatalogEntry[] = languages.map((description) => ({
  name: description.name,
  alias: description.alias,
  extensions: description.extensions,
  description
}));
