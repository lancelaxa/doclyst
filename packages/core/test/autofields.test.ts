import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib';
import { unzlibSync } from 'fflate';
import { DoclystError } from '../src/errors.js';
import { preparePdfTemplate } from '../src/pdf/autofields.js';
import { checkPdfTemplateFit, fillPdf, readPdfFields } from '../src/pdf/fill.js';
import { readGlyphs, readPageContent, readPageFonts } from '../src/pdf/content.js';

/**
 * Turning a PDF that still reads `{{NAME}}` into a fillable template.
 *
 * The point of the whole exercise is that the page is left alone: a letter
 * designed in Word and exported to PDF looks exactly as designed, and preparing
 * it must not disturb that. So these tests care most about what did *not*
 * change — the position of every other word on the page.
 *
 * All values are synthetic.
 */

/** The text the page's own content stream draws. */
async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(0);
  return readGlyphs(readPageContent(page), readPageFonts(page))
    .map((glyph) => glyph.text)
    .join('');
}

/**
 * Every string drawn anywhere in the file, including inside form XObjects.
 *
 * A filled field's value is drawn in its appearance stream, which flattening
 * then references rather than inlining, so the page's own content stream is not
 * where the value ends up.
 */
function drawnText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const streams: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start < 0) break;
    let begin = start + 'stream'.length;
    if (raw[begin] === 0x0d) begin += 1;
    if (raw[begin] === 0x0a) begin += 1;
    const end = raw.indexOf('endstream', begin);
    if (end < 0) break;
    try {
      streams.push(Buffer.from(unzlibSync(raw.subarray(begin, end))).toString('latin1'));
    } catch {
      streams.push(raw.subarray(begin, end).toString('latin1'));
    }
    cursor = end + 'endstream'.length;
  }

  const content = streams.join('\n');
  const shown: string[] = [];
  const token = /\(((?:\\.|[^()\\])*)\)\s*Tj|<([0-9A-Fa-f]*)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(content)) !== null) {
    shown.push(
      match[1] !== undefined
        ? match[1].replace(/\\([()\\])/g, '$1')
        : Buffer.from(match[2] ?? '', 'hex').toString('latin1'),
    );
  }
  return shown.join('\u0001');
}

/** Where each word sits, so a rewrite can be shown not to have moved anything. */
async function wordPositions(bytes: Uint8Array): Promise<Map<string, string>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(0);
  const glyphs = readGlyphs(readPageContent(page), readPageFonts(page));

  const positions = new Map<string, string>();
  let word = '';
  let start: { x: number; y: number } | undefined;
  for (const glyph of glyphs) {
    if (glyph.text === ' ' || glyph.text === '') {
      if (word !== '' && start !== undefined) {
        positions.set(word, `${start.x.toFixed(2)},${start.y.toFixed(2)}`);
      }
      word = '';
      start = undefined;
      continue;
    }
    if (start === undefined) start = { x: glyph.x, y: glyph.y };
    word += glyph.text;
  }
  if (word !== '' && start !== undefined) {
    positions.set(word, `${start.x.toFixed(2)},${start.y.toFixed(2)}`);
  }
  return positions;
}

async function letter(lines: readonly string[], size = 11): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => {
    page.drawText(line, { x: 56, y: 760 - index * 24, size, font });
  });
  return doc.save();
}

