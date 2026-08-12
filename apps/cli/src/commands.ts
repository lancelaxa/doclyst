import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  DoclystError,
  buildZip,
  checkPdfTemplateFit,
  detectTemplateKind,
  escapeCsvValue,
  readCsvRecords,
  readSheetNames,
  preparePdfTemplate,
  readTemplateFields,
  readXlsxRecords,
  runBatch,
  type BatchResult,
  type MissingValuePolicy,
  type OutputFormat,
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

/** Data formats the CLI can read. */
const SUPPORTED_DATA_EXTENSIONS = new Set(['.csv', '.xlsx']);

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
    const { fields, records } = await loadRecords(dataPath, getString(args, 'sheet'));
    dataFields = [...fields];
    ctx.log(`Data: ${basename(dataPath)}`);
    if (extname(dataPath).toLowerCase() === '.xlsx') {
      const bytes = new Uint8Array(await readFile(dataPath));
      ctx.log(`  Worksheets: ${readSheetNames(bytes).join(', ')}`);
    }
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

  // The second most useful thing: whether the boxes are big enough for the
  // data. A field that is too narrow for one person in four hundred otherwise
  // shows up on that row and nowhere else, after the batch has run.
  if (templatePath && dataPath) {
    const template = await loadTemplate(templatePath);
    if (template.kind === 'pdf') {
      const { records } = await loadRecords(dataPath, getString(args, 'sheet'));
      const reports = await checkPdfTemplateFit(template.bytes, records);
      const tight = reports.filter((report) => report.outcome !== 'fits');

      ctx.log('');
      if (tight.length === 0) {
        ctx.log('Every field is big enough for the widest value in the data.');
      } else {
        for (const report of tight) {
          const detail =
            report.outcome === 'overflows'
              ? `too small — the widest value (row ${report.worstRow}) will not fit legibly`
              : `tight — row ${report.worstRow} shrinks from ${report.templateSizePt}pt to ${report.fittedSizePt}pt`;
          ctx.error(`  ${report.field}: ${detail}`);
        }
        const blocking = tight.some((report) => report.outcome === 'overflows');
        ctx.error(
          blocking
            ? 'Widen the fields above in the template before generating.'
            : 'Documents will be complete, but widening those fields makes them read evenly.',
        );
        if (blocking) return 1;
      }
    }
  }

  return 0;
}

/**
 * `doclyst prepare` — turn a PDF containing {{PLACEHOLDERS}} into a template.
 *
 * The design is what makes this route worth taking, so the output is written to
 * a new file rather than over the input: the original stays available to
 * re-prepare after an edit.
 */
