/** Minimal XML text-node escaping and unescaping for WordprocessingML. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode an XML text node into plain text.
 *
 * Placeholder matching runs on decoded text so that a template containing
 * `{{A&amp;B}}` or surrounding entity-encoded punctuation still lines up with
 * the field names the user actually typed.
 */
export function decodeXmlText(xml: string): string {
  return xml.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, entity) ? (NAMED_ENTITIES[entity] as string) : whole;
  });
}

/**
 * The character a numeric reference names, if XML allows it in a document.
 *
 * Surrogate halves, U+FFFE/U+FFFF and most control characters are not legal
 * XML characters. Decoding one from a spreadsheet cell and writing it into a
 * .docx would produce a file Word refuses to open, so the reference is left as
 * the literal text it was.
 */
function safeFromCodePoint(code: number, fallback: string): string {
  if (code < 0 || code > 0x10ffff) return fallback;
  if (code >= 0xd800 && code <= 0xdfff) return fallback;
  if (code === 0xfffe || code === 0xffff) return fallback;
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Encode plain text for insertion into an XML text node.
 *
 * This is the boundary that stops a spreadsheet cell from injecting markup.
 * A value such as `</w:t><w:br/><w:t>` is data, not structure, and must land
 * in the document as those literal characters.
 */
export function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
