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

/** One element found by {@link scanElements}. */
export interface XmlElement {
  /** Offset of the opening `<`. */
  readonly start: number;
  /** Offset just past the element's final `>`. */
  readonly end: number;
  /** Attribute text of the opening tag, without the tag name or `/>`. */
  readonly attrs: string;
  /** Text between the tags; undefined for a self-closing element. */
  readonly body: string | undefined;
}

/**
 * Find each `<tag …>…</tag>` and `<tag …/>` in document order.
 *
 * This replaces regular expressions of the form `<tag[^>]*>([\s\S]*?)</tag>`,
 * which take quadratic time on a part with many unclosed elements: each
 * opener scans to the end of the input looking for a closer that is not
 * there, then the next opener does the same. A hostile spreadsheet of a few
 * megabytes could stall the page that way. Here a missing closer is noticed
 * once, after which only self-closing elements can still match.
 *
 * Like the expressions it replaces, it does not handle an element nested
 * inside another of the same name, which none of the elements it is used for
 * allow.
 */
export function* scanElements(xml: string, tag: string): Generator<XmlElement> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let cursor = 0;
  let closersRemain = true;

  for (;;) {
    const start = xml.indexOf(open, cursor);
    if (start < 0) return;
    const next = xml[start + open.length];
    // `<c` must not match `<cols`: the name has to end here.
    if (next !== undefined && !/[\s/>]/.test(next)) {
      cursor = start + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) return;

    if (xml[tagEnd - 1] === '/') {
      yield { start, end: tagEnd + 1, attrs: xml.slice(start + open.length, tagEnd - 1), body: undefined };
      cursor = tagEnd + 1;
      continue;
    }

    const closeAt = closersRemain ? xml.indexOf(close, tagEnd + 1) : -1;
    if (closeAt < 0) {
      closersRemain = false;
      cursor = tagEnd + 1;
      continue;
    }
    yield {
      start,
      end: closeAt + close.length,
      attrs: xml.slice(start + open.length, tagEnd),
      body: xml.slice(tagEnd + 1, closeAt),
    };
    cursor = closeAt + close.length;
  }
}

/**
 * Rewrite every `tag` element through `replace`, in one linear pass.
 *
 * Returning `undefined` keeps the element unchanged.
 */
export function replaceElements(
  xml: string,
  tag: string,
  replace: (element: XmlElement) => string | undefined,
): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const element of scanElements(xml, tag)) {
    const replacement = replace(element);
    if (replacement === undefined) continue;
    pieces.push(xml.slice(cursor, element.start), replacement);
    cursor = element.end;
  }
  if (cursor === 0) return xml;
  pieces.push(xml.slice(cursor));
  return pieces.join('');
}
