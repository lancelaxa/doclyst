import { describe, expect, it } from 'vitest';
import { readCsvRecords, toRecords } from '../src/data/records.js';
import { ValueResolver, coerceToText } from '../src/template/values.js';
import { DoclystError } from '../src/errors.js';

describe('toRecords', () => {
  it('keys each row by its header', () => {
    const { fields, records } = toRecords([
      ['NAME', 'SALARY'],
      ['Aisha Rahman', '4500'],
    ]);
    expect(fields).toEqual(['NAME', 'SALARY']);
    expect(records).toEqual([{ NAME: 'Aisha Rahman', SALARY: '4500' }]);
  });

  it('trims whitespace around headers', () => {
    const { fields } = toRecords([[' NAME ', ' SALARY']]);
    expect(fields).toEqual(['NAME', 'SALARY']);
  });

  it('rejects an empty file', () => {
    expect(() => toRecords([])).toThrow(/empty/i);
  });

  it('rejects a header row with no names', () => {
    expect(() => toRecords([['', '']])).toThrow(/no column headers/i);
  });

  it('rejects an empty header between named ones', () => {
    expect(() => toRecords([['NAME', '', 'SALARY']])).toThrow(/empty header/i);
  });

  it('drops trailing empty headers from a stray delimiter', () => {
    // Spreadsheet exports frequently end each line with an extra separator.
    const { fields } = toRecords([
      ['NAME', 'SALARY', ''],
      ['Aisha', '4500', ''],
    ]);
    expect(fields).toEqual(['NAME', 'SALARY']);
  });

  it('rejects duplicate headers', () => {
    expect(() => toRecords([['NAME', 'NAME']])).toThrow(/same field name/i);
  });

  it('rejects headers that differ only by case or separator', () => {
    // These would both satisfy {{FULL_NAME}}, so the mapping is ambiguous.
    expect(() => toRecords([['Full Name', 'full_name']])).toThrow(/same field name/i);
  });

  it('skips fully blank rows', () => {
    const { records } = toRecords([['NAME'], ['Aisha'], ['  '], ['Wei Lun']]);
    expect(records).toHaveLength(2);
  });

  it('pads short rows with empty strings', () => {
    const { records } = toRecords([
      ['NAME', 'SALARY'],
      ['Aisha'],
    ]);
    expect(records[0]).toEqual({ NAME: 'Aisha', SALARY: '' });
  });

  it('rejects a row with more data than the header allows', () => {
    expect(() =>
      toRecords([
        ['NAME'],
        ['Aisha', 'unexpected'],
      ]),
    ).toThrow(/but the header defines/);
  });

  it('tolerates extra trailing empty cells in a row', () => {
    const { records } = toRecords([
      ['NAME'],
      ['Aisha', ''],
    ]);
    expect(records[0]).toEqual({ NAME: 'Aisha' });
  });

  it('reports the row number on a shape error without quoting values', () => {
    try {
      toRecords([['NAME'], ['Aisha'], ['Wei Lun', 'extra']]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DoclystError);
      const message = (error as DoclystError).message;
      expect((error as DoclystError).row).toBe(2);
      // The message must locate the problem without disclosing the data.
      expect(message).not.toContain('Wei Lun');
      expect(message).not.toContain('extra');
    }
  });
});

describe('readCsvRecords', () => {
  it('parses CSV text straight into records', () => {
    const { records } = readCsvRecords('NAME,SALARY\nAisha Rahman,4500\n');
    expect(records).toEqual([{ NAME: 'Aisha Rahman', SALARY: '4500' }]);
  });
});

