import { unzipSync, strFromU8 } from 'fflate';
import { DoclystError, safeErrorSummary } from '../errors.js';
import { decodeXmlText } from '../docx/xml.js';
import { DEFAULT_MAX_COLUMNS, DEFAULT_MAX_ROWS } from './csv.js';

/**
 * A focused, read-only XLSX reader.
 *
 * Written in-repo rather than taken from a dependency, after weighing both
 * realistic options against the fact that every cell here is personal data:
 *
 *  - `xlsx` (SheetJS) on npm is frozen at 0.18.5, which carries unfixed
 *    prototype-pollution and ReDoS advisories; the patched releases are
 *    distributed outside the registry.
 *  - `exceljs` pulls in nine transitive packages including `tmp`, which spools
 *    workbook contents through temporary files — directly contrary to this
 *    project's guarantee that nothing is written outside the output paths.
 *
 * An .xlsx is a ZIP of XML, and reading cell values from one is a bounded
 * problem. What is deliberately *not* implemented: formula evaluation (cached
 * results are read instead), external and remote links, macros, charts, and
 * anything that writes. That keeps the code that touches an untrusted
 * spreadsheet small enough to audit.
 *
 * As in the DOCX engine there is no general XML parser and no DTD handling, so
 * external entity expansion is not reachable.
 */

/** Cap on total decompressed workbook size, as a zip-bomb guard. */
export const MAX_WORKBOOK_BYTES = 200 * 1024 * 1024;

export interface ParseXlsxOptions {
  /** Worksheet to read: a name, or a 0-based index. Defaults to the first. */
  readonly sheet?: string | number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

/** Read a worksheet into a rectangle of raw string cells, header row first. */
export function parseXlsx(workbook: Uint8Array, options: ParseXlsxOptions = {}): string[][] {
  const entries = openWorkbook(workbook);
  const sheetPath = resolveSheetPath(entries, options.sheet);
  const sheetXml = strFromU8(required(entries, sheetPath));

  return readSheet(sheetXml, {
    sharedStrings: readSharedStrings(entries),
    dateStyles: readDateStyles(entries),
    epoch1904: usesEpoch1904(entries),
    maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
    maxColumns: options.maxColumns ?? DEFAULT_MAX_COLUMNS,
  });
}

/** List the worksheet names of a workbook, in tab order. */
export function readSheetNames(workbook: Uint8Array): string[] {
  return listSheets(openWorkbook(workbook)).map((sheet) => sheet.name);
}

// --- archive ---------------------------------------------------------------

function openWorkbook(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new DoclystError(
      'INVALID_DATA',
      'The file is not a valid XLSX workbook (it is not a ZIP archive).',
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    let total = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize ?? 0;
        if (total > MAX_WORKBOOK_BYTES) {
          throw new DoclystError(
            'LIMIT_EXCEEDED',
            'The workbook expands to more than the supported size limit.',
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DoclystError) throw error;
    throw new DoclystError(
      'INVALID_DATA',
      `The workbook could not be read: ${safeErrorSummary(error)}.`,
      { cause: error },
    );
  }

  if (!entries['xl/workbook.xml']) {
    throw new DoclystError(
      'INVALID_DATA',
      'The file is not a valid XLSX workbook (xl/workbook.xml is missing).',
    );
  }
  return entries;
}

function required(entries: Record<string, Uint8Array>, path: string): Uint8Array {
  const bytes = entries[path];
  if (!bytes) {
    throw new DoclystError('INVALID_DATA', `The workbook is missing an expected part.`);
  }
  return bytes;
}

// --- workbook structure ----------------------------------------------------

interface SheetRef {
  readonly name: string;
  readonly relationshipId: string;
}

const SHEET_RE = /<sheet\b([^>]*)\/?>/g;
const RELATIONSHIP_RE = /<Relationship\b([^>]*)\/?>/g;

function listSheets(entries: Record<string, Uint8Array>): SheetRef[] {
  const xml = strFromU8(required(entries, 'xl/workbook.xml'));
  const sheets: SheetRef[] = [];
  SHEET_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SHEET_RE.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const name = decodeXmlText(attribute(attrs, 'name') ?? '');
    const relationshipId = attribute(attrs, 'r:id') ?? attribute(attrs, 'id') ?? '';
    if (name !== '') sheets.push({ name, relationshipId });
  }
  if (sheets.length === 0) {
    throw new DoclystError('INVALID_DATA', 'The workbook contains no worksheets.');
  }
  return sheets;
}

/** Map a sheet selection to the archive path holding that worksheet. */
function resolveSheetPath(
  entries: Record<string, Uint8Array>,
  selection: string | number | undefined,
): string {
  const sheets = listSheets(entries);

  let sheet: SheetRef | undefined;
  if (selection === undefined) {
    sheet = sheets[0];
  } else if (typeof selection === 'number') {
    sheet = sheets[selection];
    if (!sheet) {
      throw new DoclystError(
        'INVALID_DATA',
        `The workbook has ${sheets.length} worksheet(s); sheet index ${selection} does not exist.`,
      );
    }
  } else {
    sheet = sheets.find((candidate) => candidate.name === selection);
    if (!sheet) {
      // Sheet names are structural labels, not personal data, so listing them
      // helps the operator without disclosing anything about the records.
      throw new DoclystError(
        'INVALID_DATA',
        `The workbook has no worksheet named "${selection}". Available: ${sheets.map((s) => s.name).join(', ')}.`,
      );
    }
  }

  const targets = readRelationships(entries);
  const target = targets.get(sheet!.relationshipId);
  if (target) return target;

  // Some producers omit the relationship; fall back to conventional naming.
  const index = sheets.indexOf(sheet!) + 1;
  const fallback = `xl/worksheets/sheet${index}.xml`;
  if (entries[fallback]) return fallback;

  throw new DoclystError('INVALID_DATA', 'The workbook does not point at a readable worksheet.');
}

function readRelationships(entries: Record<string, Uint8Array>): Map<string, string> {
  const map = new Map<string, string>();
  const bytes = entries['xl/_rels/workbook.xml.rels'];
  if (!bytes) return map;

  const xml = strFromU8(bytes);
  RELATIONSHIP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RELATIONSHIP_RE.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const id = attribute(attrs, 'Id');
    const target = attribute(attrs, 'Target');
    if (!id || !target) continue;
    map.set(id, normalizeTarget(decodeXmlText(target)));
  }
  return map;
}

