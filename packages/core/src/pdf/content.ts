import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFontEmbedder,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';

/**
 * Reading text, and where it sits, out of a PDF page.
 *
 * A PDF does not store text: it stores instructions to draw glyphs at
 * positions, against fonts that usually carry their own private encoding. To
 * find `{{NAME}}` on a page and know the box it occupies, those instructions
 * have to be replayed — which is what this does.
 *
 * It is deliberately not a general PDF text extractor. It understands the
 * operators a word processor emits when it writes a letter, and where it is
 * unsure it says so rather than guessing: a template prepared from a
 * misread page would put a form field in the wrong place, and nobody would
 * notice until the letters were out.
 */

/**
 * Bytes as a string, one character per byte.
 *
 * Content streams are byte soup: mostly ASCII operators, with binary inside
 * string operands. Treating each byte as a character keeps offsets exact, which
 * the rewrite depends on. `Buffer` would be the obvious tool and is not
 * available in a browser, where this code has to run unchanged.
 */
function bytesToLatin1(bytes: Uint8Array): string {
  // Chunked because spreading a multi-megabyte array overflows the call stack.
  const CHUNK = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return result;
}

/** One glyph, with the position and metrics needed to place a field over it. */
export interface Glyph {
  /** The character(s) this glyph stands for. Empty when it maps to nothing. */
  readonly text: string;
  /** Left edge of the glyph, in page space. */
  readonly x: number;
  /** Baseline, in page space. */
  readonly y: number;
  /** Horizontal advance, in page space. */
  readonly width: number;
  /** Font size after the text and transformation matrices, in page space. */
  readonly size: number;
  /** Index of the show-text operation this glyph came from. */
  readonly operation: number;
  /** Index of this glyph within that operation's own glyph sequence. */
  readonly indexInOperation: number;
  /** The glyph's advance in thousandths of an em, before spacing is added. */
  readonly widthMille: number;
  /** Character and word spacing in force, in unscaled text space. */
  readonly charSpacing: number;
  readonly wordSpacing: number;
  /** True when the code is a single-byte 32, which word spacing applies to. */
  readonly isSpaceCode: boolean;
  /** Resource name of the font in force, e.g. `F1`. */
  readonly font: string;
  /** Unscaled font size, as given to `Tf`. */
  readonly fontSize: number;
  /** Bytes the font uses per character code, needed to rewrite the stream. */
  readonly bytesPerCode: number;
}

/** A parsed content-stream operation. */
export interface Operation {
  readonly operator: string;
  readonly operands: readonly Token[];
  /** Byte offsets of this operation in the source, for rewriting. */
  readonly start: number;
  readonly end: number;
}

export type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly bytes: number[]; readonly literal: boolean }
  | { readonly kind: 'array'; readonly items: readonly Token[] }
  | { readonly kind: 'dict' }
  | { readonly kind: 'keyword'; readonly value: string };

/**
 * Split a content stream into operations.
 *
 * Byte offsets are kept because the caller rewrites the stream in place, and
 * regenerating it from the parse would discard everything this parser does not
 * model — which on a letterhead is most of the page.
 */
export function parseOperations(content: string): Operation[] {
  const operations: Operation[] = [];
  let operands: Token[] = [];
  let cursor = 0;
  let operandStart = -1;

  while (cursor < content.length) {
    const before = cursor;
    cursor = skipWhitespaceAndComments(content, cursor);
    if (cursor >= content.length) break;

    const token = readToken(content, cursor);
    if (token === undefined) {
      cursor = before + 1;
      continue;
    }

    if (operandStart < 0) operandStart = cursor;

    if (token.token.kind === 'keyword') {
      const operator = token.token.value;
      // An inline image's binary data is not tokenisable; skip to its end.
      if (operator === 'BI') {
        const end = content.indexOf('EI', token.next);
        cursor = end < 0 ? content.length : end + 2;
        operands = [];
        operandStart = -1;
        continue;
      }
      operations.push({ operator, operands, start: operandStart, end: token.next });
      operands = [];
      operandStart = -1;
    } else {
      operands.push(token.token);
    }
    cursor = token.next;
  }

  return operations;
}

