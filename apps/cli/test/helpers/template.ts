import { zipSync, strToU8 } from 'fflate';

/**
 * A minimal DOCX template for CLI tests.
 *
 * Built in code rather than committed as a binary, so the repository holds no
 * opaque document files and the template under test is readable here.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** A one-cell table, used to test what PDF output cannot carry over. */
const TABLE = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';

function documentXml(placeholders: readonly string[], withTable: boolean): string {
  const paragraphs = placeholders
    .map((name) => `<w:p><w:r><w:t>Field {{${name}}}.</w:t></w:r></w:p>`)
    .join('');
  const body = withTable ? paragraphs + TABLE : paragraphs;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

/** The earliest timestamp the ZIP format can represent; keeps output stable. */
const FIXED_TIMESTAMP = new Date(Date.UTC(1980, 0, 1));

/**
 * Build a template requiring the given placeholders.
 *
 * Defaults to NAME and SALARY, matching the CSV used by most CLI tests; the
 * XLSX fixture has different column headers and passes its own.
 */
export function makeTemplate(
  placeholders: readonly string[] = ['NAME', 'SALARY'],
  options: { readonly withTable?: boolean } = {},
): Uint8Array {
  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      'word/document.xml': strToU8(documentXml(placeholders, options.withTable ?? false)),
    },
    { mtime: FIXED_TIMESTAMP },
  );
}

/** A fillable PDF template, for the field-fit checks. */
export async function makePdfTemplate(
  fields: readonly { readonly name: string; readonly width: number }[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  let y = 700;
  for (const spec of fields) {
    form
      .createTextField(spec.name)
      .addToPage(page, { x: 40, y, width: spec.width, height: 18, font });
    y -= 40;
  }
  return doc.save();
}

/** A PDF with `{{PLACEHOLDERS}}` written into it as ordinary text. */
export async function makePlaceholderPdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Dear {{NAME}},', { x: 56, y: 760, size: 11, font });
  page.drawText('Your salary is {{SALARY}}.', { x: 56, y: 736, size: 11, font });
  return doc.save();
}
