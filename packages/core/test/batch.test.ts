import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { detectTemplateKind, readTemplateFields, runBatch } from '../src/batch/run.js';
import { readDocxText } from '../src/docx/fill.js';
import { buildZip } from '../src/output/zip.js';
import { readCsvRecords } from '../src/data/records.js';
import { buildDocx, buildPdfForm, para, run, splitRuns } from './helpers/fixtures.js';

const OFFER_TEMPLATE = buildDocx(
  para(run('Dear ')) +
    para(splitRuns('{{NAME}}', 3)) +
    para(run('Your salary is {{SALARY}} from {{START_DATE}}.')),
);

const CSV = `NAME,SALARY,START_DATE,STAFF_ID
Aisha Rahman,4500,2026-01-15,EMP-0001
Wei Lun Tan,5200,2026-02-01,EMP-0002
Priya Nair,6100,2026-02-14,EMP-0003
`;

const records = readCsvRecords(CSV).records;

describe('detectTemplateKind', () => {
  it('identifies a DOCX by its ZIP signature', () => {
    expect(detectTemplateKind(OFFER_TEMPLATE)).toBe('docx');
  });

  it('identifies a PDF by its header', async () => {
    expect(detectTemplateKind(await buildPdfForm([{ name: 'NAME' }]))).toBe('pdf');
  });

  it('rejects anything else, regardless of what it was named', () => {
    // Detection is by content, so a .docx-named text file is still rejected.
    expect(() => detectTemplateKind(new Uint8Array([1, 2, 3, 4]))).toThrow(/must be a \.docx or \.pdf/);
  });
});

describe('readTemplateFields', () => {
  it('reports the fields of a DOCX template', async () => {
    const fields = await readTemplateFields({ kind: 'docx', bytes: OFFER_TEMPLATE });
    expect(fields.sort()).toEqual(['NAME', 'SALARY', 'START_DATE']);
  });
});

