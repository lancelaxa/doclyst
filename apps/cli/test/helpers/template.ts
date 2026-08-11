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

function documentXml(placeholders: readonly string[]): string {
  const paragraphs = placeholders
    .map((name) => `<w:p><w:r><w:t>Field {{${name}}}.</w:t></w:r></w:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

/** The earliest timestamp the ZIP format can represent; keeps output stable. */
const FIXED_TIMESTAMP = new Date(Date.UTC(1980, 0, 1));

/**
 * Build a template requiring the given placeholders.
 *
 * Defaults to NAME and SALARY, matching the CSV used by most CLI tests; the
 * XLSX fixture has different column headers and passes its own.
 */
export function makeTemplate(placeholders: readonly string[] = ['NAME', 'SALARY']): Uint8Array {
  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      'word/document.xml': strToU8(documentXml(placeholders)),
    },
    { mtime: FIXED_TIMESTAMP },
  );
}