function skipWhitespaceAndComments(content: string, start: number): number {
  let cursor = start;
  for (;;) {
    while (cursor < content.length && /[\s\0]/.test(content[cursor] as string)) cursor += 1;
    if (content[cursor] !== '%') return cursor;
    while (cursor < content.length && content[cursor] !== '\n' && content[cursor] !== '\r') {
      cursor += 1;
    }
  }
}

function readToken(content: string, start: number): { token: Token; next: number } | undefined {
  const char = content[start] as string;

  if (char === '(') return readLiteralString(content, start);
  if (char === '<') {
    if (content[start + 1] === '<') return readDictionary(content, start);
    return readHexString(content, start);
  }
  if (char === '/') {
    let cursor = start + 1;
    while (cursor < content.length && !/[\s\0()<>[\]{}/%]/.test(content[cursor] as string)) {
      cursor += 1;
    }
    return { token: { kind: 'name', value: content.slice(start + 1, cursor) }, next: cursor };
  }
  if (char === '[') {
    const items: Token[] = [];
    let cursor = start + 1;
    for (;;) {
      cursor = skipWhitespaceAndComments(content, cursor);
      if (cursor >= content.length || content[cursor] === ']') {
        return { token: { kind: 'array', items }, next: cursor + 1 };
      }
      const inner = readToken(content, cursor);
      if (inner === undefined) return { token: { kind: 'array', items }, next: cursor + 1 };
      items.push(inner.token);
      cursor = inner.next;
    }
  }
  if (/[+\-.\d]/.test(char)) {
    let cursor = start;
    while (cursor < content.length && /[+\-.\d]/.test(content[cursor] as string)) cursor += 1;
    const value = Number.parseFloat(content.slice(start, cursor));
    if (Number.isFinite(value)) return { token: { kind: 'number', value }, next: cursor };
    return undefined;
  }

  let cursor = start;
  while (cursor < content.length && !/[\s\0()<>[\]{}/%]/.test(content[cursor] as string)) {
    cursor += 1;
  }
  if (cursor === start) return undefined;
  return { token: { kind: 'keyword', value: content.slice(start, cursor) }, next: cursor };
}

function readLiteralString(content: string, start: number): { token: Token; next: number } {
  const bytes: number[] = [];
  let depth = 0;
  let cursor = start;

  for (; cursor < content.length; cursor += 1) {
    const char = content[cursor] as string;
    if (char === '\\') {
      const escaped = content[cursor + 1] as string | undefined;
      cursor += 1;
      if (escaped === undefined) break;
      const simple: Record<string, number> = {
        n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92,
      };
      if (escaped in simple) {
        bytes.push(simple[escaped] as number);
      } else if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && /[0-7]/.test(content[cursor + 1] ?? '')) {
          cursor += 1;
          octal += content[cursor];
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff);
      } else if (escaped === '\n') {
        // A backslash before a newline continues the line.
      } else {
        bytes.push(escaped.charCodeAt(0) & 0xff);
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { token: { kind: 'string', bytes, literal: true }, next: cursor + 1 };
    }
    if (depth >= 1) bytes.push(char.charCodeAt(0) & 0xff);
  }

  return { token: { kind: 'string', bytes, literal: true }, next: cursor };
}

function readHexString(content: string, start: number): { token: Token; next: number } {
  const end = content.indexOf('>', start);
  const body = content.slice(start + 1, end < 0 ? content.length : end).replace(/[^0-9A-Fa-f]/g, '');
  const padded = body.length % 2 === 1 ? `${body}0` : body;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  }
  return {
    token: { kind: 'string', bytes, literal: false },
    next: end < 0 ? content.length : end + 1,
  };
}

