import { DoclystError, safeErrorSummary } from '../errors.js';
import { fillPreparedDocx, prepareDocx, readDocxFields, type DocxFillOptions, type PreparedDocx } from '../docx/fill.js';
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

export interface BatchOptions {
  readonly missing?: MissingValuePolicy;
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
  let generated = 0;
  let failed = 0;

  const warnings = options.filenameTemplate
    ? checkFilenameTemplate(options.filenameTemplate)
    : [];

  const extension = template.kind === 'docx' ? '.docx' : '.pdf';

  // Unzip, validate and scrub the template once rather than per record. A
  // malformed template still fails here, before any row is attempted.
  const prepared: PreparedDocx | undefined =
    template.kind === 'docx' ? prepareDocx(template.bytes, options.docx ?? {}) : undefined;

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

      const filled =
        prepared !== undefined
          ? fillPreparedDocx(prepared, resolve)
          : await fillPdf(template.bytes, resolve, options.pdf ?? {});

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
      yield { type: 'document', document: { row, filename, bytes: filled.bytes } };
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
    unmatchedFields: next.value.unmatchedFields,
    warnings: next.value.warnings,
  };
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
