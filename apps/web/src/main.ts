import {
  DoclystError,
  buildZip,
  checkFilenameTemplate,
  detectTemplateKind,
  normalizeKey,
  readCsvRecords,
  readSheetNames,
  readTemplateFields,
  readXlsxRecords,
  runBatch,
  safeErrorSummary,
  type BatchResult,
  type DataRecord,
  type MissingValuePolicy,
  type Template,
} from '@doclyst/core';
import { byId, clear, el, nextFrame, replaceChildren } from './dom.js';
import { downloadBytes } from './download.js';
import './app.css';

/**
 * The browser interface.
 *
 * All work runs in this tab: the engine is the same `@doclyst/core` the CLI
 * uses, which has no filesystem or network access of its own. Files are read
 * through the File API, filled in memory, and handed back as downloads. No
 * record is ever persisted — not to localStorage, not to IndexedDB, not to a
 * service worker — so closing the tab disposes of everything.
 */

interface LoadedTemplate {
  readonly template: Template;
  readonly filename: string;
  readonly fields: readonly string[];
}

interface LoadedData {
  readonly filename: string;
  readonly fields: readonly string[];
  readonly records: readonly DataRecord[];
  /** Present only for workbooks. */
  readonly sheets?: readonly string[];
  /** Raw bytes, kept so another worksheet can be selected without re-reading. */
  readonly bytes?: Uint8Array;
}

let loadedTemplate: LoadedTemplate | undefined;
let loadedData: LoadedData | undefined;

const templateInput = byId<HTMLInputElement>('template-input');
const dataInput = byId<HTMLInputElement>('data-input');
const sheetRow = byId<HTMLDivElement>('sheet-row');
const sheetSelect = byId<HTMLSelectElement>('sheet-select');
const filenameInput = byId<HTMLInputElement>('filename-input');
const missingSelect = byId<HTMLSelectElement>('missing-select');
const emptyIsMissing = byId<HTMLInputElement>('empty-is-missing');
const scrubMetadata = byId<HTMLInputElement>('scrub-metadata');
const flattenPdf = byId<HTMLInputElement>('flatten-pdf');
const generateButton = byId<HTMLButtonElement>('generate');
const progress = byId<HTMLDivElement>('progress');
const progressFill = byId<HTMLDivElement>('progress-fill');
const progressLabel = byId<HTMLSpanElement>('progress-label');
const results = byId<HTMLDivElement>('results');
const templateSummary = byId<HTMLDivElement>('template-summary');
const dataSummary = byId<HTMLDivElement>('data-summary');
const filenameWarnings = byId<HTMLDivElement>('filename-warnings');

// --- loading -----------------------------------------------------------

templateInput.addEventListener('change', () => {
  void withStatus(templateSummary, async () => {
    const file = templateInput.files?.[0];
    loadedTemplate = undefined;
    if (!file) return;

    const bytes = new Uint8Array(await file.arrayBuffer());
    // Identified by content, so a mislabelled file is caught here rather than
    // failing obscurely part way through a batch.
    const template: Template = { kind: detectTemplateKind(bytes), bytes };
    const fields = await readTemplateFields(template);
    loadedTemplate = { template, filename: file.name, fields };

    replaceChildren(
      templateSummary,
      summaryLine(`${file.name} — ${template.kind.toUpperCase()}`),
      fields.length > 0
        ? fieldList('Fields', fields)
        : warning(
            template.kind === 'pdf'
              ? 'This PDF has no fillable form fields. Add form fields named after your columns.'
              : 'No placeholders found. Add {{FIELD}} markers to the template.',
          ),
    );
  });
});

dataInput.addEventListener('change', () => {
  void withStatus(dataSummary, async () => {
    const file = dataInput.files?.[0];
    loadedData = undefined;
    sheetRow.hidden = true;
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.xlsx')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sheets = readSheetNames(bytes);
      populateSheets(sheets);
      loadWorksheet(file.name, bytes, sheets[0]);
    } else {
      const { fields, records } = readCsvRecords(await file.text());
      loadedData = { filename: file.name, fields, records };
      describeData();
    }
  });
});

sheetSelect.addEventListener('change', () => {
  void withStatus(dataSummary, async () => {
    if (!loadedData?.bytes) return;
    loadWorksheet(loadedData.filename, loadedData.bytes, sheetSelect.value);
  });
});

function populateSheets(sheets: readonly string[]): void {
  clear(sheetSelect);
  for (const name of sheets) {
    sheetSelect.append(el('option', { text: name, attrs: { value: name } }));
  }
  sheetRow.hidden = sheets.length < 2;
}

function loadWorksheet(filename: string, bytes: Uint8Array, sheet: string | undefined): void {
  const { fields, records } = readXlsxRecords(bytes, sheet === undefined ? {} : { sheet });
  loadedData = { filename, fields, records, sheets: readSheetNames(bytes), bytes };
  describeData();
}

function describeData(): void {
  if (!loadedData) return;
  const { filename, fields, records } = loadedData;
  replaceChildren(
    dataSummary,
    summaryLine(`${filename} — ${records.length} row${records.length === 1 ? '' : 's'}`),
    fieldList('Columns', fields),
    ...unmatchedNotice(),
  );
  refresh();
}

