import { zipSync, strToU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { FIXED_ARCHIVE_TIMESTAMP } from '../../src/internal/deterministic.js';

/**
 * Synthetic fixtures.
 *
 * Templates are built in code rather than committed as binaries so that the
 * exact XML under test — particularly placeholders split across runs — is
 * visible in the test that depends on it. Every value used anywhere in the
 * suite is invented; no real personal data appears in this repository.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Core properties carrying identifying metadata, to test scrubbing. */
const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>Template Author</dc:creator>
<cp:lastModifiedBy>Someone Else</cp:lastModifiedBy>
<dc:title>Offer Letter Template</dc:title>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Company>Example Pte Ltd</Company>
<Manager>A Manager</Manager>
</Properties>`;

function documentXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}</w:body></w:document>`;
}

/** Wrap raw run XML in a paragraph. */
export function para(...runs: string[]): string {
  return `<w:p>${runs.join('')}</w:p>`;
}

/** A run holding one text node. */
export function run(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

/**
 * Split `text` into `count` runs at arbitrary boundaries.
 *
 * This reproduces what Word actually does to a template: `{{NAME}}` typed as
 * one word is commonly stored as several runs, so any engine that does a plain
 * string replace over document.xml fails on real files.
 */
export function splitRuns(text: string, count: number): string {
  const size = Math.ceil(text.length / count);
  const runs: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    runs.push(run(text.slice(i, i + size)));
  }
  return runs.join('');
}

export interface BuildDocxOptions {
  /** Extra parts, e.g. `word/header1.xml`. */
  readonly extraParts?: Readonly<Record<string, string>>;
}

/** Build a minimal but structurally valid DOCX from body XML. */
export function buildDocx(bodyXml: string, options: BuildDocxOptions = {}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(documentXml(bodyXml)),
    'docProps/core.xml': strToU8(CORE_XML),
    'docProps/app.xml': strToU8(APP_XML),
  };
  for (const [name, content] of Object.entries(options.extraParts ?? {})) {
    parts[name] = strToU8(content);
  }
  return zipSync(parts, { mtime: FIXED_ARCHIVE_TIMESTAMP });
}

/** A header part containing the given body XML. */
export function headerXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${bodyXml}</w:hdr>`;
}

export interface PdfFieldSpec {
  readonly name: string;
  readonly kind?: 'text' | 'checkbox' | 'dropdown';
  readonly options?: readonly string[];
  /** Widget width in points. Narrow boxes are how overflow is exercised. */
  readonly width?: number;
  readonly height?: number;
  readonly multiline?: boolean;
}

/** Build a one-page PDF with the named AcroForm fields. */
export async function buildPdfForm(fields: readonly PdfFieldSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();

  let y = 550;
  for (const spec of fields) {
    const kind = spec.kind ?? 'text';
    if (kind === 'text') {
      const field = form.createTextField(spec.name);
      if (spec.multiline) field.enableMultiline();
      field.addToPage(page, {
        x: 40,
        y,
        width: spec.width ?? 300,
        height: spec.height ?? 20,
        font,
      });
    } else if (kind === 'checkbox') {
      const field = form.createCheckBox(spec.name);
      field.addToPage(page, { x: 40, y, width: 16, height: 16 });
    } else {
      const field = form.createDropdown(spec.name);
      field.setOptions([...(spec.options ?? [])]);
      field.addToPage(page, { x: 40, y, width: 300, height: 20, font });
    }
    y -= 40;
  }

  return doc.save();
}

/** Synthetic staff records. Names, IDs and salaries are all invented. */
export const SAMPLE_RECORDS = [
  { NAME: 'Aisha Rahman', SALARY: '4500', STAFF_ID: 'EMP-0001', START_DATE: '2026-01-15' },
  { NAME: 'Wei Lun Tan', SALARY: '5200', STAFF_ID: 'EMP-0002', START_DATE: '2026-02-01' },
  { NAME: 'Priya Nair', SALARY: '6100', STAFF_ID: 'EMP-0003', START_DATE: '2026-02-14' },
] as const;
