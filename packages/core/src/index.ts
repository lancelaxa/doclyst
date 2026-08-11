/**
 * @doclyst/core — the document-filling engine.
 *
 * Pure and environment-agnostic: it takes bytes in and returns bytes out, with
 * no filesystem, no network and no global state. Anything that reads a file or
 * talks to a user lives in an app package on top of this one. That boundary is
 * what makes it possible to state plainly that the engine cannot transmit a
 * record anywhere — there is nothing in here that could.
 */

export { DoclystError, safeErrorSummary, type DoclystErrorCode } from './errors.js';

export {
  findPlaceholders,
  extractFieldNames,
  normalizeKey,
  type PlaceholderMatch,
} from './template/placeholder.js';

export {
  ValueResolver,
  coerceToText,
  stripControlCharacters,
  MAX_VALUE_LENGTH,
  type MissingValuePolicy,
  type ValueResolverOptions,
} from './template/values.js';

export {
  parseCsv,
  detectDelimiter,
  escapeCsvValue,
  toCsv,
  DEFAULT_MAX_ROWS,
  DEFAULT_MAX_COLUMNS,
  type ParseCsvOptions,
} from './data/csv.js';

export {
  toRecords,
  readCsvRecords,
  readXlsxRecords,
  type DataRecord,
  type RecordSet,
} from './data/records.js';

export {
  parseXlsx,
  readSheetNames,
  MAX_WORKBOOK_BYTES,
  type ParseXlsxOptions,
} from './data/xlsx.js';

export {
  fillDocx,
  prepareDocx,
  fillPreparedDocx,
  readDocxFields,
  readDocxText,
  MAX_TEMPLATE_BYTES,
  type DocxFillOptions,
  type DocxFillResult,
  type PreparedDocx,
} from './docx/fill.js';

export {
  replacePlaceholdersInXml,
  extractTextFromXml,
  type PlaceholderResolver,
} from './docx/wordxml.js';

export { decodeXmlText, encodeXmlText } from './docx/xml.js';

export {
  extractDocumentModel,
  modelToText,
  type Alignment,
  type DocumentModel,
  type Paragraph,
  type TextRun,
} from './docx/model.js';

export { renderModelToPdf, type PdfRenderOptions } from './pdf/render.js';

export {
  fillPdf,
  readPdfFields,
  fieldNameToKey,
  type PdfFillOptions,
  type OverflowPolicy,
  type PdfFillResult,
} from './pdf/fill.js';

export {
  sanitizeFilename,
  buildFilename,
  checkFilenameTemplate,
  dedupeFilename,
  type BuildFilenameOptions,
  type FilenameWarning,
} from './batch/filename.js';

export {
  runBatch,
  streamBatch,
  detectTemplateKind,
  readTemplateFields,
  readUnsupportedForPdf,
  type BatchOptions,
  type BatchEvent,
  type BatchFailure,
  type BatchResult,
  type BatchSummary,
  type OutputFormat,
  type GeneratedDocument,
  type Template,
  type TemplateKind,
} from './batch/run.js';

export { buildZip, type ZipEntry } from './output/zip.js';

export {
  describeValue,
  redactRecord,
  redactForLog,
  isSensitiveFieldName,
} from './privacy/redact.js';
