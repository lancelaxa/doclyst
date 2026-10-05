import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import { Unzlib } from 'fflate';
import {
  IDENTITY,
  multiply,
  readGlyphs,
  readResourceFonts,
  type Box,
  type ExtGStateInfo,
  type GlyphAppearance,
  type Matrix,
  type PaintInfo,
} from '../pdf/content.js';

/**
 * Checking signed letters that come back.
 *
 * A letter goes out as a PDF, the recipient signs it in whatever they have to
 * hand, and a PDF comes back. Nothing about that round trip stops the copy
 * that returns from saying something different — a salary typed over, a
 * clause covered with a white box, a page left out — and a person comparing a
 * hundred letters by eye will miss it.
 *
 * So each returned file is compared with the letters that were sent, by what
 * is actually drawn on each page and where. Everything the original drew must
 * still be there, in the same place. Anything new is the signature, and is
 * fine — unless it sits over the original text.
 *
 * The findings describe *where* something changed, never what the text says:
 * the letters hold salaries and names, and these messages are shown on screen
 * and pasted into tickets.
 */

/** A file handed in for checking. */
export interface LetterFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * The outcome for one returned file.
 *
 * - `signed`: everything sent is intact, and something has been added.
 * - `unsigned`: everything sent is intact, and nothing has been added.
 * - `review`: intact, but something added sits over the original text, or the
 *   file could only partly be checked. Look at it.
 * - `changed`: something sent is missing, moved or different.
 * - `unmatched`: it does not correspond to any letter that was sent.
 * - `unreadable`: it could not be read at all — a scan, a photo, or a
 *   password-protected file.
 */
export type ReturnedStatus = 'signed' | 'unsigned' | 'review' | 'changed' | 'unmatched' | 'unreadable';

export interface ReturnedLetterReport {
  /** Name of the returned file. */
  readonly file: string;
  /** Name of the sent letter it was matched to. */
  readonly letter?: string;
  readonly status: ReturnedStatus;
  /** Problems found, most serious first. Locations only, never content. */
  readonly findings: readonly string[];
  /** What was added — the signature, typically — and where. */
  readonly additions: readonly string[];
}

export interface ReturnedCheck {
  /** One report per returned file, in the order given. */
  readonly returned: readonly ReturnedLetterReport[];
  /** Sent letters that no returned file matched. */
  readonly notReturned: readonly string[];
  /** Sent letters that could not be read, and so could not be matched. */
  readonly unreadableSent: readonly string[];
}

export interface CheckReturnedOptions {
  /** Called after each file is read, so a page can show progress. */
  readonly onProgress?: (completed: number, total: number) => void | Promise<void>;
}

/**
 * How far, in points, a character may sit from where it was and still count
 * as unmoved. A point is 1/72 inch: anything that moved further than this
 * moved visibly. Re-saving in another program shifts positions by rounding
 * only, far below it.
 */
const POSITION_TOLERANCE = 1.5;

/**
 * Share of the sent letter's text a returned file must contain to be matched
 * to it at all. Below this it is a different document, not a changed one.
 */
const MIN_MATCH = 0.6;

/** Share of a character's box something must cover to count as covering it. */
const COVER_THRESHOLD = 0.25;

/** Fills at least this light, over text, are treated as covering it up. */
const WHITEOUT_LIGHTNESS = 0.85;

/** Characters too slight to matter if a signature crosses them. */
const DECORATIVE = /^[\s_.\-–—·…]*$/;