function readDictionary(content: string, start: number): { token: Token; next: number } {
  // Dictionaries only appear as operands to operators this does not model, so
  // they are skipped rather than parsed.
  let depth = 0;
  let cursor = start;
  while (cursor < content.length) {
    if (content.startsWith('<<', cursor)) {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (content.startsWith('>>', cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return { token: { kind: 'dict' }, next: cursor };
      continue;
    }
    cursor += 1;
  }
  return { token: { kind: 'dict' }, next: cursor };
}

// --- fonts -------------------------------------------------------------

/** What replaying the text operators needs to know about one font. */
export interface FontInfo {
  /** Bytes per character code. Composite fonts are addressed two at a time. */
  readonly bytesPerCode: number;
  /** The text a code stands for, or an empty string when nothing is known. */
  decode(code: number): string;
  /** Advance width in thousandths of an em. */
  widthOf(code: number): number;
  /**
   * Whether the font states metrics across printable ASCII.
   *
   * An embedded font is usually subset to the glyphs the document already
   * uses, so reusing it for a value that contains other letters would render
   * those as nothing. This is the check that decides whether reuse is safe.
   */
  coversBasicLatin(): boolean;
  /**
   * The character codes that draw `text` in this font, or undefined when any
   * character has none. Undefined means the value must not be drawn with this
   * font — a document with holes where a name should be is worse than one in
   * the wrong typeface.
   */
  encode(text: string): number[] | undefined;
}

/** Read the fonts a page's resources make available, keyed by resource name. */
export function readPageFonts(page: PDFPage): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>();
  const resources = page.node.Resources();
  const fontDict = resources?.lookup(PDFName.of('Font'));
  if (!(fontDict instanceof PDFDict)) return fonts;

  for (const [key] of fontDict.entries()) {
    const font = fontDict.lookup(key);
    if (!(font instanceof PDFDict)) continue;
    fonts.set(key.asString().replace(/^\//, ''), readFontFromDict(font));
  }
  return fonts;
}

export function readFontFromDict(font: PDFDict): FontInfo {
  const subtypeEntry = font.lookup(PDFName.of('Subtype'));
  const subtype = subtypeEntry instanceof PDFName ? subtypeEntry.asString() : undefined;
  const toUnicode = readToUnicode(font);

  if (subtype === '/Type0') {
    const descendants = font.lookup(PDFName.of('DescendantFonts'));
    const first =
      descendants instanceof PDFArray && descendants.size() > 0
        ? descendants.lookup(0)
        : undefined;
    const descendant = first instanceof PDFDict ? first : undefined;
    const widths = readCidWidths(descendant);
    const defaultWidth =
      descendant?.lookupMaybe(PDFName.of('DW'), PDFNumber)?.asNumber() ?? 1000;

    const decodeCid = (code: number): string => toUnicode?.get(code) ?? '';
    const reverse = invert(toUnicode);
    return {
      bytesPerCode: 2,
      decode: decodeCid,
      widthOf: (code) => widths.get(code) ?? defaultWidth,
      coversBasicLatin: () => [...BASIC_LATIN].every((character) => reverse.has(character)),
      encode: (text) => encodeWith(reverse, text),
    };
  }

  const firstChar = font.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber() ?? 0;
  const widthsArray = font.lookup(PDFName.of('Widths'));
  const widths = new Map<number, number>();
  if (widthsArray instanceof PDFArray) {
    for (let i = 0; i < widthsArray.size(); i += 1) {
      const width = widthsArray.lookupMaybe(i, PDFNumber)?.asNumber();
      if (width !== undefined) widths.set(firstChar + i, width);
    }
  }

  const differences = readEncodingDifferences(font);
  const descriptor = font.lookup(PDFName.of('FontDescriptor'));
  const missingWidth =
    descriptor instanceof PDFDict
      ? (descriptor.lookupMaybe(PDFName.of('MissingWidth'), PDFNumber)?.asNumber() ?? 0)
      : 0;

  const decode = (code: number): string => {
    const mapped = toUnicode?.get(code);
    if (mapped !== undefined && mapped !== '') return mapped;
    const named = differences.get(code);
    if (named !== undefined) return named;
    // WinAnsi and Standard agree with ASCII below 128, which is the whole of
    // a placeholder. Above it, Latin-1 is the closest single answer.
    return code >= 32 ? String.fromCharCode(code) : '';
  };

  // The standard 14 fonts are allowed to omit /Widths entirely, because a
  // reader is required to know their metrics already. Without this fallback
  // every glyph in such a font measures zero, and every placeholder in it would
  // be found at the wrong place and given a field of no width.
  const builtin = widths.size === 0 ? standardMetrics(font) : undefined;

  return {
    bytesPerCode: 1,
    decode,
    coversBasicLatin: () => {
      // A standard font is fully present by definition; nothing was subset.
      if (builtin !== undefined) return true;
      const drawable = new Map<string, number>();
      for (let code = 0; code < 256; code += 1) {
        // A zero width means the subset has no glyph for this code.
        if ((widths.get(code) ?? 0) > 0) drawable.set(decode(code), code);
      }
      // A space has width but no ink, and is present wherever the text is.
      drawable.set(' ', 32);
      return [...BASIC_LATIN].every((character) => drawable.has(character));
    },
    encode: (text) => {
      const codes: number[] = [];
      for (const character of text) {
        const code = simpleCodeFor(character, decode, differences);
        if (code === undefined) return undefined;
        codes.push(code);
      }
      return codes;
    },
    widthOf: (code) => {
      const stated = widths.get(code);
      if (stated !== undefined) return stated;
      if (builtin !== undefined) {
        const text = decode(code);
        if (text !== '') return builtin(text);
      }
      return missingWidth;
    },
  };
}

/** Reverse a code-to-text map, keeping the lowest code for each character. */
function invert(map: ReadonlyMap<number, string> | undefined): Map<string, number> {
  const reverse = new Map<string, number>();
  if (map === undefined) return reverse;
  for (const [code, text] of map) {
    if (text.length === 1 && !reverse.has(text)) reverse.set(text, code);
  }
  return reverse;
}

function encodeWith(reverse: ReadonlyMap<string, number>, text: string): number[] | undefined {
  const codes: number[] = [];
  for (const character of text) {
    const code = reverse.get(character);
    if (code === undefined) return undefined;
    codes.push(code);
  }
  return codes;
}

/** The single-byte code that draws a character under this font's encoding. */
function simpleCodeFor(
  character: string,
  decode: (code: number) => string,
  differences: ReadonlyMap<number, string>,
): number | undefined {
  for (const [code, mapped] of differences) {
    if (mapped === character) return code;
  }
  const point = character.codePointAt(0) ?? 0;
  // WinAnsi and Latin-1 agree over the range a letter or a name uses, so the
  // code point is the code — but only when the font agrees it decodes back.
  if (point <= 0xff && decode(point) === character) return point;
  return undefined;
}

/** Metrics for one of the standard 14 fonts, when the font dictionary is one. */
function standardMetrics(font: PDFDict): ((text: string) => number) | undefined {
  const baseFont = font.lookup(PDFName.of('BaseFont'));
  if (!(baseFont instanceof PDFName)) return undefined;

  // A subset prefix such as `ABCDEF+` is not part of the font's name.
  const name = baseFont.asString().replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
  try {
    const embedder = StandardFontEmbedder.for(name as Parameters<typeof StandardFontEmbedder.for>[0]);
    // Measured at 1000 units, which is the scale widths are expressed in.
    return (text) => embedder.widthOfTextAtSize(text, 1000);
  } catch {
    return undefined;
  }
}

/**
 * The characters a name, title or address is made of.
 *
 * Reusing an embedded font is only safe when it can draw all of these; short of
 * that a value would come out with holes in it.
 */
const BASIC_LATIN =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,'-/()";

/** Glyph names worth resolving: the ones a placeholder can be made of. */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ',
  braceleft: '{',
  braceright: '}',
  underscore: '_',
  hyphen: '-',
  period: '.',
  comma: ',',
  colon: ':',
  semicolon: ';',
  slash: '/',
  numbersign: '#',
  parenleft: '(',
  parenright: ')',
};

function readEncodingDifferences(font: PDFDict): Map<number, string> {
  const result = new Map<number, string>();
  // `/Encoding` is a bare name for the predefined encodings and a dictionary
  // only when it overrides glyphs, so the type is checked rather than assumed —
  // `lookupMaybe` throws on a mismatch, which would fail the whole page.
  const encoding = font.lookup(PDFName.of('Encoding'));
  if (!(encoding instanceof PDFDict)) return result;
  const differences = encoding.lookup(PDFName.of('Differences'));
  if (!(differences instanceof PDFArray)) return result;

  let code = 0;
  for (let i = 0; i < differences.size(); i += 1) {
    const entry = differences.lookup(i);
    if (entry instanceof PDFNumber) {
      code = entry.asNumber();
      continue;
    }
    if (entry instanceof PDFName) {
      const name = entry.asString().replace(/^\//, '');
      const resolved = resolveGlyphName(name);
      if (resolved !== undefined) result.set(code, resolved);
      code += 1;
    }
  }
  return result;
}

/** Resolve a glyph name to the character it stands for, where that is known. */
function resolveGlyphName(name: string): string | undefined {
  const known = GLYPH_NAMES[name];
  if (known !== undefined) return known;

  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name)?.[1];
  if (uni !== undefined) return String.fromCharCode(Number.parseInt(uni, 16));

  // A single-character name is conventionally that character, e.g. `/A`.
  return name.length === 1 ? name : undefined;
}

function readCidWidths(descendant: PDFDict | undefined): Map<number, number> {
  const widths = new Map<number, number>();
  const w = descendant?.lookup(PDFName.of('W'));
  if (!(w instanceof PDFArray)) return widths;

  let i = 0;
  while (i < w.size()) {
    const first = w.lookupMaybe(i, PDFNumber)?.asNumber();
    if (first === undefined) break;
    const second = w.lookup(i + 1);

    if (second instanceof PDFArray) {
      for (let k = 0; k < second.size(); k += 1) {
        const width = second.lookupMaybe(k, PDFNumber)?.asNumber();
        if (width !== undefined) widths.set(first + k, width);
      }
      i += 2;
      continue;
    }

    const last = w.lookupMaybe(i + 1, PDFNumber)?.asNumber();
    const width = w.lookupMaybe(i + 2, PDFNumber)?.asNumber();
    if (last === undefined || width === undefined) break;
    // A run can legitimately be long, but a malformed one must not hang this.
    for (let code = first; code <= last && code - first < 65_536; code += 1) {
      widths.set(code, width);
    }
    i += 3;
  }
  return widths;
}

/** Parse a font's ToUnicode CMap into a code-to-text map. */
function readToUnicode(font: PDFDict): Map<number, string> | undefined {
  // `lookupMaybe` has no overload for a stream class, so the type is checked
  // after the lookup rather than during it.
  const stream = font.lookup(PDFName.of('ToUnicode'));
  if (!(stream instanceof PDFRawStream)) return undefined;

  let text: string;
  try {
    text = bytesToLatin1(decodePDFRawStream(stream).decode());
  } catch {
    return undefined;
  }

  const map = new Map<number, string>();
  const hex = (value: string): number => Number.parseInt(value, 16);
  const utf16 = (value: string): string => {
    let out = '';
    for (let i = 0; i + 3 < value.length + 1; i += 4) {
      const unit = Number.parseInt(value.slice(i, i + 4), 16);
      if (Number.isFinite(unit)) out += String.fromCharCode(unit);
    }
    return out;
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(hex(pair[1] as string), utf16(pair[2] as string));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const range of body.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g,
    )) {
      const low = hex(range[1] as string);
      const high = hex(range[2] as string);
      if (range[3] !== undefined) {
        const base = range[3];
        for (let code = low; code <= high && code - low < 65_536; code += 1) {
          // Only the last unit increments, which is what producers rely on.
          const units = base.match(/.{4}/g) ?? [];
          const shifted = units.map((unit, index) =>
            index === units.length - 1
              ? (hex(unit) + (code - low)).toString(16).padStart(4, '0')
              : unit,
          );
          map.set(code, utf16(shifted.join('')));
        }
        continue;
      }
      const entries = [...(range[4] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)];
      entries.forEach((entry, index) => map.set(low + index, utf16(entry[1] as string)));
    }
  }

  return map;
}

