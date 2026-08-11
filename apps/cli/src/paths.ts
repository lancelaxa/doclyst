import { resolve, sep } from 'node:path';

/**
 * Confirm that a generated filename resolves inside the output directory.
 *
 * Filenames are already sanitised by the core engine, so reaching this check
 * means something upstream is wrong. It exists because the consequence of a
 * traversal here is writing a file over an arbitrary path on the operator's
 * machine, and that is worth a redundant assertion.
 */
export function resolveWithin(directory: string, filename: string): string {
  const root = resolve(directory);
  const target = resolve(root, filename);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Refusing to write outside the output directory.');
  }
  return target;
}
