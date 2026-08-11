import { DoclystError } from '../errors.js';
import { normalizeKey } from './placeholder.js';

/**
 * How to handle a placeholder that has no corresponding value in the record.
 *
 * `error` is the default. Documents produced by this tool are offer letters,
 * payslips and contracts; a silently blank salary field is a worse outcome
 * than a failed batch, so a missing value stops the row rather than shipping
 * an incomplete document.
 */
export type MissingValuePolicy = 'error' | 'empty' | 'keep';

/** Upper bound on a single substituted value, to bound output size. */
export const MAX_VALUE_LENGTH = 100_000;

export interface ValueResolverOptions {
  readonly missing?: MissingValuePolicy;
  /**
   * Treat an empty string in the data as a missing value. Off by default: a
   * deliberately blank optional field is legitimate, and callers who want the
   * stricter reading can opt in.
   */
  readonly treatEmptyAsMissing?: boolean;
  /** 1-based data row number, used only to locate errors. */
  readonly row?: number;
}

/**
 * Resolves placeholder keys against one record.
 *
 * Lookup is exact-first, then normalized, so a template that writes
 * `{{NAME}}` matches a column literally called `NAME` before falling back to
 * matching a column called `Name` or `name`.
 */
export class ValueResolver {
  readonly #exact: ReadonlyMap<string, unknown>;
  readonly #normalized: ReadonlyMap<string, unknown>;
  readonly #missing: MissingValuePolicy;
  readonly #treatEmptyAsMissing: boolean;
  readonly #row: number | undefined;

  /** Normalized keys that were requested but not present in the record. */
  readonly missingKeys = new Set<string>();

  constructor(record: Readonly<Record<string, unknown>>, options: ValueResolverOptions = {}) {
    const exact = new Map<string, unknown>();
    const normalized = new Map<string, unknown>();
    for (const [key, value] of Object.entries(record)) {
      exact.set(key, value);
      const normalizedKey = normalizeKey(key);
      // First column wins on collision, matching the header-parsing rule that
      // rejects duplicates outright; this is only reachable for near-duplicate
      // headers such as "Full Name" and "full_name".
      if (!normalized.has(normalizedKey)) normalized.set(normalizedKey, value);
    }
    this.#exact = exact;
    this.#normalized = normalized;
    this.#missing = options.missing ?? 'error';
    this.#treatEmptyAsMissing = options.treatEmptyAsMissing ?? false;
    this.#row = options.row;
  }

  /**
   * Resolve one placeholder to the literal text that replaces it.
   *
   * `original` is the exact placeholder text (`{{NAME}}`) and is returned
   * unchanged under the `keep` policy.
   */
  resolve(key: string, original: string): string {
    const normalizedKey = normalizeKey(key);
    const raw = this.#exact.has(key) ? this.#exact.get(key) : this.#normalized.get(normalizedKey);

    const absent =
      raw === undefined ||
      raw === null ||
      (this.#treatEmptyAsMissing && typeof raw === 'string' && raw.trim() === '');

    if (absent) {
      this.missingKeys.add(normalizedKey);
      switch (this.#missing) {
        case 'error':
          throw new DoclystError(
            'MISSING_VALUE',
            `No value for placeholder "${key}"${this.#row !== undefined ? ` in row ${this.#row}` : ''}.`,
            { row: this.#row, field: key },
          );
        case 'empty':
          return '';
        case 'keep':
          return original;
      }
    }

    return coerceToText(raw, key, this.#row);
  }
}

/**
 * Convert a spreadsheet cell value into the text written into the document.
 *
 * Objects and arrays are rejected rather than stringified: `[object Object]`
 * in a contract is a data-quality bug that should surface loudly, not a
 * rendering decision.
 */
export function coerceToText(value: unknown, key: string, row?: number): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    text = value ? 'Yes' : 'No';
  } else if (value instanceof Date) {
    text = formatIsoDate(value);
  } else {
    throw new DoclystError(
      'INVALID_DATA',
      `Value for "${key}"${row !== undefined ? ` in row ${row}` : ''} is not text, a number, a boolean or a date.`,
      { row, field: key },
    );
  }

  if (text.length > MAX_VALUE_LENGTH) {
    throw new DoclystError(
      'LIMIT_EXCEEDED',
      `Value for "${key}"${row !== undefined ? ` in row ${row}` : ''} exceeds the ${MAX_VALUE_LENGTH}-character limit.`,
      { row, field: key },
    );
  }

  return stripControlCharacters(text);
}

/**
 * Remove control characters that would corrupt the document XML or render as
 * replacement glyphs. Tab, newline and carriage return survive: they carry
 * real meaning in cell text and are legal in the formats we write.
 */
export function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** `YYYY-MM-DD` in UTC — unambiguous, and locale-independent across machines. */
function formatIsoDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
