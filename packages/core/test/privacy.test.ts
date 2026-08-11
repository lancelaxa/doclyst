import { describe, expect, it } from 'vitest';
import {
  describeValue,
  isSensitiveFieldName,
  redactForLog,
  redactRecord,
} from '../src/privacy/redact.js';
import { DoclystError, safeErrorSummary } from '../src/errors.js';

/**
 * These tests encode the rule the whole package depends on: a value may be
 * written into a document, and nowhere else. Anything bound for a log, an
 * error or a manifest is described, never quoted.
 */

const SYNTHETIC = {
  NAME: 'Aisha Rahman',
  NRIC: 'S0000001A',
  SALARY: '4500',
  ADDRESS: '12 Example Road',
};

describe('describeValue', () => {
  it('reports a string"s length but not its content', () => {
    expect(describeValue('Aisha Rahman')).toBe('<text:12 chars>');
  });

  it('distinguishes empty from missing', () => {
    expect(describeValue('')).toBe('<empty text>');
    expect(describeValue(undefined)).toBe('<missing>');
    expect(describeValue(null)).toBe('<null>');
  });

  it('does not disclose numbers, which can themselves be identifying', () => {
    // A salary or an account number is as sensitive as a name.
    expect(describeValue(4500)).toBe('<number>');
  });

  it.each([
    [true, '<boolean>'],
    [new Date(0), '<date>'],
  ])('describes %p structurally', (value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });
});

describe('redactRecord', () => {
  it('keeps field names and removes every value', () => {
    const redacted = redactRecord(SYNTHETIC);
    expect(Object.keys(redacted)).toEqual(['NAME', 'NRIC', 'SALARY', 'ADDRESS']);
    for (const value of Object.values(redacted)) {
      expect(value).toMatch(/^<.*>$/);
    }
  });

  it('leaves no original value anywhere in the output', () => {
    const serialised = JSON.stringify(redactRecord(SYNTHETIC));
    for (const value of Object.values(SYNTHETIC)) {
      expect(serialised).not.toContain(value);
    }
  });
});

describe('redactForLog', () => {
  it('redacts nested structures', () => {
    const serialised = JSON.stringify(redactForLog({ rows: [SYNTHETIC], note: 'S0000001A' }));
    expect(serialised).not.toContain('Aisha');
    expect(serialised).not.toContain('S0000001A');
  });

  it('passes through non-identifying scalars', () => {
    expect(redactForLog(42)).toBe(42);
    expect(redactForLog(true)).toBe(true);
  });
});

describe('isSensitiveFieldName', () => {
  it.each([
    'NRIC',
    'nric',
    'FIN',
    'Passport No',
    'Basic Salary',
    'Bank Account Number',
    'Date of Birth',
    'DOB',
    'Home Address',
    'Postal Code',
    'Mobile Number',
    'Email',
  ])('flags %j', (field) => {
    expect(isSensitiveFieldName(field)).toBe(true);
  });

  it.each(['DEPARTMENT', 'JOB_TITLE', 'ROW', 'COMPANY'])('does not flag %j', (field) => {
    expect(isSensitiveFieldName(field)).toBe(false);
  });
});

describe('safeErrorSummary', () => {
  it('passes through our own messages, which are written to be safe', () => {
    const error = new DoclystError('MISSING_VALUE', 'No value for placeholder "SALARY" in row 4.');
    expect(safeErrorSummary(error)).toBe('No value for placeholder "SALARY" in row 4.');
  });

  it('withholds a foreign error"s message, which may embed document bytes', () => {
    // A zip or PDF parser will happily quote the buffer it choked on.
    const error = new Error('Invalid entry near "Aisha Rahman, S0000001A"');
    const summary = safeErrorSummary(error);
    expect(summary).not.toContain('Aisha Rahman');
    expect(summary).not.toContain('S0000001A');
    expect(summary).toBe('Error (details withheld)');
  });

  it('keeps the error type, which is the useful diagnostic part', () => {
    expect(safeErrorSummary(new TypeError('secret'))).toBe('TypeError (details withheld)');
  });

  it('handles a thrown non-error', () => {
    expect(safeErrorSummary('S0000001A')).toBe('unknown error (details withheld)');
  });
});

describe('DoclystError', () => {
  it('carries a code and location for programmatic handling', () => {
    const error = new DoclystError('MISSING_VALUE', 'msg', { row: 3, field: 'NRIC' });
    expect(error.code).toBe('MISSING_VALUE');
    expect(error.row).toBe(3);
    expect(error.field).toBe('NRIC');
  });
});
