import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  type PDFFont,
} from 'pdf-lib';
import { DoclystError, safeErrorSummary } from '../errors.js';
import { readFontFromDict, type FontInfo } from './content.js';
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
  /**
   * What to do when a value is too long for the box the template gives it.
   *
   * A PDF form field clips whatever does not fit, so the default behaviour of
   * the format is to publish a truncated address or a truncated name with no
   * indication that anything is missing. That is the worst possible outcome on
   * a document that is about to be signed, so Doclyst never simply allows it.
   *
   * - `shrink` (default) reduces that field's font size until the value fits,
   *   down to {@link minFontSizePt}, and reports which fields it had to shrink.
   * - `error` fails the record instead, naming the field.
   * - `ignore` restores the format's own behaviour: the value is clipped.
   *   Present for templates where a field is deliberately over-provisioned,
   *   but it means accepting silent truncation.
   */
  readonly overflow?: OverflowPolicy;
  /**
   * Smallest font size, in points, that `shrink` may use. Below this a value
   * is unreadable, so shrinking stops being a fix and the record fails.
   */
  readonly minFontSizePt?: number;
}

/**
 * Prefix Doclyst gives fonts it adopts from a page into the form's resources.
 *
 * A field carrying one of these is drawn here rather than by pdf-lib, which
 * would otherwise render every value in its own default font — visibly wrong on
 * a letter set in anything else.
 */
const ADOPTED_FONT_PREFIX = 'Doclyst';

/** How to handle a value that does not fit its form field. */
export type OverflowPolicy = 'shrink' | 'error' | 'ignore';

const DEFAULT_MIN_FONT_SIZE_PT = 6;

/** Largest size auto-sizing fields are considered at, matching pdf-lib. */
const AUTO_SIZE_CEILING_PT = 12;

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
  /**
   * Fields whose font size had to be reduced for the value to fit. Reported so
   * an operator can widen the template rather than ship documents that read
   * unevenly. Field names only — never values.
   */
  readonly shrunkFields: readonly string[];
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

  // The font pdf-lib will draw the fields with, so an overflow check measures
  // what the reader actually sees.
  let defaultFont: PDFFont | undefined;
  try {
    defaultFont = form.getDefaultFont();
  } catch {
    // A template whose font cannot be resolved is filled without the fit
    // check rather than refused; see fitTextField.
  }

  const overflow = options.overflow ?? 'shrink';
  const minFontSize = options.minFontSizePt ?? DEFAULT_MIN_FONT_SIZE_PT;
  const shrunkFields: string[] = [];

  let replaced = 0;
  for (const field of fields) {
    const rawName = field.getName();
    const key = fieldNameToKey(rawName);
    const value = resolve(key, `{{${key}}}`);

    // `keep` policy returns the placeholder untouched, which signals that this
    // field has no matching column and should be left as the template made it.
    if (value === `{{${key}}}`) continue;

    applyFieldValue(field, value, key);
    // A field drawn with an adopted font is measured against that font further
    // down; measuring it here with pdf-lib's default would judge it by metrics
    // it will never be drawn in.
    if (field instanceof PDFTextField && !usesAdoptedFont(field)) {
      const shrunk = fitTextField(field, value, key, defaultFont, overflow, minFontSize);
      if (shrunk !== undefined) shrunkFields.push(shrunk);
    }
    replaced += 1;
  }

  if (options.scrubMetadata ?? true) {
    scrubPdfMetadata(doc);
  }

  // Fields pointing at a font adopted from the page are drawn here, because
  // pdf-lib generates appearances with its own font and would silently swap the
  // typeface on every value.
  const adopted = drawAdoptedFields(doc, form, resolve, overflow, minFontSize);
  shrunkFields.push(...adopted.shrunk);

  if (flatten) {
    try {
      // Appearances already generated above must not be regenerated, or the
      // adopted font would be replaced by pdf-lib's default after all.
      form.flatten({ updateFieldAppearances: adopted.drawn === 0 });
    } catch (error) {
      throw new DoclystError(
        'RENDER_FAILED',
        `The filled PDF could not be flattened: ${safeErrorSummary(error)}.`,
        { cause: error },
      );
    }
    dropFlattenedRemnants(doc);
  }

  // Flattening already rasterises each field's appearance stream, so asking
  // for a second pass would be wasted work. When the caller keeps the fields
  // interactive, appearances must be regenerated or viewers show empty boxes.
  const bytes = await doc.save({ updateFieldAppearances: !flatten && adopted.drawn === 0 });
  return { bytes, replaced, shrunkFields };
}

