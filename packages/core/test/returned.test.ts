import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import { zlibSync } from 'fflate';
import { checkReturnedLetters, type LetterFile } from '../src/verify/returned.js';
import { preparePdfTemplate } from '../src/pdf/autofields.js';
import { fillPdf } from '../src/pdf/fill.js';
import { ValueResolver } from '../src/template/values.js';

/**
 * Checking signed letters that come back.
 *
 * The letters are made the way a real batch makes them — a page with
 * placeholders, prepared into a template, filled and flattened — so the values
 * sit inside form XObjects exactly as they do in production. The "returned"
 * copies are then edited the ways a recipient's software, or a recipient, might
 * edit them. Every person is invented.
 */

const PEOPLE = [
  { NAME: 'Aisha Rahman', ROLE: 'Data Analyst', SALARY: '4,500' },
  { NAME: 'Daniel Tan', ROLE: 'Engineer', SALARY: '6,000' },
  { NAME: 'Priya Nair', ROLE: 'Designer', SALARY: '5,200' },
];

/** Where the salary value is drawn, and where the signature goes. */
const SALARY_AT = { x: 160, y: 668, width: 40, height: 14 };
const SIGNATURE_AT = { x: 140, y: 182 };

let template: Uint8Array | undefined;

async function letterTemplate(): Promise<Uint8Array> {
  if (template) return template;
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines: [number, string][] = [
    [760, 'OFFER OF EMPLOYMENT'],
    [720, 'Dear {{NAME}},'],
    [690, 'We are pleased to offer you the position of {{ROLE}}.'],
    [670, 'Basic salary: S$ {{SALARY}} per month'],
    [620, 'This offer is conditional on satisfactory references.'],
    [200, 'Accepted by:'],
    [160, 'Signature: ______________________'],
    [140, 'Name: {{NAME}}'],
  ];
  for (const [y, text] of lines) page.drawText(text, { x: 72, y, size: 11, font });
  template = (await preparePdfTemplate(await doc.save(), { widthFactor: 3 })).bytes;
  return template;
}

async function letterFor(person: Record<string, string>): Promise<Uint8Array> {
  const resolver = new ValueResolver(person);
  return (await fillPdf(await letterTemplate(), (key, original) => resolver.resolve(key, original), {})).bytes;
}

async function sentLetters(): Promise<LetterFile[]> {
  return Promise.all(PEOPLE.map(async (person, i) => ({ name: `document-000${i + 1}.pdf`, bytes: await letterFor(person) })));
}

