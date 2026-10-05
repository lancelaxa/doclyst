import { DoclystError, safeErrorSummary } from '../errors.js';
import { ValueResolver } from '../template/values.js';
import type { DataRecord } from '../data/records.js';
import { readTemplateFields, type BatchFailure, type Template } from '../batch/run.js';
import { readDocxFields, readDocxText } from '../docx/fill.js';
import { preparePdfTemplate } from '../pdf/autofields.js';
import { checkEmailAddress } from './email.js';

/**
 * A bulk-send spreadsheet for DocuSeal.
 *
 * When letters are signed online in DocuSeal, DocuSeal fills the template
 * itself: HR uploads the template once, then a spreadsheet per batch, and
 * each candidate gets a link to sign their own letter. Doclyst's part is the
 * spreadsheet, and getting it exactly right matters more than it looks:
 *
 * - **Only what the letter uses leaves the building.** The source spreadsheet
 *   usually holds far more than the letter needs — NRIC numbers, bank details,
 *   notes. Only the recipient's name and email and the template's own fields
 *   are written out.
 * - **DocuSeal matches columns to fields by substring.** Its importer maps each
 *   field to the first unmatched column whose header *contains* the field's
 *   name (`import_list.vue`, `buildDefaultMappings`). A field called `Name`
 *   would take a "Manager Name" column if that came first, and put the
 *   manager's name on the candidate's letter. Headers here are the field
 *   names exactly, ordered so each field finds its own column first, and
 *   names that could still be confused are reported.
 * - **Every value must be present.** DocuSeal locks each imported value so the
 *   signer cannot change it — the right behaviour for a salary — which also
 *   means a blank imported value is a blank, locked salary. And a field with
 *   no column at all is left for the *candidate* to fill in. Both stop the
 *   row or the batch here instead.
 */

export interface DocuSealSheetOptions {
  /**
   * The template's fields, exactly as written inside the braces — DocuSeal
   * names each field after its tag, so `{{BASIC_SALARY}}` is `BASIC_SALARY`.
   */
  readonly fields: readonly string[];
  /** Column holding the candidate's name, as DocuSeal shows it to them. */
  readonly nameColumn: string;
  /** Column holding the candidate's email address. */
  readonly emailColumn: string;
}

export interface DocuSealSheet {
  /** The spreadsheet to upload, as CSV. Empty when nothing could be included. */
  readonly csv: string;
  /** Rows written to the spreadsheet. */
  readonly included: number;
  /** Rows left out, and why. Never quotes a value. */
  readonly failures: readonly BatchFailure[];
  /** Groups of row numbers that share an email address. */
  readonly sharedAddresses: readonly (readonly number[])[];
  /** Fields left for the candidate to complete in DocuSeal, such as the signature. */
  readonly signerFields: readonly string[];
  /** Things to check in DocuSeal before sending. */
  readonly notes: readonly string[];
}

/**
 * Field names DocuSeal treats as something the signer does rather than a
 * value to fill: a plain `{{Signature}}` tag becomes a signature box.
 */
const SIGNER_FIELD_RE = /^(signature|sign|sign here|signed|initials|date signed|signing date|signed on|signed date)$/i;

/** The recipient fields DocuSeal maps before any template field. */
const RECIPIENT_FIELDS = ['Name', 'Email', 'Phone'] as const;

/**
 * Build the DocuSeal upload spreadsheet from a batch's records.
 *
 * A template field with no column stops the whole thing rather than one row:
 * it is a property of the spreadsheet, and DocuSeal would hand that field to
 * every candidate to fill in themselves.
 */
export function buildDocuSealSheet(records: readonly DataRecord[], options: DocuSealSheetOptions): DocuSealSheet {
  const signerFields = options.fields.filter((field) => SIGNER_FIELD_RE.test(field.trim()));
  const valueFields = dedupe(options.fields.filter((field) => !SIGNER_FIELD_RE.test(field.trim())));
  const notes: string[] = [];

  const sample = records[0] ?? {};
  const resolverFor = (record: DataRecord, row: number) =>
    new ValueResolver(record, { missing: 'error', treatEmptyAsMissing: true, row });
  const unmatched = valueFields.filter((field) => {
    try {
      resolverFor(sample, 1).resolve(field, '');
      return false;
    } catch {
      // Missing in the first row could be a blank cell rather than a missing
      // column; only a column absent from every record counts.
      return !records.some((record) => hasColumn(record, field));
    }
  });
  if (unmatched.length > 0) {
    throw new DoclystError(
      'MISSING_VALUE',
      `No column matches ${unmatched.map((field) => `"${field}"`).join(', ')}. DocuSeal would leave ${unmatched.length === 1 ? 'that field' : 'those fields'} for each candidate to fill in themselves, so nothing was prepared. Add the column, or rename the placeholder.`,
    );
  }

  for (const field of valueFields) {
    const recipient = RECIPIENT_FIELDS.find((name) => name.toLowerCase() === field.trim().toLowerCase());
    if (recipient) {
      notes.push(
        `DocuSeal treats a field called "${field}" as the candidate's own ${recipient.toLowerCase()}, filled from the ${recipient} column. If that is not what the placeholder means, rename it.`,
      );
    }
  }
  for (const [shorter, longer] of confusablePairs(valueFields)) {
    notes.push(
      `"${shorter}" is part of "${longer}". On DocuSeal's column-matching screen, check that ${shorter} is matched to the ${shorter} column.`,
    );
  }

  const header = ['Name', 'Email', ...valueFields.filter((field) => !RECIPIENT_FIELDS.some((name) => name.toLowerCase() === field.trim().toLowerCase()))];
  const lines: string[][] = [header];
  const failures: BatchFailure[] = [];
  const addresses = new Map<string, number[]>();

  records.forEach((record, index) => {
    const row = index + 1;
    const resolver = resolverFor(record, row);
    try {
      const name = resolveColumn(resolver, options.nameColumn, row, 'name');
      const rawAddress = resolveColumn(resolver, options.emailColumn, row, 'email address');
      const checked = checkEmailAddress(rawAddress);
      if (!checked.ok) {
        throw new DoclystError('INVALID_DATA', `The email address in column "${options.emailColumn}" in row ${row} ${checked.reason}.`, {
          row,
          field: options.emailColumn,
        });
      }
      const values = header.slice(2).map((field) => singleLine(resolver.resolve(field, '')));
      lines.push([singleLine(name), checked.address, ...values]);
      const key = checked.address.toLowerCase();
      addresses.set(key, [...(addresses.get(key) ?? []), row]);
    } catch (error) {
      failures.push(toFailure(row, error));
    }
  });

  return {
    csv: lines.length > 1 ? lines.map((cells) => cells.map(quote).join(',')).join('\r\n') + '\r\n' : '',
    included: lines.length - 1,
    failures,
    sharedAddresses: [...addresses.values()].filter((rows) => rows.length > 1),
    signerFields,
    notes,
  };
}

