import { describe, expect, it } from 'vitest';
import { replacePlaceholdersInXml, extractTextFromXml } from '../src/docx/wordxml.js';
import { para, run, splitRuns } from './helpers/fixtures.js';

const upper = (key: string): string => `<${key}>`;

/** Resolver that echoes the key back in angle brackets, for easy assertions. */
const echo = (key: string): string => upper(key);

describe('replacePlaceholdersInXml', () => {
  it('replaces a placeholder contained in a single run', () => {
    const xml = para(run('Dear {{NAME}},'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(1);
    expect(extractTextFromXml(result.xml)).toBe('Dear <NAME>,');
  });

  it('replaces a placeholder split across runs by Word', () => {
    // The case that defeats naive string replacement over document.xml.
    const xml = para(run('Dear '), run('{{NA'), run('ME}}'), run(','));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(1);
    expect(extractTextFromXml(result.xml)).toBe('Dear <NAME>,');
  });

  it('replaces a placeholder split one character per run', () => {
    const xml = para(splitRuns('Pay: {{SALARY}} monthly', 24));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(1);
    expect(extractTextFromXml(result.xml)).toBe('Pay: <SALARY> monthly');
  });

  it('replaces multiple placeholders in one paragraph', () => {
    const xml = para(run('{{TITLE}} {{NAME}} of {{ADDRESS}}'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(3);
    expect(extractTextFromXml(result.xml)).toBe('<TITLE> <NAME> of <ADDRESS>');
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    const xml = para(run('{{NAME}} and {{NAME}} again'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(2);
    expect(extractTextFromXml(result.xml)).toBe('<NAME> and <NAME> again');
  });

  it('does not let a placeholder span a paragraph boundary', () => {
    // A stray `{{` in one paragraph must not pair with a `}}` in a later one
    // and swallow everything between them.
    const xml = para(run('Opening {{ brace')) + para(run('closing }} brace'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(0);
    expect(extractTextFromXml(result.xml)).toBe('Opening {{ brace\nclosing }} brace');
  });

  it('tolerates whitespace inside the braces', () => {
    const xml = para(run('{{ NAME }}'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(extractTextFromXml(result.xml)).toBe('<NAME>');
  });

  it('leaves non-placeholder braces untouched', () => {
    const xml = para(run('See {{note 1}} and {} and {{}}'));
    const result = replacePlaceholdersInXml(xml, (key) => upper(key));
    // "note 1" is a legal field name; "{}" and "{{}}" are not placeholders.
    expect(extractTextFromXml(result.xml)).toBe('See <note 1> and {} and {{}}');
  });

  it('preserves surrounding formatting runs', () => {
    const xml = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{NAME}}</w:t></w:r></w:p>`;
    const result = replacePlaceholdersInXml(xml, echo);
    // The bold run properties must survive the substitution.
    expect(result.xml).toContain('<w:b/>');
  });

  it('sets xml:space="preserve" so leading spaces are not stripped', () => {
    const xml = para(run('{{NAME}}'));
    const result = replacePlaceholdersInXml(xml, () => '  padded  ');
    expect(result.xml).toContain('xml:space="preserve"');
    expect(extractTextFromXml(result.xml)).toBe('  padded  ');
  });

  it('does not duplicate an existing xml:space attribute', () => {
    const xml = `<w:p><w:r><w:t xml:space="preserve">{{NAME}}</w:t></w:r></w:p>`;
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.xml.match(/xml:space/g)).toHaveLength(1);
  });

  it('handles a self-closing empty text node in the middle of a match', () => {
    const xml = `<w:p><w:r><w:t>{{NA</w:t></w:r><w:r><w:t/></w:r><w:r><w:t>ME}}</w:t></w:r></w:p>`;
    const result = replacePlaceholdersInXml(xml, echo);
    expect(extractTextFromXml(result.xml)).toBe('<NAME>');
  });

  describe('injection safety', () => {
    it('escapes XML metacharacters in substituted values', () => {
      const xml = para(run('{{NAME}}'));
      const result = replacePlaceholdersInXml(xml, () => 'Tan & Lim <Pte> "Ltd"');
      expect(result.xml).toContain('Tan &amp; Lim &lt;Pte&gt; &quot;Ltd&quot;');
      expect(extractTextFromXml(result.xml)).toBe('Tan & Lim <Pte> "Ltd"');
    });

    it('treats markup in a value as literal text, not structure', () => {
      // A hostile spreadsheet cell must not be able to close our element and
      // inject its own Word markup.
      const xml = para(run('{{NAME}}'));
      const payload = '</w:t></w:r><w:r><w:t>INJECTED';
      const result = replacePlaceholdersInXml(xml, () => payload);
      expect(extractTextFromXml(result.xml)).toBe(payload);
      // Exactly one run survives: the payload did not create a second one.
      expect(result.xml.match(/<w:r>/g)).toHaveLength(1);
    });

    it('decodes entity-encoded text before matching', () => {
      const xml = para(run('{{NAME}} &amp; co'));
      const result = replacePlaceholdersInXml(xml, echo);
      expect(extractTextFromXml(result.xml)).toBe('<NAME> & co');
    });
  });

  describe('multi-line values', () => {
    it('converts newlines into Word line breaks', () => {
      const xml = para(run('{{ADDRESS}}'));
      const result = replacePlaceholdersInXml(xml, () => '12 Example Road\n#04-05\nSingapore 123456');
      expect(result.xml).toContain('<w:br/>');
      expect(result.xml.match(/<w:br\/>/g)).toHaveLength(2);
    });

    it('normalises CRLF to a single break', () => {
      const xml = para(run('{{ADDRESS}}'));
      const result = replacePlaceholdersInXml(xml, () => 'line one\r\nline two');
      expect(result.xml.match(/<w:br\/>/g)).toHaveLength(1);
    });

    it('converts tabs into Word tab elements', () => {
      const xml = para(run('{{ROW}}'));
      const result = replacePlaceholdersInXml(xml, () => 'a\tb');
      expect(result.xml).toContain('<w:tab/>');
    });
  });

  it('propagates a resolver error unchanged', () => {
    const xml = para(run('{{MISSING}}'));
    expect(() =>
      replacePlaceholdersInXml(xml, () => {
        throw new Error('no value');
      }),
    ).toThrow('no value');
  });

  it('returns the input untouched when there are no placeholders', () => {
    const xml = para(run('Nothing to substitute here.'));
    const result = replacePlaceholdersInXml(xml, echo);
    expect(result.replaced).toBe(0);
    expect(result.xml).toBe(xml);
  });
});
