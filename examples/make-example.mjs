#!/usr/bin/env node
/**
 * Write a sample template and spreadsheet so Doclyst can be tried immediately.
 *
 * The .docx is generated rather than committed, so the repository holds no
 * opaque binary files. Every person in the sample is invented; see GUIDE.md.
 *
 * Usage:  node examples/make-example.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));

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

/** One paragraph; `bold` marks the run so formatting survival is visible. */
const p = (text, bold = false) =>
  `<w:p>${bold ? '<w:pPr><w:rPr><w:b/></w:rPr></w:pPr>' : ''}` +
  `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}` +
  `<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${p('OFFER OF EMPLOYMENT', true)}
${p('')}
${p('Dear {{FULL_NAME}},')}
${p('')}
${p('We are pleased to offer you the position of {{JOB_TITLE}}, at a monthly salary of SGD {{BASIC_SALARY}}, commencing {{START_DATE}}.')}
${p('')}
${p('Your staff number will be {{STAFF_ID}}. Please confirm your acceptance in writing.')}
${p('')}
${p('Yours sincerely,')}
${p('Human Resources')}
</w:body></w:document>`;

const template = zipSync(
  {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'word/document.xml': strToU8(DOCUMENT),
  },
  // The earliest timestamp ZIP can represent; keeps output reproducible.
  { mtime: new Date(Date.UTC(1980, 0, 1)) },
);

writeFileSync(join(here, 'offer-letter.docx'), template);
console.log('Wrote examples/offer-letter.docx');
console.log('      placeholders: FULL_NAME, JOB_TITLE, BASIC_SALARY, START_DATE, STAFF_ID');
console.log('Sample data is already at examples/staff.csv');
console.log('');
console.log('Try it:');
console.log('  node apps/cli/dist/bin.js inspect --template examples/offer-letter.docx --data examples/staff.csv');
console.log('  node apps/cli/dist/bin.js fill --template examples/offer-letter.docx --data examples/staff.csv --out ./letters');
