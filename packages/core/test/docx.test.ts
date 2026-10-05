import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
  fillDocx,
  fillPreparedDocx,
  prepareDocx,
  readDocxFields,
  readDocxText,
  readLinkedContent,
} from '../src/docx/fill.js';
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

    describe('beyond the core properties', () => {
      const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
      const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      const commented = () =>
        buildDocx(
          para(
            '<w:commentRangeStart w:id="0"/>',
            '<w:ins w:id="1" w:author="Template Author" w:date="2026-01-01T00:00:00Z">',
            run('Dear {{NAME}}'),
            '</w:ins>',
            '<w:commentRangeEnd w:id="0"/>',
            '<w:r><w:commentReference w:id="0"/></w:r>',
          ),
          {
            extraParts: {
              'word/comments.xml': `<w:comments ${W}><w:comment w:id="0" w:author="Template Author" w:initials="TA"><w:p><w:r><w:t>Is this salary band right?</w:t></w:r></w:p></w:comment></w:comments>`,
              'word/people.xml': '<w15:people><w15:person w15:author="Template Author"><w15:presenceInfo w15:userId="author@example.com"/></w15:person></w15:people>',
              'docProps/custom.xml': '<Properties><property name="Owner"><vt:lpwstr>Template Author</vt:lpwstr></property></Properties>',
              'word/settings.xml': `<w:settings ${W}><w:attachedTemplate r:id="rId1"/><w:zoom w:percent="100"/></w:settings>`,
              'word/_rels/settings.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="file:///C:/Users/tauthor/Templates/HR.dotm" TargetMode="External"/></Relationships>`,
              'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId5" Type="${REL}/comments" Target="comments.xml"/><Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/><Relationship Id="rId7" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
              '[Content_Types].xml': '<Types><Override PartName="/word/document.xml" ContentType="main"/><Override PartName="/word/comments.xml" ContentType="comments"/><Override PartName="/docProps/custom.xml" ContentType="custom"/></Types>',
            },
          },
        );

      it('drops review comments, their authors and the people list', () => {
        const entries = unzipSync(fillDocx(commented(), echo).bytes);
        for (const part of ['word/comments.xml', 'word/people.xml', 'docProps/custom.xml']) {
          expect(entries[part]).toBeUndefined();
        }
        const everything = Object.values(entries).map((bytes) => strFromU8(bytes)).join('\n');
        expect(everything).not.toContain('Template Author');
        expect(everything).not.toContain('salary band');
        expect(everything).not.toContain('author@example.com');
      });

      it('keeps the package consistent once those parts are gone', () => {
        const entries = unzipSync(fillDocx(commented(), echo).bytes);
        const body = strFromU8(entries['word/document.xml']!);
        const rels = strFromU8(entries['word/_rels/document.xml.rels']!);
        const types = strFromU8(entries['[Content_Types].xml']!);
        // Nothing may still point at a part that is no longer there.
        expect(body).not.toMatch(/commentRangeStart|commentRangeEnd|commentReference/);
        expect(rels).not.toContain('comments.xml');
        expect(rels).not.toContain('people.xml');
        expect(rels).toContain('styles.xml');
        expect(types).not.toContain('/word/comments.xml');
        expect(types).not.toContain('/docProps/custom.xml');
        expect(types).toContain('/word/document.xml');
        expect(textOf(fillDocx(commented(), echo).bytes)).toBe('Dear <NAME>');
      });

      it('leaves no names or times from tracked changes', () => {
        // The changes themselves are accepted, so their wrappers go too.
        const body = strFromU8(unzipSync(fillDocx(commented(), echo).bytes)['word/document.xml']!);
        expect(body).not.toContain('<w:ins');
        expect(body).not.toContain('Template Author');
        expect(body).not.toContain('2026-01-01');
      });

      it("drops the path to the template on the author's machine", () => {
        const entries = unzipSync(fillDocx(commented(), echo).bytes);
        expect(strFromU8(entries['word/settings.xml']!)).not.toContain('attachedTemplate');
        expect(strFromU8(entries['word/settings.xml']!)).toContain('w:zoom');
        expect(strFromU8(entries['word/_rels/settings.xml.rels']!)).not.toContain('tauthor');
      });

      it('keeps all of it when scrubbing is turned off', () => {
        const entries = unzipSync(fillDocx(commented(), echo, { scrubMetadata: false }).bytes);
        expect(strFromU8(entries['word/comments.xml']!)).toContain('Template Author');
        expect(strFromU8(entries['word/document.xml']!)).toContain('commentReference');
      });
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

/**
 * Reading a document's visible text.
 *
 * A label/value layout is nothing but tabs, and dropping them made
 * `Position\tData Analyst` read back as `PositionData Analyst` — which looks
 * exactly like lost text when nothing has been lost.
 */
describe('readDocxText', () => {
  it('keeps the tabs that separate a label from its value', () => {
    const docx = buildDocx(para('<w:r><w:t>Position</w:t><w:tab/><w:t>Data Analyst</w:t></w:r>'));
    expect(readDocxText(docx)).toBe('Position\tData Analyst');
  });

  it('keeps a line break as a line break', () => {
    const docx = buildDocx(para('<w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r>'));
    expect(readDocxText(docx)).toBe('Line one\nLine two');
  });

  it('reads a filled document the same way it reads the template', () => {
    // The two are compared against each other constantly; a tab surviving in
    // one and not the other reports every document as wrong.
    const template = buildDocx(para('<w:r><w:t>Position</w:t><w:tab/><w:t>{{JOB_TITLE}}</w:t></w:r>'));
    const filled = fillDocx(template, () => 'Data Analyst').bytes;
    expect(readDocxText(filled)).toBe(readDocxText(template).replace('{{JOB_TITLE}}', 'Data Analyst'));
  });
});

describe('what the author could not see', () => {
  const tracked = () =>
    buildDocx(
      para(
        run('Basic salary: '),
        '<w:del w:id="1" w:author="Template Author" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>band 6,000 to 7,500, offer </w:delText></w:r></w:del>',
        '<w:ins w:id="2" w:author="Template Author"><w:r><w:t>{{SALARY}}</w:t></w:r></w:ins>',
        '<w:r><w:rPr><w:vanish/></w:rPr><w:t>Note to self: negotiable to {{MAX_SALARY}}</w:t></w:r>',
        '<w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t> per month.</w:t></w:r>',
      ) +
        para(
          '<w:r><w:rPr><w:b/><w:rPrChange w:id="3" w:author="Template Author"><w:rPr/></w:rPrChange></w:rPr><w:t>Welcome.</w:t></w:r>',
          '<w:moveFrom w:id="4" w:author="Template Author"><w:r><w:t>Old position.</w:t></w:r></w:moveFrom>',
        ),
    );

  it('accepts tracked changes, so deleted words do not travel', () => {
    const entries = unzipSync(fillDocx(tracked(), () => '5,000').bytes);
    const body = strFromU8(entries['word/document.xml']!);
    expect(body).not.toContain('6,000');
    expect(body).not.toContain('Old position');
    expect(body).not.toMatch(/<w:(del|ins|moveFrom|rPrChange)\b/);
    expect(textOf(fillDocx(tracked(), () => '5,000').bytes)).toBe('Basic salary: 5,000 per month.\nWelcome.');
  });

  it('removes hidden text, and does not ask for its placeholders', () => {
    expect(readDocxFields(tracked())).toEqual(['SALARY']);
    const body = strFromU8(unzipSync(fillDocx(tracked(), () => '5,000').bytes)['word/document.xml']!);
    expect(body).not.toContain('negotiable');
  });

  it('does it even with metadata scrubbing off, because it is content', () => {
    const body = strFromU8(unzipSync(fillDocx(tracked(), () => '5,000', { scrubMetadata: false }).bytes)['word/document.xml']!);
    expect(body).not.toContain('6,000');
    expect(body).not.toContain('negotiable');
  });

  it('leaves a run alone when it holds another run, rather than cut it wrongly', () => {
    // A text box inside a run: the inner run's closing tag comes first.
    const nested = buildDocx(
      para(
        '<w:r><w:rPr><w:vanish/></w:rPr><w:drawing><w:txbxContent><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>',
        run('Dear {{NAME}}'),
      ),
    );
    const body = strFromU8(unzipSync(fillDocx(nested, echo).bytes)['word/document.xml']!);
    expect(body).toContain('<w:txbxContent><w:p><w:r><w:t xml:space="preserve">Inner</w:t></w:r></w:p></w:txbxContent>');
    expect(body.match(/<w:r>/g)?.length).toBe(body.match(/<\/w:r>/g)?.length);
  });
});

describe('readLinkedContent', () => {
  const withRels = (rels: string) =>
    buildDocx(para(run('{{NAME}}')), { extraParts: { 'word/_rels/document.xml.rels': `<Relationships>${rels}</Relationships>` } });
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  it('reports a picture loaded from outside the document', () => {
    const docx = withRels(`<Relationship Id="rId9" Type="${REL}/image" Target="https://tracker.example.com/p.png" TargetMode="External"/>`);
    expect(readLinkedContent(docx)).toEqual(['a picture linked rather than embedded']);
  });

  it('reports objects and content linked to outside files', () => {
    const docx = withRels(
      `<Relationship Id="rId1" Type="${REL}/oleObject" Target="file:///\\\\server\\share\\x.xlsx" TargetMode="External"/>` +
        `<Relationship Id="rId2" Type="${REL}/subDocument" Target="part.docx" TargetMode="External"/>`,
    );
    expect(readLinkedContent(docx)).toEqual(['an object linked to an outside file', 'content pulled in from an outside file']);
  });

  it('ignores clickable links and embedded pictures', () => {
    const docx = withRels(
      `<Relationship Id="rId1" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/>` +
        `<Relationship Id="rId2" Type="${REL}/image" Target="media/logo.png"/>`,
    );
    expect(readLinkedContent(docx)).toEqual([]);
  });
});

