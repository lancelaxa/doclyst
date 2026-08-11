import { zipSync } from 'fflate';
import { dedupeFilename } from '../batch/filename.js';
import { FIXED_ARCHIVE_TIMESTAMP } from '../internal/deterministic.js';
import { withChosenLevel, type ZipEntryInput } from '../internal/compression.js';

/** One file destined for the output archive. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Build a ZIP archive from generated documents.
 *
 * Entry names are expected to have been through `sanitizeFilename` already;
 * they are re-checked here anyway, because this is the last point at which a
 * traversal sequence could be written into an archive that some other tool
 * will later extract.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const files: Record<string, ZipEntryInput> = {};
  const taken = new Set<string>();

  for (const entry of entries) {
    // Every name goes through dedupe, not just rejected ones: assigning into
    // the record by a duplicate key would drop a generated document without
    // any error, which is the one failure mode a batch tool must never have.
    // A generated .docx is itself a ZIP and a PDF is largely compressed
    // already, so deflating them a second time is close to pure cost.
    files[dedupeFilename(makeSafeZipName(entry.name), taken)] = withChosenLevel(entry.bytes);
  }

  return zipSync(files, { level: 6, mtime: FIXED_ARCHIVE_TIMESTAMP });
}

/** Reduce an entry name to one that cannot escape an extraction root. */
function makeSafeZipName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const unsafe =
    normalized === '' ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001F\u007F]/.test(normalized);
  return unsafe ? 'document' : normalized;
}
