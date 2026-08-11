import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { fillDocx, fillPreparedDocx, prepareDocx, readDocxFields, readDocxText } from '../src/docx/fill.js';
import { DoclystError } from '../src/errors.js';
import { FIXED_ARCHIVE_TIMESTAMP } from '../src/internal/deterministic.js';
import { buildDocx, headerXml, para, run, splitRuns } from './helpers/fixtures.js';

const echo = (key: string): string => `<${key}>`;

function textOf(bytes: Uint8Array): string {
  return readDocxText(bytes);
}

describe('readDocxFields', () => {
  it('lists the placeholders in the body', () => {
    const docx = buildDocx(para(run('{{NAME}} earns {{SALARY}}')));
    expect(readDocxFields(docx)).toEqual(['NAME', 'SALARY']);
  });

  it('finds placeholders split across runs', () => {
    const docx = buildDocx(para(splitRuns('{{STAFF_ID}}', 6)));
    expect(readDocxFields(docx)).toEqual(['STAFF_ID']);
  });

  it('includes placeholders that only appear in a header', () => {
    // Letterhead fields such as {{DATE}} live here, and a template validator
    // that ignored headers would report them as absent.
    const docx = buildDocx(para(run('{{NAME}}')), {
      extraParts: { 'word/header1.xml': headerXml(para(run('Ref: {{REF_NO}}'))) },
    });
    expect(readDocxFields(docx).sort()).toEqual(['NAME', 'REF_NO']);
  });

  it('reports each field once regardless of repetition', () => {
    const docx = buildDocx(para(run('{{NAME}}')) + para(run('{{NAME}} again')));
    expect(readDocxFields(docx)).toEqual(['NAME']);
  });
});

describe('fillDocx', () => {
  it('substitutes values into the body', () => {
    const docx = buildDocx(para(run('Dear {{NAME}},')));
    const result = fillDocx(docx, echo);
    expect(result.replaced).toBe(1);
    expect(textOf(result.bytes)).toBe('Dear <NAME>,');
  });

  it('substitutes into headers and footers as well as the body', () => {
    const docx = buildDocx(para(run('{{NAME}}')), {
      extraParts: {
        'word/header1.xml': headerXml(para(run('{{REF_NO}}'))),
        'word/footer1.xml': headerXml(para(run('{{PAGE_NOTE}}'))),
      },
    });
    const result = fillDocx(docx, echo);
    expect(result.replaced).toBe(3);

    const entries = unzipSync(result.bytes);
    expect(strFromU8(entries['word/header1.xml']!)).toContain('&lt;REF_NO&gt;');
    expect(strFromU8(entries['word/footer1.xml']!)).toContain('&lt;PAGE_NOTE&gt;');
  });

  it('produces a file that is still a readable DOCX', () => {
    const docx = buildDocx(para(run('{{NAME}}')));
    const result = fillDocx(docx, echo);
    const entries = unzipSync(result.bytes);
    expect(Object.keys(entries)).toContain('[Content_Types].xml');
    expect(Object.keys(entries)).toContain('word/document.xml');
  });

  it('copies non-text parts through byte for byte', () => {
    // Styles, images and relationships must survive untouched.
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const docx = zipSync(
      {
        ...unzipSync(buildDocx(para(run('{{NAME}}')))),
        'word/media/image1.png': image,
      },
      { mtime: FIXED_ARCHIVE_TIMESTAMP },
    );
    const result = fillDocx(docx, echo);
    expect(unzipSync(result.bytes)['word/media/image1.png']).toEqual(image);
  });

  it('is deterministic for the same inputs', () => {
    // Equal bytes on re-run means no timestamp records when a record was
    // processed, and reproducible output for auditing.
    const docx = buildDocx(para(run('{{NAME}}')));
    expect(fillDocx(docx, echo).bytes).toEqual(fillDocx(docx, echo).bytes);
  });

  it('propagates a missing-value error from the resolver', () => {
    const docx = buildDocx(para(run('{{NAME}}')));
    expect(() =>
      fillDocx(docx, () => {
        throw new DoclystError('MISSING_VALUE', 'No value for placeholder "NAME".');
      }),
    ).toThrow(/No value for placeholder/);
  });

  describe('metadata scrubbing', () => {
    it('removes template authorship by default', () => {
      const docx = buildDocx(para(run('{{NAME}}')));
      const entries = unzipSync(fillDocx(docx, echo).bytes);
      const core = strFromU8(entries['docProps/core.xml']!);
      const app = strFromU8(entries['docProps/app.xml']!);

      expect(core).not.toContain('Template Author');
      expect(core).not.toContain('Someone Else');
      expect(app).not.toContain('Example Pte Ltd');
      expect(app).not.toContain('A Manager');
    });

    it('keeps the metadata elements themselves, so Word still opens the file', () => {
      const docx = buildDocx(para(run('{{NAME}}')));
      const entries = unzipSync(fillDocx(docx, echo).bytes);
      const core = strFromU8(entries['docProps/core.xml']!);
      expect(core).toContain('<dc:creator></dc:creator>');
    });

    it('leaves non-identifying metadata alone', () => {
      const docx = buildDocx(para(run('{{NAME}}')));
      const entries = unzipSync(fillDocx(docx, echo).bytes);
      expect(strFromU8(entries['docProps/core.xml']!)).toContain('Offer Letter Template');
    });

    it('can be turned off', () => {
      const docx = buildDocx(para(run('{{NAME}}')));
      const entries = unzipSync(fillDocx(docx, echo, { scrubMetadata: false }).bytes);
      expect(strFromU8(entries['docProps/core.xml']!)).toContain('Template Author');
    });
  });

  describe('malformed input', () => {
    it('rejects a file that is not a ZIP', () => {
      expect(() => fillDocx(new Uint8Array([1, 2, 3, 4]), echo)).toThrow(/not a valid DOCX/);
    });

    it('rejects an empty input', () => {
      expect(() => fillDocx(new Uint8Array(), echo)).toThrow(DoclystError);
    });

    it('rejects a ZIP that is not a Word document', () => {
      const notDocx = zipSync({ 'hello.txt': strToU8('hi') }, { mtime: FIXED_ARCHIVE_TIMESTAMP });
      expect(() => fillDocx(notDocx, echo)).toThrow(/word\/document\.xml is missing/);
    });

    it('rejects an archive entry whose name escapes the root', () => {
      // Defence in depth against a template crafted to write outside a
      // future extraction directory.
      const malicious = zipSync(
        {
          ...unzipSync(buildDocx(para(run('{{NAME}}')))),
          '../../evil.xml': strToU8('<evil/>'),
        },
        { mtime: FIXED_ARCHIVE_TIMESTAMP },
      );
      expect(() => fillDocx(malicious, echo)).toThrow(/unsafe path/i);
    });

    it('reports a corrupt archive without echoing its bytes', () => {
      // A parser error message can embed document fragments, which may be
      // personal data; only a summary is allowed out.
      const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(40).fill(0xff)]);
      try {
        fillDocx(corrupt, echo);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DoclystError);
        expect((error as DoclystError).message).toMatch(/details withheld|not a valid DOCX/);
      }
    });
  });
});

