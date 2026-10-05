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
  readLinkedContent,
  MAX_TEMPLATE_BYTES,
  type DocxFillOptions,
  type DocxFillResult,
  type PreparedDocx,
} from './docx/fill.js';

export {
  replacePlaceholdersInXml,
  extractTextFromXml,
  extractVisibleText,
  type PlaceholderResolver,
} from './docx/wordxml.js';

export { decodeXmlText, encodeXmlText } from './docx/xml.js';
export { acceptRevisionsAndDropHidden } from './docx/revisions.js';

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
  checkPdfTemplateFit,
  fieldNameToKey,
  type FieldFitReport,
  type PdfFillOptions,
  type OverflowPolicy,
  type PdfFillResult,
} from './pdf/fill.js';

export {
  preparePdfTemplate,
  type PrepareTemplateOptions,
  type PrepareTemplateResult,
  type PreparedField,
} from './pdf/autofields.js';

export {
  sanitizeFilename,
  buildFilename,
  checkFilenameTemplate,
  checkFilenameFields,
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
  readLinkedContentWarnings,
  type BatchOptions,
  type BatchEvent,
  type BatchFailure,
  type BatchResult,
  type BatchSummary,
  type OutputFormat,
  type GeneratedDocument,
  type GeneratedEmail,
  type Template,
  type TemplateKind,
} from './batch/run.js';

export { buildZip, type ZipEntry } from './output/zip.js';

export {
  checkEmailAddress,
  composeEmailDraft,
  contentTypeFor,
  fillText,
  type EmailAttachment,
  type EmailDraft,
  type EmailDraftOptions,
} from './output/email.js';

export {
  buildDocuSealSheet,
  findSignatureTags,
  readDocuSealTemplate,
  type DocuSealSheet,
  type DocuSealSheetOptions,
  type DocuSealTemplateInfo,
} from './output/docuseal.js';

export {
  describeValue,
  redactRecord,
  redactForLog,
  isSensitiveFieldName,
} from './privacy/redact.js';

export {
  checkReturnedLetters,
  type CheckReturnedOptions,
  type LetterFile,
  type ReturnedCheck,
  type ReturnedLetterReport,
  type ReturnedStatus,
} from './verify/returned.js';

export {
  compareRenderedPages,
  type PageRenderer,
  type RenderedPage,
  type VisualDifference,
} from './verify/visual.js';
