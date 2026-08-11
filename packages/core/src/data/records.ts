import { DoclystError } from '../errors.js';
import { normalizeKey } from '../template/placeholder.js';
import { parseCsv, type ParseCsvOptions } from './csv.js';
import { parseXlsx, type ParseXlsxOptions } from './xlsx.js';

/** One row of source data, keyed by its column header. */
export type DataRecord = Readonly<Record<string, string>>;

export interface RecordSet {
  /** Column headers in file order, as written in the source. */
  readonly fields: readonly string[];
  /** Data rows, excluding the header. */
  readonly records: readonly DataRecord[];
}

/** Longest header name accepted, matching the placeholder key limit. */
const MAX_HEADER_LENGTH = 128;

/**
 * Turn a parsed CSV rectangle into records keyed by header.
 *
 * The header row is validated strictly. Blank and duplicate headers are hard
 * errors rather than warnings: both make placeholder resolution ambiguous, and
 * an ambiguous mapping in a batch of contracts is worth stopping for.
 */
export function toRecords(rows: readonly (readonly string[])[]): RecordSet {
  if (rows.length === 0) {
    throw new DoclystError('INVALID_DATA', 'The data file is empty.');
  }

  const rawHeader = rows[0] as readonly string[];
  const fields = rawHeader.map((h) => h.trim());

  if (fields.length === 0 || fields.every((f) => f === '')) {
    throw new DoclystError('INVALID_DATA', 'The first row of the data file has no column headers.');
  }

  // Trailing empty headers are a common artefact of spreadsheet exports (an
  // extra delimiter at the end of each line), so they are dropped rather than
  // rejected. Empty headers *between* real ones remain an error.
  let width = fields.length;
  while (width > 0 && fields[width - 1] === '') width -= 1;
  const header = fields.slice(0, width);

  const seen = new Map<string, number>();
  header.forEach((name, index) => {
    if (name === '') {
      throw new DoclystError(
        'INVALID_DATA',
        `Column ${index + 1} has an empty header. Every column used as a placeholder needs a name.`,
      );
    }
    if (name.length > MAX_HEADER_LENGTH) {
      throw new DoclystError(
        'INVALID_DATA',
        `The header for column ${index + 1} is longer than ${MAX_HEADER_LENGTH} characters.`,
      );
    }
    const normalized = normalizeKey(name);
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      throw new DoclystError(
        'INVALID_DATA',
        `Columns ${previous + 1} and ${index + 1} resolve to the same field name, so placeholder values would be ambiguous.`,
      );
    }
    seen.set(normalized, index);
  });

  const records: DataRecord[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] as readonly string[];

    // Skip rows that are entirely empty; spreadsheet exports frequently end
    // with one, and failing a batch over it would be pure friction.
    if (row.every((cell) => cell.trim() === '')) continue;

    if (row.length > header.length) {
      // Tolerate extra *empty* trailing cells, reject extra data.
      const overflow = row.slice(header.length);
      if (overflow.some((cell) => cell.trim() !== '')) {
        throw new DoclystError(
          'INVALID_DATA',
          `Row ${r} has ${row.length} values but the header defines ${header.length} columns.`,
          { row: r },
        );
      }
    }

    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? '';
    });
    records.push(Object.freeze(record));
  }

  return { fields: header, records };
}

/** Parse CSV text straight into a validated {@link RecordSet}. */
export function readCsvRecords(text: string, options: ParseCsvOptions = {}): RecordSet {
  return toRecords(parseCsv(text, options));
}

/** Parse an XLSX workbook straight into a validated {@link RecordSet}. */
export function readXlsxRecords(bytes: Uint8Array, options: ParseXlsxOptions = {}): RecordSet {
  return toRecords(parseXlsx(bytes, options));
}
