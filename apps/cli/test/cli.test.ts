import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { readDocxText } from '@doclyst/core';
import { parseArgs, getBoolean, getString } from '../src/args.js';
import { resolveWithin } from '../src/paths.js';
import { fillCommand, inspectCommand, type CommandContext } from '../src/commands.js';
import { makeTemplate } from './helpers/template.js';
import { pdfText } from './helpers/pdftext.js';

/** Collects CLI output so assertions can check what an operator would see. */
function makeContext(): CommandContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (m) => out.push(m), error: (m) => err.push(m) };
}

const CSV = `NAME,SALARY,STAFF_ID
Aisha Rahman,4500,EMP-0001
Wei Lun Tan,5200,EMP-0002
`;

describe('parseArgs', () => {
  it('reads a command and its flags', () => {
    const args = parseArgs(['fill', '--template', 'a.docx', '--data', 'b.csv']);
    expect(args.command).toBe('fill');
    expect(getString(args, 'template')).toBe('a.docx');
  });

  it('accepts --flag=value form', () => {
    expect(getString(parseArgs(['fill', '--out=./dist']), 'out')).toBe('./dist');
  });

  it('treats a flag with no value as boolean', () => {
    const args = parseArgs(['fill', '--dry-run', '--force']);
    expect(getBoolean(args, 'dry-run')).toBe(true);
    expect(getBoolean(args, 'force')).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    const args = parseArgs(['fill', '--dry-run', '--out', 'x']);
    expect(getBoolean(args, 'dry-run')).toBe(true);
    expect(getString(args, 'out')).toBe('x');
  });

  it('reports an absent flag as false or undefined', () => {
    const args = parseArgs(['fill']);
    expect(getBoolean(args, 'force')).toBe(false);
    expect(getString(args, 'out')).toBeUndefined();
  });
});

describe('resolveWithin', () => {
  it('resolves a plain filename inside the directory', () => {
    expect(resolveWithin('/tmp/out', 'a.docx')).toBe('/tmp/out/a.docx');
  });

  it('refuses a path that escapes the directory', () => {
    // The engine sanitises filenames, so this is a redundant last line of
    // defence against writing anywhere on the operator's disk.
    expect(() => resolveWithin('/tmp/out', '../../etc/passwd')).toThrow(/outside the output/);
    expect(() => resolveWithin('/tmp/out', '/etc/passwd')).toThrow(/outside the output/);
  });
});