/** Resolve a relationship target against the `xl/` base, rejecting traversal. */
function normalizeTarget(target: string): string {
  const cleaned = target.replace(/\\/g, '/');
  const path = cleaned.startsWith('/') ? cleaned.slice(1) : `xl/${cleaned}`;

  const resolved: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // A target must not climb out of the archive root.
      if (resolved.length === 0) {
        throw new DoclystError(
          'UNSAFE_PATH',
          'The workbook references a part outside the archive and was rejected.',
        );
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/');
}

function usesEpoch1904(entries: Record<string, Uint8Array>): boolean {
  const xml = strFromU8(required(entries, 'xl/workbook.xml'));
  return /<workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/i.test(xml);
}

// --- shared strings --------------------------------------------------------

const SI_RE = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
const T_RE = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
/** Phonetic guide text; displayed separately, so not part of the cell value. */
const RPH_RE = /<rPh\b[^>]*>[\s\S]*?<\/rPh>/g;

function readSharedStrings(entries: Record<string, Uint8Array>): string[] {
  const bytes = entries['xl/sharedStrings.xml'];
  if (!bytes) return [];

  const xml = strFromU8(bytes);
  const strings: string[] = [];
  SI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SI_RE.exec(xml)) !== null) {
    strings.push(collectText(match[1] ?? ''));
  }
  return strings;
}

/**
 * Join the text of an element, concatenating rich-text runs.
 *
 * A cell whose text is partly bold is stored as several `<r><t>` runs; taking
 * only the first would silently truncate the value.
 */
function collectText(xml: string): string {
  const withoutPhonetics = xml.replace(RPH_RE, '');
  let out = '';
  T_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = T_RE.exec(withoutPhonetics)) !== null) {
    out += decodeXmlText(match[1] ?? '');
  }
  return out;
}

// --- number formats --------------------------------------------------------

/** Built-in numFmt ids that denote a date and/or time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const NUMFMT_RE = /<numFmt\b([^>]*)\/?>/g;
const CELLXFS_RE = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/;
const XF_RE = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;

/**
 * Work out which style indices mean "this number is a date".
 *
 * Excel stores a date as a plain number; only the cell's number format says
 * otherwise. Without this, every date column would render as `45678`.
 */
function readDateStyles(entries: Record<string, Uint8Array>): Set<number> {
  const dateStyles = new Set<number>();
  const bytes = entries['xl/styles.xml'];
  if (!bytes) return dateStyles;

  const xml = strFromU8(bytes);

  // Custom formats declared by the workbook, e.g. `dd/mm/yyyy`.
  const customDateFormats = new Set<number>();
  NUMFMT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMFMT_RE.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const id = Number.parseInt(attribute(attrs, 'numFmtId') ?? '', 10);
    const code = decodeXmlText(attribute(attrs, 'formatCode') ?? '');
    if (Number.isFinite(id) && looksLikeDateFormat(code)) customDateFormats.add(id);
  }

  const cellXfs = CELLXFS_RE.exec(xml)?.[1] ?? '';
  let styleIndex = 0;
  XF_RE.lastIndex = 0;
  while ((match = XF_RE.exec(cellXfs)) !== null) {
    const id = Number.parseInt(attribute(match[1] ?? '', 'numFmtId') ?? '', 10);
    if (Number.isFinite(id) && (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id))) {
      dateStyles.add(styleIndex);
    }
    styleIndex += 1;
  }
  return dateStyles;
}