export async function checkReturnedLetters(
  sent: readonly LetterFile[],
  returned: readonly LetterFile[],
  options: CheckReturnedOptions = {},
): Promise<ReturnedCheck> {
  const total = sent.length + returned.length;
  let done = 0;
  const step = async (): Promise<void> => {
    done += 1;
    await options.onProgress?.(done, total);
  };

  const letters: { name: string; inventory: Inventory; index: TextIndex }[] = [];
  const unreadableSent: string[] = [];
  for (const file of sent) {
    const inventory = await readInventory(file.bytes).catch(() => undefined);
    if (inventory === undefined || textCount(inventory) === 0) unreadableSent.push(file.name);
    else letters.push({ name: file.name, inventory, index: indexText(inventory) });
    await step();
  }

  const reports: ReturnedLetterReport[] = [];
  const claimed = new Map<string, number[]>();

  for (const file of returned) {
    let inventory: Inventory;
    try {
      inventory = await readInventory(file.bytes);
    } catch (error) {
      reports.push({
        file: file.name,
        status: 'unreadable',
        findings: [
          error instanceof EncryptedError
            ? 'It is password-protected, so it cannot be checked. Ask for a copy without a password.'
            : error instanceof TooComplexError
              ? 'It is far larger or more complicated than a signed letter should be, so it was not checked. Compare it with the original by eye.'
              : 'It could not be opened as a PDF.',
        ],
        additions: [],
      });
      await step();
      continue;
    }

    if (textCount(inventory) === 0) {
      reports.push({
        file: file.name,
        status: 'unreadable',
        findings: [
          'It has no readable text — probably a scan or a photo of the printed letter. Compare it with the original by eye.',
        ],
        additions: [],
      });
      await step();
      continue;
    }

    // Match by content rather than by filename: whoever signs the letter can
    // rename it, and often does.
    const returnedIndex = indexText(inventory);
    const scored = letters
      .map((letter) => ({ letter, score: matchShare(letter.inventory, returnedIndex) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];

    if (best === undefined || best.score < MIN_MATCH) {
      reports.push({
        file: file.name,
        status: 'unmatched',
        findings: ['It does not match any of the letters you sent.'],
        additions: [],
      });
      await step();
      continue;
    }

    const comparison = compare(best.letter.inventory, inventory);
    const findings = [...comparison.changed, ...comparison.review];

    const rival = scored[1];
    if (rival !== undefined && rival.score === best.score) {
      findings.push(
        `It matches "${best.letter.name}" and "${rival.letter.name}" equally well — those two letters are identical. Check which person it came from.`,
      );
    }

    const status: ReturnedStatus =
      comparison.changed.length > 0
        ? 'changed'
        : findings.length > 0
          ? 'review'
          : comparison.additions.length === 0
            ? 'unsigned'
            : 'signed';

    claimed.set(best.letter.name, [...(claimed.get(best.letter.name) ?? []), reports.length]);
    reports.push({
      file: file.name,
      letter: best.letter.name,
      status,
      findings,
      additions: comparison.additions,
    });
    await step();
  }

  // Two returned files for one letter is either a resend or a mix-up. Either
  // way someone should know which copy they are filing.
  for (const [letter, indices] of claimed) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      const report = reports[index] as ReturnedLetterReport;
      reports[index] = {
        ...report,
        // Only a clean pass is downgraded: "changed" and "not signed" already
        // ask for attention, and say more about the file than this does.
        status: report.status === 'signed' ? 'review' : report.status,
        findings: [
          ...report.findings,
          `${indices.length} returned files match "${letter}". Make sure you keep the right one.`,
        ],
      };
    }
  }

  return {
    returned: reports,
    notReturned: letters.map((letter) => letter.name).filter((name) => !claimed.has(name)),
    unreadableSent,
  };
}

// --- reading -------------------------------------------------------------

interface TextMark {
  readonly page: number;
  readonly text: string;
  readonly box: Box;
  /** Whether the character can actually be seen. */
  readonly shown: boolean;
  /** Lightness of its paint: 0 black, 1 white. */
  readonly lightness: number;
}

interface Drawing {
  readonly page: number;
  readonly kind: 'fill' | 'stroke' | 'image' | 'annotation';
  /** Undefined when the extent cannot be known, as for an unclipped shading. */
  readonly box: Box | undefined;
  /** How it was painted; absent for an annotation drawn by the viewer. */
  readonly info?: PaintInfo;
}

interface PageGeometry {
  readonly width: number;
  readonly height: number;
  /** The visible area. Shrinking it hides whatever falls outside. */
  readonly crop: Box;
  readonly rotation: number;
  readonly userUnit: number;
}

interface Inventory {
  readonly pages: readonly PageGeometry[];
  readonly text: readonly TextMark[];
  readonly drawings: readonly Drawing[];
  /**
   * Whether the document has optional content — layers a viewer can show or
   * hide. Whether a given layer is on is not modelled here, so their presence
   * alone is reported.
   */
  readonly layers: boolean;
}

class EncryptedError extends Error {}

/**
 * Raised when a file would take more work to check than any real letter needs.
 *
 * Everything returned is supplied by the person who signed it, so it is treated
 * as hostile. A 2 KB file that draws a form which draws itself ten times, seven
 * levels deep, asks for ten million visits; a 600 KB stream can inflate to a
 * gigabyte. Either would freeze the page. Real letters sit far inside every
 * limit below.
 */
class TooComplexError extends Error {}

