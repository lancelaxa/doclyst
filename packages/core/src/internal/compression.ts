import { deflateSync } from 'fflate';

/**
 * Per-entry compression choice for the archives Doclyst writes.
 *
 * A .docx is mostly XML, which deflates well, plus embedded media — PNGs,
 * JPEGs, fonts — which are already compressed and gain nothing from a second
 * pass. Deflating those again costs real time and returns marginally *larger*
 * output, because deflate adds framing to incompressible data.
 *
 * That matters here because a batch re-writes the template's unchanged parts
 * once per record. Measured on a template with a 400 KB image, storing the
 * incompressible parts instead of deflating them made archive writing roughly
 * four times faster while leaving the output slightly smaller.
 */

/** Deflate level used for parts that actually compress. */
export const DEFLATE_LEVEL = 6;

/** No compression: the entry is stored verbatim. */
export const STORE_LEVEL = 0;

/** Bytes of a part examined when estimating compressibility. */
const SAMPLE_BYTES = 64 * 1024;

/** Below this, the choice cannot matter enough to be worth probing. */
const MIN_PROBE_BYTES = 512;

/**
 * Ratio at or above which a part is treated as incompressible.
 *
 * Deliberately close to 1: the only case worth storing is one where deflate
 * buys essentially nothing, and misjudging in that direction costs a little
 * size, while misjudging the other way costs time on every record.
 */
const INCOMPRESSIBLE_RATIO = 0.95;

/**
 * Pick a compression level for one archive entry.
 *
 * Decided by probing a prefix rather than by matching file extensions, so it
 * stays correct for media types nobody thought to list and for parts that are
 * already compressed for some other reason.
 */
export function chooseCompressionLevel(bytes: Uint8Array): 0 | 6 {
  if (bytes.length < MIN_PROBE_BYTES) return DEFLATE_LEVEL;

  const sample = bytes.length > SAMPLE_BYTES ? bytes.subarray(0, SAMPLE_BYTES) : bytes;
  // Level 1 is enough to tell "this compresses" from "this does not", and is
  // markedly cheaper than probing at the level actually used.
  const probe = deflateSync(sample, { level: 1 });

  return probe.length >= sample.length * INCOMPRESSIBLE_RATIO ? STORE_LEVEL : DEFLATE_LEVEL;
}

/** An entry paired with its chosen level, in the shape `zipSync` accepts. */
export type ZipEntryInput = [Uint8Array, { level: 0 | 6 }];

/** Pair an entry with a probed compression level. */
export function withChosenLevel(bytes: Uint8Array): ZipEntryInput {
  return [bytes, { level: chooseCompressionLevel(bytes) }];
}
