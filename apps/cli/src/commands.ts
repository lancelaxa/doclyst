import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  DoclystError,
  buildZip,
  detectTemplateKind,
  escapeCsvValue,
  readCsvRecords,
  readTemplateFields,
  runBatch,
  type BatchResult,
  type MissingValuePolicy,
  type Template,
} from '@doclyst/core';
import { getBoolean, getString, type ParsedArgs } from './args.js';
import { resolveWithin } from './paths.js';

/**
 * Filesystem permissions for everything this tool writes.
 *
 * Generated documents contain the personal data of every data subject in the
 * batch, so they are created readable and writable only by the user who ran
 * the command. The default umask would commonly make them group- and
 * world-readable, which on a shared machine or server is a disclosure.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Data formats the CLI can read today. */
const SUPPORTED_DATA_EXTENSIONS = new Set(['.csv']);

export interface CommandContext {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/** `doclyst inspect` — report what a template needs and what data provides. */
export async function inspectCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const templatePath = getString(args, 'template');
  const dataPath = getString(args, 'data');

  if (!templatePath && !dataPath) {
    ctx.error('Provide --template and/or --data to inspect.');
    return 2;
  }

  let templateFields: string[] | undefined;
  if (templatePath) {
    const template = await loadTemplate(templatePath);
    templateFields = await readTemplateFields(template);
    ctx.log(`Template: ${basename(templatePath)} (${template.kind})`);
    ctx.log(
      templateFields.length > 0
        ? `  Fields (${templateFields.length}): ${templateFields.join(', ')}`
        : '  No placeholders found.',
    );
  }

  let dataFields: string[] | undefined;
  if (dataPath) {
    const { fields, records } = await loadRecords(dataPath);
    dataFields = [...fields];
    ctx.log(`Data: ${basename(dataPath)}`);
    ctx.log(`  Rows: ${records.length}`);
    ctx.log(`  Columns (${fields.length}): ${fields.join(', ')}`);
  }

  // The single most useful thing to report before a 500-row run: which
  // placeholders no column will satisfy.
  if (templateFields && dataFields) {
    const available = new Set(dataFields.map(normalize));
    const unmatched = templateFields.filter((field) => !available.has(normalize(field)));
    if (unmatched.length > 0) {
      ctx.log('');
      ctx.error(`Unmatched placeholders (${unmatched.length}): ${unmatched.join(', ')}`);
      return 1;
    }
    ctx.log('');
    ctx.log('Every template placeholder has a matching column.');
  }

  return 0;
}