/** Largest returned file accepted. A signed letter is rarely over a few MB. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Total decompressed bytes allowed across one file, including re-visits. */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
/** Total form XObjects drawn across one file, counting every repeat. */
const MAX_FORM_DRAWS = 5_000;
/** Characters, shapes and images recorded across one file. */
const MAX_MARKS = 200_000;
/** Deepest nesting of form XObjects followed. */
const MAX_FORM_DEPTH = 8;
/** Encoded size up to which a stream with an unusual filter is decoded. */
const MAX_OTHER_FILTER_BYTES = 64 * 1024;

/** Work done so far on one file, checked against the limits above. */
class Budget {
  decoded = 0;
  formDraws = 0;
  marks = 0;

  charge(field: 'decoded' | 'formDraws' | 'marks', amount: number): void {
    this[field] += amount;
    const limit = field === 'decoded' ? MAX_DECODED_BYTES : field === 'formDraws' ? MAX_FORM_DRAWS : MAX_MARKS;
    if (this[field] > limit) throw new TooComplexError();
  }
}

/**
 * Read everything a document draws: each character, each painted shape, each
 * image, and each visible annotation, with where it sits on its page and
 * whether it can be seen.
 *
 * Form XObjects are followed, which matters more than it might seem: a
 * flattened form field is drawn from one, so the very values a letter was
 * filled with — the name and the salary — live there and nowhere else.
 */
async function readInventory(bytes: Uint8Array): Promise<Inventory> {
  if (bytes.length > MAX_FILE_BYTES) throw new TooComplexError();
  const budget = new Budget();
  // Checked before the PDF library sees the file, because loading it inflates
  // object streams with no limit of its own.
  preflightCompressedStreams(bytes);

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof Error && /encrypt/i.test(error.message)) throw new EncryptedError();
    throw error;
  }

  const pages: PageGeometry[] = [];
  const text: TextMark[] = [];
  const drawings: Drawing[] = [];

  document.getPages().forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const { width, height } = page.getSize();
    const crop = page.getCropBox();
    const userUnit = page.node.lookup(PDFName.of('UserUnit'));
    pages.push({
      width,
      height,
      crop: { x0: crop.x, y0: crop.y, x1: crop.x + crop.width, y1: crop.y + crop.height },
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      userUnit: userUnit instanceof PDFNumber ? userUnit.asNumber() : 1,
    });

    const visit = (
      content: string,
      resources: PDFDict | undefined,
      ctm: Matrix,
      inherit: GlyphAppearance | undefined,
      depth: number,
      seen: Set<PDFRef | PDFRawStream>,
    ): void => {
      const fonts = readResourceFonts(resources);
      const glyphs = readGlyphs(content, fonts, {
        ctm,
        ...(inherit ? { inherit } : {}),
        onPaint: (box, kind, info) => {
          budget.charge('marks', 1);
          drawings.push({ page: pageNumber, kind, box, info });
        },
        onExtGState: (name) => readExtGState(resources, name),
        onXObject: (name, at, appearance) => {
          const xobjects = resources?.lookup(PDFName.of('XObject'));
          if (!(xobjects instanceof PDFDict)) return;
          const ref = xobjects.get(PDFName.of(name));
          const stream = xobjects.lookup(PDFName.of(name));
          if (!(stream instanceof PDFRawStream)) return;
          const key = ref instanceof PDFRef ? ref : stream;
          if (seen.has(key)) return;

          const subtype = stream.dict.lookup(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            budget.charge('marks', 1);
            drawings.push({
              page: pageNumber,
              kind: 'image',
              box: transformBox({ x0: 0, y0: 0, x1: 1, y1: 1 }, at),
              info: { lightness: 0, alpha: appearance.alpha, softMask: appearance.softMask, rectangles: false, clip: appearance.clip },
            });
            return;
          }
          if (subtype !== PDFName.of('Form')) return;
          if (depth >= MAX_FORM_DEPTH) throw new TooComplexError();
          budget.charge('formDraws', 1);

          const inner = decodeStream(stream, budget);
          if (inner === undefined) return;
          const matrix = readMatrix(stream.dict.lookup(PDFName.of('Matrix')));
          const own = stream.dict.lookup(PDFName.of('Resources'));
          const next = new Set(seen);
          next.add(key);
          visit(inner, own instanceof PDFDict ? own : resources, multiply(matrix, at), appearance, depth + 1, next);
        },
      });

      budget.charge('marks', glyphs.length);
      for (const glyph of glyphs) {
        if (glyph.text.trim() === '') continue;
        const left = Math.min(glyph.x, glyph.x + glyph.width);
        const right = Math.max(glyph.x, glyph.x + glyph.width);
        const box = { x0: left, y0: glyph.y - glyph.size * 0.2, x1: right, y1: glyph.y + glyph.size * 0.8 };
        text.push({
          page: pageNumber,
          text: glyph.text,
          box,
          shown: isShown(glyph.appearance, box),
          lightness: glyph.appearance.lightness,
        });
      }
    };

    visit(pageContent(page.node.Contents(), budget), page.node.Resources(), IDENTITY, undefined, 0, new Set());

    const annotations = page.node.Annots();
    if (annotations instanceof PDFArray) {
      for (let i = 0; i < annotations.size(); i += 1) {
        const annotation = annotations.lookup(i);
        if (!(annotation instanceof PDFDict)) continue;
        const subtype = annotation.lookup(PDFName.of('Subtype'));
        // A link is an invisible click area, and a popup only shows when
        // opened from another annotation, which is itself counted.
        if (subtype === PDFName.of('Link') || subtype === PDFName.of('Popup')) continue;
        const flags = annotation.lookup(PDFName.of('F'));
        const flagValue = flags instanceof PDFNumber ? flags.asNumber() : 0;
        if (flagValue & (2 | 32)) continue; // Hidden, NoView
        const rect = readBox(annotation.lookup(PDFName.of('Rect')));
        if (rect === undefined) continue;
        budget.charge('marks', 1);

        // What an annotation shows is its appearance stream, so that is what
        // is read: a white box drawn by a text annotation is a white box, and
        // a signature is the strokes it is made of rather than the generous
        // rectangle around them, which would reach into the text nearby.
        const appearance = normalAppearance(annotation);
        const inner = appearance === undefined ? undefined : decodeStream(appearance, budget);
        if (appearance === undefined || inner === undefined) {
          drawings.push({ page: pageNumber, kind: 'annotation', box: rect });
          continue;
        }
        const own = appearance.dict.lookup(PDFName.of('Resources'));
        visit(inner, own instanceof PDFDict ? own : page.node.Resources(), appearanceMatrix(appearance, rect), undefined, 1, new Set([appearance]));
      }
    }
  });

  return { pages, text, drawings, layers: document.catalog.has(PDFName.of('OCProperties')) };
}

