import { decodeXmlText } from './xml.js';

/**
 * A minimal document model extracted from WordprocessingML.
 *
 * This exists so a filled template can be rendered straight to PDF. Converting
 * arbitrary Word layout faithfully needs a full layout engine, which cannot run
 * in a browser; but a letter is paragraphs of text with a little emphasis, and
 * that much can be re-typeset accurately. The model deliberately captures only
 * what can be reproduced honestly — anything richer is reported rather than
 * silently dropped.
 */

export type Alignment = 'left' | 'center' | 'right' | 'justify';

export interface TextRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Font size in points, when the run sets one explicitly. */
  readonly sizePt?: number;
}

export interface Paragraph {
  readonly runs: readonly TextRun[];
  readonly alignment: Alignment;
}

export interface DocumentModel {
  readonly paragraphs: readonly Paragraph[];
  /**
   * Features present in the source that the model cannot represent, so a
   * caller can warn rather than let someone discover a missing table in a
   * contract after it was sent.
   */
  readonly unsupported: readonly string[];
}

const PARAGRAPH_RE = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
const RUN_RE = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
const TEXT_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>/g;

/** Extract a renderable model from a `word/document.xml` string. */
export function extractDocumentModel(xml: string): DocumentModel {
  const paragraphs: Paragraph[] = [];
  const unsupported = new Set<string>();

  // `[\s/>]` rather than `[\s>]`, so a self-closing element counts too — a
  // detector that misses `<w:drawing/>` would report a document as fully
  // representable and drop the image without a word.
  if (/<w:tbl[\s/>]/.test(xml)) unsupported.add('tables');
  if (/<w:drawing[\s/>]|<w:pict[\s/>]/.test(xml)) unsupported.add('images');
  if (/<w:numPr[\s/>]/.test(xml)) unsupported.add('automatic numbering and bullets');

  PARAGRAPH_RE.lastIndex = 0;
  let paragraphMatch: RegExpExecArray | null;
  while ((paragraphMatch = PARAGRAPH_RE.exec(xml)) !== null) {
    const body = paragraphMatch[1] ?? '';
    paragraphs.push({
      runs: extractRuns(body),
      alignment: readAlignment(body),
    });
  }

  return { paragraphs, unsupported: [...unsupported] };
}

function readAlignment(paragraphXml: string): Alignment {
  // Only the paragraph's own properties count; a `w:jc` inside a nested run
  // would not be a paragraph alignment.
  const properties = /<w:pPr\b[^>]*>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1] ?? '';
  const value = /<w:jc\s+w:val="([^"]+)"/.exec(properties)?.[1];
  switch (value) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'distribute':
      return 'justify';
    default:
      return 'left';
  }
}

function extractRuns(paragraphXml: string): TextRun[] {
  const runs: TextRun[] = [];

  RUN_RE.lastIndex = 0;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = RUN_RE.exec(paragraphXml)) !== null) {
    const body = runMatch[1] ?? '';
    const properties = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1] ?? '';

    // `<w:b w:val="0"/>` switches bold off again, so the value is checked.
    const bold = isToggleOn(properties, 'b');
    const italic = isToggleOn(properties, 'i');
    // Word stores sizes in half-points.
    const halfPoints = Number.parseInt(/<w:sz\s+w:val="(\d+)"/.exec(properties)?.[1] ?? '', 10);
    const sizePt = Number.isFinite(halfPoints) ? halfPoints / 2 : undefined;

    let text = '';
    TEXT_RE.lastIndex = 0;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = TEXT_RE.exec(body)) !== null) {
      text += decodeXmlText(textMatch[1] ?? '');
    }
    // Word's own break and tab elements carry meaning that the text nodes do
    // not, so they are folded back into the string the renderer sees.
    if (/<w:br\b[^>]*\/>/.test(body)) text += '\n';
    if (/<w:tab\b[^>]*\/>/.test(body)) text = text.replace(/^/, '\t');

    if (text === '') continue;
    runs.push(sizePt === undefined ? { text, bold, italic } : { text, bold, italic, sizePt });
  }

  return runs;
}

/** True when a Word on/off property is present and not explicitly disabled. */
function isToggleOn(properties: string, tag: string): boolean {
  const match = new RegExp(`<w:${tag}(\\s[^>]*)?/?>`).exec(properties);
  if (!match) return false;
  const value = /w:val="([^"]+)"/.exec(match[1] ?? '')?.[1];
  return value === undefined || !['0', 'false', 'off'].includes(value);
}

/** The plain text of a model, used for diagnostics and tests. */
export function modelToText(model: DocumentModel): string {
  return model.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}
