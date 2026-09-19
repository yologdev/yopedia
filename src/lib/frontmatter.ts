// ---------------------------------------------------------------------------
// YAML frontmatter (constrained subset)
// ---------------------------------------------------------------------------
//
// We intentionally DO NOT use a real YAML library. The set of values we need
// to persist on a wiki page is tiny (a handful of string scalars plus an
// inline array of tag strings), and a full YAML parser invites schema drift
// and subtle round-trip bugs. Instead we support exactly three value kinds:
//
//   key: value              → string (trimmed, surrounding quotes stripped)
//   key: "value with :"     → quoted string
//   key: [a, b, "c d"]      → inline string array
//
// Anything else — block scalars, nested objects, anchors, multi-line strings,
// block arrays — throws. This is by design.

import { logger } from "@/lib/logger";

/** A parsed frontmatter object. Values are strings, string arrays, numbers, or booleans. */
export interface Frontmatter {
  [key: string]: string | string[] | number | boolean;
}

/** Result of {@link parseFrontmatter}: the frontmatter object plus body. */
export interface ParsedPage {
  data: Frontmatter;
  body: string;
}

/**
 * Strip surrounding single or double quotes from a scalar string, if present.
 * Only strips matching pairs.
 */
function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"') {
      // Unescape backslash-escaped double quotes produced by the serializer.
      return trimmed.slice(1, -1).replace(/\\"/g, '"');
    }
    if (first === "'" && last === "'") {
      // Single-quoted YAML strings don't use backslash escaping.
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Returns true if the raw value (trimmed) is surrounded by matching quotes. */
function isQuoted(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'");
}

/**
 * Coerce an unquoted scalar string to number or boolean when appropriate.
 * Returns the original string if no coercion applies.
 */
function coerceScalar(value: string): string | number | boolean {
  // Boolean coercion (exact match only)
  if (value === "true") return true;
  if (value === "false") return false;
  // Number coercion: must match an integer or decimal (possibly negative)
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// ---------------------------------------------------------------------------
// Schema-aware type normalization
// ---------------------------------------------------------------------------
//
// LLMs sometimes produce quoted numbers/booleans in YAML frontmatter, e.g.
// `confidence: "0.7"`. The generic parser intentionally keeps quoted values as
// strings (correct for arbitrary keys). But for *known schema fields* with
// defined types, we need to coerce to the correct type so downstream code that
// does `typeof confidence === "number"` gets the right answer.
//
// Length and content guards (layer 2 structural backstop):
// LLMs can dump multi-KB reasoning text into frontmatter fields. These guards
// truncate or drop oversized values after type coercion, logging warnings so
// operators can detect the pattern. Inspired by Graphiti v0.29.1's
// cap_string_attributes defense.

/** ISO date pattern: YYYY-MM-DD */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- Length guard constants ---------------------------------------------------
/** @internal exported for testing */
export const TITLE_MAX_CHARS = 300;
export const ALIASES_MAX_ITEMS = 20;
export const ALIASES_MAX_ITEM_CHARS = 200;
export const AUTHORS_MAX_ITEMS = 50;
export const AUTHORS_MAX_ITEM_CHARS = 100;
export const CONTRIBUTORS_MAX_ITEMS = 50;
export const CONTRIBUTORS_MAX_ITEM_CHARS = 100;
export const SUPERSEDES_MAX_CHARS = 200;
export const OWNER_MAX_CHARS = 100;
export const TAGS_MAX_ITEMS = 30;
export const TAGS_MAX_ITEM_CHARS = 100;

/** Truncate a string to `max` characters, logging a warning if truncated. */
function guardString(field: string, value: string, max: number): string {
  if (value.length > max) {
    logger.warn(
      "frontmatter",
      `Truncating ${field}: ${value.length} chars exceeds max ${max}`,
    );
    return value.slice(0, max);
  }
  return value;
}

/**
 * Guard an array field: drop items exceeding `maxItemChars`, truncate the
 * array to `maxItems`, and optionally deduplicate.
 */
function guardArray(
  field: string,
  items: string[],
  maxItems: number,
  maxItemChars: number,
  deduplicate = false,
): string[] {
  let result = items;

  // Drop items that exceed the per-item length limit
  result = result.filter((item) => {
    if (item.length > maxItemChars) {
      logger.warn(
        "frontmatter",
        `Dropping ${field} item (${item.length} chars exceeds max ${maxItemChars}): "${item.slice(0, 50)}…"`,
      );
      return false;
    }
    return true;
  });

  // Deduplicate if requested (case-sensitive)
  if (deduplicate) {
    const seen = new Set<string>();
    result = result.filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  // Truncate to max number of items
  if (result.length > maxItems) {
    logger.warn(
      "frontmatter",
      `Truncating ${field} array: ${result.length} items exceeds max ${maxItems}`,
    );
    result = result.slice(0, maxItems);
  }

  return result;
}

/**
 * Normalize known schema fields to their expected types after parsing.
 * Mutates `data` in place. Fields that can't be coerced are deleted
 * (absent is safer than wrong-type for downstream consumers).
 *
 * Also applies length/content guards as a structural backstop against
 * LLM-generated frontmatter with oversized or hallucinated field values.
 */
export function normalizeTypedFields(data: Frontmatter): void {
  // --- confidence: number 0-1 ---
  if ("confidence" in data) {
    const raw = data.confidence;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (isNaN(n)) {
      logger.warn("frontmatter", `Removing non-numeric confidence: ${JSON.stringify(raw)}`);
      delete data.confidence;
    } else {
      data.confidence = Math.max(0, Math.min(1, n));
    }
  }

  // --- disputed: boolean ---
  if ("disputed" in data) {
    const raw = data.disputed;
    if (typeof raw === "boolean") {
      // already correct
    } else if (raw === "true" || raw === "1") {
      data.disputed = true;
    } else if (raw === "false" || raw === "0" || raw === "") {
      data.disputed = false;
    } else {
      logger.warn("frontmatter", `Removing non-boolean disputed: ${JSON.stringify(raw)}`);
      delete data.disputed;
    }
  }

  // --- expiry: string in ISO date format ---
  if ("expiry" in data) {
    const raw = String(data.expiry);
    if (ISO_DATE_RE.test(raw)) {
      data.expiry = raw;
    } else {
      logger.warn("frontmatter", `Removing invalid expiry date: ${JSON.stringify(data.expiry)}`);
      delete data.expiry;
    }
  }

  // --- valid_from: string in ISO date format ---
  if ("valid_from" in data) {
    const raw = String(data.valid_from);
    if (ISO_DATE_RE.test(raw)) {
      data.valid_from = raw;
    } else {
      logger.warn("frontmatter", `Removing invalid valid_from date: ${JSON.stringify(data.valid_from)}`);
      delete data.valid_from;
    }
  }

  // --- title: string, max 300 chars ---
  if ("title" in data && typeof data.title === "string") {
    data.title = guardString("title", data.title, TITLE_MAX_CHARS);
  }

  // --- supersedes: string (slug), max 200 chars ---
  if ("supersedes" in data && typeof data.supersedes === "string") {
    data.supersedes = guardString("supersedes", data.supersedes, SUPERSEDES_MAX_CHARS);
  }

  // --- owner: string (principal handle), max 100 chars ---
  if ("owner" in data && typeof data.owner === "string") {
    data.owner = guardString("owner", data.owner, OWNER_MAX_CHARS);
  }

  // --- visibility: "public" | "private" (anything else → public) ---
  if ("visibility" in data) {
    data.visibility = data.visibility === "private" ? "private" : "public";
  }

  // --- array fields: authors, contributors, aliases → string[] ---
  for (const key of ["authors", "contributors", "aliases"] as const) {
    if (!(key in data)) continue;
    const raw = data[key];
    if (Array.isArray(raw)) {
      // already an array — keep it
    } else if (typeof raw === "string" && raw !== "") {
      data[key] = [raw];
    } else if (typeof raw === "string" && raw === "") {
      // empty string → empty array
      data[key] = [];
    } else {
      // unexpected type (number, boolean) — wrap string representation
      data[key] = [String(raw)];
    }
  }

  // --- tags: ensure array ---
  if ("tags" in data) {
    const raw = data.tags;
    if (Array.isArray(raw)) {
      // already an array
    } else if (typeof raw === "string" && raw !== "") {
      data.tags = [raw];
    } else if (typeof raw === "string" && raw === "") {
      data.tags = [];
    } else {
      data.tags = [String(raw)];
    }
  }

  // --- Length guards on array fields ---
  if ("aliases" in data && Array.isArray(data.aliases)) {
    data.aliases = guardArray(
      "aliases",
      data.aliases as string[],
      ALIASES_MAX_ITEMS,
      ALIASES_MAX_ITEM_CHARS,
      true, // deduplicate aliases
    );
  }

  if ("authors" in data && Array.isArray(data.authors)) {
    data.authors = guardArray(
      "authors",
      data.authors as string[],
      AUTHORS_MAX_ITEMS,
      AUTHORS_MAX_ITEM_CHARS,
    );
  }

  if ("contributors" in data && Array.isArray(data.contributors)) {
    data.contributors = guardArray(
      "contributors",
      data.contributors as string[],
      CONTRIBUTORS_MAX_ITEMS,
      CONTRIBUTORS_MAX_ITEM_CHARS,
    );
  }

  if ("tags" in data && Array.isArray(data.tags)) {
    data.tags = guardArray(
      "tags",
      data.tags as string[],
      TAGS_MAX_ITEMS,
      TAGS_MAX_ITEM_CHARS,
    );
  }
}

/**
 * Split an inline YAML array body like `a, b, "c, d"` into its elements,
 * respecting quoted substrings so commas inside quotes don't split.
 *
 * A quote character only DELIMITS when it opens an element (the YAML flow-scalar
 * rule). Mid-element it is literal text, so a plain apostrophe — `it's allowed` —
 * stays one unquoted element instead of opening a string that never closes.
 */
function splitInlineArray(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      // Inside a double-quoted element `\"` is an escaped quote — the mirror of
      // serializeFrontmatter's escaping — and must not close the string.
      if (quote === '"' && ch === "\\" && i + 1 < inner.length) {
        buf += inner[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    // Opening position only: nothing but whitespace accumulated so far.
    if ((ch === '"' || ch === "'") && buf.trim() === "") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (quote) {
    throw new Error("Invalid frontmatter: unterminated quoted string in array");
  }
  // Allow a trailing empty element only when the input was entirely empty
  // (i.e. `[]`); otherwise push the last accumulated buffer.
  if (inner.trim().length > 0 || parts.length > 0) {
    parts.push(buf);
  }
  return parts
    .map((p) => unquoteScalar(p))
    .filter((p, idx, arr) => !(p === "" && arr.length === 1));
}

/**
 * Parse a markdown document that may begin with a `---\n...\n---\n` YAML
 * frontmatter block. Returns empty data and the full content as body when
 * no frontmatter is present. Throws on malformed frontmatter.
 *
 * Supported value types (see module comment above):
 *   - Scalars: `key: value` or `key: "quoted"`
 *   - Inline arrays: `tags: [a, b, "c d"]`
 *
 * Unsupported (throws):
 *   - Block scalars (`|` or `>`)
 *   - Nested mappings (`key:` followed by indented children)
 *   - Block arrays (`- item` on subsequent lines)
 *   - YAML anchors or references
 */
export function parseFrontmatter(content: string): ParsedPage {
  // Fast path: no frontmatter marker.
  if (!content.startsWith("---\n") && content !== "---" && !content.startsWith("---\r\n")) {
    return { data: {}, body: content };
  }

  // Normalize the opening delimiter line end so indexOf works.
  const rest = content.slice(content.indexOf("\n") + 1);
  // Find the closing `---` line (must be on its own line).
  const closeMatch = rest.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error("Invalid frontmatter: missing closing `---` delimiter");
  }
  const yamlBlock = rest.slice(0, closeMatch.index);
  // Body starts after the closing delimiter line.
  let bodyStart = closeMatch.index + closeMatch[0].length;
  // Consume the newline that follows the closing delimiter, if any.
  if (rest[bodyStart] === "\n") bodyStart += 1;
  else if (rest[bodyStart] === "\r" && rest[bodyStart + 1] === "\n") bodyStart += 2;
  // And optionally a single blank line separator.
  if (rest[bodyStart] === "\n") bodyStart += 1;
  const body = rest.slice(bodyStart);

  const data: Frontmatter = {};
  const lines = yamlBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip blank lines and comments.
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Reject block scalars and block arrays upfront — they start with `- ` or
    // have indented continuation.
    if (/^\s+\S/.test(line)) {
      throw new Error(
        `Invalid frontmatter: indented/nested values are not supported ("${line.trim()}")`,
      );
    }
    if (line.trimStart().startsWith("- ")) {
      throw new Error(
        "Invalid frontmatter: block arrays (`- item`) are not supported",
      );
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid frontmatter: missing \`:\` in line "${line}"`);
    }
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();

    if (key === "") {
      throw new Error(`Invalid frontmatter: empty key in line "${line}"`);
    }

    // Reject block scalars and empty-value-with-children (nested objects).
    if (valueRaw === "" || valueRaw === "|" || valueRaw === ">") {
      // If the next non-blank line is indented, this is a nested object or
      // block scalar — both unsupported.
      const next = lines[i + 1];
      if (next !== undefined && /^\s+\S/.test(next)) {
        throw new Error(
          "Invalid frontmatter: nested objects and block scalars are not supported",
        );
      }
      if (valueRaw === "|" || valueRaw === ">") {
        throw new Error(
          "Invalid frontmatter: block scalars (`|`, `>`) are not supported",
        );
      }
      // Bare `key:` with nothing after — treat as empty string.
      data[key] = "";
      continue;
    }

    // Reject YAML anchors/aliases.
    if (valueRaw.startsWith("&") || valueRaw.startsWith("*")) {
      throw new Error(
        "Invalid frontmatter: YAML anchors and aliases are not supported",
      );
    }

    // Inline array?
    if (valueRaw.startsWith("[")) {
      if (!valueRaw.endsWith("]")) {
        throw new Error(
          `Invalid frontmatter: malformed inline array in line "${line}"`,
        );
      }
      const inner = valueRaw.slice(1, -1);
      data[key] = splitInlineArray(inner);
      continue;
    }

    // Plain scalar.
    // Quoted values always stay as strings; unquoted values get type coercion.
    if (isQuoted(valueRaw)) {
      data[key] = unquoteScalar(valueRaw);
    } else {
      data[key] = coerceScalar(unquoteScalar(valueRaw));
    }
  }

  normalizeTypedFields(data);

  return { data, body };
}

/**
 * Non-throwing {@link parseFrontmatter}: returns `null` and logs instead of
 * throwing when a document's frontmatter block is malformed.
 *
 * Read paths that walk MANY pages use this, so one unparseable page costs that
 * page's result instead of failing the whole request. Write paths keep calling
 * {@link parseFrontmatter} directly — there, rejecting bad input is the point.
 */
export function tryParseFrontmatter(
  content: string,
  slug: string,
  tag: string,
): ParsedPage | null {
  try {
    return parseFrontmatter(content);
  } catch (err) {
    logger.warn(tag, `skipping "${slug}" — malformed frontmatter:`, err);
    return null;
  }
}

/**
 * Serialize a frontmatter object + body back into a markdown document.
 * The frontmatter block is omitted when `data` is empty.
 *
 * Serialization rules (intentionally simple):
 *   - Keys emitted in insertion order.
 *   - Arrays always use inline `[a, b, c]` form. Array elements are quoted
 *     with `"..."` when they contain a comma, quote, or leading/trailing
 *     whitespace.
 *   - Scalar strings are quoted only when they contain `:` or start with `[`
 *     or `"` or `'` (characters that would otherwise confuse the parser).
 */
export function serializeFrontmatter(
  data: Frontmatter,
  body: string,
): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return body;

  const needsScalarQuoting = (s: string): boolean =>
    s.includes(":") ||
    s.startsWith("[") ||
    s.startsWith('"') ||
    s.startsWith("'") ||
    s.startsWith("#") ||
    s.startsWith("&") ||
    s.startsWith("*") ||
    s !== s.trim();

  const quoteArrayElement = (s: string): string => {
    if (
      s.includes(",") ||
      s.includes('"') ||
      // A leading quote would be read back as a delimiter, so quote it away.
      s.startsWith("'") ||
      s.includes("[") ||
      s.includes("]") ||
      s !== s.trim() ||
      s === ""
    ) {
      // Escape embedded double quotes.
      return `"${s.replace(/"/g, '\\"')}"`;
    }
    return s;
  };

  const lines: string[] = ["---"];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      const parts = value.map(quoteArrayElement);
      lines.push(`${key}: [${parts.join(", ")}]`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      // Numbers and booleans are emitted bare (no quotes).
      lines.push(`${key}: ${String(value)}`);
    } else {
      const str = String(value);
      if (needsScalarQuoting(str)) {
        lines.push(`${key}: "${str.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${str}`);
      }
    }
  }
  lines.push("---");
  // Blank line separator between frontmatter and body so downstream markdown
  // renderers treat the body as a fresh document.
  return `${lines.join("\n")}\n\n${body}`;
}