/**
 * Whether a glyph painted this way can be seen.
 *
 * Invisible render modes, near-zero opacity, a soft mask (whose effect is not
 * worked out here, so it is not trusted), and a clip that leaves less than
 * half of the glyph all count as not shown.
 */
function isShown(appearance: GlyphAppearance, box: Box): boolean {
  if (appearance.renderMode === 3 || appearance.renderMode === 7) return false;
  if (appearance.alpha < 0.5 || appearance.softMask) return false;
  if (appearance.clip !== undefined) {
    const area = (box.x1 - box.x0) * (box.y1 - box.y0);
    if (area > 0 && overlapArea(box, appearance.clip) / area < 0.5) return false;
  }
  return true;
}

function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Opacity and soft mask of a named graphics state, from the resources. */
function readExtGState(resources: PDFDict | undefined, name: string): ExtGStateInfo | undefined {
  const states = resources?.lookup(PDFName.of('ExtGState'));
  if (!(states instanceof PDFDict)) return undefined;
  const state = states.lookup(PDFName.of(name));
  if (!(state instanceof PDFDict)) return undefined;
  const number = (key: string): number | undefined => {
    const value = state.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : undefined;
  };
  const mask = state.lookup(PDFName.of('SMask'));
  const info: { fillAlpha?: number; strokeAlpha?: number; softMask?: boolean } = {};
  const fill = number('ca');
  const stroke = number('CA');
  if (fill !== undefined) info.fillAlpha = fill;
  if (stroke !== undefined) info.strokeAlpha = stroke;
  if (mask !== undefined) info.softMask = mask !== PDFName.of('None');
  return info;
}

function pageContent(contents: unknown, budget: Budget): string {
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = contents.lookup(i);
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((stream) => decodeStream(stream, budget) ?? '').join('\n');
}

/**
 * Decode a stream within the file's budget.
 *
 * Flate — what every word processor, PDF printer and signing app writes — is
 * inflated here, incrementally, stopping the moment the budget is spent.
 * Anything else is handed to the PDF library only when it is small, since
 * that library inflates without a limit. Undefined means the stream could not
 * be decoded, which is treated as drawing nothing.
 */
