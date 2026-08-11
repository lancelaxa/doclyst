/**
 * Placeholder syntax: `{{FIELD_NAME}}`.
 *
 * Surrounding whitespace inside the braces is ignored, so `{{ NAME }}` and
 * `{{NAME}}` are the same placeholder. Field names are restricted to a
 * conservative character set: letters, digits, underscore, hyphen, dot and
 * spaces. Anything else is not treated as a placeholder at all, which keeps
 * document text such as `{{ see note }}` or stray braces from being mistaken
 * for a field and silently blanked.
 */

/** Matches a placeholder and captures the raw (untrimmed) field name. */
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_.\- ]+)\}\}/g;

/** Longest field name we will accept, to bound pathological templates. */
const MAX_KEY_LENGTH = 128;

export interface PlaceholderMatch {
  /** The field name as written in the template, trimmed. */
  readonly key: string;
  /** The canonical lookup key. See {@link normalizeKey}. */
  readonly normalizedKey: string;
  /** Index of the opening `{` within the searched text. */
  readonly start: number;
  /** Index just past the closing `}` within the searched text. */
  readonly end: number;
}

/**
 * Canonical form of a field name, used to match template placeholders against
 * spreadsheet headers.
 *
 * Real templates and real spreadsheets rarely agree on casing or spacing: a
 * template says `{{NAME}}` while the CSV header says `Name`, or the template
 * says `{{DATE OF BIRTH}}` while the header says `date_of_birth`. Normalizing
 * both sides to uppercase with runs of spaces, hyphens and dots collapsed to a
 * single underscore makes those pairs match, which removes the single most
 * common cause of a batch failing on every row.
 */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/[\s.\-]+/g, '_')
    .toUpperCase();
}

/** Find every placeholder in a plain-text string, in document order. */
export function findPlaceholders(text: string): PlaceholderMatch[] {
  const matches: PlaceholderMatch[] = [];
  // The regex is stateful (`g`), so it is reset explicitly rather than shared.
  PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    const raw = match[1] ?? '';
    const key = raw.trim();
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    matches.push({
      key,
      normalizedKey: normalizeKey(key),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

/**
 * The distinct field names a template requires, in first-appearance order.
 *
 * Deduplicated by normalized key so that `{{NAME}}` appearing in a header and
 * again in the body counts as one required field.
 */
export function extractFieldNames(text: string): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const match of findPlaceholders(text)) {
    if (seen.has(match.normalizedKey)) continue;
    seen.add(match.normalizedKey);
    fields.push(match.key);
  }
  return fields;
}
