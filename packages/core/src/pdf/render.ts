import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { DoclystError, safeErrorSummary } from '../errors.js';
import type { Alignment, DocumentModel, Paragraph, TextRun } from '../docx/model.js';

/**
 * Typeset a document model into a PDF.
 *
 * This is what makes PDF output possible without a layout engine: rather than
 * trying to reproduce Word's own line breaking, the text is re-typeset here
 * with rules we control. For a letter — paragraphs, some emphasis — the result
 * is a faithful document. It is not a pixel copy of the Word file, and is not
 * meant to be.
 *
 * Only the PDF standard fonts are used, so nothing has to be downloaded and the
 * output stays small. That caps the character set at WinAnsi, which covers
 * Western European text but not, for example, Chinese or Tamil. Rather than
 * emit a document with missing glyphs, unrepresentable characters are reported
 * as an error naming the row — a mangled contract is worse than a failed one.
 */

export interface PdfRenderOptions {
  /** Page width and height in points. Defaults to A4. */
  readonly pageSize?: readonly [number, number];
  /** Margin in points on all sides. */
  readonly marginPt?: number;
  /** Base font size in points, used where a run sets none. */
  readonly fontSizePt?: number;
  /** Line height as a multiple of font size. */
  readonly lineHeight?: number;
  /** Extra space after each paragraph, in points. */
  readonly paragraphSpacingPt?: number;
  /** Strip document metadata. On by default, matching the DOCX path. */
  readonly scrubMetadata?: boolean;
}

/** A4 at 72 dpi. */
const A4: readonly [number, number] = [595.28, 841.89];

const DEFAULTS = {
  marginPt: 56,
  fontSizePt: 11,
  lineHeight: 1.4,
  paragraphSpacingPt: 6,
} as const;

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly italic: PDFFont;
  readonly boldItalic: PDFFont;
}

/** One word, carrying the formatting of the run it came from. */
interface Word {
  readonly text: string;
  readonly font: PDFFont;
  readonly size: number;
  readonly width: number;
}

export async function renderModelToPdf(
  model: DocumentModel,
  options: PdfRenderOptions = {},
): Promise<Uint8Array> {
  const pageSize = options.pageSize ?? A4;
  const margin = options.marginPt ?? DEFAULTS.marginPt;
  const baseSize = options.fontSizePt ?? DEFAULTS.fontSizePt;
  const lineHeight = options.lineHeight ?? DEFAULTS.lineHeight;
  const paragraphSpacing = options.paragraphSpacingPt ?? DEFAULTS.paragraphSpacingPt;

  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  const contentWidth = pageSize[0] - margin * 2;
  let page = doc.addPage([pageSize[0], pageSize[1]]);
  let y = pageSize[1] - margin;

  const newPage = (): void => {
    page = doc.addPage([pageSize[0], pageSize[1]]);
    y = pageSize[1] - margin;
  };

  for (const paragraph of model.paragraphs) {
    for (const line of layOutParagraph(paragraph, fonts, baseSize, contentWidth)) {
      const lineSize = line.words.length > 0 ? Math.max(...line.words.map((w) => w.size)) : baseSize;
      const advance = lineSize * lineHeight;

      // Break before drawing, so a line is never split across the fold.
      if (y - advance < margin) newPage();
      y -= advance;
      drawLine(page, line, paragraph.alignment, margin, contentWidth, y);
    }
    y -= paragraphSpacing;
  }

  if (options.scrubMetadata ?? true) {
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

  return doc.save();
}

interface Line {
  readonly words: readonly Word[];
  /** True for the last line of a paragraph, which is never justified. */
  readonly last: boolean;
}

/** Break a paragraph into lines that fit the content width. */
function layOutParagraph(
  paragraph: Paragraph,
  fonts: Fonts,
  baseSize: number,
  contentWidth: number,
): Line[] {
  const lines: Line[] = [];
  let current: Word[] = [];
  let width = 0;

  const flush = (last: boolean): void => {
    lines.push({ words: current, last });
    current = [];
    width = 0;
  };

  for (const run of paragraph.runs) {
    const font = pickFont(fonts, run);
    const size = run.sizePt ?? baseSize;

    // An explicit line break inside a run ends the line without ending the
    // paragraph, which is how multi-line addresses arrive from a spreadsheet.
    for (const [index, segment] of run.text.split('\n').entries()) {
      if (index > 0) flush(false);

      for (const token of segment.replace(/\t/g, '    ').split(/(\s+)/)) {
        if (token === '' || /^\s+$/.test(token)) {
          // Collapse runs of whitespace into a single space, and never let a
          // line begin with one.
          if (current.length > 0) {
            const space = measure(' ', font, size);
            if (width + space.width <= contentWidth) {
              current.push(space);
              width += space.width;
            }
          }
          continue;
        }

        const word = measure(token, font, size);
        if (current.length > 0 && width + word.width > contentWidth) {
          // Drop a trailing space before wrapping, so it does not affect
          // centring or right alignment on the finished line.
          while (current.length > 0 && current[current.length - 1]!.text === ' ') current.pop();
          flush(false);
        }
        current.push(word);
        width += word.width;
      }
    }
  }

  flush(true);
  return lines;
}

function pickFont(fonts: Fonts, run: TextRun): PDFFont {
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

function measure(text: string, font: PDFFont, size: number): Word {
  try {
    return { text, font, size, width: font.widthOfTextAtSize(text, size) };
  } catch (error) {
    throw unrepresentable(text, error);
  }
}

/** Draw one laid-out line, honouring the paragraph's alignment. */
function drawLine(
  page: PDFPage,
  line: Line,
  alignment: Alignment,
  margin: number,
  contentWidth: number,
  y: number,
): void {
  const words = [...line.words];
  while (words.length > 0 && words[words.length - 1]!.text === ' ') words.pop();
  if (words.length === 0) return;

  const natural = words.reduce((sum, w) => sum + w.width, 0);
  let x = margin;
  let extraPerGap = 0;

  if (alignment === 'center') {
    x = margin + (contentWidth - natural) / 2;
  } else if (alignment === 'right') {
    x = margin + (contentWidth - natural);
  } else if (alignment === 'justify' && !line.last) {
    // Justification stretches the spaces, never the words.
    const gaps = words.filter((w) => w.text === ' ').length;
    if (gaps > 0) extraPerGap = (contentWidth - natural) / gaps;
  }

  for (const word of words) {
    try {
      page.drawText(word.text, { x, y, size: word.size, font: word.font });
    } catch (error) {
      throw unrepresentable(word.text, error);
    }
    x += word.width + (word.text === ' ' ? extraPerGap : 0);
  }
}

/**
 * Turn a font encoding failure into an error that names the problem.
 *
 * pdf-lib's own message quotes the offending text, which may be someone's
 * name, so it is replaced rather than passed through.
 */
function unrepresentable(text: string, error: unknown): DoclystError {
  const offending = [...text].filter((c) => c.charCodeAt(0) > 0xff);
  if (offending.length > 0) {
    return new DoclystError(
      'RENDER_FAILED',
      `This text cannot be written to a PDF with the built-in fonts, which cover Western European characters only. ${offending.length} character(s) are outside that range.`,
    );
  }
  return new DoclystError('RENDER_FAILED', `The text could not be drawn: ${safeErrorSummary(error)}.`);
}