// --- replaying the text operators ---------------------------------------

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** Decode a page's content streams into a single string. */
export function readPageContent(page: PDFPage): string {
  const contents = page.node.Contents();
  if (contents === undefined) return '';

  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = contents.lookupMaybe(i, PDFRawStream);
      if (stream !== undefined) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }

  return streams
    .map((stream) => {
      try {
        return bytesToLatin1(decodePDFRawStream(stream).decode());
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * Replace a page's content with the given stream.
 *
 * The page is left with exactly one content stream. Producers commonly split
 * content across several, and a rewrite computed over the joined text would not
 * line up with any one of them.
 */
export function writePageContent(page: PDFPage, content: string): void {
  const context = page.doc.context;

  // The stream being replaced has to be deleted, not merely unreferenced.
  // pdf-lib writes every registered object, so an orphaned content stream stays
  // in the file — carrying, in this case, the very placeholder text that was
  // just taken off the page. It would be invisible to a reader and perfectly
  // visible to anything that inflates the file's streams.
  const previous = page.node.get(PDFName.of('Contents'));
  for (const ref of previous instanceof PDFArray ? previous.asArray() : [previous]) {
    if (ref instanceof PDFRef) context.delete(ref);
  }

  const ref = context.register(context.flateStream(content));
  page.node.set(PDFName.of('Contents'), ref);
}

/**
 * Replay a content stream's text operators and report every glyph drawn.
 *
 * Only the operators a word processor uses to lay out a letter are modelled.
 * Anything else is passed over, which loses position for constructs this does
 * not know — so callers treat an empty or partial result as "cannot prepare
 * this page" rather than as "the page has no text".
 */
export function readGlyphs(content: string, fonts: ReadonlyMap<string, FontInfo>): Glyph[] {
  const operations = parseOperations(content);
  const glyphs: Glyph[] = [];

  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;

  let fontName = '';
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let leading = 0;
  let rise = 0;

  const numbers = (operands: readonly Token[]): number[] =>
    operands.filter((token) => token.kind === 'number').map((token) => token.value);

  const show = (bytes: number[], operationIndex: number, startIndex: number): number => {
    const font = fonts.get(fontName);
    if (font === undefined) return startIndex;

    let index = startIndex;
    const step = font.bytesPerCode;
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = step === 2 ? ((bytes[i] as number) << 8) | (bytes[i + 1] as number) : (bytes[i] as number);
      const widthMille = font.widthOf(code);
      const isSpaceCode = step === 1 && code === 32;

      // The advance in unscaled text space, per the text-space model: the
      // glyph's own width plus the spacing in force, all under Tz.
      const advanceText =
        ((widthMille / 1000) * fontSize + charSpacing + (isSpaceCode ? wordSpacing : 0)) *
        horizontalScale;

      // Text space becomes page space through Tm and then the CTM. Taking the
      // scale from that combined matrix is what makes the result correct on a
      // page the producer has transformed, rather than only on an untouched one.
      const toPage = multiply(textMatrix, ctm);
      const horizontal = Math.hypot(toPage[0], toPage[1]);
      const vertical = Math.hypot(toPage[2], toPage[3]);

      const render = multiply(
        multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], textMatrix),
        ctm,
      );

      glyphs.push({
        text: font.decode(code),
        x: render[4],
        y: render[5],
        width: advanceText * horizontal,
        size: fontSize * vertical,
        operation: operationIndex,
        indexInOperation: index,
        widthMille,
        charSpacing,
        wordSpacing,
        isSpaceCode,
        font: fontName,
        fontSize,
        bytesPerCode: step,
      });

      textMatrix = multiply([1, 0, 0, 1, advanceText, 0], textMatrix);
      index += 1;
    }
    return index;
  };

  operations.forEach((operation, operationIndex) => {
    const args = numbers(operation.operands);

    switch (operation.operator) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? ctm;
        break;
      case 'cm':
        if (args.length >= 6) ctm = multiply(args.slice(0, 6) as unknown as Matrix, ctm);
        break;
      case 'BT':
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        const name = operation.operands.find((token) => token.kind === 'name');
        if (name?.kind === 'name') fontName = name.value;
        fontSize = args[args.length - 1] ?? fontSize;
        break;
      }
      case 'Td':
        if (args.length >= 2) {
          lineMatrix = multiply([1, 0, 0, 1, args[0] as number, args[1] as number], lineMatrix);
          textMatrix = lineMatrix;
        }
        break;
      case 'TD':
        if (args.length >= 2) {
          leading = -(args[1] as number);
          lineMatrix = multiply([1, 0, 0, 1, args[0] as number, args[1] as number], lineMatrix);
          textMatrix = lineMatrix;
        }
        break;
      case 'Tm':
        if (args.length >= 6) {
          lineMatrix = args.slice(0, 6) as unknown as Matrix;
          textMatrix = lineMatrix;
        }
        break;
      case 'T*':
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = lineMatrix;
        break;
      case 'TL':
        leading = args[0] ?? leading;
        break;
      case 'Tc':
        charSpacing = args[0] ?? charSpacing;
        break;
      case 'Tw':
        wordSpacing = args[0] ?? wordSpacing;
        break;
      case 'Tz':
        horizontalScale = (args[0] ?? 100) / 100;
        break;
      case 'Ts':
        rise = args[0] ?? rise;
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (operation.operator !== 'Tj') {
          if (operation.operator === '"') {
            wordSpacing = args[0] ?? wordSpacing;
            charSpacing = args[1] ?? charSpacing;
          }
          lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
          textMatrix = lineMatrix;
        }
        const string = operation.operands.find((token) => token.kind === 'string');
        if (string?.kind === 'string') show(string.bytes, operationIndex, 0);
        break;
      }
      case 'TJ': {
        const array = operation.operands.find((token) => token.kind === 'array');
        if (array?.kind !== 'array') break;
        let index = 0;
        for (const item of array.items) {
          if (item.kind === 'string') {
            index = show(item.bytes, operationIndex, index);
          } else if (item.kind === 'number') {
            const shift = (-item.value / 1000) * fontSize * horizontalScale;
            textMatrix = multiply([1, 0, 0, 1, shift, 0], textMatrix);
          }
        }
        break;
      }
      default:
        break;
    }
  });

  return glyphs;
}