describe('preparePdfTemplate', () => {
  it('creates a field for every placeholder, named after it', async () => {
    const result = await preparePdfTemplate(
      await letter(['Dear {{CANDIDATE_NAME}},', 'Your title is {{JOB_TITLE}}.']),
    );
    expect(result.fields.map((field) => field.name).sort()).toEqual([
      'CANDIDATE_NAME',
      'JOB_TITLE',
    ]);
    expect(await readPdfFields(result.bytes)).toHaveLength(2);
  });

  it('places each field where its placeholder was', async () => {
    const template = await letter(['Dear {{CANDIDATE_NAME}},']);
    const before = await wordPositions(template);
    const result = await preparePdfTemplate(template);

    const placeholder = before.get('{{CANDIDATE_NAME}},');
    expect(placeholder).toBeDefined();
    const [x] = (placeholder as string).split(',').map(Number);

    const field = result.fields[0] as { x: number; width: number };
    expect(field.x).toBeCloseTo(x as number, 1);
    expect(field.width).toBeGreaterThan(0);
  });

  it('takes the placeholder text off the page rather than covering it', async () => {
    // Covering would leave the words in the file, findable by any extractor.
    const result = await preparePdfTemplate(await letter(['Dear {{CANDIDATE_NAME}},']));
    const text = await pageText(result.bytes);
    expect(text).not.toContain('{{');
    expect(text).not.toContain('CANDIDATE_NAME');
    expect(text).toContain('Dear');
  });

  it('leaves no copy of the placeholder text anywhere in the file', async () => {
    // Regression: replacing a page's content stream leaves the old one in the
    // file unless it is deleted outright. It is unreferenced, so no reader
    // shows it — and perfectly readable to anything that inflates the streams.
    const result = await preparePdfTemplate(
      await letter(['Dear {{CANDIDATE_NAME}},', 'Position: {{JOB_TITLE}}.']),
    );
    const everything = drawnText(result.bytes);
    expect(everything).not.toContain('CANDIDATE_NAME');
    expect(everything).not.toContain('JOB_TITLE');
  });

  it('leaves every other word exactly where it was', async () => {
    // This is the whole promise of the feature. Removing glyphs from the middle
    // of a line would slide everything after them left unless the space is
    // preserved, and the shift would be small enough to miss by eye.
    const template = await letter([
      'Dear {{CANDIDATE_NAME}}, welcome aboard.',
      'Position: {{JOB_TITLE}} reporting to {{REPORTING_MANAGER}} from {{START_DATE}}.',
      'Signed by the Head of People Operations.',
    ]);
    const before = await wordPositions(template);
    const after = await wordPositions((await preparePdfTemplate(template)).bytes);

    const survivors = [...before.keys()].filter((word) => !word.includes('{{'));
    expect(survivors.length).toBeGreaterThan(8);
    for (const word of survivors) {
      expect(`${word} at ${after.get(word)}`).toBe(`${word} at ${before.get(word)}`);
    }
  });

  it('handles several placeholders on one line', async () => {
    const result = await preparePdfTemplate(
      await letter(['{{A_FIELD}} and {{B_FIELD}} and {{C_FIELD}}']),
    );
    expect(result.fields.map((field) => field.name)).toEqual([
      'A_FIELD',
      'B_FIELD',
      'C_FIELD',
    ]);
  });

  it('gives each field the size its placeholder was set in', async () => {
    const result = await preparePdfTemplate(await letter(['Title: {{JOB_TITLE}}'], 18));
    expect(result.fields[0]!.fontSizePt).toBeCloseTo(18, 1);
  });

  it('refuses a PDF with no placeholders, rather than returning an empty template', async () => {
    await expect(preparePdfTemplate(await letter(['An ordinary letter.']))).rejects.toThrow(
      /No \{\{PLACEHOLDER\}\} text was found/,
    );
  });

  it('reports a repeated placeholder instead of creating a broken field', async () => {
    const result = await preparePdfTemplate(
      await letter(['{{FULL_NAME}} here', 'and {{FULL_NAME}} again']),
    );
    expect(result.fields).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ name: 'FULL_NAME' });
    expect(result.skipped[0]!.reason).toContain('more than once');
  });

  it('does not draw a border or a background the design never had', async () => {
    const result = await preparePdfTemplate(await letter(['Dear {{CANDIDATE_NAME}},']));
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const widget = doc.getForm().getFields()[0]!.acroField.getWidgets()[0]!;

    const appearance = widget.dict.lookup(PDFName.of('MK'));
    // No appearance characteristics at all, or none that paint anything.
    if (appearance instanceof PDFDict) {
      expect(appearance.lookup(PDFName.of('BG'))).toBeUndefined();
      expect(appearance.lookup(PDFName.of('BC'))).toBeUndefined();
    }
  });

  it('can widen the fields, for values longer than the placeholder', async () => {
    // Widening is asked for by a factor and granted up to the room available,
    // so the check is that it grows — not that it grows by exactly the factor.
    const line = ['Name: {{CANDIDATE_NAME}}'];
    const plain = await preparePdfTemplate(await letter(line));
    const wide = await preparePdfTemplate(await letter(line), { widthFactor: 2 });
    expect(wide.fields[0]!.width).toBeCloseTo(plain.fields[0]!.width * 2, 1);
  });

  it('never widens a field over the text that follows it', async () => {
    // PDF does not reflow: an over-wide box prints on top of the next words
    // rather than pushing them along, and asking for extra width is the
    // obvious way to cause it.
    const template = await letter(['Position: {{JOB_TITLE}} reporting to the Head.']);
    const narrow = await preparePdfTemplate(template);
    const asked = await preparePdfTemplate(template, { widthFactor: 5 });

    const field = asked.fields[0]!;
    expect(field.width).toBeGreaterThanOrEqual(narrow.fields[0]!.width);

    // The gap to the next word is the ceiling, whatever was requested.
    const before = await wordPositions(template);
    const [placeholderX] = (before.get('{{JOB_TITLE}}') as string).split(',').map(Number);
    const [nextX] = (before.get('reporting') as string).split(',').map(Number);
    expect(field.width).toBeLessThanOrEqual((nextX as number) - (placeholderX as number) + 0.01);
  });

  it('flags a placeholder with text after it on the same line', async () => {
    const result = await preparePdfTemplate(
      await letter(['Position: {{JOB_TITLE}} reporting to the Head.', '{{SIGNATORY_NAME}}']),
    );
    const byName = new Map(result.fields.map((field) => [field.name, field]));
    expect(byName.get('JOB_TITLE')!.inline).toBe(true);
    expect(byName.get('SIGNATORY_NAME')!.inline).toBe(false);
  });

  it('lets a placeholder at the end of a line use the rest of the width', async () => {
    const result = await preparePdfTemplate(
      await letter(['Name: {{FULL_NAME}}']),
      { widthFactor: 3 },
    );
    // Nothing follows, so widening is free.
    const plain = await preparePdfTemplate(await letter(['Name: {{FULL_NAME}}']));
    expect(result.fields[0]!.width).toBeGreaterThan(plain.fields[0]!.width * 2);
  });

  it('recognises a template it has already prepared', async () => {
    // The likeliest way to reach "no placeholders" is to feed back the prepared
    // file, and the generic message would send someone hunting for a fault in a
    // source document that has nothing wrong with it.
    const prepared = await preparePdfTemplate(await letter(['Dear {{CANDIDATE_NAME}},']));
    const error = await preparePdfTemplate(prepared.bytes).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclystError);
    expect((error as DoclystError).message).toContain('already prepared');
    expect((error as DoclystError).message).toContain('ready to fill');
  });

  it('still gives the plain message for a PDF that simply has no placeholders', async () => {
    const error = await preparePdfTemplate(await letter(['An ordinary letter.'])).catch(
      (e: unknown) => e,
    );
    expect((error as DoclystError).message).toContain('No {{PLACEHOLDER}} text was found');
    expect((error as DoclystError).message).not.toContain('already prepared');
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(preparePdfTemplate(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(DoclystError);
  });
});

