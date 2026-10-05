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
import {
  IDENTITY,
  multiply,
  readGlyphs,
  readResourceFonts,
  type Box,
  type Matrix,
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
}

interface Drawing {
  readonly page: number;
  readonly kind: 'fill' | 'stroke' | 'image' | 'annotation';
  /** Undefined when the extent cannot be known, as for a shading. */
  readonly box: Box | undefined;
  /** For a fill, how light it is: 0 black, 1 white. */
  readonly lightness?: number;
}

interface PageSize {
  readonly width: number;
  readonly height: number;
}

interface Inventory {
  readonly pages: readonly PageSize[];
  readonly text: readonly TextMark[];
  readonly drawings: readonly Drawing[];
}

class EncryptedError extends Error {}

/** Deepest nesting of form XObjects followed before giving up. */
const MAX_FORM_DEPTH = 8;

/**
 * Read everything a document draws: each character, each painted shape, each
 * image, and each visible annotation, with where it sits on its page.
 *
 * Form XObjects are followed, which matters more than it might seem: a
 * flattened form field is drawn from one, so the very values a letter was
 * filled with — the name and the salary — live there and nowhere else.
 */
async function readInventory(bytes: Uint8Array): Promise<Inventory> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof Error && /encrypt/i.test(error.message)) throw new EncryptedError();
    throw error;
  }

  const pages: PageSize[] = [];
  const text: TextMark[] = [];
  const drawings: Drawing[] = [];

  document.getPages().forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const { width, height } = page.getSize();
    pages.push({ width, height });

    const visit = (content: string, resources: PDFDict | undefined, ctm: Matrix, depth: number, seen: Set<PDFRef | PDFRawStream>): void => {
      const fonts = readResourceFonts(resources);
      const glyphs = readGlyphs(content, fonts, {
        ctm,
        onPaint: (box, kind, lightness) =>
          drawings.push(kind === 'fill' ? { page: pageNumber, kind, box, lightness } : { page: pageNumber, kind, box }),
        onXObject: (name, at) => {
          const xobjects = resources?.lookup(PDFName.of('XObject'));
          if (!(xobjects instanceof PDFDict)) return;
          const ref = xobjects.get(PDFName.of(name));
          const stream = xobjects.lookup(PDFName.of(name));
          if (!(stream instanceof PDFRawStream)) return;
          const key = ref instanceof PDFRef ? ref : stream;
          if (seen.has(key)) return;

          const subtype = stream.dict.lookup(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            drawings.push({ page: pageNumber, kind: 'image', box: transformBox({ x0: 0, y0: 0, x1: 1, y1: 1 }, at) });
            return;
          }
          if (subtype !== PDFName.of('Form') || depth >= MAX_FORM_DEPTH) return;

          let inner: string;
          try {
            inner = latin1(decodePDFRawStream(stream).decode());
          } catch {
            return;
          }
          const matrix = readMatrix(stream.dict.lookup(PDFName.of('Matrix')));
          const own = stream.dict.lookup(PDFName.of('Resources'));
          const next = new Set(seen);
          next.add(key);
          visit(inner, own instanceof PDFDict ? own : resources, multiply(matrix, at), depth + 1, next);
        },
      });

      for (const glyph of glyphs) {
        if (glyph.text.trim() === '') continue;
        const left = Math.min(glyph.x, glyph.x + glyph.width);
        const right = Math.max(glyph.x, glyph.x + glyph.width);
        text.push({
          page: pageNumber,
          text: glyph.text,
          box: { x0: left, y0: glyph.y - glyph.size * 0.2, x1: right, y1: glyph.y + glyph.size * 0.8 },
        });
      }
    };

    visit(pageContent(page.node.Contents()), page.node.Resources(), IDENTITY, 0, new Set());

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

        // What an annotation shows is its appearance stream, so that is what
        // is read: a white box drawn by a text annotation is a white box, and
        // a signature is the strokes it is made of rather than the generous
        // rectangle around them, which would reach into the text nearby.
        const appearance = normalAppearance(annotation);
        if (appearance === undefined) {
          drawings.push({ page: pageNumber, kind: 'annotation', box: rect });
          continue;
        }
        let inner: string;
        try {
          inner = latin1(decodePDFRawStream(appearance).decode());
        } catch {
          drawings.push({ page: pageNumber, kind: 'annotation', box: rect });
          continue;
        }
        const own = appearance.dict.lookup(PDFName.of('Resources'));
        visit(inner, own instanceof PDFDict ? own : page.node.Resources(), appearanceMatrix(appearance, rect), 1, new Set([appearance]));
      }
    }
  });

  return { pages, text, drawings };
}