/**
 * Draw the fields whose font was adopted from the page.
 *
 * The appearance stream is written by hand so the value appears in the same
 * typeface as the text around it. Without this the letter reads as two
 * documents spliced together, which is the whole thing the PDF-template route
 * exists to avoid.
 *
 * Returns how many fields were drawn, so the caller knows whether pdf-lib may
 * regenerate the rest.
 */
function drawAdoptedFields(
  doc: PDFDocument,
  form: ReturnType<PDFDocument['getForm']>,
  resolve: PlaceholderResolver,
  overflow: OverflowPolicy,
  minSize: number,
): { drawn: number; shrunk: string[] } {
  const resources = form.acroForm.dict.lookup(PDFName.of('DR'));
  const formFonts =
    resources instanceof PDFDict ? resources.lookup(PDFName.of('Font')) : undefined;
  if (!(formFonts instanceof PDFDict)) return { drawn: 0, shrunk: [] };

  let drawn = 0;
  const shrunk: string[] = [];
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;

    const appearance = field.acroField.getDefaultAppearance() ?? '';
    const fontName = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(appearance);
    if (fontName === null || !(fontName[1] ?? '').startsWith(ADOPTED_FONT_PREFIX)) continue;

    const name = fontName[1] as string;
    const size = Number.parseFloat(fontName[2] as string);
    const fontDict = formFonts.lookup(PDFName.of(name));
    if (!(fontDict instanceof PDFDict)) continue;

    const key = fieldNameToKey(field.getName());
    const value = resolve(key, `{{${key}}}`);
    if (value === `{{${key}}}`) continue;

    const font = readFontFromDict(fontDict);
    const result = drawFieldValue(doc, form, field, formFonts, name, font, size, value, key, overflow, minSize);
    if (result === 'drawn') drawn += 1;
    else if (result === 'shrunk') {
      drawn += 1;
      shrunk.push(key);
    }
  }
  return { drawn, shrunk };
}

/** Whether a field is set to be drawn with a font adopted from the page. */
function usesAdoptedFont(field: PDFTextField): boolean {
  const appearance = field.acroField.getDefaultAppearance() ?? '';
  const name = /\/(\S+)\s+[\d.]+\s+Tf/.exec(appearance)?.[1];
  return name !== undefined && name.startsWith(ADOPTED_FONT_PREFIX);
}