describe('runBatch', () => {
  const template = { kind: 'docx' as const, bytes: OFFER_TEMPLATE };

  it('produces one document per record', async () => {
    const result = await runBatch(template, records);
    expect(result.documents).toHaveLength(3);
    expect(result.failures).toHaveLength(0);
  });

  it('substitutes each record into its own document', async () => {
    const result = await runBatch(template, records);
    const text = readDocxText(result.documents[0]!.bytes);
    expect(text).toContain('Aisha Rahman');
    expect(text).toContain('4500');
    expect(readDocxText(result.documents[2]!.bytes)).toContain('Priya Nair');
  });

  it('does not leak one record into another record"s document', async () => {
    const result = await runBatch(template, records);
    const first = readDocxText(result.documents[0]!.bytes);
    expect(first).not.toContain('Wei Lun Tan');
    expect(first).not.toContain('5200');
  });

  it('names documents by position by default', async () => {
    const result = await runBatch(template, records);
    expect(result.documents.map((d) => d.filename)).toEqual([
      'document-0001.docx',
      'document-0002.docx',
      'document-0003.docx',
    ]);
  });

  it('applies a filename template', async () => {
    const result = await runBatch(template, records, { filenameTemplate: '{{STAFF_ID}}-offer' });
    expect(result.documents.map((d) => d.filename)).toEqual([
      'EMP-0001-offer.docx',
      'EMP-0002-offer.docx',
      'EMP-0003-offer.docx',
    ]);
  });

  it('reports the row number alongside each document', async () => {
    const result = await runBatch(template, records);
    expect(result.documents.map((d) => d.row)).toEqual([1, 2, 3]);
  });

  it('reports progress for each record', async () => {
    const seen: number[] = [];
    await runBatch(template, records, { onProgress: (completed) => seen.push(completed) });
    expect(seen).toEqual([1, 2, 3]);
  });

  describe('duplicate filenames', () => {
    it('disambiguates rather than overwriting', async () => {
      // Two people sharing a name must not silently collapse to one document.
      const duplicates = readCsvRecords(
        'NAME,SALARY,START_DATE\nAisha Rahman,1,2026-01-01\nAisha Rahman,2,2026-01-02\n',
      ).records;
      const result = await runBatch(template, duplicates, { filenameTemplate: '{{NAME}}' });
      expect(result.documents.map((d) => d.filename)).toEqual([
        'Aisha Rahman.docx',
        'Aisha Rahman (2).docx',
      ]);
    });
  });

  describe('failure handling', () => {
    const incomplete = readCsvRecords(
      'NAME,SALARY,START_DATE\nAisha,1,2026-01-01\nWei Lun,,2026-01-02\n',
    ).records;

    it('continues past a failing row by default', async () => {
      // With hundreds of rows, the rest of the batch is worth keeping.
      const result = await runBatch(template, incomplete, { treatEmptyAsMissing: true });
      expect(result.documents).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.row).toBe(2);
    });

    it('stops at the first failure when asked', async () => {
      const result = await runBatch(template, incomplete, {
        treatEmptyAsMissing: true,
        stopOnError: true,
      });
      expect(result.failures).toHaveLength(1);
    });

    it('describes a failure without disclosing the record', async () => {
      const result = await runBatch(template, incomplete, { treatEmptyAsMissing: true });
      const failure = result.failures[0]!;
      expect(failure.code).toBe('MISSING_VALUE');
      expect(failure.field).toBe('SALARY');
      expect(failure.message).not.toContain('Wei Lun');
    });

    it('reports placeholders that no column satisfies', async () => {
      const missingColumn = readCsvRecords('NAME\nAisha\n').records;
      const result = await runBatch(template, missingColumn, { missing: 'empty' });
      expect(result.unmatchedFields.sort()).toEqual(['SALARY', 'START_DATE']);
    });

    it('warns when a filename template would expose an identifier', async () => {
      const result = await runBatch(template, records, { filenameTemplate: '{{NRIC}}' });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.field).toBe('NRIC');
    });
  });

  describe('missing-value policies', () => {
    const sparse = readCsvRecords('NAME,SALARY,START_DATE\nAisha,,2026-01-01\n').records;

    it('errors by default when a value is absent', async () => {
      const noColumn = readCsvRecords('NAME\nAisha\n').records;
      const result = await runBatch(template, noColumn);
      expect(result.documents).toHaveLength(0);
      expect(result.failures[0]?.code).toBe('MISSING_VALUE');
    });

    it('substitutes blanks under the empty policy', async () => {
      const noColumn = readCsvRecords('NAME\nAisha\n').records;
      const result = await runBatch(template, noColumn, { missing: 'empty' });
      expect(result.documents).toHaveLength(1);
      expect(readDocxText(result.documents[0]!.bytes)).toContain('Your salary is  from .');
    });

    it('leaves placeholders visible under the keep policy', async () => {
      const noColumn = readCsvRecords('NAME\nAisha\n').records;
      const result = await runBatch(template, noColumn, { missing: 'keep' });
      expect(readDocxText(result.documents[0]!.bytes)).toContain('{{SALARY}}');
    });

    it('accepts a blank cell as a real value by default', async () => {
      const result = await runBatch(template, sparse);
      expect(result.documents).toHaveLength(1);
    });
  });

  describe('PDF templates', () => {
    it('fills a PDF once per record', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }, { name: 'SALARY' }]);
      const data = readCsvRecords('NAME,SALARY\nAisha,4500\nWei Lun,5200\n').records;
      const result = await runBatch({ kind: 'pdf', bytes: pdf }, data);
      expect(result.documents).toHaveLength(2);
      expect(result.documents[0]?.filename).toBe('document-0001.pdf');
    });

    it('records a per-row failure without aborting the batch', async () => {
      const pdf = await buildPdfForm([{ name: 'NAME' }, { name: 'NRIC' }]);
      const data = readCsvRecords('NAME,NRIC\nAisha,S0000001A\nWei Lun,\n').records;
      const result = await runBatch({ kind: 'pdf', bytes: pdf }, data, {
        treatEmptyAsMissing: true,
      });
      expect(result.documents).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
    });
  });

  it('rejects a malformed template once instead of failing every row', async () => {
    // The template is validated before any record is attempted, so a broken
    // one surfaces as a single clear error rather than 500 identical failures.
    await expect(
      runBatch({ kind: 'docx', bytes: new Uint8Array([1, 2, 3, 4]) }, records),
    ).rejects.toThrow(/not a valid DOCX/);
  });

  it('handles a batch of several hundred records', async () => {
    const rows = Array.from(
      { length: 300 },
      (_, i) => `Person ${i},${1000 + i},2026-01-01,EMP-${i}`,
    ).join('\n');
    const many = readCsvRecords(`NAME,SALARY,START_DATE,STAFF_ID\n${rows}\n`).records;

    const result = await runBatch(template, many);
    expect(result.documents).toHaveLength(300);
    expect(result.failures).toHaveLength(0);
    expect(new Set(result.documents.map((d) => d.filename)).size).toBe(300);
  });
});

describe('buildZip', () => {
  it('packs each document under its filename', async () => {
    const result = await runBatch({ kind: 'docx', bytes: OFFER_TEMPLATE }, records);
    const archive = buildZip(
      result.documents.map((d) => ({ name: d.filename, bytes: d.bytes })),
    );
    expect(Object.keys(unzipSync(archive)).sort()).toEqual([
      'document-0001.docx',
      'document-0002.docx',
      'document-0003.docx',
    ]);
  });

  it('never drops a document to a duplicate entry name', () => {
    // Assigning by a repeated key would silently lose the earlier file.
    const archive = buildZip([
      { name: 'same.docx', bytes: new Uint8Array([1]) },
      { name: 'same.docx', bytes: new Uint8Array([2]) },
    ]);
    expect(Object.keys(unzipSync(archive))).toHaveLength(2);
  });

  it('neutralises an entry name that would escape the extraction root', () => {
    const archive = buildZip([{ name: '../../evil.docx', bytes: new Uint8Array([1]) }]);
    for (const name of Object.keys(unzipSync(archive))) {
      expect(name).not.toContain('..');
      expect(name.startsWith('/')).toBe(false);
    }
  });

  it('is reproducible for the same inputs', () => {
    const entries = [{ name: 'a.docx', bytes: new Uint8Array([1, 2, 3]) }];
    expect(buildZip(entries)).toEqual(buildZip(entries));
  });
});
