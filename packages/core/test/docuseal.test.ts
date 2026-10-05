import { describe, expect, it } from 'vitest';
import { buildDocuSealSheet, findSignatureTags, readDocuSealTemplate } from '../src/output/docuseal.js';
import { readCsvRecords } from '../src/data/records.js';
import { DoclystError } from '../src/errors.js';
import { buildDocx, para, run } from './helpers/fixtures.js';

/** Synthetic candidates. Addresses are at example.com, which never delivers. */
const CSV = `Full Name,Email,Job Title,Basic Salary,NRIC,Manager Name
Aisha Rahman,aisha.rahman@example.com,Data Analyst,"4,500",S0000001A,Daniel Tan
Wei Lun Tan,weilun@example.com,Engineer,,S0000002B,Daniel Tan
Priya Nair,not-an-address,Designer,"5,200",S0000003C,Daniel Tan
Zoe Mueller,AISHA.RAHMAN@example.com,Associate,"4,800",S0000004D,Daniel Tan
`;

const OPTIONS = { fields: ['JOB_TITLE', 'BASIC_SALARY'], nameColumn: 'Full Name', emailColumn: 'Email' };

function parse(csv: string): string[][] {
  return csv
    .trim()
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? '').replace(/""/g, '"')));
}

/**
 * DocuSeal's own default column matching, ported from `import_list.vue`
 * (`buildDefaultMappings`): each field, recipient fields first, takes the
 * first unmatched column whose header contains its name.
 */
function docusealMapping(header: readonly string[], fieldOrder: readonly string[]): Map<string, string> {
  const taken = new Set<number>();
  const mapping = new Map<string, string>();
  for (const field of ['Name', 'Email', 'Phone', ...fieldOrder]) {
    const index = header.findIndex((column, i) => column.toLowerCase().includes(field.toLowerCase()) && !taken.has(i));
    if (index >= 0) {
      taken.add(index);
      mapping.set(field, header[index] as string);
    }
  }
  return mapping;
}

