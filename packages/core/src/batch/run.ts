import { DoclystError, safeErrorSummary } from '../errors.js';
import { fillPreparedDocx, prepareDocx, readDocxFields, type DocxFillOptions, type PreparedDocx } from '../docx/fill.js';
import { extractDocumentModel } from '../docx/model.js';
import { replacePlaceholdersInXml } from '../docx/wordxml.js';
import { renderModelToPdf, type PdfRenderOptions } from '../pdf/render.js';
import { fillPdf, readPdfFields, type PdfFillOptions } from '../pdf/fill.js';
import { normalizeKey } from '../template/placeholder.js';
import { ValueResolver, type MissingValuePolicy } from '../template/values.js';
import type { DataRecord } from '../data/records.js';
import { buildFilename, checkFilenameTemplate, dedupeFilename, type FilenameWarning } from './filename.js';

/** Template formats Doclyst can fill. */
export type TemplateKind = 'docx' | 'pdf';

export interface Template {
  readonly kind: TemplateKind;
  readonly bytes: Uint8Array;
}

/** Identify a template by its magic bytes rather than by its file extension. */
export function detectTemplateKind(bytes: Uint8Array): TemplateKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'docx';
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf';
  }
  throw new DoclystError(
    'UNSUPPORTED_TEMPLATE',
    'The template must be a .docx or .pdf file. The uploaded file is neither.',
  );
}

/** List the fields a template expects, as placeholder keys. */
export async function readTemplateFields(template: Template): Promise<string[]> {
  return template.kind === 'docx' ? readDocxFields(template.bytes) : readPdfFields(template.bytes);
}

/** File format the batch produces. */
export type OutputFormat = 'docx' | 'pdf';

export interface BatchOptions {
  readonly missing?: MissingValuePolicy;
  /**
   * Format to write. Defaults to matching the template.
   *
   * A DOCX template can produce PDF: the filled document is re-typeset rather
   * than converted, because converting Word layout needs a layout engine that
   * cannot run in a browser. A PDF template always produces PDF.
   */
  readonly outputFormat?: OutputFormat;
  /** Typesetting options, used only when a DOCX template produces PDF. */
  readonly pdfRender?: PdfRenderOptions;
  readonly treatEmptyAsMissing?: boolean;
  /** Filename template, e.g. `{{STAFF_ID}}-offer`. Defaults to `document-0001`. */
  readonly filenameTemplate?: string;
  readonly docx?: DocxFillOptions;
  readonly pdf?: PdfFillOptions;
  /**
   * Stop the whole batch at the first failing record. Off by default: with 500
   * rows, an operator is far better served by 499 documents plus a precise
   * list of what failed than by an all-or-nothing abort on row 3.
   */
  readonly stopOnError?: boolean;
  /**
   * Invoked after each record so callers can show progress.
   *
   * May return a promise, which is awaited. A UI needs that: filling is
   * otherwise a tight synchronous loop that would freeze the page for the
   * whole batch, and yielding here lets it paint between records.
   */
  readonly onProgress?: (completed: number, total: number) => void | Promise<void>;
}

