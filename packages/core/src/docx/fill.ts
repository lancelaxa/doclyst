import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { FIXED_ARCHIVE_TIMESTAMP } from '../internal/deterministic.js';
import { withChosenLevel, type ZipEntryInput } from '../internal/compression.js';
import { DoclystError, safeErrorSummary } from '../errors.js';
import { extractFieldNames } from '../template/placeholder.js';
import { extractTextFromXml, replacePlaceholdersInXml, type PlaceholderResolver } from './wordxml.js';

/**
 * DOCX template filling.
 *
 * A .docx is a ZIP of XML parts. Placeholders are substituted in every part
 * that can hold visible text — the body, and also headers, footers and notes,
 * which is where letterhead fields such as `{{DATE}}` and `{{REF_NO}}` usually
 * live. Parts that are not text (styles, images, relationships) are copied
 * through byte-for-byte, so the output differs from the template only where a
 * placeholder stood.
 */

/** Parts whose text content is substituted. */
const TEXT_PART_RE = /^word\/(document\d*|header\d+|footer\d+|footnotes|endnotes)\.xml$/;

/** Cap on total decompressed template size, as a zip-bomb guard. */
export const MAX_TEMPLATE_BYTES = 200 * 1024 * 1024;

export interface DocxFillOptions {
  /**
   * Remove authorship metadata from the generated file. On by default: the
   * template's author, company and revision history are the template owner's
   * details, and they should not ride along on a document sent to each of
   * hundreds of data subjects.
   */
  readonly scrubMetadata?: boolean;
}

/** Read a DOCX and return the distinct placeholder field names it contains. */
export function readDocxFields(template: Uint8Array): string[] {
  const entries = openDocx(template);
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!TEXT_PART_RE.test(name)) continue;
    // Field discovery must stitch runs back together exactly as filling does.
    // Scanning the raw XML would miss every placeholder Word had split across
    // runs — which is most of them in a real template — so `inspect` would
    // report a working template as having no fields.
    for (const field of extractFieldNames(extractTextFromXml(strFromU8(bytes)))) {
      const key = field.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(field);
    }
  }
  return fields;
}

/** Extract the visible text of a DOCX, mainly for tests and previews. */
export function readDocxText(template: Uint8Array): string {
  const entries = openDocx(template);
  const body = entries['word/document.xml'];
  if (!body) {
    throw new DoclystError('INVALID_TEMPLATE', 'The DOCX file has no word/document.xml part.');
  }
  return extractTextFromXml(strFromU8(body));
}

export interface DocxFillResult {
  readonly bytes: Uint8Array;
  /** Number of placeholder occurrences replaced across all parts. */
  readonly replaced: number;
}

/**
 * A template that has been unzipped, validated and scrubbed once.
 *
 * Filling a template is dominated by archive work, and in a batch every record
 * re-reads the *same* template. Doing that once and keeping the parts — along
 * with each part's compression level, which is probed here rather than on
 * every record — takes the repeated cost down to substituting the text parts
 * and writing the archive.
 */
export interface PreparedDocx {
  /** Parts that carry no placeholders, ready to write with a fixed level. */
  readonly staticParts: ReadonlyMap<string, ZipEntryInput>;
  /** Decoded XML of the parts that need substitution. */
  readonly textParts: ReadonlyMap<string, string>;
}

/** Unzip, validate and scrub a template so a batch can reuse the result. */
export function prepareDocx(template: Uint8Array, options: DocxFillOptions = {}): PreparedDocx {
  const entries = openDocx(template);
  const staticParts = new Map<string, ZipEntryInput>();
  const textParts = new Map<string, string>();

  for (const [name, bytes] of Object.entries(entries)) {
    if (TEXT_PART_RE.test(name)) {
      textParts.set(name, strFromU8(bytes));
    } else if ((options.scrubMetadata ?? true) && isMetadataPart(name)) {
      staticParts.set(name, withChosenLevel(strToU8(scrubMetadataXml(name, strFromU8(bytes)))));
    } else {
      staticParts.set(name, withChosenLevel(bytes));
    }
  }

  return { staticParts, textParts };
}

