/**
 * Redaction helpers.
 *
 * Doclyst assumes every value flowing through it is personal data (names,
 * NRIC/FIN numbers, salaries, addresses, phone numbers). Nothing in this
 * package may place a raw value into an error message, a log line, a warning
 * or a manifest. Everything user-facing describes values *structurally* —
 * where they came from and what shape they are — never what they contain.
 */

/** Field-name patterns that usually indicate especially sensitive content. */
const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnric\b/i,
  /\bfin\b/i,
  /\buen\b/i,
  /passport/i,
  /salary|wage|payslip|remuneration|compensation/i,
  /\bbank\b|account.?(no|num|number)/i,
  /\bdob\b|date.?of.?birth|birth.?date/i,
  /\bnational.?id\b|\bid.?(no|num|number)\b/i,
  /address|postal/i,
  /phone|mobile|contact.?(no|num|number)/i,
  /email/i,
  /medical|diagnosis|health/i,
];

/**
 * True when a field name looks like it holds especially sensitive personal
 * data. Used to warn before such a field is written somewhere durable and
 * externally visible, such as a filename.
 *
 * This is a heuristic advisory signal, not a classifier. It is deliberately
 * biased toward false positives: warning about a harmless field costs a line
 * of output, missing a real NRIC costs a disclosure.
 */
export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Describe a value without disclosing it, for logs and error messages.
 *
 * Returns a structural summary such as `<text:11 chars>`, never any part of
 * the value itself. Length is disclosed because it is diagnostically useful
 * (spotting an empty or truncated cell) and is not itself identifying.
 */
export function describeValue(value: unknown): string {
  if (value === null) return '<null>';
  if (value === undefined) return '<missing>';
  if (typeof value === 'boolean') return `<boolean>`;
  if (typeof value === 'number') return `<number>`;
  if (value instanceof Date) return `<date>`;
  if (typeof value === 'string') {
    if (value.length === 0) return '<empty text>';
    return `<text:${value.length} chars>`;
  }
  return `<${typeof value}>`;
}

/**
 * Redact every value of a record, preserving only its keys.
 *
 * Use this whenever a record must be included in diagnostic output. Keys are
 * assumed to be safe to display: they come from template placeholders and
 * spreadsheet headers, which describe fields rather than identify people.
 */
export function redactRecord(record: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = describeValue(value);
  }
  return out;
}

/**
 * Strip anything that could carry personal data out of a value destined for a
 * log sink. Strings are replaced wholesale, because a free-form string is the
 * most likely place for a name or an NRIC to hide.
 */
export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') return describeValue(value);
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}
