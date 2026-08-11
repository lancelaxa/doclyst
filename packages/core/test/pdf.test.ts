import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { fieldNameToKey, fillPdf, readPdfFields } from '../src/pdf/fill.js';
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