describe('a prepared template, once filled', () => {
  const RECORD: Record<string, string> = {
    CANDIDATE_NAME: 'Aisha Rahman',
    JOB_TITLE: 'Data Analyst',
    REPORTING_MANAGER: 'Wei Lun Tan',
  };

  it('shows the values where the placeholders were', async () => {
    const prepared = await preparePdfTemplate(
      await letter(['Dear {{CANDIDATE_NAME}},', 'Position: {{JOB_TITLE}}.']),
    );
    const filled = await fillPdf(prepared.bytes, (key) => RECORD[key] ?? '', {});

    // The values are drawn in the fields' appearance streams...
    const drawn = drawnText(filled.bytes);
    expect(drawn).toContain('Aisha Rahman');
    expect(drawn).toContain('Data Analyst');

    // ...and the page still carries its own text, minus the placeholders.
    const page = await pageText(filled.bytes);
    expect(page).toContain('Dear');
    expect(page).toContain('Position:');
    expect(page).not.toContain('{{');
  });

  it('keeps the surrounding text in place through preparing and filling', async () => {
    const template = await letter([
      'Dear {{CANDIDATE_NAME}}, welcome aboard.',
      'Position: {{JOB_TITLE}} reporting to {{REPORTING_MANAGER}}.',
    ]);
    const before = await wordPositions(template);
    const prepared = await preparePdfTemplate(template);
    const filled = await fillPdf(prepared.bytes, (key) => RECORD[key] ?? '', {});
    const after = await wordPositions(filled.bytes);

    for (const word of ['Dear', 'welcome', 'aboard.', 'Position:', 'reporting', 'to']) {
      expect(`${word} at ${after.get(word)}`).toBe(`${word} at ${before.get(word)}`);
    }
  });

  it('produces one document per record, with no value from another', async () => {
    const prepared = await preparePdfTemplate(await letter(['Dear {{CANDIDATE_NAME}},']));

    const first = await fillPdf(prepared.bytes, () => 'Aisha Rahman', {});
    const second = await fillPdf(prepared.bytes, () => 'Priya Nair', {});

    expect(drawnText(first.bytes)).toContain('Aisha Rahman');
    expect(drawnText(first.bytes)).not.toContain('Priya Nair');
    expect(drawnText(second.bytes)).toContain('Priya Nair');
  });

  it('draws the value in the font the placeholder was in', async () => {
    // Filling a letter's own typeface with Helvetica is the near-miss that
    // makes an automated document look automated.
    const prepared = await preparePdfTemplate(await letter(['Dear {{CANDIDATE_NAME}},']));
    const doc = await PDFDocument.load(prepared.bytes, { updateMetadata: false });
    const appearance = doc.getForm().getFields()[0]!.acroField.getDefaultAppearance() ?? '';
    expect(appearance).toMatch(/\/Doclyst\S+\s+[\d.]+\s+Tf/);
  });
});