function decodeStream(stream: PDFRawStream, budget: Budget): string | undefined {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const filters =
    filter === undefined ? [] : filter instanceof PDFName ? [filter] : filter instanceof PDFArray ? filter.asArray() : [filter];
  const hasParams = stream.dict.has(PDFName.of('DecodeParms'));

  if (filters.length === 0) {
    budget.charge('decoded', stream.contents.length);
    return latin1(stream.contents);
  }
  if (filters.length === 1 && filters[0] === PDFName.of('FlateDecode') && !hasParams) {
    const inflated = inflateWithin(stream.contents, MAX_DECODED_BYTES - budget.decoded);
    if (inflated !== undefined) {
      budget.charge('decoded', inflated.length);
      return latin1(inflated);
    }
  }
  if (stream.contents.length > MAX_OTHER_FILTER_BYTES) throw new TooComplexError();
  try {
    const decoded = decodePDFRawStream(stream).decode();
    budget.charge('decoded', decoded.length);
    return latin1(decoded);
  } catch (error) {
    if (error instanceof TooComplexError) throw error;
    return undefined;
  }
}

/**
 * Inflate zlib data, giving up with {@link TooComplexError} once `limit` bytes
 * have come out. Undefined if the data is not valid zlib.
 */
function inflateWithin(data: Uint8Array, limit: number): Uint8Array | undefined {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inflater = new Unzlib((chunk) => {
    size += chunk.length;
    if (size > limit) throw new TooComplexError();
    chunks.push(chunk);
  });
  try {
    pushInSlices(inflater, data);
  } catch (error) {
    if (error instanceof TooComplexError) throw error;
    // Some producers write slightly malformed zlib that the PDF library
    // tolerates; that path is still open to small streams.
    return undefined;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Feed compressed data to an inflater a little at a time.
 *
 * Handed everything at once, the inflater produces the whole output before
 * its callback can object, so a limit checked there arrives after the memory
 * is already gone. Deflate expands at most about a thousandfold, so a 4 KB
 * slice can produce no more than about 4 MB before the limit is consulted.
 */
function pushInSlices(inflater: Unzlib, data: Uint8Array): void {
  const SLICE = 4096;
  for (let offset = 0; offset < data.length; offset += SLICE) {
    inflater.push(data.subarray(offset, offset + SLICE), offset + SLICE >= data.length);
  }
  if (data.length === 0) inflater.push(data, true);
}

/**
 * Refuse a file whose compressed streams inflate past the budget, before it is
 * parsed at all.
 *
 * Works on the raw bytes: every `stream` keyword is followed to its
 * `endstream`, and anything that inflates is counted, never kept. This is a
 * guard rather than a parser, so it errs towards counting too much.
 */
function preflightCompressedStreams(bytes: Uint8Array): void {
  const raw = latin1(bytes);
  const keyword = /stream\r?\n/g;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(raw)) !== null) {
    if (raw.slice(match.index - 3, match.index) === 'end') continue;
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    keyword.lastIndex = end + 9;
    const counter = new Unzlib((chunk) => {
      total += chunk.length;
      if (total > MAX_DECODED_BYTES * 2) throw new TooComplexError();
    });
    try {
      pushInSlices(counter, bytes.subarray(start, end));
    } catch (error) {
      if (error instanceof TooComplexError) throw error;
      // Not zlib, or not compressed at all: nothing to count.
    }
  }
}

