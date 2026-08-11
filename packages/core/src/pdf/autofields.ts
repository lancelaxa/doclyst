import { PDFDict, PDFDocument, PDFName, StandardFonts, type PDFPage } from 'pdf-lib';
import { DoclystError, safeErrorSummary } from '../errors.js';
import { findPlaceholders } from '../template/placeholder.js';
import {
  readGlyphs,
  readPageContent,
  readPageFonts,
  removeGlyphs,
  writePageContent,
  type FontInfo,
  type Glyph,
} from './content.js';

/**
 * Turning a PDF that still has `{{PLACEHOLDERS}}` typed into it into a
 * fillable template.
 *
 * This is what makes exact fidelity practical. A letter designed in Word and
 * exported to PDF looks precisely as designed, because Word did the layout —
 * but filling it needs form fields, and placing thirty of those by hand in a
 * PDF editor is the step that stops teams adopting the approach. Here the
 * placeholders are found where they already sit, removed from the page, and a
 * correctly sized field is put in their place.
 *
 * The design is untouched. Only the placeholder glyphs are taken out, and the
 * text that follows them on the line keeps its position exactly.
 */

export interface PrepareTemplateOptions {
  /**
   * Extra width, as a multiple of the placeholder's own width, to allow for
   * values longer than the placeholder text. Defaults to 1 — no extra.
   *
   * A placeholder is rarely as wide as the value that replaces it, and a form
   * field hides what does not fit, so some slack is usually wanted. It is not
   * the default because widening a field can push it over neighbouring text,
   * which only the template's author can judge.
   */
  readonly widthFactor?: number;
  /** Leave the placeholder text visible under the field. Off by default. */
  readonly keepPlaceholderText?: boolean;
}

/** One field created from a placeholder. */
export interface PreparedField {
  /** Placeholder key, e.g. `CANDIDATE_NAME`. */
  readonly name: string;
  /** 1-based page the field's first occurrence is on. */
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * How many times the placeholder appears. A repeated one — `{{COMPANY_NAME}}`
   * in a letterhead and again in the closing — becomes a single field with a
   * widget at each place, so one value fills them all.
   */
  readonly occurrences: number;
  /** Font size the placeholder was set in, which the field inherits. */
  readonly fontSizePt: number;
  /**
   * False when the placeholder's own font could not safely be reused and the
   * field falls back to Helvetica, so the value will not match the surrounding
   * text. Reported rather than hidden: it is a visible difference.
   */
  readonly keptFont: boolean;
  /**
   * True when other text follows on the same line.
   *
   * PDF does not reflow, so such a field is a fixed box in the middle of a
   * sentence: a short value leaves a visible gap before the words after it, and
   * a long one has to shrink rather than push them along. Worth knowing before
   * a batch, and worth designing around — a placeholder on its own line, or at
   * the end of one, has neither problem.
   */
  readonly inline: boolean;
}