describe('buildDocuSealSheet', () => {
  it('writes only the name, the address and the fields the letter uses', () => {
    const { records } = readCsvRecords(CSV);
    const sheet = buildDocuSealSheet(records, OPTIONS);
    const [header, first] = parse(sheet.csv);
    expect(header).toEqual(['Name', 'Email', 'JOB_TITLE', 'BASIC_SALARY']);
    expect(first).toEqual(['Aisha Rahman', 'aisha.rahman@example.com', 'Data Analyst', '4,500']);
    // Nothing the letter does not use leaves the machine.
    expect(sheet.csv).not.toContain('S000000');
    expect(sheet.csv).not.toContain('Daniel Tan');
  });

  it('leaves out a row with a blank value, rather than send a blank, locked salary', () => {
    const { records } = readCsvRecords(CSV);
    const sheet = buildDocuSealSheet(records, OPTIONS);
    expect(sheet.included).toBe(2);
    expect(sheet.failures.map((failure) => failure.row)).toEqual([2, 3]);
    expect(sheet.failures[0]?.message).toContain('BASIC_SALARY');
    expect(sheet.failures[1]?.message).toBe('The email address in column "Email" in row 3 is not an email address.');
    for (const failure of sheet.failures) expect(failure.message).not.toMatch(/Wei Lun|not-an-address/);
  });

  it('reports rows that share an address', () => {
    const { records } = readCsvRecords(CSV);
    expect(buildDocuSealSheet(records, OPTIONS).sharedAddresses).toEqual([[1, 4]]);
  });

  it('refuses to prepare anything when a field has no column, since the candidate would fill it in', () => {
    const { records } = readCsvRecords(CSV);
    expect(() => buildDocuSealSheet(records, { ...OPTIONS, fields: ['JOB_TITLE', 'START_DATE'] })).toThrow(DoclystError);
    expect(() => buildDocuSealSheet(records, { ...OPTIONS, fields: ['JOB_TITLE', 'START_DATE'] })).toThrow(/"START_DATE"/);
  });

  it('leaves the signature to the candidate', () => {
    const { records } = readCsvRecords(CSV);
    const sheet = buildDocuSealSheet(records, { ...OPTIONS, fields: ['JOB_TITLE', 'Signature', 'Initials'] });
    expect(sheet.signerFields).toEqual(['Signature', 'Initials']);
    expect(parse(sheet.csv)[0]).toEqual(['Name', 'Email', 'JOB_TITLE']);
  });

  it('lets DocuSeal match every column to its own field, even with a manager name in the source', () => {
    const { records } = readCsvRecords(CSV);
    const fields = ['SALARY', 'BASIC_SALARY', 'JOB_TITLE'];
    const csv = `Full Name,Email,SALARY,Basic Salary,Job Title\nAisha Rahman,a@example.com,1,"4,500",Analyst\n`;
    const sheet = buildDocuSealSheet(readCsvRecords(csv).records, { ...OPTIONS, fields });
    const header = parse(sheet.csv)[0] as string[];
    const mapping = docusealMapping(header, fields);
    expect(mapping.get('Name')).toBe('Name');
    expect(mapping.get('Email')).toBe('Email');
    for (const field of fields) expect(mapping.get(field)).toBe(field);
    // And when DocuSeal lists the fields in another order, the risk is named.
    expect(sheet.notes).toContain(
      '"SALARY" is part of "BASIC_SALARY". On DocuSeal\'s column-matching screen, check that SALARY is matched to the SALARY column.',
    );
    expect(records.length).toBe(4);
  });

  it('warns when a placeholder shares a name with DocuSeal\'s own recipient fields', () => {
    const { records } = readCsvRecords(`Full Name,Email,Name\nAisha Rahman,a@example.com,Aisha\n`);
    const sheet = buildDocuSealSheet(records, { ...OPTIONS, fields: ['NAME'] });
    expect(sheet.notes[0]).toContain('DocuSeal treats a field called "NAME" as the candidate\'s own name');
    expect(parse(sheet.csv)[0]).toEqual(['Name', 'Email']);
  });

  it('quotes every cell and keeps values exactly, with no formula apostrophe', () => {
    const { records } = readCsvRecords(`Full Name,Email,NOTE\n"O""Neil, Jo",jo@example.com,-5% allowance\n`);
    const sheet = buildDocuSealSheet(records, { ...OPTIONS, fields: ['NOTE'] });
    expect(sheet.csv).toBe('"Name","Email","NOTE"\r\n"O""Neil, Jo","jo@example.com","-5% allowance"\r\n');
  });
});

describe('findSignatureTags', () => {
  it('finds plain and typed signature tags, and ignores value fields', () => {
    expect(
      findSignatureTags('Dear {{FULL_NAME}}, sign: {{Signature}} {{Sign here;type=signature;role=Candidate}} {{Date;type=datenow}} {{INITIALS;type=initials}}'),
    ).toEqual(['{{Signature}}', '{{Sign here;type=signature;role=Candidate}}', '{{INITIALS;type=initials}}']);
    expect(findSignatureTags('Dear {{FULL_NAME}}')).toEqual([]);
  });
});

describe('readDocuSealTemplate', () => {
  it('reads value fields and signature tags from a Word template', async () => {
    const docx = buildDocx(para(run('Dear {{FULL_NAME}}, salary {{BASIC_SALARY}}.')) + para(run('Signed: {{Signature;type=signature}}')));
    const info = await readDocuSealTemplate({ kind: 'docx', bytes: docx });
    // The attribute form is not a Doclyst placeholder, so it is not a value field.
    expect(info.fields).toEqual(['FULL_NAME', 'BASIC_SALARY']);
    expect(info.signatureTags).toEqual(['{{Signature;type=signature}}']);
  });

  it('notices a Word template with nowhere to sign', async () => {
    const info = await readDocuSealTemplate({ kind: 'docx', bytes: buildDocx(para(run('Dear {{FULL_NAME}}'))) });
    expect(info.signatureTags).toEqual([]);
  });
});
