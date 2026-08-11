import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { checkPdfTemplateFit, fieldNameToKey, fillPdf, readPdfFields } from '../src/pdf/fill.js';
import { DoclystError } from '../src/errors.js';
import { buildPdfForm } from './helpers/fixtures.js';

const echo = (key: string): string => `<${key}>`;

describe('fieldNameToKey', () => {
  it('passes a bare field name through', () => {
    expect(fieldNameToKey('SALARY')).toBe('SALARY');
  });

  it('unwraps a name written in placeholder braces', () => {
    // Template authors reasonably name the field the way the DOCX syntax looks.
    expect(fieldNameToKey('{{SALARY}}')).toBe('SALARY');
    expect(fieldNameToKey('{{ SALARY }}')).toBe('SALARY');
  });

  it('trims surrounding whitespace', () => {
    expect(fieldNameToKey('  SALARY  ')).toBe('SALARY');
  });
});

describe('readPdfFields', () => {
  it('lists the form field names', async () => {
    const pdf = await buildPdfForm([{ name: 'NAME' }, { name: 'SALARY' }]);
    expect((await readPdfFields(pdf)).sort()).toEqual(['NAME', 'SALARY']);
  });

  it('normalises brace-wrapped field names', async () => {
    const pdf = await buildPdfForm([{ name: '{{NAME}}' }]);
    expect(await readPdfFields(pdf)).toEqual(['NAME']);
  });
});