/**
 * The pre-flight check has to predict the run.
 *
 * A prepared template draws its values in a font lifted from the page. Checking
 * it against pdf-lib's default font instead answered a different question:
 * `inspect` called three fields tight where filling shrank one. A check that
 * disagrees with the thing it is checking is worse than no check.
 */
describe('checking a prepared template against the data', () => {
  it('predicts exactly the fields that filling shrinks', async () => {
    const prepared = await preparePdfTemplate(
      await letter(['Name: {{FULL_NAME}}', 'Title: {{JOB_TITLE}}']),
    );
    // Long enough to need shrinking, short enough to still fit legibly.
    const records = [{ FULL_NAME: 'Aisha', JOB_TITLE: 'Senior Data Analyst' }];

    const predicted = (await checkPdfTemplateFit(prepared.bytes, records))
      .filter((report) => report.outcome !== 'fits')
      .map((report) => report.field)
      .sort();

    const filled = await fillPdf(
      prepared.bytes,
      (key) => (records[0] as Record<string, string>)[key] ?? '',
      {},
    );

    // Not a vacuous agreement: something did have to shrink.
    expect(filled.shrunkFields.length).toBeGreaterThan(0);
    expect(predicted).toEqual([...filled.shrunkFields].sort());
  });

  it('measures against the font the template will actually draw with', async () => {
    // Same box, same value, judged by the font that will draw it.
    const prepared = await preparePdfTemplate(await letter(['Name: {{FULL_NAME}}']));
    const reports = await checkPdfTemplateFit(prepared.bytes, [
      { FULL_NAME: 'Aisha' },
    ]);
    expect(reports[0]).toMatchObject({ field: 'FULL_NAME', outcome: 'fits' });
  });
});