/** Load a letter, let `edit` change it, and save it as a new file. */
async function edited(bytes: Uint8Array, edit: (doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  await edit(doc);
  return doc.save();
}

/** A hand-drawn signature: strokes, in dark blue ink, above the signature line. */
function sign(doc: PDFDocument): void {
  doc.getPage(0).drawSvgPath('M 0 0 C 10 15 20 -5 30 8 S 50 -6 70 6 L 90 0', {
    x: SIGNATURE_AT.x,
    y: SIGNATURE_AT.y,
    borderColor: rgb(0.1, 0.1, 0.5),
    borderWidth: 1.5,
  });
}

async function checkOne(returned: Uint8Array, name = 'signed.pdf') {
  const result = await checkReturnedLetters(await sentLetters(), [{ name, bytes: returned }]);
  return result.returned[0]!;
}

describe('checkReturnedLetters', () => {
  it('passes a signed letter with nothing changed, and says where the signature is', async () => {
    const report = await checkOne(await edited(await letterFor(PEOPLE[1]!), sign));
    expect(report.status).toBe('signed');
    expect(report.letter).toBe('document-0002.pdf');
    expect(report.findings).toEqual([]);
    expect(report.additions).toEqual(['Signature or drawing — page 1, near the bottom']);
  });

  it('matches by content, whatever the file is now called', async () => {
    const report = await checkOne(await edited(await letterFor(PEOPLE[2]!), sign), 'Priya - signed offer FINAL (2).pdf');
    expect(report.letter).toBe('document-0003.pdf');
  });

  it('notices a letter that came back without anything added', async () => {
    const report = await checkOne(await edited(await letterFor(PEOPLE[0]!), () => undefined));
    expect(report.status).toBe('unsigned');
  });

  it('catches a value that is different from what was sent', async () => {
    const report = await checkOne(await edited(await letterFor({ ...PEOPLE[0]!, SALARY: '9,500' }), sign));
    expect(report.status).toBe('changed');
    // Still matched to the right person: everything else on the page agrees.
    expect(report.letter).toBe('document-0001.pdf');
    expect(report.findings).toEqual(['Page 1, near the top: 1 line of the original text is missing, moved or changed.']);
  });

  it('catches text covered with a white box and written over', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), async (doc) => {
        const page = doc.getPage(0);
        page.drawRectangle({ ...SALARY_AT, color: rgb(1, 1, 1) });
        page.drawText('9,500', { x: SALARY_AT.x, y: 670, size: 11, font: await doc.embedFont(StandardFonts.Helvetica) });
        sign(doc);
      }),
    );
    expect(report.status).toBe('changed');
    expect(report.findings).toContain('Page 1, near the top: some of the original text has been covered over.');
  });

  it('catches a white box drawn by an annotation, not just on the page', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), (doc) => {
        const { context } = doc;
        const appearance = context.register(
          context.flateStream('1 1 1 rg 0 0 40 14 re f', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 40, 14],
          }),
        );
        const annotation = context.register(
          context.obj({
            Type: 'Annot',
            Subtype: 'FreeText',
            Rect: [SALARY_AT.x, SALARY_AT.y, SALARY_AT.x + SALARY_AT.width, SALARY_AT.y + SALARY_AT.height],
            AP: { N: appearance },
          }),
        );
        doc.getPage(0).node.set(PDFName.of('Annots'), context.obj([annotation]));
      }),
    );
    expect(report.status).toBe('changed');
    expect(report.findings).toContain('Page 1, near the top: some of the original text has been covered over.');
  });

  it('ignores an annotation that is hidden', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), (doc) => {
        const { context } = doc;
        const annotation = context.register(
          context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [160, 668, 200, 682], F: PDFNumber.of(2) }),
        );
        doc.getPage(0).node.set(PDFName.of('Annots'), context.obj([annotation]));
        sign(doc);
      }),
    );
    expect(report.status).toBe('signed');
  });

  it('asks for a look when ink crosses the original text', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), (doc) => {
        // A signature large enough to run through "Name: Aisha Rahman".
        doc.getPage(0).drawLine({ start: { x: 60, y: 130 }, end: { x: 220, y: 175 }, thickness: 1.5, color: rgb(0, 0, 0.5) });
      }),
    );
    expect(report.status).toBe('review');
    expect(report.findings).toEqual([
      'Page 1, near the bottom: something added sits over the original text. Open the letter and check it is only a signature or initials.',
    ]);
  });

  it('does not mind a signature across the blank signature line', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), (doc) => {
        doc.getPage(0).drawLine({ start: { x: 130, y: 158 }, end: { x: 240, y: 170 }, thickness: 1.5, color: rgb(0, 0, 0.5) });
      }),
    );
    expect(report.status).toBe('signed');
  });

  it('reports typed text, such as a date, as an addition', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), async (doc) => {
        doc.getPage(0).drawText('3 March 2026', { x: 72, y: 100, size: 11, font: await doc.embedFont(StandardFonts.Helvetica) });
        sign(doc);
      }),
    );
    expect(report.status).toBe('signed');
    expect(report.additions).toContain('Text — page 1, near the bottom');
  });

  it('catches an added or missing page', async () => {
    const added = await checkOne(await edited(await letterFor(PEOPLE[0]!), (doc) => void doc.addPage()));
    expect(added.status).toBe('changed');
    expect(added.findings).toContain('It has 2 pages; the letter you sent had 1.');
  });

  it('catches a page of a different size', async () => {
    const report = await checkOne(
      await edited(await letterFor(PEOPLE[0]!), (doc) => {
        doc.getPage(0).setMediaBox(0, 0, 612, 842);
        sign(doc);
      }),
    );
    expect(report.status).toBe('changed');
    expect(report.findings).toContain('Page 1 is a different size from the one you sent.');
  });

  it('says when a file matches none of the letters sent', async () => {
    const other = await PDFDocument.create();
    other.addPage().drawText('An unrelated document about something else entirely.', {
      x: 72,
      y: 700,
      font: await other.embedFont(StandardFonts.Helvetica),
    });
    const report = await checkOne(await other.save());
    expect(report.status).toBe('unmatched');
    expect(report.letter).toBeUndefined();
  });

  it('says when a file has no text to check, as with a scan', async () => {
    const scan = await PDFDocument.create();
    scan.addPage().drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.97, 0.97, 0.97) });
    const report = await checkOne(await scan.save());
    expect(report.status).toBe('unreadable');
    expect(report.findings[0]).toContain('scan or a photo');
  });

  it('says when a file is not a PDF at all', async () => {
    const report = await checkOne(new TextEncoder().encode('not a pdf'));
    expect(report.status).toBe('unreadable');
    expect(report.findings).toEqual(['It could not be opened as a PDF.']);
  });

  it('lists the letters nothing came back for, and flags two copies of one letter', async () => {
    const signed = await edited(await letterFor(PEOPLE[1]!), sign);
    const result = await checkReturnedLetters(await sentLetters(), [
      { name: 'a.pdf', bytes: signed },
      { name: 'b.pdf', bytes: signed },
    ]);
    expect(result.notReturned).toEqual(['document-0001.pdf', 'document-0003.pdf']);
    for (const report of result.returned) {
      expect(report.status).toBe('review');
      expect(report.findings).toContain('2 returned files match "document-0002.pdf". Make sure you keep the right one.');
    }
  });

  it('flags a file that matches two identical letters equally', async () => {
    const letter = await letterFor(PEOPLE[0]!);
    const result = await checkReturnedLetters(
      [
        { name: 'one.pdf', bytes: letter },
        { name: 'two.pdf', bytes: letter },
      ],
      [{ name: 'back.pdf', bytes: await edited(letter, sign) }],
    );
    expect(result.returned[0]?.status).toBe('review');
    expect(result.returned[0]?.findings[0]).toContain('equally well');
  });

  it('never quotes the letter in what it reports', async () => {
    const report = await checkOne(await edited(await letterFor({ ...PEOPLE[0]!, SALARY: '9,500' }), sign));
    const said = [...report.findings, ...report.additions].join(' ');
    for (const value of [...Object.values(PEOPLE[0]!), '9,500']) expect(said).not.toContain(value);
  });

  describe('against deliberate tampering', () => {
    /** Put instructions in front of the page's own, so they apply to all of it. */
    function prefixContent(doc: PDFDocument, instructions: string): void {
      const page = doc.getPage(0);
      const contents = page.node.get(PDFName.of('Contents'));
      const existing = contents instanceof PDFArray ? contents.asArray() : [contents!];
      page.node.set(
        PDFName.of('Contents'),
        doc.context.obj([doc.context.register(doc.context.flateStream(instructions)), ...existing]),
      );
    }

    it('catches a page whose visible area was shrunk to hide part of it', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), (doc) => {
          doc.getPage(0).setCropBox(0, 0, 595, 600);
          sign(doc);
        }),
      );
      expect(report.status).toBe('changed');
      expect(report.findings).toContain('Page 1: the visible area of the page has been changed, which can hide part of it.');
    });

    it('catches the filled-in values redrawn in white, with new ones typed beside them', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), async (doc) => {
          const { context } = doc;
          for (const [ref, object] of context.enumerateIndirectObjects()) {
            if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Form')) continue;
            const content = new TextDecoder('latin1').decode(decodePDFRawStream(object).decode());
            if (!content.includes(' Tj')) continue;
            const replacement = context.flateStream(content.replace('0 g', '1 g'), {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: object.dict.get(PDFName.of('BBox')),
              Resources: object.dict.get(PDFName.of('Resources')),
            });
            context.assign(ref, replacement);
          }
          doc.getPage(0).drawText('9,500', { x: 230, y: 670, size: 11, font: await doc.embedFont(StandardFonts.Helvetica) });
          sign(doc);
        }),
      );
      expect(report.status).toBe('changed');
      expect(report.findings.some((finding) => finding.includes('hidden or made invisible'))).toBe(true);
    });

    it('catches text switched to an invisible render mode', async () => {
      const report = await checkOne(await edited(await letterFor(PEOPLE[0]!), (doc) => prefixContent(doc, '3 Tr')));
      expect(report.status).toBe('changed');
      expect(report.findings.some((finding) => finding.includes('hidden or made invisible'))).toBe(true);
    });

    it('catches a page clipped down to nothing', async () => {
      const report = await checkOne(await edited(await letterFor(PEOPLE[0]!), (doc) => prefixContent(doc, '0 0 1 1 re W n')));
      expect(report.status).toBe('changed');
    });

    it('catches text made fully transparent', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), (doc) => {
          const page = doc.getPage(0);
          page.node.Resources()!.set(PDFName.of('ExtGState'), doc.context.obj({ Clear: { ca: 0, CA: 0 } }));
          prefixContent(doc, '/Clear gs');
        }),
      );
      expect(report.status).toBe('changed');
    });

    it('catches a dark box over the text, not only a white one', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), (doc) => {
          doc.getPage(0).drawRectangle({ ...SALARY_AT, color: rgb(0, 0, 0) });
          sign(doc);
        }),
      );
      expect(report.status).toBe('changed');
      expect(report.findings).toContain('Page 1, near the top: some of the original text has been covered over.');
    });

    it('asks for a look at a file that uses layers', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), (doc) => {
          doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [], D: {} }));
          sign(doc);
        }),
      );
      expect(report.status).toBe('review');
      expect(report.findings).toContain('It uses layers, which can show or hide parts of the page. Check it by eye.');
    });
  });

  describe('against files built to exhaust the page', () => {
    const TOO_BIG = 'It is far larger or more complicated than a signed letter should be, so it was not checked. Compare it with the original by eye.';

    it('refuses a form that draws itself ten times over, seven levels deep', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595, 842]);
      page.drawText('x', { x: 10, y: 10 });
      const { context } = doc;
      let child = context.register(context.flateStream('0 0 1 1 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
      for (let level = 0; level < 7; level += 1) {
        child = context.register(
          context.flateStream('/X Do '.repeat(10), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { X: child } } }),
        );
      }
      page.node.Resources()!.set(PDFName.of('XObject'), context.obj({ X: child }));
      page.node.addContentStream(context.register(context.flateStream('/X Do')));

      const started = Date.now();
      const report = await checkOne(await doc.save());
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(report.status).toBe('unreadable');
      expect(report.findings).toEqual([TOO_BIG]);
    });

    it('refuses a small stream that would inflate to hundreds of megabytes', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595, 842]);
      page.drawText('x', { x: 10, y: 10 });
      const bomb = zlibSync(new Uint8Array(160 * 1024 * 1024).fill(0x20), { level: 9 });
      const stream = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode', Length: bomb.length }), bomb);
      page.node.addContentStream(doc.context.register(stream));

      const started = Date.now();
      const report = await checkOne(await doc.save());
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(report.findings).toEqual([TOO_BIG]);
    }, 30_000);

    it('copes with arrays nested deeper than any real file', async () => {
      const report = await checkOne(
        await edited(await letterFor(PEOPLE[0]!), (doc) => {
          doc.getPage(0).node.addContentStream(doc.context.register(doc.context.flateStream('['.repeat(100_000))));
          sign(doc);
        }),
      );
      expect(report.status).toBe('signed');
    });
  });
});