describe('fillPdf', () => {
  it('writes values into text fields', async () => {
    const pdf = await buildPdfForm([{ name: 'NAME' }, { name: 'SALARY' }]);
    const result = await fillPdf(pdf, echo, { flatten: false });
    expect(result.replaced).toBe(2);

    const filled = await PDFDocument.load(result.bytes);
    expect(filled.getForm().getTextField('NAME').getText()).toBe('<NAME>');
    expect(filled.getForm().getTextField('SALARY').getText()).toBe('<SALARY>');
  });

  it('matches fields whose names are written in braces', async () => {
    const pdf = await buildPdfForm([{ name: '{{NAME}}' }]);
    const result = await fillPdf(pdf, (key) => (key === 'NAME' ? 'Aisha Rahman' : ''), {
      flatten: false,
    });
    const filled = await PDFDocument.load(result.bytes);
    expect(filled.getForm().getTextField('{{NAME}}').getText()).toBe('Aisha Rahman');
  });

  describe('flattening', () => {
    it('removes the interactive fields by default', async () => {
      // Flattened values cannot be edited back out, and the field objects —
      // which hold their own copy of the value — are gone.
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo);
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getFields()).toHaveLength(0);
    });

    it('keeps fields interactive when asked', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo, { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getFields()).toHaveLength(1);
    });
  });

  describe('checkboxes', () => {
    it.each(['Yes', 'y', 'TRUE', '1', 'x', 'checked', 'on'])('checks on %j', async (value) => {
      const pdf = await buildPdfForm([{ name: 'CONFIRMED', kind: 'checkbox' }]);
      const result = await fillPdf(pdf, () => value, { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getCheckBox('CONFIRMED').isChecked()).toBe(true);
    });

    it.each(['No', 'false', '0', ''])('leaves unchecked on %j', async (value) => {
      const pdf = await buildPdfForm([{ name: 'CONFIRMED', kind: 'checkbox' }]);
      const result = await fillPdf(pdf, () => value, { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getCheckBox('CONFIRMED').isChecked()).toBe(false);
    });
  });

  describe('dropdowns', () => {
    const spec = [{ name: 'DEPARTMENT', kind: 'dropdown' as const, options: ['Finance', 'Legal'] }];

    it('selects a matching option', async () => {
      const pdf = await buildPdfForm(spec);
      const result = await fillPdf(pdf, () => 'Legal', { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getDropdown('DEPARTMENT').getSelected()).toEqual(['Legal']);
    });

    it('matches case-insensitively', async () => {
      const pdf = await buildPdfForm(spec);
      const result = await fillPdf(pdf, () => 'legal', { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getDropdown('DEPARTMENT').getSelected()).toEqual(['Legal']);
    });

    it('rejects a value that is not an allowed option', async () => {
      // Silently leaving it unselected would read as a deliberate answer.
      const pdf = await buildPdfForm(spec);
      await expect(fillPdf(pdf, () => 'Marketing')).rejects.toThrow(/not one of/);
    });

    it('does not name the rejected value in the error', async () => {
      const pdf = await buildPdfForm(spec);
      try {
        await fillPdf(pdf, () => 'SecretDept');
        expect.unreachable();
      } catch (error) {
        expect((error as DoclystError).message).not.toContain('SecretDept');
      }
    });
  });

  describe('metadata scrubbing', () => {
    // `PDFDocument.load` stamps its own Producer and ModDate onto the
    // in-memory document unless told not to, so these assertions must opt out
    // or they measure pdf-lib's load behaviour instead of our output.
    const inspect = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

    it('clears identifying metadata by default', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo);
      const filled = await inspect(result.bytes);

      expect(filled.getAuthor() ?? '').toBe('');
      expect(filled.getCreator() ?? '').toBe('');
      expect(filled.getProducer() ?? '').toBe('');
      expect(filled.getTitle() ?? '').toBe('');
    });

    it('leaves no producer string in the saved bytes', async () => {
      // The strongest form of the check: whatever any reader reports, the
      // identifying string must not be present in the file at all.
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo);
      expect(Buffer.from(result.bytes).includes('pdf-lib')).toBe(false);
    });

    it('uses a fixed timestamp so processing time is not recorded', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo);
      const filled = await inspect(result.bytes);
      expect(filled.getCreationDate()?.getTime()).toBe(0);
    });

    it('can be turned off', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const result = await fillPdf(pdf, echo, { scrubMetadata: false });
      const filled = await inspect(result.bytes);
      expect(filled.getProducer()).toBeTruthy();
    });
  });

  describe('rejected input', () => {
    it('rejects a file that is not a PDF', async () => {
      await expect(fillPdf(new Uint8Array([1, 2, 3, 4, 5]), echo)).rejects.toThrow(/not a valid PDF/);
    });

    it('rejects an empty input', async () => {
      await expect(fillPdf(new Uint8Array(), echo)).rejects.toThrow(DoclystError);
    });

    it('explains clearly when a PDF has no form fields', async () => {
      // The most likely user error: a PDF with {{NAME}} typed as page text.
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      const bytes = await doc.save();
      await expect(fillPdf(bytes, echo)).rejects.toThrow(/no fillable form fields/);
    });

    it('propagates a missing-value error from the resolver', async () => {
      const pdf = await buildPdfForm([{ name: 'NRIC' }]);
      await expect(
        fillPdf(pdf, () => {
          throw new DoclystError('MISSING_VALUE', 'No value for placeholder "NRIC".');
        }),
      ).rejects.toThrow(/No value for placeholder/);
    });

    it('leaves a field untouched under the keep policy', async () => {
      // The resolver signals "no column for this" by echoing the placeholder.
      const pdf = await buildPdfForm([{ name: 'NAME' }, { name: 'UNKNOWN' }]);
      const result = await fillPdf(pdf, (key, original) => (key === 'NAME' ? 'Aisha' : original), {
        flatten: false,
      });
      expect(result.replaced).toBe(1);
    });
  });

  describe('injection safety', () => {
    it('treats PDF syntax in a value as literal text', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }]);
      const payload = ') Tj /F1 24 Tf (INJECTED';
      const result = await fillPdf(pdf, () => payload, { flatten: false });
      const filled = await PDFDocument.load(result.bytes);
      expect(filled.getForm().getTextField('NAME').getText()).toBe(payload);
    });
  });
});

/**
 * Values that do not fit the box the template gives them.
 *
 * A PDF form field clips its overflow, so the format's own behaviour is to
 * publish a truncated address with nothing to say so. On a document about to
 * be signed that is the worst available outcome, and these tests pin the
 * behaviour that replaces it.
 */
