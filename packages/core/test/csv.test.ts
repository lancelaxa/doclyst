import { describe, expect, it } from 'vitest';
import { parseCsv, detectDelimiter, escapeCsvValue, toCsv } from '../src/data/csv.js';
import { DoclystError } from '../src/errors.js';

describe('parseCsv', () => {
  it('parses a simple table', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a lone CR as a row terminator', () => {
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM so the first header still matches', () => {
    // Without this, the first column is named "﻿NAME" and every
    // {{NAME}} placeholder silently fails to resolve.
    const [header] = parseCsv('﻿NAME,SALARY\nAisha,4500');
    expect(header?.[0]).toBe('NAME');
  });

  it('keeps quoted delimiters as data', () => {
    expect(parseCsv('a,b\n"12 Example Road, #04-05",Singapore')).toEqual([
      ['a', 'b'],
      ['12 Example Road, #04-05', 'Singapore'],
    ]);
  });

  it('keeps quoted newlines inside a single field', () => {
    const rows = parseCsv('addr\n"line one\nline two"');
    expect(rows[1]?.[0]).toBe('line one\nline two');
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('preserves empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('returns an empty result for blank input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('   \n  ')).toEqual([]);
  });

  it('does not emit a trailing empty row for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  it('rejects input that ends inside a quoted field', () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(DoclystError);
    expect(() => parseCsv('a\n"unterminated')).toThrow(/closing quote/i);
  });

  it('enforces the row limit', () => {
    const many = ['h', ...Array.from({ length: 20 }, (_, i) => String(i))].join('\n');
    expect(() => parseCsv(many, { maxRows: 5 })).toThrow(/exceeds the supported limit/);
  });

  it('enforces the column limit', () => {
    expect(() => parseCsv('a,b,c,d,e', { maxColumns: 3 })).toThrow(/columns/);
  });

  it('honours an explicit delimiter', () => {
    expect(parseCsv('a;b\n1;2', { delimiter: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects a multi-character delimiter', () => {
    expect(() => parseCsv('a||b', { delimiter: '||' })).toThrow(/single character/);
  });
});

describe('detectDelimiter', () => {
  it.each([
    ['a,b,c', ','],
    ['a;b;c', ';'],
    ['a\tb\tc', '\t'],
    ['a|b|c', '|'],
  ])('detects %j', (input, expected) => {
    expect(detectDelimiter(input)).toBe(expected);
  });

  it('defaults to comma when no candidate appears', () => {
    expect(detectDelimiter('single')).toBe(',');
  });

  it('ignores delimiters inside quotes when counting', () => {
    // The semicolons are data; the file is comma-delimited.
    expect(detectDelimiter('"a;b;c;d",second')).toBe(',');
  });

  it('parses a semicolon file end to end via auto-detection', () => {
    expect(parseCsv('NAME;SALARY\nAisha;4500')).toEqual([
      ['NAME', 'SALARY'],
      ['Aisha', '4500'],
    ]);
  });
});

describe('escapeCsvValue', () => {
  it('leaves ordinary values alone', () => {
    expect(escapeCsvValue('Aisha Rahman')).toBe('Aisha Rahman');
  });

  it('quotes values containing a comma, quote or newline', () => {
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('a\nb')).toBe('"a\nb"');
  });

  describe('formula injection', () => {
    // A manifest is written to be opened in Excel or Sheets. A value that
    // starts with one of these characters would be evaluated there, so it is
    // neutralised on the way out.
    it.each(['=1+1', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://x","click")'])(
      'neutralises %j',
      (payload) => {
        expect(escapeCsvValue(payload).replace(/^"/, '')).toMatch(/^'/);
      },
    );

    it('neutralises a leading tab or carriage return', () => {
      expect(escapeCsvValue('\t=1+1')).toContain("'");
      expect(escapeCsvValue('\r=1+1')).toContain("'");
    });

    it('still quotes a neutralised value that also contains a comma', () => {
      const escaped = escapeCsvValue('=A1,B2');
      expect(escaped).toBe('"\'=A1,B2"');
    });
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF and escapes each cell', () => {
    expect(
      toCsv([
        ['row', 'status'],
        ['1', '=cmd'],
      ]),
    ).toBe("row,status\r\n1,'=cmd");
  });
});