describe('CLI commands', () => {
  let dir: string;
  let templatePath: string;
  let dataPath: string;
  let outDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doclyst-test-'));
    templatePath = join(dir, 'offer.docx');
    dataPath = join(dir, 'staff.csv');
    outDir = join(dir, 'out');
    await writeFile(templatePath, makeTemplate());
    await writeFile(dataPath, CSV);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('inspect', () => {
    it('lists template fields and data columns', async () => {
      const ctx = makeContext();
      const code = await inspectCommand(
        parseArgs(['inspect', '--template', templatePath, '--data', dataPath]),
        ctx,
      );
      expect(code).toBe(0);
      expect(ctx.out.join('\n')).toContain('NAME, SALARY');
      expect(ctx.out.join('\n')).toContain('Rows: 2');
    });

    it('reports placeholders that no column can fill', async () => {
      await writeFile(dataPath, 'NAME\nAisha\n');
      const ctx = makeContext();
      const code = await inspectCommand(
        parseArgs(['inspect', '--template', templatePath, '--data', dataPath]),
        ctx,
      );
      expect(code).toBe(1);
      expect(ctx.err.join('\n')).toContain('Unmatched placeholders');
      expect(ctx.err.join('\n')).toContain('SALARY');
    });

    it('does not print any field values', async () => {
      const ctx = makeContext();
      await inspectCommand(
        parseArgs(['inspect', '--template', templatePath, '--data', dataPath]),
        ctx,
      );
      const output = [...ctx.out, ...ctx.err].join('\n');
      expect(output).not.toContain('Aisha Rahman');
      expect(output).not.toContain('4500');
    });

    it('requires something to inspect', async () => {
      expect(await inspectCommand(parseArgs(['inspect']), makeContext())).toBe(2);
    });
  });

  describe('fill', () => {
    const fillArgs = (...extra: string[]) =>
      parseArgs(['fill', '--template', templatePath, '--data', dataPath, '--out', outDir, ...extra]);

    it('writes one document per row', async () => {
      const ctx = makeContext();
      expect(await fillCommand(fillArgs(), ctx)).toBe(0);

      const first = await readFile(join(outDir, 'document-0001.docx'));
      expect(readDocxText(new Uint8Array(first))).toContain('Aisha Rahman');
      const second = await readFile(join(outDir, 'document-0002.docx'));
      expect(readDocxText(new Uint8Array(second))).toContain('Wei Lun Tan');
    });

    it('creates the output directory owner-only', async () => {
      // Generated documents hold the personal data of everyone in the batch;
      // the default umask would often make them group- and world-readable.
      await fillCommand(fillArgs(), makeContext());
      expect((await stat(outDir)).mode & 0o777).toBe(0o700);
    });

    it('creates each document owner-only', async () => {
      await fillCommand(fillArgs(), makeContext());
      expect((await stat(join(outDir, 'document-0001.docx'))).mode & 0o777).toBe(0o600);
    });

    it('writes a manifest that records outcomes but no values', async () => {
      await fillCommand(fillArgs(), makeContext());
      const manifest = await readFile(join(outDir, 'manifest.csv'), 'utf8');
      expect(manifest).toContain('row,filename,status,code,detail');
      expect(manifest).toContain('document-0001.docx');
      expect(manifest).not.toContain('Aisha Rahman');
      expect(manifest).not.toContain('4500');
    });

    describe('--output', () => {
      it('writes PDFs, named .pdf, when asked for PDF', async () => {
        const ctx = makeContext();
        expect(await fillCommand(fillArgs('--output', 'pdf'), ctx)).toBe(0);

        const first = new Uint8Array(await readFile(join(outDir, 'document-0001.pdf')));
        expect(Buffer.from(first.slice(0, 5)).toString()).toBe('%PDF-');
        expect(pdfText(first)).toContain('Aisha Rahman');
      });

      it('still writes DOCX by default', async () => {
        await fillCommand(fillArgs(), makeContext());
        await expect(stat(join(outDir, 'document-0001.docx'))).resolves.toBeDefined();
      });

      it('creates each PDF owner-only, like every other output', async () => {
        await fillCommand(fillArgs('--output', 'pdf'), makeContext());
        expect((await stat(join(outDir, 'document-0001.pdf'))).mode & 0o777).toBe(0o600);
      });

      it('rejects a format it does not have', async () => {
        const ctx = makeContext();
        expect(await fillCommand(fillArgs('--output', 'rtf'), ctx)).toBe(2);
        expect(ctx.err.join('\n')).toContain('--output must be one of');
      });

      it('warns when PDF output would drop part of the template', async () => {
        // Silence here would mean discovering the missing table after sending.
        await writeFile(templatePath, makeTemplate(['NAME', 'SALARY'], { withTable: true }));
        const ctx = makeContext();
        expect(await fillCommand(fillArgs('--output', 'pdf'), ctx)).toBe(0);
        expect(ctx.err.join('\n')).toContain('tables');
      });

      it('says nothing about unsupported features when writing DOCX', async () => {
        await writeFile(templatePath, makeTemplate(['NAME', 'SALARY'], { withTable: true }));
        const ctx = makeContext();
        await fillCommand(fillArgs(), ctx);
        expect(ctx.err.join('\n')).not.toContain('tables');
      });
    });

    it('writes a ZIP when asked', async () => {
      const zipPath = join(dir, 'out.zip');
      const ctx = makeContext();
      expect(
        await fillCommand(
          parseArgs([
            'fill', '--template', templatePath, '--data', dataPath, '--zip', zipPath,
          ]),
          ctx,
        ),
      ).toBe(0);
      const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
      expect(Object.keys(entries).sort()).toEqual(['document-0001.docx', 'document-0002.docx']);
    });

    it('applies a filename template', async () => {
      await fillCommand(fillArgs('--filename', '{{STAFF_ID}}-offer'), makeContext());
      await expect(stat(join(outDir, 'EMP-0001-offer.docx'))).resolves.toBeTruthy();
    });

    it('warns when a filename template would expose an identifier', async () => {
      const ctx = makeContext();
      await fillCommand(fillArgs('--filename', '{{NRIC}}'), ctx);
      expect(ctx.err.join('\n')).toMatch(/visible without opening/i);
    });

    describe('overwrite protection', () => {
      it('refuses to replace an existing file', async () => {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'document-0001.docx'), 'existing');
        const ctx = makeContext();
        expect(await fillCommand(fillArgs(), ctx)).toBe(1);
        expect(ctx.err.join('\n')).toMatch(/Refusing to overwrite/);
        expect(await readFile(join(outDir, 'document-0001.docx'), 'utf8')).toBe('existing');
      });

      it('does not write through a symlink planted in the output directory', async () => {
        // Without this, anyone who can create files in the output directory
        // could redirect a generated document over an arbitrary file.
        const outside = join(dir, 'outside.txt');
        await writeFile(outside, 'untouched');
        await mkdir(outDir, { recursive: true });
        await symlink(outside, join(outDir, 'document-0001.docx'));

        const ctx = makeContext();
        expect(await fillCommand(fillArgs(), ctx)).toBe(1);
        expect(await readFile(outside, 'utf8')).toBe('untouched');
      });

      it('replaces the symlink itself, not its target, under --force', async () => {
        const outside = join(dir, 'outside.txt');
        await writeFile(outside, 'untouched');
        await mkdir(outDir, { recursive: true });
        await symlink(outside, join(outDir, 'document-0001.docx'));

        expect(await fillCommand(fillArgs('--force'), makeContext())).toBe(0);
        // The target survives; the link has become a real generated document.
        expect(await readFile(outside, 'utf8')).toBe('untouched');
        await expect(readlink(join(outDir, 'document-0001.docx'))).rejects.toThrow();
        expect(
          readDocxText(new Uint8Array(await readFile(join(outDir, 'document-0001.docx')))),
        ).toContain('Aisha Rahman');
      });

      it('refuses to overwrite an existing ZIP', async () => {
        const zipPath = join(dir, 'out.zip');
        await writeFile(zipPath, 'existing');
        const ctx = makeContext();
        expect(
          await fillCommand(
            parseArgs(['fill', '--template', templatePath, '--data', dataPath, '--zip', zipPath]),
            ctx,
          ),
        ).toBe(1);
        expect(await readFile(zipPath, 'utf8')).toBe('existing');
      });

      it('refuses to overwrite an existing manifest', async () => {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'manifest.csv'), 'existing');
        const ctx = makeContext();
        // The documents write cleanly; the manifest is what collides.
        expect(await fillCommand(fillArgs(), ctx)).toBe(1);
        expect(ctx.err.join('\n')).toMatch(/Refusing to overwrite an existing manifest/);
        expect(await readFile(join(outDir, 'manifest.csv'), 'utf8')).toBe('existing');
      });

      it('replaces when --force is given', async () => {
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'document-0001.docx'), 'existing');
        expect(await fillCommand(fillArgs('--force'), makeContext())).toBe(0);
        expect(await readFile(join(outDir, 'document-0001.docx'), 'utf8')).not.toBe('existing');
      });
    });

    describe('dry run', () => {
      it('reports what would happen and writes nothing', async () => {
        const ctx = makeContext();
        expect(await fillCommand(fillArgs('--dry-run'), ctx)).toBe(0);
        expect(ctx.out.join('\n')).toContain('2 document(s) would be written');
        await expect(stat(outDir)).rejects.toThrow();
      });
    });

    describe('failures', () => {
      it('continues past a bad row and exits non-zero', async () => {
        await writeFile(dataPath, 'NAME,SALARY,STAFF_ID\nAisha,4500,E1\nWei Lun,,E2\n');
        const ctx = makeContext();
        expect(await fillCommand(fillArgs('--empty-is-missing'), ctx)).toBe(1);

        await expect(stat(join(outDir, 'document-0001.docx'))).resolves.toBeTruthy();
        expect(ctx.err.join('\n')).toContain('Row 2');
      });

      it('does not print record values when reporting a failure', async () => {
        await writeFile(dataPath, 'NAME,SALARY,STAFF_ID\nAisha Rahman,,E1\n');
        const ctx = makeContext();
        await fillCommand(fillArgs('--empty-is-missing'), ctx);
        expect([...ctx.out, ...ctx.err].join('\n')).not.toContain('Aisha Rahman');
      });

      it('records the failure in the manifest', async () => {
        await writeFile(dataPath, 'NAME,SALARY,STAFF_ID\nAisha,4500,E1\nWei Lun,,E2\n');
        await fillCommand(fillArgs('--empty-is-missing'), makeContext());
        const manifest = await readFile(join(outDir, 'manifest.csv'), 'utf8');
        expect(manifest).toContain('failed');
        expect(manifest).toContain('MISSING_VALUE');
      });
    });

    describe('XLSX input', () => {
      // The fixture is generated by openpyxl; see packages/core/test/fixtures.
      const workbook = fileURLToPath(
        new URL('../../../packages/core/test/fixtures/staff.xlsx', import.meta.url),
      );

      /** A template whose placeholders match the workbook's column headers. */
      let sheetTemplate: string;

      beforeEach(async () => {
        sheetTemplate = join(dir, 'sheet-offer.docx');
        await writeFile(sheetTemplate, makeTemplate(['FULL_NAME', 'STAFF_ID']));
      });

      it('fills documents from a workbook', async () => {
        const ctx = makeContext();
        const code = await fillCommand(
          parseArgs(['fill', '--template', sheetTemplate, '--data', workbook, '--out', outDir]),
          ctx,
        );
        expect(code).toBe(0);
        // "Full Name" in the sheet fills {{FULL_NAME}} in the template.
        const first = await readFile(join(outDir, 'document-0001.docx'));
        expect(readDocxText(new Uint8Array(first))).toContain('Aisha Rahman');
      });

      it('reads a named worksheet', async () => {
        const ctx = makeContext();
        expect(
          await fillCommand(
            parseArgs([
              'fill', '--template', sheetTemplate, '--data', workbook,
              '--out', outDir, '--sheet', 'Archive',
            ]),
            ctx,
          ),
        ).toBe(0);
        const first = await readFile(join(outDir, 'document-0001.docx'));
        expect(readDocxText(new Uint8Array(first))).toContain('Former Person');
      });

      it('reads a worksheet by index', async () => {
        await fillCommand(
          parseArgs([
            'fill', '--template', sheetTemplate, '--data', workbook,
            '--out', outDir, '--sheet', '1',
          ]),
          makeContext(),
        );
        const first = await readFile(join(outDir, 'document-0001.docx'));
        expect(readDocxText(new Uint8Array(first))).toContain('Former Person');
      });

      it('lists the worksheets on inspect', async () => {
        const ctx = makeContext();
        await inspectCommand(parseArgs(['inspect', '--data', workbook]), ctx);
        expect(ctx.out.join('\n')).toContain('Worksheets: Staff, Archive');
      });

      it('does not print any cell values on inspect', async () => {
        const ctx = makeContext();
        await inspectCommand(parseArgs(['inspect', '--data', workbook]), ctx);
        expect([...ctx.out, ...ctx.err].join('\n')).not.toContain('Aisha Rahman');
      });
    });

    describe('usage errors', () => {
      it('requires a template and data file', async () => {
        expect(await fillCommand(parseArgs(['fill']), makeContext())).toBe(2);
      });

      it('requires an output destination', async () => {
        expect(
          await fillCommand(
            parseArgs(['fill', '--template', templatePath, '--data', dataPath]),
            makeContext(),
          ),
        ).toBe(2);
      });

      it('rejects an unknown missing-value policy', async () => {
        expect(await fillCommand(fillArgs('--missing', 'invent'), makeContext())).toBe(2);
      });

      it('rejects an unsupported data file type', async () => {
        const json = join(dir, 'staff.json');
        await writeFile(json, '[]');
        await expect(
          fillCommand(
            parseArgs(['fill', '--template', templatePath, '--data', json, '--out', outDir]),
            makeContext(),
          ),
        ).rejects.toThrow(/Unsupported data file type/);
      });

      it('rejects a file named .xlsx that is not a workbook', async () => {
        // The extension selects the reader; the content still has to be valid.
        const xlsx = join(dir, 'staff.xlsx');
        await writeFile(xlsx, 'not really a spreadsheet');
        await expect(
          fillCommand(
            parseArgs(['fill', '--template', templatePath, '--data', xlsx, '--out', outDir]),
            makeContext(),
          ),
        ).rejects.toThrow(/not a valid XLSX workbook/);
      });
    });
  });
});