/**
 * Find the signature boxes a template asks DocuSeal for.
 *
 * Accepts a plain `{{Signature}}` and the attribute form
 * `{{Sign here;type=signature;role=Candidate}}`. A template with none would be
 * sent out with nothing to sign.
 */
export function findSignatureTags(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\{\{([^{}]{1,200})\}\}/g)) {
    const body = (match[1] ?? '').trim();
    const [name = '', ...attributes] = body.split(';').map((part) => part.trim());
    const type = attributes.find((attribute) => /^type\s*=/i.test(attribute))?.split('=')[1]?.trim().toLowerCase();
    if (type === 'signature' || type === 'initials' || (type === undefined && /^(signature|sign|sign here|initials)$/i.test(name))) {
      found.push(match[0]);
    }
  }
  return found;
}

function resolveColumn(resolver: ValueResolver, column: string, row: number, what: string): string {
  try {
    return resolver.resolve(column, '');
  } catch {
    throw new DoclystError('MISSING_VALUE', `No ${what} in column "${column}" in row ${row}.`, { row, field: column });
  }
}

/** Whether a record has a column for a field, matched the way placeholders are. */
function hasColumn(record: DataRecord, field: string): boolean {
  const resolver = new ValueResolver(record, { missing: 'error' });
  try {
    resolver.resolve(field, '');
    return true;
  } catch {
    return false;
  }
}

/** Pairs where one field's name is contained in another's, ignoring case. */
function confusablePairs(fields: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const a of fields) {
    for (const b of fields) {
      if (a !== b && b.toLowerCase().includes(a.toLowerCase())) pairs.push([a, b]);
    }
  }
  return pairs;
}

function dedupe(fields: readonly string[]): string[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = field.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One line per cell: a line break inside a value would only confuse a reader of the file. */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Quote every cell. Values are written exactly — DocuSeal reads them
 * literally, so the apostrophe Excel uses to defuse formulas would end up in
 * the letter. The file is for uploading, not for opening in a spreadsheet.
 */
function quote(cell: string): string {
  return `"${cell.replace(/"/g, '""')}"`;
}

function toFailure(row: number, error: unknown): BatchFailure {
  if (error instanceof DoclystError) {
    const failure: BatchFailure = { row, code: error.code, message: error.message };
    return error.field !== undefined ? { ...failure, field: error.field } : failure;
  }
  return { row, code: 'RENDER_FAILED', message: safeErrorSummary(error) };
}

/** What DocuSeal will make of a template. */
export interface DocuSealTemplateInfo {
  /** Fields DocuSeal will fill from the spreadsheet, named as in the template. */
  readonly fields: readonly string[];
  /**
   * Signature tags found, or undefined when the template could not be read for
   * them (a PDF, whose text is not searched here).
   */
  readonly signatureTags: readonly string[] | undefined;
}

/**
 * Read a template the way DocuSeal will: its `{{FIELD}}` tags, and whether it
 * has somewhere to sign.
 *
 * A Word template is read directly. A PDF saved from Word still has its tags
 * as page text, so they are found the same way Prepare finds them, without
 * changing the file.
 */
export async function readDocuSealTemplate(template: Template): Promise<DocuSealTemplateInfo> {
  if (template.kind === 'docx') {
    return { fields: readDocxFields(template.bytes), signatureTags: findSignatureTags(readDocxText(template.bytes)) };
  }
  const existing = await readTemplateFields(template);
  if (existing.length > 0) return { fields: existing, signatureTags: undefined };
  const prepared = await preparePdfTemplate(template.bytes);
  return {
    fields: dedupe([...prepared.fields.map((field) => field.name), ...prepared.skipped.map((skip) => skip.name)]),
    signatureTags: undefined,
  };
}
