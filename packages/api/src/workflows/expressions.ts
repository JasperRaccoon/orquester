// Automated workflows — the `{{ … }}` expression language (spec §3.3).
//
// A hand-written parser and evaluator: NO eval, NO Function, no WASM, no node-only import — it runs
// in the daemon, the browser (whose CSP forbids eval) and the MCP alike. The grammar:
//
//   template   := ( text | "\{{" | "{{" expression "}}" )*
//   expression := path ( "|" filter )*
//   path       := root ( "." ident | "[" index "]" | "[" string "]" )*
//   filter     := ident ( "(" literal ( "," literal )* ")" )?
//   literal    := string | number | true | false | null
//
// Roots: nodes, input, trigger, run, project, secrets, workflow. Filters: json, compact,
// default(x), trim, lines(n), first, last, length, upper, lower.
//
// Rules that keep hostile input harmless: a template longer than MAX_TEMPLATE_LENGTH is not parsed;
// a path is at most MAX_EXPRESSION_PATH_DEPTH segments; `__proto__`, `constructor` and `prototype`
// are refused as keys; only OWN properties of plain objects and arrays are ever read (anything
// inherited reads as missing); `secrets` must name exactly one secret (never the whole store).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const EXPRESSION_ROOTS = ["nodes", "input", "trigger", "run", "project", "secrets", "workflow"] as const;
export type ExpressionRoot = (typeof EXPRESSION_ROOTS)[number];

export const EXPRESSION_FILTERS = [
  "json",
  "compact",
  "default",
  "trim",
  "lines",
  "first",
  "last",
  "length",
  "upper",
  "lower"
] as const;
export type ExpressionFilterName = (typeof EXPRESSION_FILTERS)[number];

/** A template longer than this (UTF-16 units) is not parsed: it renders as written, with an error. */
const MAX_TEMPLATE_LENGTH = 1024 * 1024;
/** Segments after the root. */
const MAX_EXPRESSION_PATH_DEPTH = 32;
const MAX_EXPRESSION_FILTERS = 16;
/** A string literal inside an expression (a `default("…")` argument, a `["key"]`). */
const MAX_EXPRESSION_LITERAL_LENGTH = 4096;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const ROOTS: ReadonlySet<string> = new Set(EXPRESSION_ROOTS);
const FILTERS: ReadonlySet<string> = new Set(EXPRESSION_FILTERS);

export type ExpressionLiteral = string | number | boolean | null;

export interface ExpressionFilter {
  name: ExpressionFilterName;
  args: ExpressionLiteral[];
}

/** Where one path segment sits in the template source (renames rewrite `nodes.<Name>` in place). */
export interface ExpressionKeySpan {
  start: number;
  end: number;
  /** `.key` → the identifier's span; `["key"]` → the string literal's span, quotes included. */
  style: "dot" | "bracket-string" | "bracket-index";
}

export interface TemplateExpression {
  kind: "expr";
  root: ExpressionRoot;
  path: (string | number)[];
  filters: ExpressionFilter[];
  /** The whole `{{ … }}` as written. */
  raw: string;
  /** The expression between the braces, trimmed — how warnings name it. */
  source: string;
  /** Offsets of `{{` and just past `}}` in the template. */
  start: number;
  end: number;
  /** One span per `path` entry. */
  keySpans: ExpressionKeySpan[];
}

export interface TemplateText {
  kind: "text";
  /** The text with `\{{` escapes resolved. */
  text: string;
  start: number;
  end: number;
}

export type TemplateSegment = TemplateText | TemplateExpression;

export interface TemplateParseError {
  message: string;
  /** The offending span in the template (a broken expression renders as its literal text). */
  start: number;
  end: number;
  /** The identifier the broken expression starts with, when there is one. */
  root?: string;
}

export interface ParsedTemplate {
  segments: TemplateSegment[];
  errors: TemplateParseError[];
}

export interface ExpressionNodeState {
  output?: unknown;
  status: string;
  error?: unknown;
}