/** Write one field's appearance stream, drawing the value in the given font. */
function drawFieldValue(
  doc: PDFDocument,
  form: ReturnType<PDFDocument['getForm']>,
  field: PDFTextField,
  formFonts: PDFDict,
  fontName: string,
  font: FontInfo,
  size: number,
  value: string,
  key: string,
  overflow: OverflowPolicy,
  minSize: number,
): 'drawn' | 'shrunk' | 'skipped' {
  // A font that cannot spell the value is not used for it. Leaving the field to
  // pdf-lib's default font shows the value in the wrong typeface, which is far
  // better than showing it with holes where letters should be.
  const codes = font.encode(value);
  if (codes === undefined) return 'skipped';

  const widget = field.acroField.getWidgets()[0];
  if (widget === undefined) return 'skipped';

  const rectangle = widget.getRectangle();
  const width = font.bytesPerCode === 2 ? 2 : 1;
  const hex = codes
    .map((code) => code.toString(16).padStart(width * 2, '0'))
    .join('');

  // Shrink to the box using this font's own metrics, not pdf-lib's, since this
  // is the font the value will actually be drawn in.
  const advance = codes.reduce((sum, code) => sum + font.widthOf(code), 0) / 1000;
  const available = rectangle.width - 4;
  const overflows = advance > 0 && advance * size > available;

  if (overflows && overflow === 'error') {
    throw new DoclystError(
      'INVALID_DATA',
      `The value for "${key}" is too long for that field in the PDF template, and a PDF form field hides whatever does not fit. Widen the field, allow more lines, or shorten the value.`,
      { field: key },
    );
  }

  const fitted = overflows ? available / advance : size;
  if (overflows && overflow !== 'ignore' && fitted < minSize) {
    throw new DoclystError(
      'INVALID_DATA',
      `The value for "${key}" cannot be made to fit that field in the PDF template without shrinking it below ${minSize}pt, which would be unreadable. Widen the field, allow more lines, or shorten the value.`,
      { field: key },
    );
  }
  const drawSize = overflows && overflow !== 'ignore' ? fitted : size;

  // Sit the text on a baseline that centres the cap height in the box.
  const baseline = (rectangle.height - drawSize * 0.72) / 2;
  const stream = [
    '/Tx BMC',
    'q',
    'BT',
    `/${fontName} ${drawSize.toFixed(2)} Tf`,
    '0 g',
    `2 ${baseline.toFixed(2)} Td`,
    `<${hex}> Tj`,
    'ET',
    'Q',
    'EMC',
  ].join('\n');

  const appearance = doc.context.flateStream(stream, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, rectangle.width, rectangle.height],
    Resources: { Font: { [fontName]: formFonts.get(PDFName.of(fontName)) } },
  });

  const ref = doc.context.register(appearance);
  widget.setNormalAppearance(ref);
  // pdf-lib regenerates the appearance of any field still marked dirty, which
  // would replace what was just drawn with its own default font.
  form.markFieldAsClean(field.ref);

  return overflows && overflow !== 'ignore' ? 'shrunk' : 'drawn';
}

/**
 * Clear what flattening leaves behind.
 *
 * `flatten()` draws each field onto the page and deletes the field objects, but
 * the page's `/Annots` array keeps pointing at the widget annotations that have
 * just been removed. The result is a structurally invalid PDF — every generated
 * document carried ten dangling references in testing — which readers report as
 * a damaged file and strict validators reject outright. On a document being
 * sent to a candidate or kept as a record, that is not acceptable.
 *
 * Only references that no longer resolve are dropped, so genuine annotations
 * such as links survive. The empty form dictionary goes too: a flattened
 * document has no interactive form, and leaving one behind keeps a shell of the
 * field structure in a file that is supposed to be final.
 */
function dropFlattenedRemnants(doc: PDFDocument): void {
  const context = doc.context;
  const live = new Set<string>();
  for (const [ref] of context.enumerateIndirectObjects()) live.add(ref.tag);

  for (const page of doc.getPages()) {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) continue;

    const kept = annotations
      .asArray()
      .filter((entry) => !(entry instanceof PDFRef) || live.has(entry.tag));
    if (kept.length === annotations.size()) continue;

    if (kept.length === 0) {
      page.node.delete(PDFName.of('Annots'));
      continue;
    }
    const replacement = PDFArray.withContext(context);
    for (const entry of kept) replacement.push(entry);
    page.node.set(PDFName.of('Annots'), replacement);
  }

  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  if (!(acroForm instanceof PDFDict)) return;
  const fields = acroForm.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray) || fields.size() === 0) {
    doc.catalog.delete(PDFName.of('AcroForm'));
  }
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
 * Make a text value fit the box the template gives it.
 *
 * A PDF form field is a fixed rectangle with a clip path, so anything wider is
 * drawn and then hidden: the file contains the full address, the reader sees
 * half of it. Nothing in the format signals this, which is why it is checked
 * here rather than left to whoever opens the document.
 *
 * The measurement uses the same font pdf-lib will draw with, so it reflects
 * the real appearance rather than an estimate. Where it cannot be exact — a
 * template using a font Doclyst cannot resolve — it declines to guess and
 * leaves the value alone, because a false failure on a correct document is its
 * own kind of harm.
 */