describe('a value too long for its field', () => {
  const LONG = 'Blk 512 Ang Mo Kio Avenue 8, #14-233, Singapore 560512';

  /** The size each drawn string was actually set in. */
  async function drawnAt(bytes: Uint8Array): Promise<{ size: number; text: string }[]> {
    const { unzlibSync } = await import('fflate');
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
        // Not a compressed stream.
      }
      cursor = end + 'endstream'.length;
    }

    const drawn: { size: number; text: string }[] = [];
    for (const stream of streams) {
      let size = 0;
      const token = /\/[^\s/]+\s+([\d.]+)\s+Tf|\(((?:\\.|[^()\\])*)\)\s*Tj|<([0-9A-Fa-f]*)>\s*Tj/g;
      let match: RegExpExecArray | null;
      while ((match = token.exec(stream)) !== null) {
        if (match[1] !== undefined) {
          size = Number.parseFloat(match[1]);
          continue;
        }
        const text =
          match[2] !== undefined ? match[2] : Buffer.from(match[3] ?? '', 'hex').toString('latin1');
        if (text.trim() !== '') drawn.push({ size, text });
      }
    }
    return drawn;
  }

  it('shrinks the text to fit rather than letting the reader see half an address', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 260 }]);
    const result = await fillPdf(template, () => LONG, {});

    expect(result.shrunkFields).toEqual(['ADDRESS']);
    const drawn = await drawnAt(result.bytes);
    expect(drawn.map((d) => d.text).join('')).toBe(LONG);

    // Shrunk from the size the template asked for, and now inside the box.
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const measuring = await PDFDocument.create();
    const helvetica = await measuring.embedFont(StandardFonts.Helvetica);
    const size = drawn[0]!.size;
    expect(helvetica.widthOfTextAtSize(LONG, size)).toBeLessThanOrEqual(260);
  });

  it('leaves a value that already fits exactly as the template set it', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 260 }]);
    const result = await fillPdf(template, () => 'Singapore', {});
    expect(result.shrunkFields).toEqual([]);
  });

  it('wraps instead of shrinking when the field allows more than one line', async () => {
    const template = await buildPdfForm([
      { name: 'ADDRESS', width: 160, height: 60, multiline: true },
    ]);
    const result = await fillPdf(template, () => LONG, {});
    const drawn = await drawnAt(result.bytes);

    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.map((d) => d.text).join(' ')).toBe(LONG);
  });

  it('fails the record when it cannot fit legibly, rather than truncating', async () => {
    // Below roughly 6pt the value is present but unreadable, which is no more
    // use on a contract than a clipped one.
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 40, height: 12 }]);
    await expect(fillPdf(template, () => LONG, {})).rejects.toThrow(/unreadable|too long/);
  });

  it('names the field but never quotes the value it could not fit', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 40, height: 12 }]);
    const error = await fillPdf(template, () => LONG, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoclystError);
    expect((error as DoclystError).field).toBe('ADDRESS');
    expect((error as DoclystError).message).not.toContain('Ang Mo Kio');
    expect((error as DoclystError).message).not.toContain('560512');
  });

  it('fails immediately under the error policy, without shrinking anything', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 260 }]);
    await expect(fillPdf(template, () => LONG, { overflow: 'error' })).rejects.toThrow(
      /too long for that field/,
    );
  });

  it('restores the format"s own clipping under the ignore policy', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 260 }]);
    const result = await fillPdf(template, () => LONG, { overflow: 'ignore' });
    expect(result.shrunkFields).toEqual([]);
  });

  it('respects a caller"s legibility floor', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 260 }]);
    // The value needs roughly 9.5pt here, so a floor above that must refuse.
    await expect(fillPdf(template, () => LONG, { minFontSizePt: 11 })).rejects.toThrow(
      /below 11pt/,
    );
  });
});

/**
 * Checking a template against the data before anything is generated.
 *
 * Filling is per-record, so a field too narrow for one person in four hundred
 * surfaces on that row and nowhere else — after the letters have gone out.
 */