// --- rewriting -----------------------------------------------------------

/**
 * Produce a content stream with the given glyphs no longer drawn.
 *
 * Deleting characters from a show-text operation would slide everything after
 * them to the left. To avoid that, each removed run is replaced by a `TJ`
 * adjustment of exactly the advance it had: `TJ` shifts the text position
 * without touching the line matrix, so following text — on the same line and on
 * every line after it — stays precisely where the producer put it.
 *
 * The rest of the stream is copied byte for byte. That matters more than it
 * sounds: a letterhead is mostly things this parser does not model, and
 * regenerating the stream from the parse would discard them.
 */
export function removeGlyphs(content: string, remove: readonly Glyph[]): string {
  if (remove.length === 0) return content;

  const byOperation = new Map<number, Map<number, Glyph>>();
  for (const glyph of remove) {
    const existing = byOperation.get(glyph.operation);
    if (existing === undefined) byOperation.set(glyph.operation, new Map([[glyph.indexInOperation, glyph]]));
    else existing.set(glyph.indexInOperation, glyph);
  }

  const operations = parseOperations(content);
  let result = '';
  let copied = 0;

  operations.forEach((operation, index) => {
    const targets = byOperation.get(index);
    if (targets === undefined) return;
    if (!['Tj', 'TJ', "'", '"'].includes(operation.operator)) return;

    result += content.slice(copied, operation.start);
    result += rewriteShowText(operation, targets);
    copied = operation.end;
  });

  return result + content.slice(copied);
}