function fitTextField(
  field: PDFTextField,
  value: string,
  key: string,
  font: PDFFont | undefined,
  policy: OverflowPolicy,
  minSize: number,
): string | undefined {
  if (policy === 'ignore' || value === '' || font === undefined) return undefined;

  const measured = measureFit(field, value, font, minSize);
  if (measured === undefined || measured.outcome === 'fits') return undefined;

  if (policy === 'error' || measured.outcome === 'overflows') {
    throw new DoclystError(
      'INVALID_DATA',
      measured.outcome === 'overflows'
        ? `The value for "${key}" cannot be made to fit that field in the PDF template without shrinking it below ${minSize}pt, which would be unreadable. Widen the field, allow more lines, or shorten the value.`
        : `The value for "${key}" is too long for that field in the PDF template, and a PDF form field hides whatever does not fit. Widen the field, allow more lines, or shorten the value.`,
      { field: key },
    );
  }

  field.setFontSize(measured.fittedSizePt);
  return key;
}

/** What would happen to a value placed in a field: the measurement, no writing. */
export interface FieldFit {
  readonly outcome: 'fits' | 'shrinks' | 'overflows';
  /** Size the text would be drawn at. Equals the template's size when it fits. */
  readonly fittedSizePt: number;
  /** Size the template asks for. */
  readonly templateSizePt: number;
}

/**
 * Measure a value against the box a field gives it, without changing anything.
 *
 * Split out from filling so the same arithmetic answers both questions: what to
 * do with this value now, and whether the template is big enough for the data
 * before a single document is written.
 */
function measureFit(
  field: PDFTextField,
  value: string,
  font: PDFFont,
  minSize: number,
): FieldFit | undefined {
  const widget = field.acroField.getWidgets()[0];
  if (widget === undefined) return undefined;

  const rectangle = widget.getRectangle();
  // pdf-lib insets the drawable area by the border, and leaves a point of
  // padding. Matching that keeps the check aligned with what is actually drawn.
  const border = widget.getBorderStyle()?.getWidth() ?? 0;
  const inset = border + 1;
  const width = rectangle.width - inset * 2;
  const height = rectangle.height - inset * 2;
  if (width <= 0 || height <= 0) return undefined;

  const declared = readFontSize(field);
  // Size 0 means the field auto-sizes; pdf-lib then picks a size itself, which
  // it will happily take below legibility, so it is checked the same way.
  const templateSizePt =
    declared === undefined || declared === 0 ? AUTO_SIZE_CEILING_PT : declared;
  const multiline = field.isMultiline();

  if (fits(font, value, templateSizePt, width, height, multiline)) {
    return { outcome: 'fits', fittedSizePt: templateSizePt, templateSizePt };
  }

  // Width scales linearly with size, so stepping down settles quickly; the loop
  // also covers the multiline case, where a smaller size changes the wrapping.
  let size = Math.min(templateSizePt, Math.floor(templateSizePt * 10) / 10);
  while (size >= minSize) {
    if (fits(font, value, size, width, height, multiline)) {
      return { outcome: 'shrinks', fittedSizePt: size, templateSizePt };
    }
    size = Math.round((size - 0.5) * 10) / 10;
  }

  return { outcome: 'overflows', fittedSizePt: minSize, templateSizePt };
}

/** How a template's fields stand up to the data that will be poured into them. */
export interface FieldFitReport {
  /** Placeholder key the field maps to. */
  readonly field: string;
  readonly outcome: 'fits' | 'shrinks' | 'overflows';
  /** Size the text would end up at, in points. */
  readonly fittedSizePt: number;
  /** Size the template asks for, in points. */
  readonly templateSizePt: number;
  /** 1-based row holding the value that drives this outcome. Never the value. */
  readonly worstRow: number;
}

/**
 * Check a PDF template against the data before generating anything.
 *
 * Filling is per-record, so a field that is too narrow for one person in four
 * hundred surfaces on that row and nowhere else — after the batch has run. This
 * asks the question up front, for every field, against the widest value the data
 * actually holds, and reports rows rather than values.
 */
