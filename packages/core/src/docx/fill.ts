import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { FIXED_ARCHIVE_TIMESTAMP } from '../internal/deterministic.js';
import { withChosenLevel, type ZipEntryInput } from '../internal/compression.js';
import { DoclystError, safeErrorSummary } from '../errors.js';
import { extractFieldNames } from '../template/placeholder.js';
import {
  extractTextFromXml,
  extractVisibleText,
  replacePlaceholdersInXml,
  type PlaceholderResolver,
} from './wordxml.js';
import { acceptRevisionsAndDropHidden } from './revisions.js';

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
    for (const field of extractFieldNames(extractTextFromXml(acceptRevisionsAndDropHidden(strFromU8(bytes))))) {
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
  return extractVisibleText(acceptRevisionsAndDropHidden(strFromU8(body)));
}

/**
 * Describe what a template loads from outside itself when it is opened.
 *
 * A picture inserted with "Link to File", or an object linked rather than
 * embedded, is fetched by the recipient's copy of Word each time the letter
 * is opened — from a web address, which then learns who opened it and when,
 * or from a network share, to which Windows may send the recipient's sign-in
 * details. For people outside the organisation it does not even work: the
 * share is unreachable and the logo shows as a red cross.
 *
 * Doclyst cannot fetch the content to embed it, and removing the link would
 * leave a broken picture, so this is reported before anything is generated.
 * Clickable hyperlinks are left out: they go nowhere until clicked.
 */
export function readLinkedContent(template: Uint8Array): string[] {
  const found = new Set<string>();
  for (const [name, bytes] of Object.entries(openDocx(template))) {
    if (!/(^|\/)_rels\/[^/]+\.rels$/.test(name)) continue;
    for (const element of strFromU8(bytes).match(/<Relationship\b[^>]*>/g) ?? []) {
      if (!/TargetMode\s*=\s*"External"/.test(element)) continue;
      const type = /Type\s*=\s*"[^"]*\/([^"/]+)"/.exec(element)?.[1] ?? '';
      if (type === 'hyperlink') continue;
      // Removed from every generated document already; see scrubPackageXml.
      if (type === 'attachedTemplate') continue;
      found.add(
        type === 'image'
          ? 'a picture linked rather than embedded'
          : type === 'oleObject' || type === 'package'
            ? 'an object linked to an outside file'
            : type === 'subDocument' || type === 'frame' || type === 'aFChunk'
              ? 'content pulled in from an outside file'
              : 'a link to an outside file or address',
      );
    }
  }
  return [...found];
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

  const scrub = options.scrubMetadata ?? true;
  for (const [name, bytes] of Object.entries(entries)) {
    if (scrub && AUTHOR_ONLY_PART_RE.test(name)) continue;
    if (TEXT_PART_RE.test(name)) {
      const xml = acceptRevisionsAndDropHidden(strFromU8(bytes));
      textParts.set(name, scrub ? scrubAuthorshipXml(xml) : xml);
    } else if (scrub && isMetadataPart(name)) {
      staticParts.set(name, withChosenLevel(strToU8(scrubMetadataXml(name, strFromU8(bytes)))));
    } else if (scrub && isPackageStructurePart(name)) {
      staticParts.set(name, withChosenLevel(strToU8(scrubPackageXml(name, strFromU8(bytes)))));
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
 * Parts that hold nothing but the template author's own material, and are
 * dropped from every generated document.
 *
 * Review comments are the one that matters most: Word shows them in the
 * margin, so "Is this salary band right?" left on the template would be read
 * by every person the letter is sent to. The people part lists each
 * commenter, often with their email address, and custom properties carry
 * whatever the author's organisation stamps on its files.
 */
const AUTHOR_ONLY_PART_RE =
  /^(word\/(comments|commentsExtended|commentsIds|commentsExtensible|people)\.xml|docProps\/custom\.xml)$/;

/** Relationship types that point at a dropped part, or at the author's machine. */
const AUTHOR_ONLY_RELATIONSHIP_RE =
  /\/(comments|commentsExtended|commentsIds|commentsExtensible|people|custom-properties|attachedTemplate)"/;

function isPackageStructurePart(name: string): boolean {
  return name === '[Content_Types].xml' || name === 'word/settings.xml' || /(^|\/)_rels\/[^/]+\.rels$/.test(name);
}

/**
 * Keep the package consistent once author-only parts are gone.
 *
 * A relationship or content-type entry left pointing at a removed part makes
 * Word report the file as damaged. The attached-template reference goes too:
 * it is a path on the author's machine — `C:\Users\<name>\...` — and is of no
 * use to anyone who receives the letter.
 */
function scrubPackageXml(name: string, xml: string): string {
  if (name === '[Content_Types].xml') {
    return xml.replace(/<Override\b[^>]*PartName="\/(word\/(comments|commentsExtended|commentsIds|commentsExtensible|people)|docProps\/custom)\.xml"[^>]*\/>/g, '');
  }
  if (name === 'word/settings.xml') {
    return xml.replace(/<w:attachedTemplate\b[^>]*\/>/g, '');
  }
  return xml.replace(/<Relationship\b[^>]*>/g, (element) =>
    AUTHOR_ONLY_RELATIONSHIP_RE.test(element) ? '' : element,
  );
}

/**
 * Remove the author's traces from a text part: the anchors of the comments
 * just dropped, and the names and times on tracked changes.
 *
 * The anchors have to go with the comments — a reference to a comment that
 * no longer exists is another thing Word reports as damage. Tracked-change
 * authors are blanked rather than removed, because the attribute is required.
 */
function scrubAuthorshipXml(xml: string): string {
  return xml
    .replace(/<w:comment(RangeStart|RangeEnd|Reference)\b[^>]*\/>/g, '')
    .replace(/\sw:author="[^"]*"/g, ' w:author=""')
    .replace(/\sw:initials="[^"]*"/g, '')
    .replace(/\sw:date="[^"]*"/g, '');
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