function readBox(value: unknown): Box | undefined {
  if (!(value instanceof PDFArray) || value.size() < 4) return undefined;
  const [a, b, c, d] = [0, 1, 2, 3].map((n) => {
    const item = value.lookup(n);
    return item instanceof PDFNumber ? item.asNumber() : NaN;
  }) as [number, number, number, number];
  if (![a, b, c, d].every(Number.isFinite)) return undefined;
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

/** The appearance an annotation shows normally, if it has one. */
function normalAppearance(annotation: PDFDict): PDFRawStream | undefined {
  const ap = annotation.lookup(PDFName.of('AP'));
  if (!(ap instanceof PDFDict)) return undefined;
  const normal = ap.lookup(PDFName.of('N'));
  if (normal instanceof PDFRawStream) return normal;
  // A dictionary of states, as for a checkbox: the current one is named by /AS.
  if (normal instanceof PDFDict) {
    const state = annotation.lookup(PDFName.of('AS'));
    const chosen = state instanceof PDFName ? normal.lookup(state) : undefined;
    if (chosen instanceof PDFRawStream) return chosen;
  }
  return undefined;
}

/**
 * The matrix that places an appearance stream on the page.
 *
 * Per the PDF specification, the stream's bounding box, transformed by its own
 * matrix, is scaled and moved to fill the annotation's rectangle.
 */
function appearanceMatrix(stream: PDFRawStream, rect: Box): Matrix {
  const matrix = readMatrix(stream.dict.lookup(PDFName.of('Matrix')));
  const bbox = readBox(stream.dict.lookup(PDFName.of('BBox')));
  if (bbox === undefined) return multiply(matrix, [1, 0, 0, 1, rect.x0, rect.y0]);
  const placed = transformBox(bbox, matrix);
  const width = placed.x1 - placed.x0;
  const height = placed.y1 - placed.y0;
  const sx = width > 0 ? (rect.x1 - rect.x0) / width : 1;
  const sy = height > 0 ? (rect.y1 - rect.y0) / height : 1;
  return multiply(matrix, [sx, 0, 0, sy, rect.x0 - placed.x0 * sx, rect.y0 - placed.y0 * sy]);
}

function readMatrix(value: unknown): Matrix {
  if (!(value instanceof PDFArray) || value.size() < 6) return IDENTITY;
  const numbers = [0, 1, 2, 3, 4, 5].map((n) => {
    const item = value.lookup(n);
    return item instanceof PDFNumber ? item.asNumber() : NaN;
  });
  return numbers.every(Number.isFinite) ? (numbers as unknown as Matrix) : IDENTITY;
}

function transformBox(box: Box, m: Matrix): Box {
  const corners = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x0, box.y1],
    [box.x1, box.y1],
  ].map(([x, y]) => [
    (x as number) * m[0] + (y as number) * m[2] + m[4],
    (x as number) * m[1] + (y as number) * m[3] + m[5],
  ]);
  return {
    x0: Math.min(...corners.map((c) => c[0] as number)),
    y0: Math.min(...corners.map((c) => c[1] as number)),
    x1: Math.max(...corners.map((c) => c[0] as number)),
    y1: Math.max(...corners.map((c) => c[1] as number)),
  };
}

function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return result;
}

function textCount(inventory: Inventory): number {
  return inventory.text.length;
}

// --- matching ------------------------------------------------------------

/** Characters bucketed by page, text and coarse position, for fast lookup. */
type TextIndex = Map<string, TextMark[]>;

const CELL = 2 * POSITION_TOLERANCE;

function cellKey(page: number, text: string, x: number, y: number): string {
  return `${page}|${text}|${Math.floor(x / CELL)}|${Math.floor(y / CELL)}`;
}

function indexText(inventory: Inventory): TextIndex {
  const index: TextIndex = new Map();
  for (const mark of inventory.text) {
    const key = cellKey(mark.page, mark.text, mark.box.x0, mark.box.y0);
    const bucket = index.get(key);
    if (bucket) bucket.push(mark);
    else index.set(key, [mark]);
  }
  return index;
}