export interface PrepareTemplateResult {
  readonly bytes: Uint8Array;
  readonly fields: readonly PreparedField[];
  /**
   * Placeholders that were found but could not be turned into fields, with the
   * reason. Reported rather than dropped: a template silently missing a field
   * produces letters silently missing a value.
   */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Find every `{{PLACEHOLDER}}` in a PDF and replace it with a form field.
 *
 * The result is a template {@link fillPdf} can use, with the original page
 * design intact.
 */
export async function preparePdfTemplate(
  template: Uint8Array,
  options: PrepareTemplateOptions = {},
): Promise<PrepareTemplateResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(template, { updateMetadata: false });
  } catch (error) {
    throw new DoclystError(
      'INVALID_TEMPLATE',
      `The PDF could not be read: ${safeErrorSummary(error)}. Encrypted or password-protected PDFs are not supported.`,
      { cause: error },
    );
  }

  const existing = new Set(doc.getForm().getFields().map((field) => field.getName()));
  /** Fields the template arrived with, kept for the "already prepared" case. */
  const alreadyPresent = new Set(existing);
  const widthFactor = options.widthFactor ?? 1;

  const skipped: { name: string; reason: string }[] = [];

  /** Each placeholder, with every place on the page it has to appear. */
  interface Placed {
    readonly widgets: {
      readonly page: number;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[];
    readonly fontSizePt: number;
    readonly keptFont: boolean;
    readonly inline: boolean;
    readonly fontResource: string;
  }
  const placed = new Map<string, Placed>();

  doc.getPages().forEach((page, pageIndex) => {
    const found = findOnPage(page);

    // Removing text shifts nothing else, but the edits are applied together so
    // one failure cannot leave a page half-rewritten.
    const removals: Placement[] = [];

    for (const placement of found) {
      const name = placement.key;
      if (existing.has(name) && !placed.has(name)) {
        skipped.push({ name, reason: 'the template already has a field with this name' });
        continue;
      }

      existing.add(name);
      removals.push(placement);
      // Widening is capped at the room actually there, so asking for more
      // space than the line has cannot produce overlapping text.
      const width = Math.min(placement.width * widthFactor, placement.available);
      const widget = { page: pageIndex + 1, x: placement.x, y: placement.y, width, height: placement.height };

      // A placeholder used more than once — a company name in the letterhead
      // and again in the closing — is one field shown in several places, not
      // several fields. Anything else leaves the repeats printed as literal
      // `{{COMPANY_NAME}}` text on a letter about to be sent.
      const already = placed.get(name);
      if (already !== undefined) {
        already.widgets.push(widget);
        continue;
      }

      placed.set(name, {
        widgets: [widget],
        fontSizePt: placement.fontSize,
        keptFont: placement.fontIsReusable,
        inline: placement.inline,
        fontResource: placement.fontResource,
      });
    }

    if (!options.keepPlaceholderText && removals.length > 0) {
      hidePlaceholders(page, removals);
    }
  });

  const fields: PreparedField[] = [...placed].map(([name, entry]) => {
    const first = entry.widgets[0] as Placed['widgets'][number];
    return {
      name,
      page: first.page,
      x: first.x,
      y: first.y,
      // The narrowest occurrence governs: a value has to fit everywhere it is
      // shown, not just the first place.
      width: Math.min(...entry.widgets.map((widget) => widget.width)),
      height: first.height,
      fontSizePt: entry.fontSizePt,
      keptFont: entry.keptFont,
      inline: entry.inline,
      occurrences: entry.widgets.length,
    };
  });

  if (fields.length === 0 && skipped.length === 0) {
    // The likeliest reason to find no placeholders is that this file has
    // already been through here. Saying so beats sending someone to look for a
    // fault in a source document that has nothing wrong with it.
    if (alreadyPresent.size > 0) {
      throw new DoclystError(
        'UNSUPPORTED_TEMPLATE',
        `This PDF has no {{PLACEHOLDER}} text but does have ${alreadyPresent.size} form field(s), so it looks like a template that was already prepared. It is ready to fill as it is. To change it, edit the original document, save it as PDF again, and prepare that.`,
      );
    }
    throw new DoclystError(
      'UNSUPPORTED_TEMPLATE',
      'No {{PLACEHOLDER}} text was found in this PDF. Check that the placeholders are typed into the document as ordinary text, and that the PDF is not a scan.',
    );
  }

  const form = doc.getForm();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  for (const [name, entry] of placed) {
    const textField = form.createTextField(name);
    for (const widget of entry.widgets) {
      textField.addToPage(doc.getPage(widget.page - 1), {
        x: widget.x,
        y: widget.y,
        width: widget.width,
        height: widget.height,
        font: helvetica,
        // A form field draws a black border and a white box unless told not to.
        // Either would be a mark on the page that the design never had.
        borderWidth: 0,
        borderColor: undefined,
        backgroundColor: undefined,
      });
    }

    // The default appearance only exists once a widget is on a page, so the
    // font and size are applied after placing them.
    const firstPage = doc.getPage((entry.widgets[0] as { page: number }).page - 1);
    const adopted = entry.keptFont
      ? adoptPageFont(doc, firstPage, entry.fontResource)
      : undefined;
    const field = { fontSizePt: entry.fontSizePt };

    if (adopted !== undefined) {
      textField.acroField.setDefaultAppearance(
        `/${adopted} ${field.fontSizePt} Tf 0 g`,
      );
    } else {
      textField.setFontSize(field.fontSizePt);
    }
  }

  return { bytes: await doc.save(), fields, skipped };
}

/**
 * Make a page's font available to the form, and return the name to use for it.
 *
 * Filling with Helvetica when the letter is set in something else is exactly
 * the sort of near-miss that makes an automated document look automated, so the
 * field is pointed at the font the placeholder was already in. The font is
 * already embedded; only a reference from the form's resource dictionary is
 * added.
 */
