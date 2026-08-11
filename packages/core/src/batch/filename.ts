import { DoclystError } from '../errors.js';
import { findPlaceholders } from '../template/placeholder.js';
import { isSensitiveFieldName } from '../privacy/redact.js';
import { stripControlCharacters } from '../template/values.js';

/**
 * Output filename construction.
 *
 * Filenames deserve their own module because they are the one part of a
 * generated document that is visible *without opening it* — in a directory
 * listing, a ZIP index, an email attachment bar, a backup log. A filename
 * built from `{{NRIC}}` discloses an identifier to everyone who can see the
 * folder, including people with no reason to read the document itself. So the
 * default names files by position, and naming them after data is opt-in and
 * warned about.
 */

/** Characters illegal in a filename on Windows, plus path separators. */
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*]/g;

/** Device names Windows refuses to use as a filename, with or without suffix. */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Conservative cap; long names break on some filesystems and archive tools. */
const MAX_FILENAME_LENGTH = 120;

/**
 * Reduce arbitrary text to a filename that is safe on every target platform.
 *
 * This is the only function permitted to produce an output filename, and it
 * is total: every input yields a usable name, falling back to `document`
 * rather than throwing, so one odd record cannot fail a 500-row batch.
 */
export function sanitizeFilename(input: string, extension: string): string {
  let name = stripControlCharacters(input)
    // Path separators and Windows-illegal characters become a single
    // underscore. Substituting rather than dropping keeps the parts of a
    // multi-word value distinguishable ("A/B Ltd" stays "A_B Ltd").
    .replace(ILLEGAL_CHARS_RE, '_')
    .replace(/_{2,}/g, '_')
    // Collapse any run of dots so `..` can never survive as a path segment.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    // Strip the separator debris a traversal attempt leaves at either end, so
    // "../../etc/passwd" lands as "etc_passwd" rather than "._._etc_passwd".
    // Windows also silently trims trailing dots and spaces, which would
    // otherwise let "report." and "report" collide after the fact.
    .replace(/^[._\s]+|[._\s]+$/g, '');

  if (name === '') name = 'document';

  if (RESERVED_NAMES.has(name.toUpperCase())) {
    name = `${name}_file`;
  }

  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  const budget = MAX_FILENAME_LENGTH - suffix.length;
  if (name.length > budget) {
    name = name.slice(0, Math.max(1, budget)).trimEnd();
  }

  return `${name}${suffix}`;
}

export interface FilenameWarning {
  readonly kind: 'sensitive-field-in-filename';
  readonly field: string;
  readonly message: string;
}

/**
 * Inspect a filename template for fields that should not appear in a filename.
 *
 * Returns advisories rather than throwing: naming a file after a staff number
 * may be exactly what an operator intends, and refusing would just push them
 * to work around the tool. The point is that the choice is made knowingly.
 */
export function checkFilenameTemplate(template: string): FilenameWarning[] {
  const warnings: FilenameWarning[] = [];
  const seen = new Set<string>();
  for (const match of findPlaceholders(template)) {
    if (seen.has(match.normalizedKey)) continue;
    seen.add(match.normalizedKey);
    if (isSensitiveFieldName(match.key)) {
      warnings.push({
        kind: 'sensitive-field-in-filename',
        field: match.key,
        message: `Filenames are visible without opening the document. Using "${match.key}" in the filename discloses it to anyone who can see the output folder, ZIP listing or backup index.`,
      });
    }
  }
  return warnings;
}

export interface BuildFilenameOptions {
  /** Filename template, e.g. `{{STAFF_ID}}-offer`. Extension is appended. */
  readonly template?: string;
  /** File extension to append, with or without a leading dot. */
  readonly extension: string;
  /** 1-based index of this record in the batch. */
  readonly index: number;
  /** Total records, used to zero-pad the sequential fallback. */
  readonly total: number;
}

/**
 * Build the output filename for one record.
 *
 * With no template, files are named `document-0001.pdf` — ordered, stable and
 * disclosing nothing. `{{ROW}}` is always available as the record's position.
 */
export function buildFilename(
  record: Readonly<Record<string, unknown>>,
  options: BuildFilenameOptions,
): string {
  const width = Math.max(4, String(options.total).length);
  const row = String(options.index).padStart(width, '0');

  if (!options.template || options.template.trim() === '') {
    return sanitizeFilename(`document-${row}`, options.extension);
  }

  const rendered = options.template.replace(/\{\{([A-Za-z0-9_.\- ]+)\}\}/g, (whole, raw: string) => {
    const key = raw.trim();
    if (key.toUpperCase() === 'ROW') return row;
    const value = lookup(record, key);
    if (value === undefined || value === null || String(value).trim() === '') {
      // An unresolved field would otherwise collapse every affected record to
      // the same name; the row number keeps them distinct and traceable.
      return row;
    }
    return String(value);
  });

  return sanitizeFilename(rendered, options.extension);
}

function lookup(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (key in record) return record[key];
  const normalized = key.trim().replace(/[\s.\-]+/g, '_').toUpperCase();
  for (const [candidate, value] of Object.entries(record)) {
    if (candidate.trim().replace(/[\s.\-]+/g, '_').toUpperCase() === normalized) return value;
  }
  return undefined;
}

/**
 * Ensure a filename is unique within a batch by appending ` (2)`, ` (3)`, …
 *
 * Two records that share a name — two people with the same name, or a template
 * that omits a distinguishing field — must not overwrite one another. Silent
 * loss of a generated document is the failure this prevents.
 */
export function dedupeFilename(name: string, taken: Set<string>): string {
  const key = name.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return name;
  }

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let counter = 2; counter < 100_000; counter += 1) {
    const candidate = `${stem} (${counter})${extension}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new DoclystError('LIMIT_EXCEEDED', 'Too many output files share the same name.');
}