describe('checkPdfTemplateFit', () => {
  const RECORDS = [
    { NAME: 'Aisha Rahman', ADDRESS: '45 Bukit Timah Road, #12-07' },
    { NAME: 'Wei Lun Tan', ADDRESS: 'Blk 512 Ang Mo Kio Avenue 8, #14-233, Singapore 560512' },
    { NAME: 'Priya Nair', ADDRESS: '9 Serangoon Ave 2' },
  ];

  it('reports a field that is comfortably big enough as fitting', async () => {
    const template = await buildPdfForm([{ name: 'NAME', width: 280 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ field: 'NAME', outcome: 'fits' });
  });

  it('reports a field no value can fit legibly, and the row that proves it', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 90 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(reports[0]).toMatchObject({ field: 'ADDRESS', outcome: 'overflows', worstRow: 2 });
  });

  it('reports a field that will merely shrink, with the size it lands on', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 240 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(reports[0]!.outcome).toBe('shrinks');
    expect(reports[0]!.fittedSizePt).toBeLessThan(reports[0]!.templateSizePt);
    expect(reports[0]!.worstRow).toBe(2);
  });

  it('judges a field by the widest value, not the first', async () => {
    // Row 1 fits this box; row 2 does not. Checking only row 1 would pass the
    // template and fail in production.
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 190 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(reports[0]!.outcome).not.toBe('fits');
    expect(reports[0]!.worstRow).toBe(2);
  });

  it('matches columns as loosely as filling does', async () => {
    const template = await buildPdfForm([{ name: 'FULL_NAME', width: 280 }]);
    const reports = await checkPdfTemplateFit(template, [{ 'Full Name': 'Aisha Rahman' }]);
    expect(reports[0]).toMatchObject({ field: 'FULL_NAME', outcome: 'fits' });
  });

  it('says nothing about a field the data has no column for', async () => {
    const template = await buildPdfForm([{ name: 'UNUSED', width: 100 }]);
    expect(await checkPdfTemplateFit(template, RECORDS)).toEqual([]);
  });

  it('prefers the row that cannot fit over one that merely shrinks', async () => {
    // Regression: both rows bottom out at the legibility floor, so ranking by
    // fitted size alone kept whichever was measured first and reported a row
    // that shrinks in place of the row that genuinely overflows.
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 80 }]);
    const reports = await checkPdfTemplateFit(template, [
      { ADDRESS: '9 Serangoon Ave 2, #05-11' },
      { ADDRESS: 'Blk 512 Ang Mo Kio Avenue 8, #14-233, Singapore 560512' },
    ]);
    expect(reports[0]!.outcome).toBe('overflows');
    expect(reports[0]!.worstRow).toBe(2);
  });

  it('reports rows, never values', async () => {
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 90 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(JSON.stringify(reports)).not.toContain('Ang Mo Kio');
    expect(JSON.stringify(reports)).not.toContain('Bukit Timah');
  });

  it('agrees with what filling actually does', async () => {
    // The check is only worth having if it predicts the real outcome.
    const template = await buildPdfForm([{ name: 'ADDRESS', width: 240 }]);
    const reports = await checkPdfTemplateFit(template, RECORDS);
    expect(reports[0]!.outcome).toBe('shrinks');

    const filled = await fillPdf(template, (key) => (RECORDS[1] as Record<string, string>)[key] ?? '', {});
    expect(filled.shrunkFields).toContain('ADDRESS');
  });
});

/**
 * Flattening must leave a structurally valid file.
 *
 * pdf-lib's `flatten()` deletes the field objects but leaves the page's
 * `/Annots` array pointing at them. Readers report the result as damaged and
 * strict validators reject it, which is not acceptable on a document being sent
 * to a candidate or kept as a record.
 */
describe('the structure of a flattened document', () => {
  async function danglingReferences(bytes: Uint8Array): Promise<string[]> {
    const { PDFDocument, PDFArray, PDFDict, PDFRef } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const live = new Set<string>();
    for (const [ref] of doc.context.enumerateIndirectObjects()) live.add(ref.tag);

    const dangling: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node instanceof PDFRef) {
        if (!live.has(node.tag)) dangling.push(`${path} -> ${node.tag}`);
        return;
      }
      if (node instanceof PDFDict) {
        for (const [key, value] of node.entries()) walk(value, `${path}/${key.asString()}`);
      } else if (node instanceof PDFArray) {
        node.asArray().forEach((value, index) => walk(value, `${path}[${index}]`));
      }
    };
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) walk(object, ref.tag);
    return dangling;
  }

  it('leaves no reference to a field it has just removed', async () => {
    const template = await buildPdfForm([
      { name: 'NAME' },
      { name: 'SALARY' },
      { name: 'START_DATE' },
    ]);
    const result = await fillPdf(template, (key) => `value for ${key}`, {});
    expect(await danglingReferences(result.bytes)).toEqual([]);
  });

  it('removes the empty form dictionary, since a flattened file has no form', async () => {
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const template = await buildPdfForm([{ name: 'NAME' }]);
    const result = await fillPdf(template, () => 'Aisha Rahman', {});

    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(doc.catalog.lookup(PDFName.of('AcroForm'))).toBeUndefined();
  });

  it('keeps the form intact when flattening is turned off', async () => {
    const template = await buildPdfForm([{ name: 'NAME' }]);
    const result = await fillPdf(template, () => 'Aisha Rahman', { flatten: false });

    expect(await danglingReferences(result.bytes)).toEqual([]);
    const fields = await readPdfFields(result.bytes);
    expect(fields).toEqual(['NAME']);
  });
});
