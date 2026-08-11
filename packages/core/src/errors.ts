/**
 * Error types for Doclyst.
 *
 * Every error carries a stable machine-readable `code` and a message written
 * to be safe to display and to log. Messages reference *locations* (row 12,
 * field SALARY, entry `word/document.xml`) and never the values found there.
 */

export type DoclystErrorCode =
  | 'INVALID_TEMPLATE'
  | 'UNSUPPORTED_TEMPLATE'
  | 'INVALID_DATA'
  | 'MISSING_VALUE'
  | 'RENDER_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'UNSAFE_PATH';

export class DoclystError extends Error {
  readonly code: DoclystErrorCode;
  /** Optional 1-based data row this error relates to. */
  readonly row?: number;
  /** Optional field/placeholder key this error relates to. */
  readonly field?: string;

  constructor(
    code: DoclystErrorCode,
    message: string,
    options: { row?: number; field?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DoclystError';
    this.code = code;
    if (options.row !== undefined) this.row = options.row;
    if (options.field !== undefined) this.field = options.field;
  }
}

/**
 * Wrap an unknown thrown value into a safe, displayable summary.
 *
 * Third-party parsers (zip, PDF) can throw errors whose messages embed chunks
 * of the document being parsed. Those chunks may contain personal data, so a
 * foreign error's message is never surfaced verbatim: only its constructor
 * name is kept, which is enough to distinguish a corrupt zip from a bad PDF
 * without leaking document bytes.
 */
export function safeErrorSummary(error: unknown): string {
  if (error instanceof DoclystError) return error.message;
  if (error instanceof Error) return `${error.name} (details withheld)`;
  return 'unknown error (details withheld)';
}
