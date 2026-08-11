/**
 * The fixed timestamp stamped on every archive entry Doclyst writes.
 *
 * Two reasons it is a constant rather than the current time:
 *
 *  - Privacy. A per-entry mtime records when each record was processed, which
 *    leaks batch timing and ordering to anyone who inspects the archive.
 *  - Reproducibility. Identical inputs produce byte-identical outputs, so a
 *    run can be verified by re-running it.
 *
 * The value is 1980-01-01, the earliest instant the ZIP format's DOS-derived
 * timestamp can represent. The epoch itself (1970) is out of range and makes
 * the writer throw.
 */
export const FIXED_ARCHIVE_TIMESTAMP = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
