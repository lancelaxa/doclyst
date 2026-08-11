#!/usr/bin/env node
import { DoclystError, safeErrorSummary } from '@doclyst/core';
import { parseArgs } from './args.js';
import { fillCommand, inspectCommand, type CommandContext } from './commands.js';

const HELP = `doclyst — privacy-first batch document filling

  Everything runs on this machine. No document, record or field value is sent
  anywhere: the tool makes no network requests at all.

Usage
  doclyst inspect --template <file> [--data <file>]
  doclyst fill --template <file> --data <file> (--out <dir> | --zip <file>) [options]

Commands
  inspect    List a template's placeholders and a data file's columns, and
             report any placeholder no column can fill.
  fill       Render one document per data row.

Required for fill
  --template <file>     .docx or .pdf template.
  --data <file>         .csv or .xlsx file whose column headers match the
                        placeholders.
  --out <dir>           Directory to write documents into (mode 0700).
  --zip <file>          Also, or instead, write a single ZIP archive.

Options
  --sheet <name|index>  Worksheet to read from an .xlsx. Defaults to the
                        first. Ignored for .csv.
  --filename <template> Name pattern, e.g. "{{STAFF_ID}}-offer". Defaults to
                        document-0001, which discloses nothing in a listing.
  --missing <policy>    error (default) | empty | keep. How to treat a
                        placeholder with no value.
  --output <format>     docx (default) | pdf. A .docx template can produce
                        PDF, which is re-typeset rather than converted, so
                        tables, images and numbering are not carried over —
                        the run says so if the template uses them. A .pdf
                        template always produces PDF.
  --empty-is-missing    Treat a blank cell as a missing value.
  --stop-on-error       Abort at the first failing row instead of continuing.
  --dry-run             Report what would be produced; write nothing.
  --force               Overwrite existing output files.
  --no-flatten          Keep PDF form fields editable (they are flattened by
                        default so values cannot be edited back out).
  --keep-metadata       Keep template author/company metadata in the output.
  --help                Show this message.

Exit codes
  0 success   1 completed with failures   2 bad usage
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const ctx: CommandContext = {
    log: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };

  if (args.flags.has('help') || args.command === 'help' || args.command === undefined) {
    ctx.log(HELP);
    return args.command === undefined && !args.flags.has('help') ? 2 : 0;
  }

  switch (args.command) {
    case 'inspect':
      return inspectCommand(args, ctx);
    case 'fill':
      return fillCommand(args, ctx);
    default:
      ctx.error(`Unknown command "${args.command}". Run "doclyst --help".`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Only a safe summary reaches the terminal. A raw stack trace from a
    // parser can embed fragments of the document or record being processed,
    // and terminals get scrolled back, screenshotted and pasted into tickets.
    if (error instanceof DoclystError) {
      process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    } else if (isFsError(error)) {
      process.stderr.write(`Error: could not read or write a file (${error.code}).\n`);
    } else {
      process.stderr.write(`Error: ${safeErrorSummary(error)}\n`);
    }
    process.exitCode = 1;
  });

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