/** Rebuild one show-text operation without the glyphs being removed. */
function rewriteShowText(operation: Operation, remove: ReadonlyMap<number, Glyph>): string {
  // The line-positioning half of `'` and `"` has to survive, so it is emitted
  // explicitly before the text is re-issued as a plain TJ.
  let prefix = '';
  if (operation.operator === '"') {
    const numbers = operation.operands.filter((token) => token.kind === 'number');
    const wordSpacing = numbers[0]?.kind === 'number' ? numbers[0].value : 0;
    const charSpacing = numbers[1]?.kind === 'number' ? numbers[1].value : 0;
    prefix = `${wordSpacing} Tw ${charSpacing} Tc T* `;
  } else if (operation.operator === "'") {
    prefix = 'T* ';
  }

  const items: Token[] =
    operation.operator === 'TJ'
      ? [...(operation.operands.find((token) => token.kind === 'array')?.items ?? [])]
      : operation.operands.filter((token) => token.kind === 'string');

  // Every glyph in one operation shares a font, so a single code width steps
  // through all of its strings.
  const step = ([...remove.values()][0] as Glyph).bytesPerCode;

  const parts: string[] = [];
  let kept: number[] = [];
  let pending = 0;
  let glyphIndex = 0;

  const flushKept = (): void => {
    if (kept.length === 0) return;
    parts.push(`<${kept.map((byte) => byte.toString(16).padStart(2, '0')).join('')}>`);
    kept = [];
  };
  const flushPending = (): void => {
    if (pending === 0) return;
    // A positive advance is a negative adjustment: TJ moves left by adj/1000.
    parts.push(`${(-pending).toFixed(2)}`);
    pending = 0;
  };

  for (const item of items) {
    if (item.kind === 'number') {
      flushKept();
      flushPending();
      parts.push(`${item.value}`);
      continue;
    }
    if (item.kind !== 'string') continue;

    for (let i = 0; i + step <= item.bytes.length; i += step) {
      const glyph = remove.get(glyphIndex);
      if (glyph === undefined) {
        flushPending();
        for (let k = 0; k < step; k += 1) kept.push(item.bytes[i + k] as number);
      } else {
        flushKept();
        pending += advanceMille(glyph);
      }
      glyphIndex += 1;
    }
  }
  flushKept();
  flushPending();

  return `${prefix}[${parts.join(' ')}] TJ`;
}

/**
 * A glyph's advance in thousandths of an em, including the spacing in force.
 *
 * `TJ` adjustments are expressed in those units, so character and word spacing
 * — which are in text space — have to be converted before they can be added.
 */
function advanceMille(glyph: Glyph): number {
  const spacing = glyph.charSpacing + (glyph.isSpaceCode ? glyph.wordSpacing : 0);
  if (glyph.fontSize === 0) return glyph.widthMille;
  return glyph.widthMille + (spacing * 1000) / glyph.fontSize;
}