function adoptPageFont(doc: PDFDocument, page: PDFPage, resource: string): string | undefined {
  const pageFonts = page.node.Resources()?.lookup(PDFName.of('Font'));
  if (!(pageFonts instanceof PDFDict)) return undefined;

  const entry = pageFonts.get(PDFName.of(resource));
  if (entry === undefined) return undefined;

  const acroForm = doc.getForm().acroForm.dict;
  let resources = acroForm.lookup(PDFName.of('DR'));
  if (!(resources instanceof PDFDict)) {
    resources = doc.context.obj({});
    acroForm.set(PDFName.of('DR'), resources);
  }
  let formFonts = (resources as PDFDict).lookup(PDFName.of('Font'));
  if (!(formFonts instanceof PDFDict)) {
    formFonts = doc.context.obj({});
    (resources as PDFDict).set(PDFName.of('Font'), formFonts);
  }

  // Namespaced so a page resource cannot collide with a name the form already
  // uses for something else.
  const name = `Doclyst${resource}`;
  (formFonts as PDFDict).set(PDFName.of(name), entry);
  return name;
}

/** A placeholder located on a page, with the box it occupies. */
interface Placement {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly glyphs: readonly Glyph[];
  /** Page resource name of the font the placeholder was set in. */
  readonly fontResource: string;
  /** Whether that font can be reused for arbitrary values. */
  readonly fontIsReusable: boolean;
  /**
   * Space from the placeholder's left edge to the next text on the same line,
   * or to the edge of the page when nothing follows.
   */
  readonly available: number;
  /** True when other text follows on the same line. */
  readonly inline: boolean;
}

/**
 * Locate the placeholders on one page.
 *
 * Glyphs are grouped into lines by baseline before matching, because a
 * placeholder is routinely split across several show-text operations — the same
 * thing Word does inside a .docx — and matching per operation would miss most
 * of them.
 */
function findOnPage(page: PDFPage): Placement[] {
  const fonts = readPageFonts(page);
  const glyphs = readGlyphs(readPageContent(page), fonts);
  if (glyphs.length === 0) return [];

  // Where a field may run to when nothing follows it on the line. The page's
  // own right edge, less the margin the text itself establishes.
  const { width: pageWidth } = page.getSize();
  const leftMargin = Math.min(...glyphs.map((glyph) => glyph.x));
  const pageRight = pageWidth - leftMargin;

  const lines = new Map<string, Glyph[]>();
  for (const glyph of glyphs) {
    // Baselines are grouped to a tenth of a point; rounding harder would merge
    // a superscript into its line, and softer would split a line in two.
    const key = glyph.y.toFixed(1);
    const line = lines.get(key);
    if (line === undefined) lines.set(key, [glyph]);
    else line.push(glyph);
  }

  const placements: Placement[] = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.x - b.x);

    // Character offsets are mapped back to glyphs, since one glyph can decode
    // to several characters and a match has to resolve to real positions.
    const offsets: number[] = [];
    let text = '';
    for (const [index, glyph] of line.entries()) {
      for (let i = 0; i < glyph.text.length; i += 1) offsets.push(index);
      text += glyph.text;
    }

    for (const match of findPlaceholders(text)) {
      const first = offsets[match.start];
      const last = offsets[match.end - 1];
      if (first === undefined || last === undefined) continue;

      const covered = line.slice(first, last + 1);
      if (covered.length === 0) continue;

      const left = covered[0] as Glyph;
      const size = Math.max(...covered.map((glyph) => glyph.size));
      const width = covered.reduce((sum, glyph) => sum + glyph.width, 0);

      const fontResource = left.font;
      const font: FontInfo | undefined = fonts.get(fontResource);

      // A field must not extend over whatever comes next on the line. PDF has
      // no reflow, so an over-wide box does not push the following words along
      // — it prints on top of them.
      const right = left.x + width;
      const following = line
        .slice(last + 1)
        .find((glyph) => glyph.x >= right - 0.01 && glyph.text.trim() !== '');
      const available = following === undefined
        ? Math.max(width, pageRight - left.x)
        : following.x - left.x;

      placements.push({
        available,
        inline: following !== undefined,
        key: match.key,
        x: left.x,
        // A form field is positioned by its box, not its baseline. Descenders
        // sit about a fifth of the size below it.
        y: left.y - size * 0.22,
        width,
        height: size * 1.25,
        fontSize: size,
        glyphs: covered,
        fontResource,
        fontIsReusable: font?.coversBasicLatin() ?? false,
      });
    }
  }

  return placements;
}

/**
 * Take the placeholder text off the page.
 *
 * Drawing a white box over it would be easier and wrong: the words would stay
 * in the file, findable by any text extractor and visible the moment the box
 * was removed. The glyphs are deleted from the content stream instead, and the
 * space they occupied is preserved so nothing around them moves.
 */
function hidePlaceholders(page: PDFPage, placements: readonly Placement[]): void {
  const glyphs = placements.flatMap((placement) => placement.glyphs);
  const content = readPageContent(page);
  writePageContent(page, removeGlyphs(content, glyphs));
}