export async function checkPdfTemplateFit(
  template: Uint8Array,
  records: readonly Readonly<Record<string, string>>[],
  options: { readonly minFontSizePt?: number } = {},
): Promise<FieldFitReport[]> {
  const doc = await loadPdf(template);
  const form = doc.getForm();
  const minSize = options.minFontSizePt ?? DEFAULT_MIN_FONT_SIZE_PT;

  let font: PDFFont | undefined;
  try {
    font = form.getDefaultFont();
  } catch {
    return [];
  }
  if (font === undefined) return [];

  const reports: FieldFitReport[] = [];
  for (const field of form.getFields()) {
    if (!(field instanceof PDFTextField)) continue;
    const key = fieldNameToKey(field.getName());

    // The widest value is the one that decides the field, so only it is
    // measured — and only its row number is reported.
    let worst: FieldFit | undefined;
    let worstRow = 0;
    for (const [index, record] of records.entries()) {
      const value = lookup(record, key);
      if (value === undefined || value === '') continue;
      const measured = measureFit(field, value, font, minSize);
      if (measured === undefined) continue;
      if (worst === undefined || isWorse(measured, worst)) {
        worst = measured;
        worstRow = index + 1;
      }
    }

    if (worst === undefined) continue;
    reports.push({
      field: key,
      outcome: worst.outcome,
      fittedSizePt: worst.fittedSizePt,
      templateSizePt: worst.templateSizePt,
      worstRow,
    });
  }

  return reports;
}

/**
 * Whether one measurement is a worse outcome than another.
 *
 * Severity has to rank ahead of size. Once two values have both bottomed out at
 * the legibility floor their fitted sizes are equal, so comparing sizes alone
 * would keep whichever was seen first and report a row that merely shrinks in
 * place of the row that genuinely does not fit.
 */
function isWorse(candidate: FieldFit, incumbent: FieldFit): boolean {
  const rank = { fits: 0, shrinks: 1, overflows: 2 } as const;
  if (rank[candidate.outcome] !== rank[incumbent.outcome]) {
    return rank[candidate.outcome] > rank[incumbent.outcome];
  }
  return candidate.fittedSizePt < incumbent.fittedSizePt;
}

/** Find a record's value for a placeholder key, matching headers loosely. */
function lookup(record: Readonly<Record<string, string>>, key: string): string | undefined {
  const wanted = normalizeHeader(key);
  for (const [header, value] of Object.entries(record)) {
    if (normalizeHeader(header) === wanted) return value;
  }
  return undefined;
}

function normalizeHeader(key: string): string {
  return key.trim().replace(/[\s.\-]+/g, '_').toUpperCase();
}

/** Whether a value fits a box at a given size, wrapping if the field allows. */
function fits(
  font: PDFFont,
  value: string,
  size: number,
  width: number,
  height: number,
  multiline: boolean,
): boolean {
  const lineHeight = font.heightAtSize(size);

  if (!multiline) {
    const singleLine = value.replace(/[\r\n]+/g, ' ');
    return font.widthOfTextAtSize(singleLine, size) <= width && lineHeight <= height;
  }

  let lines = 0;
  for (const paragraph of value.split(/\r?\n/)) {
    lines += countWrappedLines(font, paragraph, size, width);
  }
  return lines * lineHeight <= height;
}

/** How many lines a paragraph takes when wrapped to a width. */
function countWrappedLines(font: PDFFont, text: string, size: number, width: number): number {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return 1;

  let lines = 1;
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    // A single word wider than the box will overflow whatever we do; counting
    // it as its own line lets the caller shrink until it stops doing so.
    lines += 1;
    current = word;
  }
  return lines;
}

/** The font size a field's default appearance asks for, if it states one. */
function readFontSize(field: PDFTextField): number | undefined {
  const appearance = field.acroField.getDefaultAppearance() ?? '';
  const size = /\/[^\s/]+\s+([\d.]+)\s+Tf/.exec(appearance)?.[1];
  return size === undefined ? undefined : Number.parseFloat(size);
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
