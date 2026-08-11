import { DoclystError } from '../errors.js';

/**
 * A small RFC 4180 CSV parser.
 *
 * Written in-house rather than pulled from a dependency for two reasons: the
 * grammar is small enough to implement correctly and test exhaustively, and
 * every value parsed here is personal data, so the fewer third-party parsers
 * that touch it the smaller the surface that could mishandle or log it.
 */

export interface ParseCsvOptions {
  /** Field separator. Auto-detected from the header line when omitted. */
  readonly delimiter?: string;
  /** Maximum number of data rows to accept. */
  readonly maxRows?: number;
  /** Maximum number of columns to accept. */
  readonly maxColumns?: number;
}

export const DEFAULT_MAX_ROWS = 50_000;
export const DEFAULT_MAX_COLUMNS = 512;

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Split CSV text into a rectangle of raw string cells.
 *
 * Rows are *not* padded or truncated here; shape validation belongs to the
 * record layer, which can report it against a header.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;

  // A UTF-8 BOM would otherwise become part of the first header name, so the
  // first column would never match its placeholder.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (input.trim() === '') return [];

  const delimiter = options.delimiter ?? detectDelimiter(input);
  if (delimiter.length !== 1) {
    throw new DoclystError('INVALID_DATA', 'The CSV delimiter must be a single character.');
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    if (row.length > maxColumns) {
      throw new DoclystError(
        'LIMIT_EXCEEDED',
        `The file has more than ${maxColumns} columns, which exceeds the supported limit.`,
      );
    }
  };

  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) {
      throw new DoclystError(
        'LIMIT_EXCEEDED',
        `The file has more than ${maxRows} data rows, which exceeds the supported limit.`,
      );
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    sawAnyChar = true;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      // Consume CRLF as one terminator; a lone CR also ends the row.
      if (input[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new DoclystError(
      'INVALID_DATA',
      'The CSV file ends inside a quoted value; a closing quote is missing.',
    );
  }

  // A trailing newline terminates the last row rather than starting a new one.
  if (field !== '' || row.length > 0 || (sawAnyChar && rows.length === 0)) {
    endRow();
  }

  return rows;
}

/**
 * Guess the delimiter from the first line.
 *
 * Picks the candidate that appears most often outside quotes. Semicolon and
 * tab files are common in locales that use a comma as the decimal separator,
 * and silently misreading one produces a single-column file where every
 * placeholder fails to resolve.
 */
export function detectDelimiter(text: string): string {
  const firstLine = readFirstLineOutsideQuotes(text);
  let best = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function readFirstLineOutsideQuotes(text: string): string {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) return text.slice(0, i);
  }
  return text;
}

function countOutsideQuotes(line: string, target: string): number {
  let count = 0;
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === target) count += 1;
  }
  return count;
}

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Doclyst never evaluates these, but it does write CSV manifests that an
 * operator is likely to open in Excel or Sheets. A value that arrived as
 * `=HYPERLINK(...)` in the input would then execute in *their* spreadsheet, so
 * it is neutralised on the way out.
 */
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

/**
 * Make a value safe to write into a CSV cell.
 *
 * Prefixes formula-triggering values with an apostrophe (the convention every
 * major spreadsheet honours as "treat as text") and applies RFC 4180 quoting.
 */
export function escapeCsvValue(value: string): string {
  const neutralised = FORMULA_TRIGGER_RE.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/** Serialise a rectangle of values as RFC 4180 CSV with CRLF line endings. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
}