/** What an expression reads (§3.2). */
export interface ExpressionContext {
  nodes: Record<string, ExpressionNodeState>;
  input: unknown;
  trigger: unknown;
  run: unknown;
  project: unknown;
  /** name -> value. Only `secrets.NAME` reads it; the store itself is never a value. */
  secrets: Record<string, string>;
  workflow?: unknown;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Token =
  | { t: "ident"; v: string; start: number; end: number }
  | { t: "number"; v: number; start: number; end: number }
  | { t: "string"; v: string; start: number; end: number }
  | { t: "punct"; v: "." | "[" | "]" | "|" | "(" | ")" | ","; start: number; end: number };

class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number
  ) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function tokenize(src: string, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  let i = from;
  while (i < to) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < to && IDENT_PART.test(src[i]!)) i += 1;
      tokens.push({ t: "ident", v: src.slice(start, i), start, end: i });
      continue;
    }
    if (DIGIT.test(ch) || (ch === "-" && i + 1 < to && DIGIT.test(src[i + 1]!))) {
      const start = i;
      i += 1;
      while (i < to && DIGIT.test(src[i]!)) i += 1;
      if (i + 1 < to && src[i] === "." && DIGIT.test(src[i + 1]!)) {
        i += 1;
        while (i < to && DIGIT.test(src[i]!)) i += 1;
      }
      const text = src.slice(start, i);
      if (text.length > 32) throw new ExpressionSyntaxError(`The number ${text.slice(0, 20)}… is too long`, start);
      tokens.push({ t: "number", v: Number(text), start, end: i });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      let value = "";
      i += 1;
      let closed = false;
      while (i < to) {
        const c = src[i]!;
        if (c === "\\") {
          const next = src[i + 1];
          if (next === undefined || i + 1 >= to) break;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          i += 2;
        } else if (c === quote) {
          i += 1;
          closed = true;
          break;
        } else {
          value += c;
          i += 1;
        }
        if (value.length > MAX_EXPRESSION_LITERAL_LENGTH) {
          throw new ExpressionSyntaxError(
            `A text literal is longer than ${MAX_EXPRESSION_LITERAL_LENGTH} characters`,
            start
          );
        }
      }
      if (!closed) throw new ExpressionSyntaxError("A text literal is not closed (missing quote)", start);
      tokens.push({ t: "string", v: value, start, end: i });
      continue;
    }
    if (ch === "." || ch === "[" || ch === "]" || ch === "|" || ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ t: "punct", v: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    throw new ExpressionSyntaxError(`Unexpected character "${ch}"`, i);
  }
  return tokens;
}

function describeToken(token: Token | undefined): string {
  if (token === undefined) return "the end of the expression";
  if (token.t === "string") return "a text literal";
  return `"${String(token.v)}"`;
}

const FILTER_ARITY: Record<ExpressionFilterName, { min: number; max: number }> = {
  json: { min: 0, max: 0 },
  compact: { min: 0, max: 0 },
  default: { min: 1, max: 1 },
  trim: { min: 0, max: 0 },
  lines: { min: 1, max: 1 },
  first: { min: 0, max: 0 },
  last: { min: 0, max: 0 },
  length: { min: 0, max: 0 },
  upper: { min: 0, max: 0 },
  lower: { min: 0, max: 0 }
};

function checkKey(key: string, at: number): void {
  if (FORBIDDEN_KEYS.has(key)) throw new ExpressionSyntaxError(`"${key}" cannot be read in an expression`, at);
}

