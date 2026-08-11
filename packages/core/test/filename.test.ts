import { describe, expect, it } from 'vitest';
import {
  buildFilename,
  checkFilenameTemplate,
  dedupeFilename,
  sanitizeFilename,
} from '../src/batch/filename.js';

describe('sanitizeFilename', () => {
  it('appends the extension', () => {
    expect(sanitizeFilename('offer', '.docx')).toBe('offer.docx');
    expect(sanitizeFilename('offer', 'docx')).toBe('offer.docx');
  });

  describe('path traversal', () => {
    it.each([
      ['../../etc/passwd', 'etc_passwd.pdf'],
      ['..\\..\\windows\\system32', 'windows_system32.pdf'],
      ['/absolute/path', 'absolute_path.pdf'],
      ['C:\\Users\\admin\\file', 'C_Users_admin_file.pdf'],
    ])('neutralises %j', (input, expected) => {
      const result = sanitizeFilename(input, '.pdf');
      expect(result).toBe(expected);
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(result).not.toContain('..');
    });

    it('collapses any run of dots so .. cannot survive', () => {
      expect(sanitizeFilename('a....b', '.pdf')).toBe('a.b.pdf');
    });
  });

  it('replaces characters that are illegal on Windows', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h', '.pdf')).toBe('a_b_c_d_e_f_g_h.pdf');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('a\u0000b\u001Fc', '.pdf')).toBe('abc.pdf');
  });

  it('strips leading and trailing dots and spaces', () => {
    // Windows silently trims these, which would let two names collide later.
    expect(sanitizeFilename('  ..name..  ', '.pdf')).toBe('name.pdf');
  });

  it('falls back to a default when nothing usable remains', () => {
    expect(sanitizeFilename('...', '.pdf')).toBe('document.pdf');
    expect(sanitizeFilename('', '.pdf')).toBe('document.pdf');
    expect(sanitizeFilename('///', '.pdf')).toBe('document.pdf');
  });

  it('escapes Windows reserved device names', () => {
    expect(sanitizeFilename('CON', '.pdf')).toBe('CON_file.pdf');
    expect(sanitizeFilename('nul', '.pdf')).toBe('nul_file.pdf');
    expect(sanitizeFilename('COM1', '.pdf')).toBe('COM1_file.pdf');
  });

  it('escapes a reserved device name that carries a suffix', () => {
    // Windows matches the device name against the part before the first dot,
    // so "CON.log" is reserved just as "CON" is.
    expect(sanitizeFilename('CON.log', '.pdf')).toBe('CON_file.log.pdf');
    expect(sanitizeFilename('nul.txt', '.pdf')).toBe('nul_file.txt.pdf');
    expect(sanitizeFilename('PRN.data', '.pdf')).toBe('PRN_file.data.pdf');
  });

  it('leaves a name that merely starts with reserved letters alone', () => {
    expect(sanitizeFilename('CONTRACT', '.pdf')).toBe('CONTRACT.pdf');
    expect(sanitizeFilename('AUXILIARY', '.pdf')).toBe('AUXILIARY.pdf');
  });

  it('truncates long names while keeping the extension', () => {
    const result = sanitizeFilename('x'.repeat(500), '.docx');
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('.docx')).toBe(true);
  });

  it('never throws, whatever it is given', () => {
    for (const input of ['', '.', '..', '  ', '\u0000', 'a'.repeat(10_000)]) {
      expect(() => sanitizeFilename(input, '.pdf')).not.toThrow();
    }
  });
});

