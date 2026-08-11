import { unzlibSync } from 'fflate';

/**
 * Read back what a rendered PDF actually contains.
 *
 * Asserting on the drawn text rather than on the model is what makes these
 * tests worth having: it catches a document that lays out but shows nothing,
 * which is precisely the failure someone would only notice after sending it.
 *
 * Only what the renderer emits needs to be understood — pdf-lib writes each
 * word as a hex string followed by `Tj`, and puts both content and objects in
 * Flate-compressed streams — so this is deliberately not a general PDF parser.
 */

/** Every Flate-compressed stream in the file, decompressed and concatenated. */
function inflatedStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const streams: string[] = [];

  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start < 0) break;

    let begin = start + 'stream'.length;
    if (raw[begin] === 0x0d) begin += 1;
    if (raw[begin] === 0x0a) begin += 1;

    const end = raw.indexOf('endstream', begin);
    if (end < 0) break;

    try {
      streams.push(Buffer.from(unzlibSync(raw.subarray(begin, end))).toString('latin1'));
    } catch {
      // Not a compressed stream; nothing this helper needs is in it.
    }
    cursor = end + 'endstream'.length;
  }

  return streams.join('\n');
}

/**
 * The text a PDF draws, in drawing order, with a newline at each line break.
 *
 * The renderer drops the space at a wrap point — correctly, since the line
 * ends there — so a plain concatenation would fuse the last word of one line
 * to the first of the next. The text matrix carries the position of every
 * word, and a change in its `y` is exactly where a new line begins.
 */
export function pdfText(bytes: Uint8Array): string {
  const content = inflatedStreams(bytes);
  const shown: string[] = [];
  let lastY: string | undefined;

  const showText = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = showText.exec(content)) !== null) {
    const y = match[2];
    if (lastY !== undefined && y !== lastY) shown.push('\n');
    lastY = y;
    shown.push(Buffer.from(match[3] ?? '', 'hex').toString('latin1'));
  }
  return shown.join('');
}

/** Base fonts a PDF references, e.g. `Helvetica-BoldOblique`. */
export function pdfFonts(bytes: Uint8Array): string[] {
  const names = new Set<string>();
  const baseFont = /\/BaseFont\s*\/([A-Za-z-]+)/g;
  let match: RegExpExecArray | null;
  const content = inflatedStreams(bytes);
  while ((match = baseFont.exec(content)) !== null) names.add(match[1] ?? '');
  return [...names].sort();
}

/** Number of pages, counted from the page objects the renderer emitted. */
export function pdfPageCount(bytes: Uint8Array): number {
  const count = /\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/.exec(inflatedStreams(bytes));
  return count ? Number.parseInt(count[1] ?? '0', 10) : 0;
}