function parseExpression(
  src: string,
  from: number,
  to: number
): Omit<TemplateExpression, "kind" | "raw" | "start" | "end"> {
  const tokens = tokenize(src, from, to);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];
  const isPunct = (token: Token | undefined, v: string): boolean => token?.t === "punct" && token.v === v;

  const first = next();
  if (first === undefined) throw new ExpressionSyntaxError("Empty expression", from);
  if (first.t !== "ident") {
    throw new ExpressionSyntaxError(
      `An expression starts with one of ${EXPRESSION_ROOTS.join(", ")} — not ${describeToken(first)}`,
      first.start
    );
  }
  if (!ROOTS.has(first.v)) {
    throw new ExpressionSyntaxError(
      `Unknown "${first.v}" — an expression starts with one of ${EXPRESSION_ROOTS.join(", ")}`,
      first.start
    );
  }
  const root = first.v as ExpressionRoot;
  const path: (string | number)[] = [];
  const keySpans: ExpressionKeySpan[] = [];

  while (isPunct(peek(), ".") || isPunct(peek(), "[")) {
    const opener = next()!;
    if (path.length >= MAX_EXPRESSION_PATH_DEPTH) {
      throw new ExpressionSyntaxError(`A path is at most ${MAX_EXPRESSION_PATH_DEPTH} steps deep`, opener.start);
    }
    if (opener.t === "punct" && opener.v === ".") {
      const key = next();
      if (key?.t === "number") {
        throw new ExpressionSyntaxError(`Use [${String(key.v)}] to read a list item, not .${String(key.v)}`, key.start);
      }
      if (key?.t !== "ident") {
        throw new ExpressionSyntaxError(`Expected a name after ".", found ${describeToken(key)}`, key?.start ?? to);
      }
      checkKey(key.v, key.start);
      path.push(key.v);
      keySpans.push({ start: key.start, end: key.end, style: "dot" });
      continue;
    }
    const key = next();
    if (key?.t === "number") {
      if (!Number.isSafeInteger(key.v) || key.v < 0) {
        throw new ExpressionSyntaxError("A list index is a whole number, 0 or more", key.start);
      }
      path.push(key.v);
      keySpans.push({ start: key.start, end: key.end, style: "bracket-index" });
    } else if (key?.t === "string") {
      checkKey(key.v, key.start);
      path.push(key.v);
      keySpans.push({ start: key.start, end: key.end, style: "bracket-string" });
    } else {
      throw new ExpressionSyntaxError(
        `Expected a list index or a quoted key after "[", found ${describeToken(key)}`,
        key?.start ?? to
      );
    }
    const close = next();
    if (!isPunct(close, "]")) {
      throw new ExpressionSyntaxError(`Expected "]", found ${describeToken(close)}`, close?.start ?? to);
    }
  }

  const filters: ExpressionFilter[] = [];
  while (isPunct(peek(), "|")) {
    next();
    const name = next();
    if (name?.t !== "ident") {
      throw new ExpressionSyntaxError(`Expected a filter name after "|", found ${describeToken(name)}`, name?.start ?? to);
    }
    if (!FILTERS.has(name.v)) {
      throw new ExpressionSyntaxError(
        `Unknown filter "${name.v}" — filters: ${EXPRESSION_FILTERS.join(", ")}`,
        name.start
      );
    }
    if (filters.length >= MAX_EXPRESSION_FILTERS) {
      throw new ExpressionSyntaxError(`At most ${MAX_EXPRESSION_FILTERS} filters`, name.start);
    }
    const args: ExpressionLiteral[] = [];
    if (isPunct(peek(), "(")) {
      next();
      if (!isPunct(peek(), ")")) {
        for (;;) {
          const literal = next();
          if (literal?.t === "string" || literal?.t === "number") args.push(literal.v);
          else if (literal?.t === "ident" && (literal.v === "true" || literal.v === "false")) args.push(literal.v === "true");
          else if (literal?.t === "ident" && literal.v === "null") args.push(null);
          else {
            throw new ExpressionSyntaxError(
              `A filter argument is a quoted text, a number, true, false or null — not ${describeToken(literal)}`,
              literal?.start ?? to
            );
          }
          if (isPunct(peek(), ",")) {
            next();
            continue;
          }
          break;
        }
      }
      const close = next();
      if (!isPunct(close, ")")) {
        throw new ExpressionSyntaxError(`Expected ")", found ${describeToken(close)}`, close?.start ?? to);
      }
    }
    const filterName = name.v as ExpressionFilterName;
    const arity = FILTER_ARITY[filterName];
    if (args.length < arity.min || args.length > arity.max) {
      throw new ExpressionSyntaxError(
        arity.max === 0
          ? `The filter "${filterName}" takes no arguments`
          : `The filter "${filterName}" takes ${arity.min === arity.max ? arity.min : `${arity.min}–${arity.max}`} argument${arity.max === 1 ? "" : "s"}`,
        name.start
      );
    }
    if (filterName === "lines") {
      const n = args[0];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
        throw new ExpressionSyntaxError('lines(n) takes a whole number, e.g. lines(20)', name.start);
      }
    }
    filters.push({ name: filterName, args });
  }

  const rest = peek();
  if (rest !== undefined) {
    throw new ExpressionSyntaxError(
      isPunct(rest, "|") ? `Unexpected "|"` : `Unexpected ${describeToken(rest)} — use "|" before a filter`,
      rest.start
    );
  }
  return { root, path, filters, source: src.slice(from, to).trim(), keySpans };
}