describe('buildFilename', () => {
  const record = { STAFF_ID: 'EMP-0007', NAME: 'Aisha Rahman' };

  it('names files by position when no template is given', () => {
    // The default must disclose nothing in a directory listing.
    expect(buildFilename(record, { extension: '.pdf', index: 1, total: 3 })).toBe(
      'document-0001.pdf',
    );
  });

  it('pads the sequence to at least four digits', () => {
    expect(buildFilename(record, { extension: '.pdf', index: 42, total: 100 })).toBe(
      'document-0042.pdf',
    );
  });

  it('widens padding for very large batches', () => {
    expect(buildFilename(record, { extension: '.pdf', index: 7, total: 100_000 })).toBe(
      'document-000007.pdf',
    );
  });

  it('substitutes fields from the record', () => {
    expect(
      buildFilename(record, { template: '{{STAFF_ID}}-offer', extension: '.docx', index: 1, total: 1 }),
    ).toBe('EMP-0007-offer.docx');
  });

  it('resolves {{ROW}} to the record position', () => {
    expect(buildFilename(record, { template: 'doc-{{ROW}}', extension: '.pdf', index: 5, total: 10 })).toBe(
      'doc-0005.pdf',
    );
  });

  it('matches fields case-insensitively', () => {
    expect(
      buildFilename({ 'Staff Id': 'EMP-1' }, { template: '{{STAFF_ID}}', extension: '.pdf', index: 1, total: 1 }),
    ).toBe('EMP-1.pdf');
  });

  it('falls back to the row number for an unresolved field', () => {
    // Otherwise every affected record collapses onto the same filename.
    expect(
      buildFilename(record, { template: '{{UNKNOWN}}', extension: '.pdf', index: 3, total: 9 }),
    ).toBe('0003.pdf');
  });

  it('sanitises a value that contains path separators', () => {
    expect(
      buildFilename(
        { NAME: '../../escape' },
        { template: '{{NAME}}', extension: '.pdf', index: 1, total: 1 },
      ),
    ).toBe('escape.pdf');
  });
});

describe('checkFilenameTemplate', () => {
  it('warns when an identifier would appear in the filename', () => {
    const warnings = checkFilenameTemplate('{{NRIC}}-offer');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.field).toBe('NRIC');
    expect(warnings[0]?.kind).toBe('sensitive-field-in-filename');
  });

  it.each(['{{SALARY}}', '{{Date of Birth}}', '{{Passport Number}}', '{{Bank Account}}', '{{Mobile}}'])(
    'warns about %s',
    (template) => {
      expect(checkFilenameTemplate(template)).toHaveLength(1);
    },
  );

  it('stays quiet for a non-identifying field', () => {
    expect(checkFilenameTemplate('{{DEPARTMENT}}-{{ROW}}')).toHaveLength(0);
  });

  it('reports each field once', () => {
    expect(checkFilenameTemplate('{{NRIC}}-{{NRIC}}')).toHaveLength(1);
  });

  it('does not put the value in the warning, only the field name', () => {
    const [warning] = checkFilenameTemplate('{{NRIC}}');
    expect(warning?.message).toContain('NRIC');
    expect(warning?.message).toMatch(/visible without opening/i);
  });
});

describe('dedupeFilename', () => {
  it('returns the name unchanged when it is free', () => {
    expect(dedupeFilename('a.pdf', new Set())).toBe('a.pdf');
  });

  it('disambiguates a collision rather than overwriting', () => {
    // Two people can share a name; neither document may be lost.
    const taken = new Set<string>();
    expect(dedupeFilename('Aisha Rahman.pdf', taken)).toBe('Aisha Rahman.pdf');
    expect(dedupeFilename('Aisha Rahman.pdf', taken)).toBe('Aisha Rahman (2).pdf');
    expect(dedupeFilename('Aisha Rahman.pdf', taken)).toBe('Aisha Rahman (3).pdf');
  });

  it('treats names differing only by case as colliding', () => {
    // Windows and macOS filesystems are case-insensitive by default.
    const taken = new Set<string>();
    dedupeFilename('Report.pdf', taken);
    expect(dedupeFilename('report.pdf', taken)).toBe('report (2).pdf');
  });

  it('keeps the extension when disambiguating', () => {
    const taken = new Set<string>();
    dedupeFilename('a.docx', taken);
    expect(dedupeFilename('a.docx', taken)).toBe('a (2).docx');
  });

  it('handles a name with no extension', () => {
    const taken = new Set<string>();
    dedupeFilename('a', taken);
    expect(dedupeFilename('a', taken)).toBe('a (2)');
  });
});