function pageContent(contents: unknown): string {
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = contents.lookup(i);
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams
    .map((stream) => {
      try {
        return latin1(decodePDFRawStream(stream).decode());
      } catch {
        return '';
      }
    })
    .join('\n');
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
    const a = sent.pages[i] as PageSize;
    const b = returned.pages[i] as PageSize;
    if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) {
      changed.push(`Page ${i + 1} is a different size from the one you sent.`);
    }
  }

  // Every character sent must still be there, in the same place.
  const returnedIndex = indexText(returned);
  const used = new Set<TextMark>();
  const missing: TextMark[] = [];
  for (const mark of sent.text) {
    const match = findNear(returnedIndex, mark, used);
    if (match) used.add(match);
    else missing.push(mark);
  }
  for (const [where, count] of regions(missing, sent.pages)) {
    changed.push(`${where}: ${plural(count, 'line')} of the original text ${count === 1 ? 'is' : 'are'} missing, moved or changed.`);
  }

  // Everything new: characters, and shapes, images and annotations that the
  // sent letter did not have.
  const addedText = returned.text.filter((mark) => !used.has(mark));
  const addedDrawings = unmatchedDrawings(sent.drawings, returned.drawings);

  // Only text that is still there can be covered. Text already reported
  // missing would otherwise be reported twice — once as gone, and again as
  // "covered" by whatever now stands in its place.
  const present = new Set(sent.text.filter((mark) => !missing.includes(mark)));
  const protectedText = [...present].filter((mark) => !DECORATIVE.test(mark.text));
  const covering: { page: number; box: Box }[] = [];
  const coveredUp: { page: number; box: Box }[] = [];
  const uncheckable = new Set<number>();
  for (const drawing of addedDrawings) {
    if (drawing.box === undefined) uncheckable.add(drawing.page);
    else if (covers(drawing.box, drawing.page, protectedText)) {
      // A pale, filled shape over the text hides it: correction fluid, in
      // effect. A signature is ink, never white, so this is not a judgement
      // call the way a stroke crossing a printed name is.
      const place = { page: drawing.page, box: drawing.box };
      if (drawing.kind === 'fill' && (drawing.lightness ?? 0) >= WHITEOUT_LIGHTNESS) coveredUp.push(place);
      else covering.push(place);
    }
  }
  for (const where of new Set(coveredUp.map((item) => describePlace(item.page, item.box, returned.pages)))) {
    changed.push(`${where}: some of the original text has been covered over.`);
  }
  for (const mark of addedText) {
    if (covers(mark.box, mark.page, protectedText)) covering.push(mark);
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
  const drawingPlaces = new Set(
    addedDrawings
      .filter((drawing) => drawing.box !== undefined)
      .map((drawing) => describePlace(drawing.page, drawing.box as Box, returned.pages)),
  );
  for (const where of drawingPlaces) additions.push(`Signature or drawing — ${lowerFirst(where)}`);

  return { changed, review, additions };
}

function unmatchedDrawings(sent: readonly Drawing[], returned: readonly Drawing[]): Drawing[] {
  const remaining = [...sent];
  const added: Drawing[] = [];
  for (const drawing of returned) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.page === drawing.page &&
        candidate.kind === drawing.kind &&
        sameBox(candidate.box, drawing.box),
    );
    if (index >= 0) remaining.splice(index, 1);
    else added.push(drawing);
  }
  return added;
}

function sameBox(a: Box | undefined, b: Box | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    Math.abs(a.x0 - b.x0) <= POSITION_TOLERANCE &&
    Math.abs(a.y0 - b.y0) <= POSITION_TOLERANCE &&
    Math.abs(a.x1 - b.x1) <= POSITION_TOLERANCE &&
    Math.abs(a.y1 - b.y1) <= POSITION_TOLERANCE
  );
}

/** Whether a box covers a meaningful share of any original character. */
function covers(box: Box, page: number, text: readonly TextMark[]): boolean {
  return text.some((mark) => {
    if (mark.page !== page) return false;
    const width = Math.min(box.x1, mark.box.x1) - Math.max(box.x0, mark.box.x0);
    const height = Math.min(box.y1, mark.box.y1) - Math.max(box.y0, mark.box.y0);
    if (width <= 0 || height <= 0) return false;
    const area = (mark.box.x1 - mark.box.x0) * (mark.box.y1 - mark.box.y0);
    return area > 0 && (width * height) / area >= COVER_THRESHOLD;
  });
}

/** Group characters into lines, and count lines per page region. */
function regions(marks: readonly TextMark[], pages: readonly PageSize[]): Map<string, number> {
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
function describePlace(page: number, box: Box, pages: readonly PageSize[]): string {
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