/** Finds the `}}` that closes an expression opened at `from`, skipping quoted text. -1 when none. */
function findClose(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < src.length - 1; i += 1) {
    const ch = src[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "}" && src[i + 1] === "}") return i;
  }
  return -1;
}

function leadingIdentifier(src: string, from: number, to: number): string | undefined {
  const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(from, Math.min(to, from + 64)));
  return match?.[1];
}

/** Parse a template into text and expression segments. A broken expression becomes literal text plus an error. */
export function parseTemplate(src: string): ParsedTemplate {
  if (typeof src !== "string") return { segments: [], errors: [] };
  if (src.length > MAX_TEMPLATE_LENGTH) {
    return {
      segments: [{ kind: "text", text: src, start: 0, end: src.length }],
      errors: [
        {
          message: `This text is longer than ${MAX_TEMPLATE_LENGTH} characters; its {{ … }} expressions are not read`,
          start: 0,
          end: src.length
        }
      ]
    };
  }
  const segments: TemplateSegment[] = [];
  const errors: TemplateParseError[] = [];
  let text = "";
  let textStart = 0;
  const appendText = (chunk: string, at: number): void => {
    if (chunk.length === 0) return;
    if (text.length === 0) textStart = at;
    text += chunk;
  };
  const flushText = (end: number): void => {
    if (text.length > 0) segments.push({ kind: "text", text, start: textStart, end });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) {
      appendText(src.slice(i), i);
      break;
    }
    if (open > i && src[open - 1] === "\\") {
      // `\{{` — a literal "{{".
      appendText(src.slice(i, open - 1), i);
      appendText("{{", open - 1);
      i = open + 2;
      continue;
    }
    appendText(src.slice(i, open), i);
    let close = findClose(src, open + 2);
    if (close < 0) close = src.indexOf("}}", open + 2);
    if (close < 0) {
      errors.push({
        message: 'An expression is not closed: "{{" without "}}" (write \\{{ for literal braces)',
        start: open,
        end: src.length,
        root: leadingIdentifier(src, open + 2, src.length)
      });
      appendText(src.slice(open), open);
      break;
    }
    const end = close + 2;
    try {
      const parsed = parseExpression(src, open + 2, close);
      flushText(open);
      segments.push({ kind: "expr", raw: src.slice(open, end), start: open, end, ...parsed });
    } catch (error) {
      const message = error instanceof ExpressionSyntaxError ? error.message : "Invalid expression";
      errors.push({ message, start: open, end, root: leadingIdentifier(src, open + 2, close) });
      appendText(src.slice(open, end), open);
    }
    i = end;
  }
  flushText(src.length);
  return { segments, errors };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ExpressionResult {
  value: unknown;
  /** True when the path read nothing (and no `default` filled it). */
  missing: boolean;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function readKey(current: unknown, key: string | number): { found: boolean; value?: unknown } {
  if (Array.isArray(current)) {
    if (typeof key === "number") return key < current.length ? { found: true, value: current[key] } : { found: false };
    if (key === "length") return { found: true, value: current.length };
    return { found: false };
  }
  if (isPlainObject(current)) {
    const name = String(key);
    if (FORBIDDEN_KEYS.has(name) || !hasOwn(current, name)) return { found: false };
    return { found: true, value: current[name] };
  }
  return { found: false };
}

function formatPath(root: string, path: readonly (string | number)[]): string {
  let out = root;
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) out += `.${key}`;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out;
}

/** JSON text of a value; `null` when it cannot be serialized (a cycle, a BigInt). */
export function stringifyExpressionValue(value: unknown, pretty = true): string | null {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value, null, pretty ? 2 : undefined);
    return text === undefined ? "" : text;
  } catch {
    return null;
  }
}

