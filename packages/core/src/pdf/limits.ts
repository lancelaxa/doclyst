import { Unzlib } from 'fflate';

/**
 * Limits on how much a PDF may decompress to before it is parsed.
 *
 * pdf-lib inflates object streams as it loads a file, with no limit of its
 * own, so a small file can ask for gigabytes of memory before any of
 * Doclyst's own code runs. These checks run on the raw bytes first.
 */

/** Raised when a file would inflate past the limit it was checked against. */
export class InflateLimitError extends Error {}

/**
 * Feed compressed data to an inflater a little at a time.
 *
 * Handed everything at once, the inflater produces the whole output before
 * its callback can object, so a limit checked there arrives after the memory
 * is already gone. Deflate expands at most about a thousandfold, so a 4 KB
 * slice can produce no more than about 4 MB before the limit is consulted.
 */
export function pushInSlices(inflater: Unzlib, data: Uint8Array): void {
  const SLICE = 4096;
  for (let offset = 0; offset < data.length; offset += SLICE) {
    inflater.push(data.subarray(offset, offset + SLICE), offset + SLICE >= data.length);
  }
  if (data.length === 0) inflater.push(data, true);
}

/**
 * Throw {@link InflateLimitError} if the file's compressed streams, taken
 * together, inflate past `limit` bytes.
 *
 * Works on the raw bytes: every `stream` keyword is followed to its
 * `endstream`, and anything that inflates is counted, never kept. This is a
 * guard rather than a parser, so it errs towards counting too much.
 */
export function preflightCompressedStreams(bytes: Uint8Array, limit: number): void {
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
      if (total > limit) throw new InflateLimitError();
    });
    try {
      pushInSlices(counter, bytes.subarray(start, end));
    } catch (error) {
      if (error instanceof InflateLimitError) throw error;
      // Not zlib, or not compressed at all: nothing to count.
    }
  }
}

const checked = new WeakSet<Uint8Array>();

/**
 * {@link preflightCompressedStreams}, done once per buffer.
 *
 * A batch fills the same template once per record, and inflating every
 * stream of a large letterhead five hundred times over to learn the same
 * answer would be pure waste.
 */
export function preflightOnce(bytes: Uint8Array, limit: number): void {
  if (checked.has(bytes)) return;
  preflightCompressedStreams(bytes, limit);
  checked.add(bytes);
}

function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return result;
}