/** `doclyst fill` — render one document per data row. */
export async function fillCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const templatePath = getString(args, 'template');
  const dataPath = getString(args, 'data');
  const outDir = getString(args, 'out');
  const zipPath = getString(args, 'zip');

  if (!templatePath || !dataPath) {
    ctx.error('Both --template and --data are required.');
    return 2;
  }
  if (!outDir && !zipPath) {
    ctx.error('Provide --out <directory> and/or --zip <file> to say where output should go.');
    return 2;
  }

  const missing = parseMissingPolicy(getString(args, 'missing'));
  if (missing === undefined) {
    ctx.error('--missing must be one of: error, empty, keep.');
    return 2;
  }

  const template = await loadTemplate(templatePath);
  const { records } = await loadRecords(dataPath);
  if (records.length === 0) {
    ctx.error('The data file contains no data rows.');
    return 1;
  }

  const dryRun = getBoolean(args, 'dry-run');
  const result = await runBatch(template, records, {
    missing,
    treatEmptyAsMissing: getBoolean(args, 'empty-is-missing'),
    filenameTemplate: getString(args, 'filename'),
    stopOnError: getBoolean(args, 'stop-on-error'),
    docx: { scrubMetadata: !getBoolean(args, 'keep-metadata') },
    pdf: {
      scrubMetadata: !getBoolean(args, 'keep-metadata'),
      flatten: !getBoolean(args, 'no-flatten'),
    },
  });

  for (const warning of result.warnings) {
    ctx.error(`Warning: ${warning.message}`);
  }

  if (dryRun) {
    ctx.log(
      `Dry run: ${result.documents.length} document(s) would be written, ${result.failures.length} row(s) would fail.`,
    );
    reportFailures(result, ctx);
    return result.failures.length > 0 ? 1 : 0;
  }

  if (outDir) {
    await mkdir(outDir, { recursive: true, mode: DIR_MODE });
    const force = getBoolean(args, 'force');
    for (const document of result.documents) {
      const target = resolveWithin(outDir, document.filename);
      if (!force && (await exists(target))) {
        ctx.error(
          `Refusing to overwrite an existing file: ${document.filename}. Use --force to replace it.`,
        );
        return 1;
      }
      await writeFile(target, document.bytes, { mode: FILE_MODE });
    }
    await writeManifest(outDir, result);
    ctx.log(`Wrote ${result.documents.length} document(s) to ${outDir}`);
  }

  if (zipPath) {
    const archive = buildZip(
      result.documents.map((document) => ({ name: document.filename, bytes: document.bytes })),
    );
    await writeFile(zipPath, archive, { mode: FILE_MODE });
    ctx.log(`Wrote ${result.documents.length} document(s) to ${zipPath}`);
  }

  reportFailures(result, ctx);

  if (result.unmatchedFields.length > 0 && missing !== 'error') {
    ctx.error(
      `Placeholders with no matching column (${result.unmatchedFields.length}): ${result.unmatchedFields.join(', ')}`,
    );
  }

  return result.failures.length > 0 ? 1 : 0;
}

/**
 * Write a run manifest next to the documents.
 *
 * The manifest records row numbers, filenames and outcomes — never field
 * values. Values are escaped for CSV *and* neutralised against formula
 * injection, because the file exists to be opened in a spreadsheet.
 */
async function writeManifest(outDir: string, result: BatchResult): Promise<void> {
  const rows: string[] = ['row,filename,status,code,detail'];

  for (const document of result.documents) {
    rows.push(
      [String(document.row), document.filename, 'ok', '', ''].map(escapeCsvValue).join(','),
    );
  }
  for (const failure of result.failures) {
    rows.push(
      [String(failure.row), '', 'failed', failure.code, failure.message]
        .map(escapeCsvValue)
        .join(','),
    );
  }

  const target = resolveWithin(outDir, 'manifest.csv');
  await writeFile(target, `${rows.join('\r\n')}\r\n`, { mode: FILE_MODE });
}

function reportFailures(result: BatchResult, ctx: CommandContext): void {
  if (result.failures.length === 0) return;
  ctx.error(`${result.failures.length} row(s) failed:`);
  for (const failure of result.failures.slice(0, 20)) {
    ctx.error(`  Row ${failure.row}: ${failure.message}`);
  }
  if (result.failures.length > 20) {
    ctx.error(`  ...and ${result.failures.length - 20} more (see manifest.csv).`);
  }
}

async function loadTemplate(path: string): Promise<Template> {
  const bytes = new Uint8Array(await readFile(path));
  return { kind: detectTemplateKind(bytes), bytes };
}

async function loadRecords(path: string) {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_DATA_EXTENSIONS.has(extension)) {
    throw new DoclystError(
      'INVALID_DATA',
      `Unsupported data file type "${extension || '(none)'}". Supported: ${[...SUPPORTED_DATA_EXTENSIONS].join(', ')}.`,
    );
  }
  return readCsvRecords(await readFile(path, 'utf8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseMissingPolicy(value: string | undefined): MissingValuePolicy | undefined {
  if (value === undefined) return 'error';
  return value === 'error' || value === 'empty' || value === 'keep' ? value : undefined;
}

function normalize(key: string): string {
  return key.trim().replace(/[\s.\-]+/g, '_').toUpperCase();
}