describe('ValueResolver', () => {
  const record = { Name: 'Aisha Rahman', 'Basic Salary': '4500', Blank: '' };

  it('resolves an exact key', () => {
    const resolver = new ValueResolver({ NAME: 'Aisha' });
    expect(resolver.resolve('NAME', '{{NAME}}')).toBe('Aisha');
  });

  it('resolves case-insensitively', () => {
    const resolver = new ValueResolver(record);
    expect(resolver.resolve('NAME', '{{NAME}}')).toBe('Aisha Rahman');
  });

  it('matches spaces in a header against underscores in a placeholder', () => {
    // Template says {{BASIC_SALARY}}, spreadsheet header says "Basic Salary".
    const resolver = new ValueResolver(record);
    expect(resolver.resolve('BASIC_SALARY', '{{BASIC_SALARY}}')).toBe('4500');
  });

  it('prefers an exact match over a normalized one', () => {
    const resolver = new ValueResolver({ NAME: 'exact', Name: 'normalized' });
    expect(resolver.resolve('NAME', '{{NAME}}')).toBe('exact');
  });

  describe('missing values', () => {
    it('throws by default rather than shipping a blank document', () => {
      const resolver = new ValueResolver(record, { row: 7 });
      expect(() => resolver.resolve('NRIC', '{{NRIC}}')).toThrow(DoclystError);
    });

    it('reports the row and field but not the record contents', () => {
      const resolver = new ValueResolver(record, { row: 7 });
      try {
        resolver.resolve('NRIC', '{{NRIC}}');
        expect.unreachable();
      } catch (error) {
        const err = error as DoclystError;
        expect(err.code).toBe('MISSING_VALUE');
        expect(err.row).toBe(7);
        expect(err.field).toBe('NRIC');
        expect(err.message).not.toContain('Aisha');
      }
    });

    it('substitutes an empty string under the empty policy', () => {
      const resolver = new ValueResolver(record, { missing: 'empty' });
      expect(resolver.resolve('NRIC', '{{NRIC}}')).toBe('');
    });

    it('leaves the placeholder in place under the keep policy', () => {
      const resolver = new ValueResolver(record, { missing: 'keep' });
      expect(resolver.resolve('NRIC', '{{NRIC}}')).toBe('{{NRIC}}');
    });

    it('records which keys were missing', () => {
      const resolver = new ValueResolver(record, { missing: 'empty' });
      resolver.resolve('NRIC', '{{NRIC}}');
      resolver.resolve('Passport No', '{{Passport No}}');
      expect([...resolver.missingKeys]).toEqual(['NRIC', 'PASSPORT_NO']);
    });

    it('treats a blank cell as present by default', () => {
      const resolver = new ValueResolver(record);
      expect(resolver.resolve('Blank', '{{Blank}}')).toBe('');
      expect(resolver.missingKeys.size).toBe(0);
    });

    it('treats a blank cell as missing when asked', () => {
      const resolver = new ValueResolver(record, { treatEmptyAsMissing: true });
      expect(() => resolver.resolve('Blank', '{{Blank}}')).toThrow(DoclystError);
    });
  });
});

describe('coerceToText', () => {
  it('passes strings through', () => {
    expect(coerceToText('Aisha', 'NAME')).toBe('Aisha');
  });

  it('renders finite numbers', () => {
    expect(coerceToText(4500, 'SALARY')).toBe('4500');
  });

  it('renders booleans as Yes/No', () => {
    expect(coerceToText(true, 'CONFIRMED')).toBe('Yes');
    expect(coerceToText(false, 'CONFIRMED')).toBe('No');
  });

  it('renders dates as ISO calendar dates', () => {
    expect(coerceToText(new Date('2026-02-14T00:00:00Z'), 'START_DATE')).toBe('2026-02-14');
  });

  it('rejects objects rather than writing [object Object] into a contract', () => {
    expect(() => coerceToText({ a: 1 }, 'NAME')).toThrow(/not text/);
  });

  it('strips control characters that would corrupt the document XML', () => {
    expect(coerceToText('a\u0007b\u0000c', 'NAME')).toBe('abc');
  });

  it('keeps tabs and newlines, which are meaningful in cell text', () => {
    expect(coerceToText('a\tb\nc', 'ADDRESS')).toBe('a\tb\nc');
  });

  it('rejects a value beyond the length limit', () => {
    expect(() => coerceToText('x'.repeat(100_001), 'NOTES')).toThrow(/limit/);
  });
});