/**
 * Warn before a run about placeholders no column can satisfy.
 *
 * Far better to say so now than to produce a folder of documents with a blank
 * salary in each, or to fail every row once the batch is under way.
 */
function unmatchedNotice(): Node[] {
  if (!loadedTemplate || !loadedData) return [];
  const available = new Set(loadedData.fields.map(normalizeKey));
  const unmatched = loadedTemplate.fields.filter((field) => !available.has(normalizeKey(field)));
  if (unmatched.length === 0) {
    return [el('p', { className: 'ok', text: 'Every template placeholder has a matching column.' })];
  }
  return [warning(`No column matches: ${unmatched.join(', ')}`)];
}

// --- options -----------------------------------------------------------

filenameInput.addEventListener('input', () => {
  const warnings = checkFilenameTemplate(filenameInput.value);
  replaceChildren(filenameWarnings, ...warnings.map((w) => warning(w.message)));
});

// --- generating --------------------------------------------------------

generateButton.addEventListener('click', () => {
  void generate();
});

async function generate(): Promise<void> {
  if (!loadedTemplate || !loadedData) return;

  setBusy(true);
  clear(results);
  progress.hidden = false;
  updateProgress(0, loadedData.records.length);

  try {
    const result = await runBatch(loadedTemplate.template, loadedData.records, {
      missing: missingSelect.value as MissingValuePolicy,
      treatEmptyAsMissing: emptyIsMissing.checked,
      filenameTemplate: filenameInput.value.trim() || undefined,
      docx: { scrubMetadata: scrubMetadata.checked },
      pdf: { scrubMetadata: scrubMetadata.checked, flatten: flattenPdf.checked },
      onProgress: async (completed, total) => {
        updateProgress(completed, total);
        // Yield periodically so the page keeps painting during a long batch.
        if (completed % 5 === 0) await nextFrame();
      },
    });
    showResults(result);
  } catch (error) {
    // A template-level failure (a corrupt file, a PDF with no fields) stops the
    // whole run; per-row problems arrive as failures inside the result.
    replaceChildren(results, warning(describeError(error)));
  } finally {
    progress.hidden = true;
    setBusy(false);
  }
}

function showResults(result: BatchResult): void {
  const nodes: Node[] = [];

  nodes.push(
    el('p', {
      className: result.failures.length > 0 ? 'partial' : 'ok',
      text:
        `${result.documents.length} document${result.documents.length === 1 ? '' : 's'} ready` +
        (result.failures.length > 0 ? `, ${result.failures.length} row(s) failed` : ''),
    }),
  );

  if (result.documents.length > 0) {
    const zipButton = el('button', { className: 'primary', text: 'Download all as ZIP' });
    zipButton.addEventListener('click', () => {
      const archive = buildZip(
        result.documents.map((document) => ({ name: document.filename, bytes: document.bytes })),
      );
      downloadBytes(archive, 'doclyst-documents.zip');
    });
    nodes.push(zipButton);

    const list = el('ul', { className: 'file-list' });
    for (const document of result.documents) {
      const link = el('button', { className: 'link', text: document.filename });
      link.addEventListener('click', () => downloadBytes(document.bytes, document.filename));
      list.append(el('li', {}, [link]));
    }
    nodes.push(list);
  }

  if (result.failures.length > 0) {
    // Failures name a row and a field, never a value, so this list is safe to
    // read aloud, screenshot or paste into a ticket.
    const list = el('ul', { className: 'failure-list' });
    for (const failure of result.failures) {
      list.append(el('li', { text: `Row ${failure.row}: ${failure.message}` }));
    }
    nodes.push(el('h3', { text: 'Rows that failed' }), list);
  }

  replaceChildren(results, ...nodes);
}

function updateProgress(completed: number, total: number): void {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  progressFill.style.width = `${percent}%`;
  progressLabel.textContent = `${completed} of ${total}`;
}

function setBusy(busy: boolean): void {
  generateButton.disabled = busy || !ready();
  generateButton.textContent = busy ? 'Generating…' : 'Generate documents';
}

function ready(): boolean {
  return loadedTemplate !== undefined && (loadedData?.records.length ?? 0) > 0;
}

function refresh(): void {
  generateButton.disabled = !ready();
}

// --- presentation helpers ----------------------------------------------

function summaryLine(text: string): HTMLElement {
  return el('p', { className: 'name', text });
}

function fieldList(label: string, fields: readonly string[]): HTMLElement {
  return el('p', { className: 'fields', text: `${label} (${fields.length}): ${fields.join(', ')}` });
}

function warning(message: string): HTMLElement {
  return el('p', { className: 'warn', text: message });
}

/**
 * Turn a thrown value into something safe to show.
 *
 * Our own errors are written to be displayable. Anything else is summarised,
 * because a parser's message can quote the bytes it choked on — which may be
 * a name or an NRIC.
 */
function describeError(error: unknown): string {
  return error instanceof DoclystError ? error.message : safeErrorSummary(error);
}

/** Run a loader, reporting any failure in place rather than throwing. */
async function withStatus(target: HTMLElement, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    replaceChildren(target, warning(describeError(error)));
  } finally {
    refresh();
  }
}
