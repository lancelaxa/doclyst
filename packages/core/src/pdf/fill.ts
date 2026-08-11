import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib';
import { DoclystError, safeErrorSummary } from '../errors.js';
import type { PlaceholderResolver } from '../docx/wordxml.js';

/**
 * PDF template filling, via AcroForm fields.
 *
 * Unlike DOCX, a PDF does not store editable text: it stores positioned glyph
 * runs against (often subset) fonts, with kerning baked into the layout. There
 * is no dependable way to swap `{{SALARY}}` for a longer value in a content
 * stream without re-flowing the page, and a half-working substitution on a
 * payslip is worse than none. So PDF templates are driven by form fields,
 * which are a first-class, text-addressable part of the format.
 *
 * A field is matched to a data column by its name. Both `{{SALARY}}` and
 * plain `SALARY` work as field names, so a template author can use whichever
 * their PDF editor makes convenient.
 */

/** A form field name may be written bare or wrapped in placeholder braces. */
const WRAPPED_NAME_RE = /^\s*\{\{\s*(.+?)\s*\}\}\s*$/;

export interface PdfFillOptions {
  /**
   * Flatten form fields into static page content. On by default, for two
   * reasons: the recipient cannot edit the values back out, and the interactive
   * field objects — which retain their own value store — are removed rather
   * than shipped alongside the rendered text.
   */
  readonly flatten?: boolean;
  /**
   * Strip document metadata. On by default; the template's author, producer
   * and timestamps otherwise travel to every recipient.
   */
  readonly scrubMetadata?: boolean;
}

/** Normalise a form field name to the placeholder key it represents. */
export function fieldNameToKey(name: string): string {
  const wrapped = WRAPPED_NAME_RE.exec(name);
  return (wrapped?.[1] ?? name).trim();
}

async function loadPdf(template: Uint8Array): Promise<PDFDocument> {
  if (
    template.length < 5 ||
    template[0] !== 0x25 || // %
    template[1] !== 0x50 || // P
    template[2] !== 0x44 || // D
    template[3] !== 0x46 // F
  ) {
    throw new DoclystError('INVALID_TEMPLATE', 'The file is not a valid PDF.');
  }

  try {
    // `ignoreEncryption` stays false: an encrypted template would otherwise be
    // filled and saved *without* its protection, quietly downgrading a control
    // the template owner deliberately applied.
    return await PDFDocument.load(template, { updateMetadata: false });
  } catch (error) {
    throw new DoclystError(
      'INVALID_TEMPLATE',
      `The PDF template could not be read: ${safeErrorSummary(error)}. Encrypted or password-protected PDFs are not supported.`,
      { cause: error },
    );
  }
}

/** List the fillable field names of a PDF template, as placeholder keys. */
export async function readPdfFields(template: Uint8Array): Promise<string[]> {
  const doc = await loadPdf(template);
  return doc
    .getForm()
    .getFields()
    .map((field) => fieldNameToKey(field.getName()));
}

export interface PdfFillResult {
  readonly bytes: Uint8Array;
  /** Number of form fields that received a value. */
  readonly replaced: number;
}

/** Fill a PDF template's form fields, resolving each through `resolve`. */
export async function fillPdf(
  template: Uint8Array,
  resolve: PlaceholderResolver,
  options: PdfFillOptions = {},
): Promise<PdfFillResult> {
  const doc = await loadPdf(template);
  const flatten = options.flatten ?? true;
  const form = doc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    throw new DoclystError(
      'UNSUPPORTED_TEMPLATE',
      'The PDF template has no fillable form fields. Add form fields named after your data columns (for example "NAME" or "{{NAME}}"), then try again.',
    );
  }

  let replaced = 0;
  for (const field of fields) {
    const rawName = field.getName();
    const key = fieldNameToKey(rawName);
    const value = resolve(key, `{{${key}}}`);

    // `keep` policy returns the placeholder untouched, which signals that this
    // field has no matching column and should be left as the template made it.
    if (value === `{{${key}}}`) continue;

    applyFieldValue(field, value, key);
    replaced += 1;
  }

  if (options.scrubMetadata ?? true) {
    scrubPdfMetadata(doc);
  }

  if (flatten) {
    try {
      form.flatten();
    } catch (error) {
      throw new DoclystError(
        'RENDER_FAILED',
        `The filled PDF could not be flattened: ${safeErrorSummary(error)}.`,
        { cause: error },
      );
    }
  }

  // Flattening already rasterises each field's appearance stream, so asking
  // for a second pass would be wasted work. When the caller keeps the fields
  // interactive, appearances must be regenerated or viewers show empty boxes.
  const bytes = await doc.save({ updateFieldAppearances: !flatten });
  return { bytes, replaced };
}

/** Set one field's value according to its widget type. */
function applyFieldValue(field: unknown, value: string, key: string): void {
  try {
    if (field instanceof PDFTextField) {
      field.setText(value);
      return;
    }
    if (field instanceof PDFCheckBox) {
      if (isTruthy(value)) field.check();
      else field.uncheck();
      return;
    }
    if (field instanceof PDFDropdown) {
      selectOrThrow(field.getOptions(), value, key, (v) => field.select(v));
      return;
    }
    if (field instanceof PDFOptionList) {
      selectOrThrow(field.getOptions(), value, key, (v) => field.select(v));
      return;
    }
    if (field instanceof PDFRadioGroup) {
      selectOrThrow(field.getOptions(), value, key, (v) => field.select(v));
      return;
    }
  } catch (error) {
    if (error instanceof DoclystError) throw error;
    throw new DoclystError('RENDER_FAILED', `The value for "${key}" could not be written to the PDF form field.`, {
      field: key,
      cause: error,
    });
  }
  throw new DoclystError(
    'UNSUPPORTED_TEMPLATE',
    `The PDF form field "${key}" is of a type Doclyst cannot fill.`,
    { field: key },
  );
}

/**
 * Select an option on a choice field, matching case-insensitively.
 *
 * A value that is not one of the available options is an error rather than a
 * silent no-op: on a form, an unselected choice reads as a deliberate answer.
 */
function selectOrThrow(
  options: readonly string[],
  value: string,
  key: string,
  select: (value: string) => void,
): void {
  const match = options.find((option) => option.toLowerCase() === value.trim().toLowerCase());
  if (match === undefined) {
    throw new DoclystError(
      'INVALID_DATA',
      `The value for "${key}" is not one of the ${options.length} options allowed by that PDF field.`,
      { field: key },
    );
  }
  select(match);
}

function isTruthy(value: string): boolean {
  return ['yes', 'y', 'true', '1', 'x', 'checked', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Replace document metadata with empty, fixed values.
 *
 * Fixed epoch timestamps also make output deterministic, so the same inputs
 * produce the same bytes and the time a record was processed is not recorded
 * in the file.
 */
function scrubPdfMetadata(doc: PDFDocument): void {
  const epoch = new Date(0);
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);
  doc.setProducer('');
  doc.setCreator('');
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);
}