/** Fill a template that has already been prepared. */
export function fillPreparedDocx(
  prepared: PreparedDocx,
  resolve: PlaceholderResolver,
): DocxFillResult {
  const output: Record<string, Uint8Array | ZipEntryInput> = {};
  let replaced = 0;

  for (const [name, entry] of prepared.staticParts) {
    output[name] = entry;
  }
  for (const [name, xml] of prepared.textParts) {
    const result = replacePlaceholdersInXml(xml, resolve);
    replaced += result.replaced;
    output[name] = strToU8(result.xml);
  }

  const bytes = zipSync(output, { level: 6, mtime: FIXED_ARCHIVE_TIMESTAMP });
  return { bytes, replaced };
}

/**
 * Fill a DOCX template, resolving each placeholder through `resolve`.
 *
 * Convenience for one-off use. To fill many records from one template, call
 * {@link prepareDocx} once and {@link fillPreparedDocx} per record.
 */
export function fillDocx(
  template: Uint8Array,
  resolve: PlaceholderResolver,
  options: DocxFillOptions = {},
): DocxFillResult {
  return fillPreparedDocx(prepareDocx(template, options), resolve);
}

/** Unzip a DOCX, rejecting anything that is not a plausible Word document. */
function openDocx(template: Uint8Array): Record<string, Uint8Array> {
  if (template.length < 4 || template[0] !== 0x50 || template[1] !== 0x4b) {
    throw new DoclystError(
      'INVALID_TEMPLATE',
      'The file is not a valid DOCX (it is not a ZIP archive).',
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    let total = 0;
    entries = unzipSync(template, {
      filter: (file) => {
        // `originalSize` is read from the archive's own header, so it is a
        // claim rather than a fact; it is still worth checking, because it
        // rejects an obvious zip bomb before any of it is decompressed.
        total += file.originalSize ?? 0;
        if (total > MAX_TEMPLATE_BYTES) {
          throw new DoclystError(
            'LIMIT_EXCEEDED',
            'The DOCX template expands to more than the supported size limit.',
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DoclystError) throw error;
    throw new DoclystError(
      'INVALID_TEMPLATE',
      `The DOCX template could not be read: ${safeErrorSummary(error)}.`,
      { cause: error },
    );
  }

  for (const name of Object.keys(entries)) {
    assertSafeEntryName(name);
  }

  if (!entries['word/document.xml']) {
    throw new DoclystError(
      'INVALID_TEMPLATE',
      'The file is not a valid DOCX (word/document.xml is missing).',
    );
  }
  return entries;
}

/**
 * Reject archive entry names that would escape the extraction root.
 *
 * Doclyst keeps parts in memory rather than extracting to disk, so this is
 * defence in depth: it stops a malicious name from reaching a future code
 * path — or a downstream consumer of our output — that does write to disk.
 */
function assertSafeEntryName(name: string): void {
  const unsafe =
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[/\\]/).some((segment) => segment === '..') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001F\u007F]/.test(name);
  if (unsafe) {
    throw new DoclystError(
      'UNSAFE_PATH',
      'The DOCX template contains an archive entry with an unsafe path and was rejected.',
    );
  }
}

function isMetadataPart(name: string): boolean {
  return name === 'docProps/core.xml' || name === 'docProps/app.xml';
}

/**
 * Blank out the identifying fields of the Office metadata parts.
 *
 * Element *structure* is preserved (values are emptied, tags are not removed)
 * because Word is stricter about a missing required element than an empty one.
 */
function scrubMetadataXml(name: string, xml: string): string {
  const fields =
    name === 'docProps/core.xml'
      ? ['dc:creator', 'cp:lastModifiedBy', 'cp:lastPrinted', 'dc:description', 'cp:category']
      : ['Company', 'Manager'];

  let out = xml;
  for (const field of fields) {
    // Matches `<field ...>value</field>`, keeping the opening tag's attributes
    // (they can carry required namespace declarations) and dropping the value.
    const element = new RegExp(`<${field}(\\s[^>]*)?>[\\s\\S]*?</${field}>`, 'g');
    out = out.replace(element, (_whole, attrs: string | undefined) =>
      `<${field}${attrs ?? ''}></${field}>`,
    );
    // The self-closing form `<field/>` already holds no value, so it is left
    // alone rather than rewritten.
  }
  return out;
}