/**
 * Decide whether a format code renders a date.
 *
 * Quoted literals and escaped characters are stripped first: a currency format
 * such as `"Sold"#,##0` must not be treated as a date because of the `d`.
 */
function looksLikeDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(stripped);
}

// --- worksheet -------------------------------------------------------------

const ROW_RE = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const V_RE = /<v\b[^>]*>([\s\S]*?)<\/v>|<v\b[^>]*\/>/;
const IS_RE = /<is\b[^>]*>([\s\S]*?)<\/is>/;

interface SheetContext {
  readonly sharedStrings: readonly string[];
  readonly dateStyles: ReadonlySet<number>;
  readonly epoch1904: boolean;
  readonly maxRows: number;
  readonly maxColumns: number;
}

function readSheet(xml: string, ctx: SheetContext): string[][] {
  const rows: string[][] = [];

  ROW_RE.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = ROW_RE.exec(xml)) !== null) {
    const body = rowMatch[2];
    if (body === undefined) {
      rows.push([]);
      continue;
    }

    const cells: string[] = [];
    CELL_RE.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    let position = 0;

    while ((cellMatch = CELL_RE.exec(body)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const reference = attribute(attrs, 'r');
      // A sparse row omits empty cells entirely, so the cell reference is what
      // keeps later columns aligned with their headers.
      const column = reference ? columnIndex(reference) : position;
      if (column > ctx.maxColumns) {
        throw new DoclystError(
          'LIMIT_EXCEEDED',
          `The worksheet has more than ${ctx.maxColumns} columns, which exceeds the supported limit.`,
        );
      }
      while (cells.length < column) cells.push('');
      cells.push(readCell(attrs, cellMatch[2] ?? '', ctx));
      position = column + 1;
    }

    rows.push(cells);
    if (rows.length > ctx.maxRows + 1) {
      throw new DoclystError(
        'LIMIT_EXCEEDED',
        `The worksheet has more than ${ctx.maxRows} data rows, which exceeds the supported limit.`,
      );
    }
  }

  // Trailing rows that Excel kept for formatting carry no values.
  while (rows.length > 0 && (rows.at(-1) as string[]).every((cell) => cell === '')) rows.pop();
  return rows;
}

/** Render one cell to the text that will be substituted into a document. */
function readCell(attrs: string, body: string, ctx: SheetContext): string {
  const type = attribute(attrs, 't') ?? 'n';

  if (type === 'inlineStr') {
    return collectText(IS_RE.exec(body)?.[1] ?? '');
  }

  const raw = decodeXmlText(V_RE.exec(body)?.[1] ?? '');
  if (raw === '') return '';

  switch (type) {
    case 's': {
      const index = Number.parseInt(raw, 10);
      return ctx.sharedStrings[index] ?? '';
    }
    // A formula's cached result. Formulas are never evaluated here.
    case 'str':
      return raw;
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    // `#REF!`, `#N/A` and friends are passed through rather than blanked, so a
    // broken source cell is visible in the output instead of silently empty.
    case 'e':
      return raw;
    case 'd':
      return raw.slice(0, 10);
    default: {
      const style = Number.parseInt(attribute(attrs, 's') ?? '', 10);
      if (Number.isFinite(style) && ctx.dateStyles.has(style)) {
        return serialToDateText(Number.parseFloat(raw), ctx.epoch1904);
      }
      // The literal stored text is kept for ordinary numbers, so a value such
      // as 4500.10 is not re-rendered through floating point.
      return raw;
    }
  }
}

/**
 * Convert an Excel date serial to text.
 *
 * The 1900 system deliberately contains a non-existent 29 February 1900, kept
 * for Lotus 1-2-3 compatibility, so serials at or below 59 sit one day ahead of
 * a naive conversion and are corrected here.
 */
function serialToDateText(serial: number, epoch1904: boolean): string {
  if (!Number.isFinite(serial)) return '';

  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const adjusted = !epoch1904 && serial < 60 ? serial + 1 : serial;
  const date = new Date(base + Math.round(adjusted * 86_400_000));
  if (Number.isNaN(date.getTime())) return '';

  const iso = date.toISOString();
  const hasTime = Math.abs(adjusted - Math.floor(adjusted)) > 1e-9;
  // Time is only shown when the value actually carries one, so a plain date
  // does not acquire a misleading 00:00:00.
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

// --- small helpers ---------------------------------------------------------

/** Read one attribute out of a captured tag's attribute text. */
function attribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"([^"]*)"`);
  return pattern.exec(attrs)?.[1];
}

/** `B12` → 1. Letters are base-26 with A = 1. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
  }
  return Math.max(0, index - 1);
}