export async function prepareCommand(args: ParsedArgs, ctx: CommandContext): Promise<number> {
  const templatePath = getString(args, 'template');
  const outPath = getString(args, 'out');

  if (!templatePath || !outPath) {
    ctx.error('Both --template <file.pdf> and --out <file.pdf> are required.');
    return 2;
  }

  const widen = getString(args, 'widen');
  const widthFactor = widen === undefined ? undefined : Number.parseFloat(widen);
  if (widthFactor !== undefined && (!Number.isFinite(widthFactor) || widthFactor <= 0)) {
    ctx.error('--widen must be a positive number, e.g. 1.5.');
    return 2;
  }

  const template = await loadTemplate(templatePath);
  if (template.kind !== 'pdf') {
    ctx.error('prepare works on a PDF. Save your Word document as PDF first, then prepare that.');
    return 2;
  }

  const result = await preparePdfTemplate(
    template.bytes,
    widthFactor === undefined ? {} : { widthFactor },
  );

  ctx.log(`Prepared ${result.fields.length} field(s) from ${basename(templatePath)}:`);
  for (const field of result.fields) {
    const font = field.keptFont ? '' : ' (falls back to Helvetica)';
    ctx.log(
      `  ${field.name} — page ${field.page}, ${field.width.toFixed(0)}x${field.height.toFixed(0)}pt at ${field.fontSizePt.toFixed(1)}pt${font}`,
    );
  }

  for (const skip of result.skipped) {
    ctx.error(`Warning: "${skip.name}" was not turned into a field because ${skip.reason}.`);
  }

  // A fixed box in the middle of a sentence cannot push the words after it
  // along, so a short value leaves a gap and a long one shrinks. Placeholders
  // on their own line have neither problem, and the author can move them.
  const inline = result.fields.filter((field) => field.inline);
  if (inline.length > 0) {
    ctx.error('');
    ctx.error(
      `Note: ${inline.length} placeholder(s) have text after them on the same line: ${inline.map((field) => field.name).join(', ')}.`,
    );
    ctx.error(
      'A PDF cannot reflow, so a short value will leave a gap before the following words and a long one will shrink to fit. Putting those placeholders on their own line in the source document avoids both.',
    );
  }

  // A field that cannot use the surrounding font will look different from the
  // text around it, which is the one thing this route exists to avoid.
  const swapped = result.fields.filter((field) => !field.keptFont);
  if (swapped.length > 0) {
    ctx.error(
      `Warning: ${swapped.length} field(s) will draw their value in Helvetica, because the template's own font does not carry every letter a value might need. Check one document before sending a batch.`,
    );
  }

  try {
    await writeNewFile(outPath, result.bytes, getBoolean(args, 'force'));
  } catch (error) {
    if (isAlreadyExists(error)) {
      ctx.error(`Refusing to overwrite an existing file: ${outPath}. Use --force to replace it.`);
      return 1;
    }
    throw error;
  }

  ctx.log('');
  ctx.log(`Wrote ${outPath}. Check it against your data with:`);
  ctx.log(`  doclyst inspect --template ${outPath} --data <your-data.csv>`);
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

  const outputFormat = parseOutputFormat(getString(args, 'output'));
  if (outputFormat === undefined) {
    ctx.error('--output must be one of: docx, pdf.');
    return 2;
  }

  const template = await loadTemplate(templatePath);
  if (template.kind === 'pdf' && outputFormat === 'docx' && getString(args, 'output')) {
    ctx.error('A PDF template can only produce PDF; --output docx does not apply.');
    return 2;
  }
  const { records } = await loadRecords(dataPath, getString(args, 'sheet'));
  if (records.length === 0) {
    ctx.error('The data file contains no data rows.');
    return 1;
  }

  const dryRun = getBoolean(args, 'dry-run');
  const result = await runBatch(template, records, {
    missing,
    outputFormat,
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

  // The template gave these fields less room than the data needs. The output
  // is complete and legible, but it will read unevenly, and the fix belongs in
  // the template rather than in every future run.
  if (result.shrunkFields.length > 0) {
    ctx.error(
      `Warning: the text was shrunk to fit these PDF form fields: ${result.shrunkFields.join(', ')}. Widen them in the template for an even result.`,
    );
  }

  // Worth saying loudly: a table dropped from a contract is the kind of thing
  // nobody notices until after it has been sent.
  if (result.unsupported.length > 0) {
    ctx.error(
      `Warning: producing PDF re-typesets the document, and this template uses ${result.unsupported.join(', ')}, which cannot be carried over. Check one document before sending the batch.`,
    );
  }

  if (dryRun) {
    ctx.log(
      `Dry run: ${result.documents.length} document(s) would be written, ${result.failures.length} row(s) would fail.`,
    );
    reportFailures(result, ctx);
    return result.failures.length > 0 ? 1 : 0;
  }

  const force = getBoolean(args, 'force');

  if (outDir) {
    await mkdir(outDir, { recursive: true, mode: DIR_MODE });
    for (const document of result.documents) {
      const target = resolveWithin(outDir, document.filename);
      try {
        await writeNewFile(target, document.bytes, force);
      } catch (error) {
        if (isAlreadyExists(error)) {
          ctx.error(
            `Refusing to overwrite an existing file: ${document.filename}. Use --force to replace it.`,
          );
          return 1;
        }
        throw error;
      }
    }
    try {
      await writeManifest(outDir, result, force);
    } catch (error) {
      if (isAlreadyExists(error)) {
        ctx.error('Refusing to overwrite an existing manifest.csv. Use --force to replace it.');
        return 1;
      }
      throw error;
    }
    ctx.log(`Wrote ${result.documents.length} document(s) to ${outDir}`);
  }

  if (zipPath) {
    const archive = buildZip(
      result.documents.map((document) => ({ name: document.filename, bytes: document.bytes })),
    );
    try {
      await writeNewFile(zipPath, archive, force);
    } catch (error) {
      if (isAlreadyExists(error)) {
        ctx.error(`Refusing to overwrite an existing file: ${zipPath}. Use --force to replace it.`);
        return 1;
      }
      throw error;
    }
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
async function writeManifest(outDir: string, result: BatchResult, force: boolean): Promise<void> {
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
  await writeNewFile(target, `${rows.join('\r\n')}\r\n`, force);
}

/**
 * Create a file, never writing through something that is already there.
 *
 * Uses `wx` (O_CREAT | O_EXCL), which fails if the path exists *and* refuses
 * to follow a symlink. That matters because a symlink planted in the output
 * directory would otherwise redirect a generated document over an arbitrary
 * file the user can write. Checking with `access` first and then writing would
 * still leave a window between the two; this closes it.
 *
 * With `--force` the existing entry is unlinked first, which removes the
 * symlink itself rather than its target. If an attacker re-creates it in
 * between, the exclusive create fails rather than writing through.
 */
async function writeNewFile(
  path: string,
  data: Uint8Array | string,
  force: boolean,
): Promise<void> {
  if (force) await rm(path, { force: true });

  try {
    await writeFile(path, data, { mode: FILE_MODE, flag: 'wx' });
  } catch (error) {
    // A failure after the exclusive create leaves a truncated file behind, and
    // the next attempt then refuses to overwrite it — a message that reads as
    // though there were something there worth keeping. Nothing this created is
    // worth keeping, so it goes.
    if (!isAlreadyExists(error)) await rm(path, { force: true });
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
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

/**
 * Read a data file into records.
 *
 * `sheet` selects a worksheet by name or 0-based index and is ignored for CSV.
 * XLSX is read as bytes; CSV as UTF-8 text.
 */
async function loadRecords(path: string, sheet?: string) {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_DATA_EXTENSIONS.has(extension)) {
    throw new DoclystError(
      'INVALID_DATA',
      `Unsupported data file type "${extension || '(none)'}". Supported: ${[...SUPPORTED_DATA_EXTENSIONS].join(', ')}.`,
    );
  }

  if (extension === '.xlsx') {
    const bytes = new Uint8Array(await readFile(path));
    // A bare integer selects by position; anything else is a sheet name.
    const selection =
      sheet !== undefined && /^\d+$/.test(sheet) ? Number.parseInt(sheet, 10) : sheet;
    return readXlsxRecords(bytes, selection === undefined ? {} : { sheet: selection });
  }

  return readCsvRecords(await readFile(path, 'utf8'));
}

function parseMissingPolicy(value: string | undefined): MissingValuePolicy | undefined {
  if (value === undefined) return 'error';
  return value === 'error' || value === 'empty' || value === 'keep' ? value : undefined;
}

function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (value === undefined) return 'docx';
  return value === 'docx' || value === 'pdf' ? value : undefined;
}

function normalize(key: string): string {
  return key.trim().replace(/[\s.\-]+/g, '_').toUpperCase();
}