/** Find a mark of the same text within tolerance, skipping ones in `used`. */
function findNear(index: TextIndex, mark: TextMark, used?: Set<TextMark>): TextMark | undefined {
  const cx = Math.floor(mark.box.x0 / CELL);
  const cy = Math.floor(mark.box.y0 / CELL);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = index.get(`${mark.page}|${mark.text}|${cx + dx}|${cy + dy}`);
      if (!bucket) continue;
      for (const candidate of bucket) {
        if (used?.has(candidate)) continue;
        if (
          Math.abs(candidate.box.x0 - mark.box.x0) <= POSITION_TOLERANCE &&
          Math.abs(candidate.box.y0 - mark.box.y0) <= POSITION_TOLERANCE
        ) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/** Share of a sent letter's characters found, in place, in a returned file. */
function matchShare(letter: Inventory, returned: TextIndex): number {
  if (letter.text.length === 0) return 0;
  const used = new Set<TextMark>();
  let found = 0;
  for (const mark of letter.text) {
    const match = findNear(returned, mark, used);
    if (match) {
      used.add(match);
      found += 1;
    }
  }
  return found / letter.text.length;
}

// --- comparing -----------------------------------------------------------

interface Comparison {
  readonly changed: string[];
  readonly review: string[];
  readonly additions: string[];
}

function compare(sent: Inventory, returned: Inventory): Comparison {
  const changed: string[] = [];
  const review: string[] = [];

  if (returned.pages.length !== sent.pages.length) {
    changed.push(
      `It has ${plural(returned.pages.length, 'page')}; the letter you sent had ${sent.pages.length}.`,
    );
  }
  const shared = Math.min(sent.pages.length, returned.pages.length);
  for (let i = 0; i < shared; i += 1) {
    const a = sent.pages[i] as PageGeometry;
    const b = returned.pages[i] as PageGeometry;
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) {
      changed.push(`Page ${i + 1} is a different size from the one you sent.`);
    } else if (!sameBox(a.crop, b.crop, 2) || a.rotation !== b.rotation || a.userUnit !== b.userUnit) {
      // A smaller visible area hides whatever falls outside it — a clause, a
      // salary — while every character stays in the file.
      changed.push(`Page ${i + 1}: the visible area of the page has been changed, which can hide part of it.`);
    }
  }

  if (returned.layers && !sent.layers) {
    review.push('It uses layers, which can show or hide parts of the page. Check it by eye.');
  }

  // Every character sent must still be there, in the same place, and still
  // visible. Present-but-hidden counts as changed: white text, invisible text
  // or text clipped away reads as gone, even though it is still in the file.
  const returnedIndex = indexText(returned);
  const used = new Set<TextMark>();
  const missing: TextMark[] = [];
  const hidden: TextMark[] = [];
  for (const mark of sent.text) {
    const match = findNear(returnedIndex, mark, used);
    if (!match) {
      missing.push(mark);
      continue;
    }
    used.add(match);
    if (mark.shown && (!match.shown || Math.abs(match.lightness - mark.lightness) > 0.35)) hidden.push(mark);
  }
  for (const [where, count] of regions(missing, sent.pages)) {
    changed.push(`${where}: ${plural(count, 'line')} of the original text ${count === 1 ? 'is' : 'are'} missing, moved or changed.`);
  }
  for (const [where, count] of regions(hidden, sent.pages)) {
    changed.push(`${where}: ${plural(count, 'line')} of the original text ${count === 1 ? 'has' : 'have'} been hidden or made invisible.`);
  }

  // Everything new: characters, and shapes, images and annotations that the
  // sent letter did not have. Additions nobody can see are left out.
  const addedText = returned.text.filter((mark) => !used.has(mark) && mark.shown);
  const addedDrawings = unmatchedDrawings(sent.drawings, returned.drawings).filter(
    (drawing) => drawing.info === undefined || (drawing.info.alpha >= 0.1 && visibleBox(drawing) !== null),
  );

  // Only text that is still there, and visible, can be covered. Text already
  // reported would otherwise be reported twice.
  const gone = new Set([...missing, ...hidden]);
  const protectedText = new TextGrid(
    sent.text.filter((mark) => !gone.has(mark) && mark.shown && !DECORATIVE.test(mark.text)),
  );
  const covering: { page: number; box: Box }[] = [];
  const coveredUp: { page: number; box: Box }[] = [];
  const uncheckable = new Set<number>();
  for (const drawing of addedDrawings) {
    const box = visibleBox(drawing);
    if (box === undefined) {
      uncheckable.add(drawing.page);
      continue;
    }
    if (box === null || !protectedText.covers(box, drawing.page)) continue;
    // A filled rectangle over the text, of any colour, or a pale fill of any
    // shape, hides it: correction fluid or a redaction bar. A signature is
    // neither — it is ink, and never a plain box.
    const place = { page: drawing.page, box };
    const info = drawing.info;
    const coverUp =
      drawing.kind === 'fill' &&
      info !== undefined &&
      info.alpha >= 0.5 &&
      (info.rectangles || info.lightness >= WHITEOUT_LIGHTNESS);
    if (coverUp) coveredUp.push(place);
    else covering.push(place);
  }
  for (const where of new Set(coveredUp.map((item) => describePlace(item.page, item.box, returned.pages)))) {
    changed.push(`${where}: some of the original text has been covered over.`);
  }
  for (const mark of addedText) {
    if (protectedText.covers(mark.box, mark.page)) covering.push(mark);
  }
  for (const where of new Set(covering.map((item) => describePlace(item.page, item.box, returned.pages)))) {
    review.push(`${where}: something added sits over the original text. Open the letter and check it is only a signature or initials.`);
  }
  for (const page of uncheckable) {
    review.push(`Page ${page}: has added shading or effects whose extent cannot be measured. Check that page by eye.`);
  }

  const additions: string[] = [];
  const textPlaces = new Set(addedText.map((mark) => describePlace(mark.page, mark.box, returned.pages)));
  for (const where of textPlaces) additions.push(`Text — ${lowerFirst(where)}`);
  const drawingPlaces = new Set<string>();
  for (const drawing of addedDrawings) {
    const box = visibleBox(drawing);
    if (box) drawingPlaces.add(describePlace(drawing.page, box, returned.pages));
  }
  for (const where of drawingPlaces) additions.push(`Signature or drawing — ${lowerFirst(where)}`);

  return { changed, review, additions };
}

/**
 * The part of a drawing that can be seen: its box cut down to its clip.
 * Undefined when its extent is unknown; null when the clip leaves nothing.
 */
function visibleBox(drawing: Drawing): Box | undefined | null {
  if (drawing.box === undefined) return undefined;
  const clip = drawing.info?.clip;
  if (clip === undefined) return drawing.box;
  const box = {
    x0: Math.max(drawing.box.x0, clip.x0),
    y0: Math.max(drawing.box.y0, clip.y0),
    x1: Math.min(drawing.box.x1, clip.x1),
    y1: Math.min(drawing.box.y1, clip.y1),
  };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

function unmatchedDrawings(sent: readonly Drawing[], returned: readonly Drawing[]): Drawing[] {
  // Bucketed by page and kind, so a file with many drawings is not compared
  // against every drawing of the letter one by one.
  const remaining = new Map<string, Drawing[]>();
  for (const drawing of sent) {
    const key = `${drawing.page}|${drawing.kind}`;
    const bucket = remaining.get(key);
    if (bucket) bucket.push(drawing);
    else remaining.set(key, [drawing]);
  }
  const added: Drawing[] = [];
  for (const drawing of returned) {
    const bucket = remaining.get(`${drawing.page}|${drawing.kind}`) ?? [];
    const index = bucket.findIndex((candidate) => sameBox(candidate.box, drawing.box));
    if (index >= 0) bucket.splice(index, 1);
    else added.push(drawing);
  }
  return added;
}

function sameBox(a: Box | undefined, b: Box | undefined, tolerance = POSITION_TOLERANCE): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    Math.abs(a.x0 - b.x0) <= tolerance &&
    Math.abs(a.y0 - b.y0) <= tolerance &&
    Math.abs(a.x1 - b.x1) <= tolerance &&
    Math.abs(a.y1 - b.y1) <= tolerance
  );
}