/** How a value is inserted into text: a string as is, anything else as pretty JSON, a missing value as "". */
export function expressionValueToText(value: unknown): string {
  if (typeof value === "string") return value;
  return stringifyExpressionValue(value, true) ?? "";
}

function isEmptyForDefault(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Evaluate one parsed expression against a context. Never throws. */
export function evaluateExpression(expr: TemplateExpression, ctx: ExpressionContext): ExpressionResult {
  const warnings: string[] = [];
  let missing = false;
  let missingAt = "";
  let value: unknown;

  if (expr.root === "secrets") {
    const name = expr.path[0];
    if (expr.path.length !== 1 || typeof name !== "string") {
      warnings.push(`{{ ${expr.source} }}: name exactly one secret, e.g. secrets.API_TOKEN`);
      missing = true;
      missingAt = formatPath("secrets", expr.path);
    } else {
      const secrets = isPlainObject(ctx.secrets) ? ctx.secrets : {};
      if (hasOwn(secrets, name) && typeof secrets[name] === "string") value = secrets[name];
      else {
        missing = true;
        missingAt = formatPath("secrets", [name]);
      }
    }
  } else {
    const rootValue = hasOwn(ctx, expr.root) ? (ctx as unknown as Record<string, unknown>)[expr.root] : undefined;
    if (rootValue === undefined) {
      missing = true;
      missingAt = expr.root;
    } else {
      value = rootValue;
      for (let index = 0; index < expr.path.length; index += 1) {
        const step = readKey(value, expr.path[index]!);
        if (!step.found || step.value === undefined) {
          missing = true;
          missingAt = formatPath(expr.root, expr.path.slice(0, index + 1));
          value = undefined;
          break;
        }
        value = step.value;
      }
    }
  }
  if (missing) value = undefined;

  for (const filter of expr.filters) {
    if (filter.name === "default") {
      if (missing || isEmptyForDefault(value)) {
        value = filter.args[0];
        missing = false;
      }
      continue;
    }
    if (missing) continue;
    switch (filter.name) {
      case "json":
      case "compact": {
        const text = stringifyExpressionValue(value, filter.name === "json");
        if (text === null) {
          warnings.push(`{{ ${expr.source} }}: the value cannot be written as JSON`);
          missing = true;
          value = undefined;
        } else value = text;
        break;
      }
      case "trim":
        value = expressionValueToText(value).trim();
        break;
      case "upper":
        value = expressionValueToText(value).toUpperCase();
        break;
      case "lower":
        value = expressionValueToText(value).toLowerCase();
        break;
      case "lines": {
        const n = filter.args[0] as number;
        value = expressionValueToText(value).split(/\r?\n/).slice(0, n).join("\n");
        break;
      }
      case "first":
      case "last": {
        const list = Array.isArray(value) ? value : typeof value === "string" ? Array.from(value) : null;
        if (list === null) {
          warnings.push(`{{ ${expr.source} }}: "${filter.name}" needs a list or a text`);
          missing = true;
          value = undefined;
        } else if (list.length === 0) {
          missing = true;
          missingAt = `${expr.source} (empty)`;
          value = undefined;
        } else {
          value = filter.name === "first" ? list[0] : list[list.length - 1];
          if (value === undefined) missing = true;
        }
        break;
      }
      case "length":
        if (Array.isArray(value)) value = value.length;
        else if (typeof value === "string") value = Array.from(value).length;
        else if (isPlainObject(value)) value = Object.keys(value).length;
        else {
          warnings.push(`{{ ${expr.source} }}: "length" needs a list, a text or an object`);
          missing = true;
          value = undefined;
        }
        break;
      default: {
        const unhandled: never = filter.name;
        void unhandled;
      }
    }
  }

  if (missing && warnings.length === 0) {
    warnings.push(`{{ ${expr.source} }} is empty: nothing at ${missingAt || expr.source}`);
  }
  return { value: missing ? undefined : value, missing, warnings };
}

export interface RenderOptions {
  /** Applied to every inserted value (e.g. `escapePromptVariables` before the `{variables}` pass). */
  escapeValue?: (text: string) => string;
}

export interface RenderResult {
  text: string;
  warnings: string[];
}

function parseErrorWarning(error: TemplateParseError): string {
  return `Template error: ${error.message}`;
}

/** Render a template to text. Missing values insert "" and warn; broken expressions stay as written and warn. */
export function renderTemplate(src: string, ctx: ExpressionContext, opts: RenderOptions = {}): RenderResult {
  if (typeof src !== "string") return { text: "", warnings: [] };
  const parsed = parseTemplate(src);
  const warnings = parsed.errors.map(parseErrorWarning);
  let text = "";
  for (const segment of parsed.segments) {
    if (segment.kind === "text") {
      text += segment.text;
      continue;
    }
    const result = evaluateExpression(segment, ctx);
    warnings.push(...result.warnings);
    const inserted = expressionValueToText(result.value);
    text += opts.escapeValue ? opts.escapeValue(inserted) : inserted;
  }
  return { text, warnings };
}

/** The single expression a template consists of (whitespace around it allowed), else null. */
export function singleExpression(src: string): TemplateExpression | null {
  const parsed = parseTemplate(src);
  if (parsed.errors.length > 0) return null;
  let found: TemplateExpression | null = null;
  for (const segment of parsed.segments) {
    if (segment.kind === "text") {
      if (segment.text.trim().length > 0) return null;
      continue;
    }
    if (found !== null) return null;
    found = segment;
  }
  return found;
}

/**
 * Render a template to a VALUE: a template that is exactly one `{{ … }}` (whitespace around it
 * allowed) yields the raw value — a number stays a number, an object an object, a missing path
 * `undefined` — anything else renders to text.
 */
export function renderTemplateValue(src: string, ctx: ExpressionContext): { value: unknown; warnings: string[] } {
  const single = typeof src === "string" ? singleExpression(src) : null;
  if (single !== null) {
    const result = evaluateExpression(single, ctx);
    return { value: result.value, warnings: result.warnings };
  }
  const rendered = renderTemplate(src, ctx);
  return { value: rendered.text, warnings: rendered.warnings };
}

// ---------------------------------------------------------------------------
// Static analysis (validation, renames)
// ---------------------------------------------------------------------------

export interface TemplateReference {
  root: ExpressionRoot;
  path: (string | number)[];
  source: string;
  start: number;
  end: number;
}

/** Every well-formed expression's path, in order. */
export function templateReferences(src: string): TemplateReference[] {
  if (typeof src !== "string" || !src.includes("{{")) return [];
  return parseTemplate(src)
    .segments.filter((segment): segment is TemplateExpression => segment.kind === "expr")
    .map((segment) => ({
      root: segment.root,
      path: segment.path,
      source: segment.source,
      start: segment.start,
      end: segment.end
    }));
}

/**
 * True when the text uses (or tries to use) a workflow expression: a well-formed `{{ … }}`, or a
 * broken one that starts with a root name. `{{.State}}`-style text (a Go template in a docker
 * command) is not a workflow expression; `\{{` is an escape.
 */
export function hasTemplate(src: string): boolean {
  if (typeof src !== "string" || !src.includes("{{")) return false;
  const parsed = parseTemplate(src);
  if (parsed.segments.some((segment) => segment.kind === "expr")) return true;
  return parsed.errors.some((error) => error.root !== undefined && ROOTS.has(error.root));
}

/**
 * Rewrite every `nodes.<fromName>` (and `nodes["fromName"]`) reference to `toName`, leaving the rest
 * of the text byte-for-byte as written. Broken expressions are not touched.
 */
export function rewriteNodeReferences(src: string, fromName: string, toName: string): string {
  if (typeof src !== "string" || fromName === toName || !src.includes("{{")) return src;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const segment of parseTemplate(src).segments) {
    if (segment.kind !== "expr" || segment.root !== "nodes" || segment.path[0] !== fromName) continue;
    const span = segment.keySpans[0];
    if (span === undefined) continue;
    if (span.style === "dot") edits.push({ start: span.start, end: span.end, text: toName });
    else if (span.style === "bracket-string") {
      const quote = src[span.start] === "'" ? "'" : '"';
      edits.push({ start: span.start, end: span.end, text: `${quote}${toName}${quote}` });
    }
  }
  let out = src;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
