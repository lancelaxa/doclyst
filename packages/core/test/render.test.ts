import { describe, expect, it } from 'vitest';
import { DoclystError } from '../src/errors.js';
import { extractDocumentModel, modelToText } from '../src/docx/model.js';
import { renderModelToPdf } from '../src/pdf/render.js';
import { runBatch, readUnsupportedForPdf } from '../src/batch/run.js';
import { buildDocx, headerXml, para, run, splitRuns, SAMPLE_RECORDS } from './helpers/fixtures.js';
import { pdfFonts, pdfPageCount, pdfText } from './helpers/pdftext.js';

/**
 * Rendering a filled template straight to PDF.
 *
 * Every value here is synthetic. The renderer re-typesets rather than converts,
 * so these tests care about two things above all: that the text a document
 * shows is exactly the text it was given, and that anything the renderer
 * cannot reproduce is reported rather than dropped in silence.
 */

const body = (xml: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${xml}</w:body></w:document>`;

describe('extractDocumentModel', () => {
  it('reads paragraphs and their text', () => {
    const model = extractDocumentModel(body(para(run('Dear Aisha Rahman,')) + para(run('Welcome.'))));
    expect(model.paragraphs).toHaveLength(2);
    expect(modelToText(model)).toBe('Dear Aisha Rahman,\nWelcome.');
  });

  it('keeps a placeholder that Word split across runs as one string', () => {
    const model = extractDocumentModel(body(para(splitRuns('Priya Nair', 4))));
    expect(modelToText(model)).toBe('Priya Nair');
  });

  it('reads bold and italic from run properties', () => {
    const model = extractDocumentModel(
      body(para('<w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Confidential</w:t></w:r>')),
    );
    expect(model.paragraphs[0]!.runs[0]).toMatchObject({ bold: true, italic: true });
  });

  it('treats an explicitly disabled toggle as off', () => {
    // Word writes `<w:b w:val="0"/>` to switch bold off again, so presence of
    // the element alone is not the answer.
    const model = extractDocumentModel(
      body(para('<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Plain</w:t></w:r>')),
    );
    expect(model.paragraphs[0]!.runs[0]!.bold).toBe(false);
  });

  it('converts half-point sizes to points', () => {
    const model = extractDocumentModel(
      body(para('<w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>Heading</w:t></w:r>')),
    );
    expect(model.paragraphs[0]!.runs[0]!.sizePt).toBe(14);
  });

  it('reads paragraph alignment, mapping Word names to ours', () => {
    const aligned = (value: string): string =>
      para(`<w:pPr><w:jc w:val="${value}"/></w:pPr>`, run('x'));
    const model = extractDocumentModel(
      body(aligned('center') + aligned('right') + aligned('both') + para(run('x'))),
    );
    expect(model.paragraphs.map((p) => p.alignment)).toEqual([
      'center',
      'right',
      'justify',
      'left',
    ]);
  });

  it('ignores alignment that is not the paragraph’s own', () => {
    const model = extractDocumentModel(body(para('<w:r><w:jc w:val="center"/><w:t>x</w:t></w:r>')));
    expect(model.paragraphs[0]!.alignment).toBe('left');
  });

  it('reports features it cannot represent instead of dropping them quietly', () => {
    const withTable = extractDocumentModel(
      body(para(run('Before')) + '<w:tbl><w:tr><w:tc>' + para(run('Cell')) + '</w:tc></w:tr></w:tbl>'),
    );
    expect(withTable.unsupported).toContain('tables');

    const withList = extractDocumentModel(
      body(para('<w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>', run('One'))),
    );
    expect(withList.unsupported).toContain('automatic numbering and bullets');

    const withImage = extractDocumentModel(body(para('<w:r><w:drawing/></w:r>')));
    expect(withImage.unsupported).toContain('images');
  });

  it('reports nothing for a plain letter', () => {
    expect(extractDocumentModel(body(para(run('Plain text.')))).unsupported).toEqual([]);
  });
});

describe('renderModelToPdf', () => {
  const model = (xml: string) => extractDocumentModel(body(xml));

  it('produces a PDF whose drawn text is the text it was given', async () => {
    const bytes = await renderModelToPdf(model(para(run('Dear Aisha Rahman,'))));
    expect(bytes.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    expect(pdfText(bytes)).toBe('Dear Aisha Rahman,');
  });

  it('keeps the spaces between words', async () => {
    // Each word is drawn as its own operation, so a lost space is a plausible
    // failure that reads perfectly well in the model.
    const bytes = await renderModelToPdf(model(para(run('You will be employed as a Data Analyst'))));
    expect(pdfText(bytes)).toBe('You will be employed as a Data Analyst');
  });

  it('collapses runs of whitespace rather than reproducing them', async () => {
    const bytes = await renderModelToPdf(model(para(run('Salary:    SGD 5,200'))));
    expect(pdfText(bytes)).toBe('Salary: SGD 5,200');
  });

  it('wraps long text onto more than one line without losing any of it', async () => {
    const sentence = 'The quick brown fox jumps over the lazy dog. '.repeat(10).trim();
    const bytes = await renderModelToPdf(model(para(run(sentence))));
    // Wrapping must not drop or duplicate a word; whitespace is normalised.
    expect(pdfText(bytes).replace(/\s+/g, ' ')).toBe(sentence.replace(/\s+/g, ' '));
  });

  it('starts a new page rather than running off the bottom', async () => {
    const many = Array.from({ length: 120 }, (_, i) => para(run(`Clause ${i + 1}.`))).join('');
    const bytes = await renderModelToPdf(model(many));
    expect(pdfPageCount(bytes)).toBeGreaterThan(1);
    expect(pdfText(bytes)).toContain('Clause 120.');
  });

  it('embeds the bold and italic faces a run asks for', async () => {
    const bytes = await renderModelToPdf(
      model(
        para('<w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>') +
          para('<w:r><w:rPr><w:i/></w:rPr><w:t>Italic</w:t></w:r>'),
      ),
    );
    const fonts = pdfFonts(bytes);
    expect(fonts).toContain('Helvetica-Bold');
    expect(fonts).toContain('Helvetica-Oblique');
  });

  it('treats a line break inside a run as a line break, not a lost character', async () => {
    const bytes = await renderModelToPdf(
      model(para('<w:r><w:t>Line one</w:t><w:br/></w:r>' + run('Line two'))),
    );
    expect(pdfText(bytes)).toBe('Line one\nLine two');
  });

  it('scrubs metadata by default', async () => {
    const bytes = await renderModelToPdf(model(para(run('x'))));
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).not.toContain('pdf-lib');
  });

  it('fails a document it cannot spell rather than emitting missing glyphs', async () => {
    // The built-in fonts cover WinAnsi only. A mangled contract is worse than
    // a failed one, so this is an error and not a best effort.
    await expect(renderModelToPdf(model(para(run('余嘉文'))))).rejects.toThrow(
      DoclystError,
    );
  });

  it('does not quote the offending text when reporting an unrenderable character', async () => {
    // The text that failed is very often a person's name.
    const name = 'முருகன்';
    const error = await renderModelToPdf(model(para(run(name)))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoclystError);
    expect((error as DoclystError).message).not.toContain(name);
    // It counts them, so the reader knows the scale, without reproducing any.
    expect((error as DoclystError).message).toMatch(/\d+ character\(s\)/);
  });
});

describe('readUnsupportedForPdf', () => {
  it('reports nothing for a plain letter template', () => {
    const template = { kind: 'docx' as const, bytes: buildDocx(para(run('Dear {{NAME}},'))) };
    expect(readUnsupportedForPdf(template)).toEqual([]);
  });

  it('reports a header, which rendering would drop entirely', () => {
    // A letterhead vanishing from three hundred offer letters is exactly the
    // kind of thing nobody notices until one has been sent.
    const template = {
      kind: 'docx' as const,
      bytes: buildDocx(para(run('Dear {{NAME}},')), {
        extraParts: { 'word/header1.xml': headerXml(para(run('Example Pte Ltd'))) },
      }),
    };
    expect(readUnsupportedForPdf(template)).toContain('headers and footers');
  });

  it('reports nothing for a PDF template, which is not re-typeset', () => {
    expect(readUnsupportedForPdf({ kind: 'pdf', bytes: new Uint8Array() })).toEqual([]);
  });
});

describe('runBatch with PDF output', () => {
  const template = {
    kind: 'docx' as const,
    bytes: buildDocx(
      para(run('Dear ')) +
        para(splitRuns('{{NAME}}', 3)) +
        para(run('Your salary is {{SALARY}} from {{START_DATE}}.')),
    ),
  };

  it('writes PDFs, named .pdf, when asked for PDF', async () => {
    const result = await runBatch(template, SAMPLE_RECORDS, { outputFormat: 'pdf' });
    expect(result.failures).toEqual([]);
    expect(result.documents).toHaveLength(3);
    for (const document of result.documents) {
      expect(document.filename.endsWith('.pdf')).toBe(true);
      expect(document.bytes.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    }
  });

  it('substitutes each record into its own PDF', async () => {
    const result = await runBatch(template, SAMPLE_RECORDS, { outputFormat: 'pdf' });
    const first = pdfText(result.documents[0]!.bytes);
    expect(first).toContain('Aisha Rahman');
    expect(first).toContain('4500');
    // No value from another row may leak into this one.
    expect(first).not.toContain('6100');
    expect(pdfText(result.documents[2]!.bytes)).toContain('Priya Nair');
  });

  it('leaves no placeholder behind', async () => {
    const result = await runBatch(template, SAMPLE_RECORDS, { outputFormat: 'pdf' });
    expect(pdfText(result.documents[0]!.bytes)).not.toContain('{{');
  });

  it('still writes DOCX by default', async () => {
    const result = await runBatch(template, SAMPLE_RECORDS);
    expect(result.documents[0]!.filename.endsWith('.docx')).toBe(true);
    expect(result.unsupported).toEqual([]);
  });

  it('reports unsupported features once for the whole batch', async () => {
    const withTable = {
      kind: 'docx' as const,
      bytes: buildDocx(
        para(splitRuns('{{NAME}}', 2)) + '<w:tbl><w:tr><w:tc>' + para(run('Cell')) + '</w:tc></w:tr></w:tbl>',
      ),
    };
    const result = await runBatch(withTable, SAMPLE_RECORDS, { outputFormat: 'pdf' });
    expect(result.unsupported).toContain('tables');
    expect(result.documents).toHaveLength(3);
  });

  it('fails only the row it cannot render, not the batch', async () => {
    const records = [
      { NAME: 'Aisha Rahman', SALARY: '4500', START_DATE: '2026-01-15' },
      { NAME: '雷志強', SALARY: '5200', START_DATE: '2026-02-01' },
      { NAME: 'Priya Nair', SALARY: '6100', START_DATE: '2026-02-14' },
    ];
    const result = await runBatch(template, records, { outputFormat: 'pdf' });
    expect(result.documents).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.row).toBe(2);
    // The failure names the row and the problem, never the value.
    expect(result.failures[0]!.message).not.toContain('雷');
  });

  it('ignores the requested format for a PDF template, which can only be PDF', async () => {
    const { buildPdfForm } = await import('./helpers/fixtures.js');
    const bytes = await buildPdfForm([{ name: 'NAME' }]);
    const result = await runBatch({ kind: 'pdf', bytes }, SAMPLE_RECORDS, {
      outputFormat: 'docx',
      missing: 'empty',
    });
    expect(result.documents[0]!.filename.endsWith('.pdf')).toBe(true);
  });
});