/**
 * Original characters indexed by area, so asking whether something covers
 * any of them looks only at the characters nearby.
 */
class TextGrid {
  static readonly CELL = 24;
  readonly #cells = new Map<string, TextMark[]>();

  constructor(marks: readonly TextMark[]) {
    for (const mark of marks) {
      for (const key of gridKeys(mark.page, mark.box)) {
        const cell = this.#cells.get(key);
        if (cell) cell.push(mark);
        else this.#cells.set(key, [mark]);
      }
    }
  }

  /** Whether a box covers a meaningful share of any indexed character. */
  covers(box: Box, page: number): boolean {
    for (const key of gridKeys(page, box)) {
      for (const mark of this.#cells.get(key) ?? []) {
        const area = (mark.box.x1 - mark.box.x0) * (mark.box.y1 - mark.box.y0);
        if (area > 0 && overlapArea(box, mark.box) / area >= COVER_THRESHOLD) return true;
      }
    }
    return false;
  }
}

/** Grid cells a box touches, clamped so a vast box costs no more than a page. */
function* gridKeys(page: number, box: Box): Generator<string> {
  const cell = (value: number): number => Math.floor(Math.max(-2000, Math.min(4000, value)) / TextGrid.CELL);
  for (let x = cell(box.x0); x <= cell(box.x1); x += 1) {
    for (let y = cell(box.y0); y <= cell(box.y1); y += 1) yield `${page}|${x}|${y}`;
  }
}

/** Group characters into lines, and count lines per page region. */
function regions(marks: readonly TextMark[], pages: readonly PageGeometry[]): Map<string, number> {
  const lines = new Map<string, Set<number>>();
  for (const mark of marks) {
    const where = describePlace(mark.page, mark.box, pages);
    const set = lines.get(where) ?? new Set<number>();
    set.add(Math.round(mark.box.y0 / 4));
    lines.set(where, set);
  }
  return new Map([...lines].map(([where, set]) => [where, set.size]));
}

/** "Page 2, near the bottom" — a place a person can find by looking. */
function describePlace(page: number, box: Box, pages: readonly PageGeometry[]): string {
  const height = pages[page - 1]?.height ?? 842;
  const fromTop = 1 - (box.y0 + box.y1) / 2 / height;
  const band = fromTop < 1 / 3 ? 'near the top' : fromTop < 2 / 3 ? 'in the middle' : 'near the bottom';
  return `Page ${page}, ${band}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