describe('prepared templates', () => {
  it('produces the same bytes as filling the raw template', () => {
    const docx = buildDocx(para(run('Dear {{NAME}},')));
    const direct = fillDocx(docx, echo);
    const viaPrepared = fillPreparedDocx(prepareDocx(docx), echo);
    expect(viaPrepared.bytes).toEqual(direct.bytes);
    expect(viaPrepared.replaced).toBe(direct.replaced);
  });

  it('does not leak one record"s values into the next', () => {
    // The whole point of preparing once is reuse, so the shared state must be
    // read-only. A leak here would put one person's salary in another's letter.
    const docx = buildDocx(para(run('{{NAME}} earns {{SALARY}}')));
    const prepared = prepareDocx(docx);

    const first = readDocxText(
      fillPreparedDocx(prepared, (key) => (key === 'NAME' ? 'Aisha Rahman' : '4500')).bytes,
    );
    const second = readDocxText(
      fillPreparedDocx(prepared, (key) => (key === 'NAME' ? 'Wei Lun Tan' : '5200')).bytes,
    );

    expect(first).toBe('Aisha Rahman earns 4500');
    expect(second).toBe('Wei Lun Tan earns 5200');
    expect(second).not.toContain('Aisha');
    expect(second).not.toContain('4500');
  });

  it('stays stable across many reuses', () => {
    const docx = buildDocx(para(run('{{NAME}}')));
    const prepared = prepareDocx(docx);
    const first = fillPreparedDocx(prepared, echo).bytes;
    for (let i = 0; i < 20; i += 1) {
      expect(fillPreparedDocx(prepared, echo).bytes).toEqual(first);
    }
  });

  it('validates the template once, up front', () => {
    expect(() => prepareDocx(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a valid DOCX/);
  });

  it('scrubs metadata during preparation', () => {
    const docx = buildDocx(para(run('{{NAME}}')));
    const entries = unzipSync(fillPreparedDocx(prepareDocx(docx), echo).bytes);
    expect(strFromU8(entries['docProps/core.xml']!)).not.toContain('Template Author');
  });

  it('round-trips an incompressible part untouched', () => {
    // Such parts are stored rather than deflated; the bytes must survive.
    const media = new Uint8Array(2048);
    for (let i = 0; i < media.length; i += 1) media[i] = (i * 2654435761) % 256;
    const docx = zipSync(
      { ...unzipSync(buildDocx(para(run('{{NAME}}')))), 'word/media/photo.jpeg': media },
      { mtime: FIXED_ARCHIVE_TIMESTAMP },
    );
    const out = unzipSync(fillPreparedDocx(prepareDocx(docx), echo).bytes);
    expect(out['word/media/photo.jpeg']).toEqual(media);
  });
});

describe('readDocxText', () => {
  it('joins paragraphs with newlines', () => {
    const docx = buildDocx(para(run('one')) + para(run('two')));
    expect(readDocxText(docx)).toBe('one\ntwo');
  });
});