/** One successfully generated document. */
export interface GeneratedDocument {
  /** 1-based row number in the source data. */
  readonly row: number;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** A record that could not be rendered. Carries no personal data. */
export interface BatchFailure {
  /** 1-based row number in the source data. */
  readonly row: number;
  readonly code: string;
  /** Safe to display and to log; describes the problem, never the value. */
  readonly message: string;
  readonly field?: string;
}

export interface BatchResult {
  readonly documents: readonly GeneratedDocument[];
  readonly failures: readonly BatchFailure[];
  /**
   * Template features that could not be carried into a re-typeset PDF, such
   * as tables or images. Empty unless a DOCX template produced PDF.
   */
  readonly unsupported: readonly string[];
  /**
   * PDF form fields whose text had to be shrunk to fit the box the template
   * gives them. Field names only, never values.
   */
  readonly shrunkFields: readonly string[];
  /** Template fields with no matching column, as normalized keys. */
  readonly unmatchedFields: readonly string[];
  readonly warnings: readonly FilenameWarning[];
}

/** One event from a streaming batch. */
export type BatchEvent =
  | { readonly type: 'document'; readonly document: GeneratedDocument }
  | { readonly type: 'failure'; readonly failure: BatchFailure };

/** What a streaming batch reports once every record has been attempted. */
export interface BatchSummary {
  readonly generated: number;
  readonly failed: number;
  /**
   * Template features that could not be carried into a re-typeset PDF, such
   * as tables or images. Empty unless a DOCX template produced PDF.
   */
  readonly unsupported: readonly string[];
  /**
   * PDF form fields whose text had to be shrunk to fit the box the template
   * gives them. Field names only, never values.
   */
  readonly shrunkFields: readonly string[];
  /** Template fields with no matching column, as normalized keys. */
  readonly unmatchedFields: readonly string[];
  readonly warnings: readonly FilenameWarning[];
}

/**
 * Render one document per record, yielding each as it is produced.
 *
 * This is the real implementation; {@link runBatch} is a thin collector over
 * it. Yielding rather than accumulating is what lets a caller write each
 * document straight to disk and keep peak memory flat, instead of holding the
 * whole batch — which for hundreds of image-heavy documents is the difference
 * between working and exhausting the tab.
 *
 * Failures are yielded rather than thrown, so one malformed record does not
 * discard the work already done for the rest of the batch. A malformed
 * *template* still throws, before any record is attempted.
 */
export async function* streamBatch(
  template: Template,
  records: readonly DataRecord[],
  options: BatchOptions = {},
): AsyncGenerator<BatchEvent, BatchSummary, void> {
  const takenNames = new Set<string>();
  const unmatched = new Set<string>();
  const shrunk = new Set<string>();
  let generated = 0;
  let failed = 0;

  const warnings = options.filenameTemplate
    ? checkFilenameTemplate(options.filenameTemplate)
    : [];

  // A PDF template can only produce PDF; a DOCX template does whichever the
  // caller asked for.
  const format: OutputFormat =
    template.kind === 'pdf' ? 'pdf' : (options.outputFormat ?? 'docx');
  const extension = format === 'pdf' ? '.pdf' : '.docx';

  // Unzip, validate and scrub the template once rather than per record. A
  // malformed template still fails here, before any row is attempted.
  const prepared: PreparedDocx | undefined =
    template.kind === 'docx' ? prepareDocx(template.bytes, options.docx ?? {}) : undefined;

  // The body XML is the one part re-typesetting needs, and the features it
  // cannot represent are the same for every record, so they are found once.
  const bodyXml = prepared?.textParts.get('word/document.xml');
  const unsupported = prepared && format === 'pdf' ? unsupportedForPdf(prepared) : [];

  for (let i = 0; i < records.length; i += 1) {
    const row = i + 1;
    const record = records[i] as DataRecord;

    try {
      const resolver = new ValueResolver(record, {
        missing: options.missing ?? 'error',
        treatEmptyAsMissing: options.treatEmptyAsMissing ?? false,
        row,
      });
      const resolve = (key: string, original: string): string => resolver.resolve(key, original);

      let bytes: Uint8Array;
      if (prepared !== undefined && format === 'pdf') {
        // Substitute into the body XML and typeset the result directly. This
        // skips building a .docx that would only be thrown away.
        const substituted = replacePlaceholdersInXml(bodyXml ?? '', resolve).xml;
        bytes = await renderModelToPdf(extractDocumentModel(substituted), {
          ...(options.pdfRender ?? {}),
          scrubMetadata: options.docx?.scrubMetadata ?? true,
        });
      } else if (prepared !== undefined) {
        bytes = fillPreparedDocx(prepared, resolve).bytes;
      } else {
        const filled = await fillPdf(template.bytes, resolve, options.pdf ?? {});
        bytes = filled.bytes;
        // Which fields were tight is a property of the template, not the row,
        // so it is collected once for the batch rather than repeated per record.
        for (const field of filled.shrunkFields) shrunk.add(field);
      }

      for (const key of resolver.missingKeys) unmatched.add(key);

      const filename = dedupeFilename(
        buildFilename(record, {
          template: options.filenameTemplate,
          extension,
          index: row,
          total: records.length,
        }),
        takenNames,
      );

      generated += 1;
      yield { type: 'document', document: { row, filename, bytes } };
    } catch (error) {
      failed += 1;
      yield { type: 'failure', failure: toFailure(row, error) };
      if (options.stopOnError) break;
    }

    await options.onProgress?.(row, records.length);
  }

  return {
    generated,
    failed,
    unsupported,
    shrunkFields: [...shrunk],
    unmatchedFields: [...unmatched].map(normalizeKey),
    warnings,
  };
}

/**
 * Render one document per record, collecting the whole batch in memory.
 *
 * Convenient when the results are wanted together — to build a ZIP, or to list
 * them for download. For large or image-heavy batches prefer
 * {@link streamBatch}, which never holds more than one document at a time.
 */
export async function runBatch(
  template: Template,
  records: readonly DataRecord[],
  options: BatchOptions = {},
): Promise<BatchResult> {
  const documents: GeneratedDocument[] = [];
  const failures: BatchFailure[] = [];

  const stream = streamBatch(template, records, options);
  let next = await stream.next();
  while (!next.done) {
    if (next.value.type === 'document') documents.push(next.value.document);
    else failures.push(next.value.failure);
    next = await stream.next();
  }

  return {
    documents,
    failures,
    unsupported: next.value.unsupported,
    shrunkFields: next.value.shrunkFields,
    unmatchedFields: next.value.unmatchedFields,
    warnings: next.value.warnings,
  };
}

/**
 * List what a DOCX template would lose if it were rendered to PDF.
 *
 * Rendering re-typesets the body text, so anything that is not body text goes
 * missing. Reporting it before a run matters more than it might sound: a
 * dropped letterhead or a dropped salary table is not obvious in a folder of
 * three hundred documents, and is very obvious to the person who receives one.
 */
export function readUnsupportedForPdf(template: Template): readonly string[] {
  if (template.kind !== 'docx') return [];
  return unsupportedForPdf(prepareDocx(template.bytes, {}));
}

function unsupportedForPdf(prepared: PreparedDocx): readonly string[] {
  const body = prepared.textParts.get('word/document.xml');
  const found = new Set(body ? extractDocumentModel(body).unsupported : []);

  // Headers and footers are separate parts and are not rendered at all, so a
  // letterhead would silently vanish.
  for (const [name, xml] of prepared.textParts) {
    if (name === 'word/document.xml') continue;
    if (!/^word\/(header|footer)\d+\.xml$/.test(name)) continue;
    if (extractDocumentModel(xml).paragraphs.some((p) => p.runs.length > 0)) {
      found.add('headers and footers');
      break;
    }
  }

  return [...found];
}

/** Convert a thrown value into a failure record that carries no personal data. */
function toFailure(row: number, error: unknown): BatchFailure {
  if (error instanceof DoclystError) {
    const failure: BatchFailure = {
      row,
      code: error.code,
      message: error.message,
    };
    return error.field !== undefined ? { ...failure, field: error.field } : failure;
  }
  return { row, code: 'RENDER_FAILED', message: safeErrorSummary(error) };
}
