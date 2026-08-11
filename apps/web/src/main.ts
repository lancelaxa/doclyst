import {
  DoclystError,
  buildZip,
  checkFilenameTemplate,
  detectTemplateKind,
  normalizeKey,
  readCsvRecords,
  readSheetNames,
  readTemplateFields,
  readUnsupportedForPdf,
  readXlsxRecords,
  runBatch,
  safeErrorSummary,
  streamBatch,
  type BatchFailure,
  type BatchResult,
  type BatchSummary,
  type DataRecord,
  type MissingValuePolicy,
  type OutputFormat,
  type Template,
} from '@doclyst/core';
import { byId, clear, el, nextFrame, replaceChildren } from './dom.js';
import { downloadBytes } from './download.js';
import {
  StreamingZipWriter,
  isAbort,
  pickDirectory,
  pickZipFile,
  supportsFileSystemAccess,
  writeFileTo,
} from './filesystem.js';
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

/**
 * Total output size above which a single ZIP becomes unreliable in a browser.
 *
 * Measured in Chromium: a batch whose documents came to roughly 570 MB left
 * the tab holding about 1.2 GB once the archive was built, and the download
 * was cancelled silently. A plain blob of the same size on an idle page
 * downloaded fine, so the limit is memory pressure rather than any size cap —
 * which makes it device-dependent, hence a warning rather than a refusal.
 */
const LARGE_OUTPUT_WARNING_BYTES = 300 * 1024 * 1024;

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

const templateDrop = byId<HTMLLabelElement>('template-drop');
const dataDrop = byId<HTMLLabelElement>('data-drop');
const templateInput = byId<HTMLInputElement>('template-input');
const dataInput = byId<HTMLInputElement>('data-input');
const sheetRow = byId<HTMLDivElement>('sheet-row');
const sheetSelect = byId<HTMLSelectElement>('sheet-select');
const filenameInput = byId<HTMLInputElement>('filename-input');
const formatSelect = byId<HTMLSelectElement>('format-select');
const formatWarnings = byId<HTMLDivElement>('format-warnings');
const missingSelect = byId<HTMLSelectElement>('missing-select');
const emptyIsMissing = byId<HTMLInputElement>('empty-is-missing');
const scrubMetadata = byId<HTMLInputElement>('scrub-metadata');
const flattenPdf = byId<HTMLInputElement>('flatten-pdf');
const generateButton = byId<HTMLButtonElement>('generate');
const saveFolderButton = byId<HTMLButtonElement>('save-folder');
const saveZipButton = byId<HTMLButtonElement>('save-zip');
const streamingHint = byId<HTMLParagraphElement>('streaming-hint');
const progress = byId<HTMLDivElement>('progress');
const progressFill = byId<HTMLDivElement>('progress-fill');
const progressLabel = byId<HTMLSpanElement>('progress-label');
const results = byId<HTMLDivElement>('results');
const templateSummary = byId<HTMLDivElement>('template-summary');
const dataSummary = byId<HTMLDivElement>('data-summary');
const filenameWarnings = byId<HTMLDivElement>('filename-warnings');

// --- drag and drop -----------------------------------------------------

/**
 * Let a file be dropped onto a zone as well as chosen through the picker.
 *
 * The drop is routed through the hidden `<input type="file">` rather than
 * handled separately, so both routes end in exactly one code path — and the
 * input remains the accessible control the label points at.
 */
function enableDropZone(zone: HTMLElement, input: HTMLInputElement): void {
  const setDragging = (dragging: boolean): void => {
    zone.classList.toggle('dragging', dragging);
  };

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    setDragging(true);
  });
  zone.addEventListener('dragleave', () => setDragging(false));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    setDragging(false);

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    // Assigning a DataTransfer's list is the only way to put a dropped file
    // into a file input, which keeps the change handler as the single entry
    // point for loading.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
}

enableDropZone(templateDrop, templateInput);
enableDropZone(dataDrop, dataInput);

/** Mark a zone as holding a file, and name it in place of the prompt. */
function markZone(zone: HTMLElement, filename: string | undefined): void {
  zone.classList.toggle('loaded', filename !== undefined);
  const text = zone.querySelector('.dz-text');
  const meta = zone.querySelector('.dz-meta');
  if (!text || !meta) return;

  if (filename === undefined) {
    // Rebuild the prompt as elements; filenames are never treated as markup.
    const isTemplate = zone === templateDrop;
    replaceChildren(
      text as HTMLElement,
      el('strong', { text: isTemplate ? 'Choose a template' : 'Choose a spreadsheet' }),
      document.createTextNode(' or drop it here'),
    );
    meta.textContent = isTemplate ? 'DOCX or PDF' : 'CSV or XLSX';
    return;
  }

  replaceChildren(text as HTMLElement, el('strong', { text: filename }));
  meta.textContent = 'Click or drop to replace';
}

// Progressive enhancement: these only appear where the browser can write to
// a user-chosen location. Everywhere else the download path is unchanged.
if (supportsFileSystemAccess()) {
  saveFolderButton.hidden = false;
  saveZipButton.hidden = false;
  streamingHint.hidden = false;
}

// --- loading -----------------------------------------------------------

templateInput.addEventListener('change', () => {
  void withStatus(templateSummary, async () => {
    const file = templateInput.files?.[0];
    loadedTemplate = undefined;
    markZone(templateDrop, undefined);
    if (!file) return;

    const bytes = new Uint8Array(await file.arrayBuffer());
    // Identified by content, so a mislabelled file is caught here rather than
    // failing obscurely part way through a batch.
    const template: Template = { kind: detectTemplateKind(bytes), bytes };
    const fields = await readTemplateFields(template);
    loadedTemplate = { template, filename: file.name, fields };
    markZone(templateDrop, file.name);

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
    markZone(dataDrop, undefined);
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
  markZone(dataDrop, filename);
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

formatSelect.addEventListener('change', syncFormat);

/** The format actually in effect: a PDF template can only produce PDF. */
function outputFormat(): OutputFormat {
  if (loadedTemplate?.template.kind === 'pdf') return 'pdf';
  return formatSelect.value === 'pdf' ? 'pdf' : 'docx';
}

/**
 * Reflect the template's constraints in the format control, and say up front
 * what a PDF run would lose.
 *
 * Warning here rather than after the run is the point: once three hundred
 * documents are on disk, a missing letterhead has already been discovered by
 * whoever opens one.
 */
function syncFormat(): void {
  const kind = loadedTemplate?.template.kind;
  formatSelect.disabled = kind === 'pdf';
  if (kind === 'pdf') formatSelect.value = 'pdf';

  clear(formatWarnings);
  if (kind === 'pdf') {
    formatWarnings.append(
      el('p', { className: 'fields', text: 'A PDF template always produces PDF.' }),
    );
    return;
  }
  if (kind !== 'docx' || outputFormat() !== 'pdf') return;

  try {
    const unsupported = readUnsupportedForPdf(loadedTemplate!.template);
    if (unsupported.length > 0) {
      formatWarnings.append(
        warning(
          `This template uses ${unsupported.join(', ')}, which cannot be carried into a re-typeset PDF. Generate one document and check it before running the batch.`,
        ),
      );
    }
  } catch {
    // Whatever is wrong with the template will be reported properly when the
    // batch runs; a warning box is not the place to raise it first.
  }
}

// --- generating --------------------------------------------------------

generateButton.addEventListener('click', () => {
  void generate();
});

saveFolderButton.addEventListener('click', () => {
  void streamToDisk('folder');
});

saveZipButton.addEventListener('click', () => {
  void streamToDisk('zip');
});

/**
 * Generate straight to disk, never holding the batch in memory.
 *
 * Each document is written as it is produced, so peak memory is about one
 * document regardless of how many records there are — which is what makes
 * large, image-heavy batches possible at all.
 */
async function streamToDisk(target: 'folder' | 'zip'): Promise<void> {
  if (!loadedTemplate || !loadedData) return;

  let destination: Awaited<ReturnType<typeof pickDirectory>> | undefined;
  let zipWriter: StreamingZipWriter | undefined;

  try {
    // The picker must be opened from the click, before any long work, or the
    // browser treats it as lacking a user gesture and refuses.
    if (target === 'folder') {
      destination = await pickDirectory();
      if (!destination) return;
    } else {
      const handle = await pickZipFile('doclyst-documents.zip');
      if (!handle) return;
      zipWriter = await StreamingZipWriter.create(handle);
    }
  } catch (error) {
    // Dismissing the picker is a decision, not a failure.
    if (!isAbort(error)) replaceChildren(results, warning(describeError(error)));
    return;
  }

  setBusy(true);
  clear(results);
  progress.hidden = false;
  updateProgress(0, loadedData.records.length);

  const failures: BatchFailure[] = [];
  let written = 0;
  let bytesWritten = 0;

  const stream = streamBatch(loadedTemplate.template, loadedData.records, {
    missing: missingSelect.value as MissingValuePolicy,
    outputFormat: outputFormat(),
    treatEmptyAsMissing: emptyIsMissing.checked,
    filenameTemplate: filenameInput.value.trim() || undefined,
    docx: { scrubMetadata: scrubMetadata.checked },
    pdf: { scrubMetadata: scrubMetadata.checked, flatten: flattenPdf.checked },
    onProgress: async (completed, total) => {
      updateProgress(completed, total);
      if (completed % 5 === 0) await nextFrame();
    },
  });

  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === 'failure') {
        failures.push(next.value.failure);
      } else {
        const { filename, bytes } = next.value.document;
        if (zipWriter) {
          // A generated .docx is already a ZIP and a PDF is largely
          // compressed, so entries are stored rather than deflated again.
          await zipWriter.add(filename, bytes, false);
        } else {
          await writeFileTo(destination!, filename, bytes);
        }
        written += 1;
        bytesWritten += bytes.length;
      }
      next = await stream.next();
    }

    await zipWriter?.close();
    showStreamResult(next.value, target, written, bytesWritten, failures);
  } catch (error) {
    // Stop producing documents, and discard a half-written archive rather than
    // leaving something that looks like a complete set.
    await stream.return(undefined as never).catch(() => undefined);
    await zipWriter?.abort(error).catch(() => undefined);
    replaceChildren(
      results,
      warning(`Stopped after ${written} document(s): ${describeError(error)}`),
    );
  } finally {
    progress.hidden = true;
    setBusy(false);
  }
}

function showStreamResult(
  summary: BatchSummary,
  target: 'folder' | 'zip',
  written: number,
  bytesWritten: number,
  failures: readonly BatchFailure[],
): void {
  const nodes: Node[] = [
    el('p', {
      className: failures.length > 0 ? 'partial' : 'ok',
      text:
        `${written} document${written === 1 ? '' : 's'} written ` +
        `${target === 'zip' ? 'to the ZIP' : 'to the folder'} (${formatBytes(bytesWritten)})` +
        (failures.length > 0 ? `, ${failures.length} row(s) failed` : ''),
    }),
  ];

  if (summary.unmatchedFields.length > 0) {
    nodes.push(warning(`No column matched: ${summary.unmatchedFields.join(', ')}`));
  }

  nodes.push(...unsupportedNotice(summary.unsupported), ...shrunkNotice(summary.shrunkFields));

  if (failures.length > 0) {
    const list = el('ul', { className: 'failure-list' });
    for (const failure of failures) {
      list.append(el('li', { text: `Row ${failure.row}: ${failure.message}` }));
    }
    nodes.push(el('h3', { text: 'Rows that failed' }), list);
  }

  replaceChildren(results, ...nodes);
}

async function generate(): Promise<void> {
  if (!loadedTemplate || !loadedData) return;

  setBusy(true);
  clear(results);
  progress.hidden = false;
  updateProgress(0, loadedData.records.length);

  try {
    const result = await runBatch(loadedTemplate.template, loadedData.records, {
      missing: missingSelect.value as MissingValuePolicy,
      outputFormat: outputFormat(),
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

  nodes.push(...unsupportedNotice(result.unsupported), ...shrunkNotice(result.shrunkFields));

  if (result.documents.length > 0) {
    const totalBytes = result.documents.reduce((sum, document) => sum + document.bytes.length, 0);
    nodes.push(el('p', { className: 'fields', text: `Total size: ${formatBytes(totalBytes)}` }));

    const zipButton = el('button', { className: 'btn btn-primary', text: 'Download all as ZIP' });
    zipButton.addEventListener('click', () => {
      const archive = buildZip(
        result.documents.map((document) => ({ name: document.filename, bytes: document.bytes })),
      );
      downloadBytes(archive, 'doclyst-documents.zip');
    });
    nodes.push(zipButton);

    // Browsers cancel a blob download once the tab is under enough memory
    // pressure, and they do it silently — the click simply does nothing, with
    // no error to catch. Saying so up front beats leaving someone clicking a
    // button that will never respond. Individual downloads are unaffected
    // because each document is small.
    if (totalBytes > LARGE_OUTPUT_WARNING_BYTES) {
      nodes.push(
        warning(
          `These documents total ${formatBytes(totalBytes)}. A ZIP this large may fail to save — browsers cancel very large downloads without reporting it. ${
            supportsFileSystemAccess()
              ? 'Use “Save to folder” or “Save as ZIP” above, which write straight to disk and have no such limit.'
              : 'Download the files individually below, or use the command-line tool, which writes straight to disk and has no such limit.'
          }`,
        ),
      );
    }

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

/** Name the PDF fields the template gave too little room. */
function shrunkNotice(fields: readonly string[]): Node[] {
  if (fields.length === 0) return [];
  return [
    warning(
      `The text was shrunk to fit these form fields: ${fields.join(', ')}. The documents are complete, but widening those fields in the template will make them read evenly.`,
    ),
  ];
}

/** Repeat, on the finished batch, what the template could not carry into PDF. */
function unsupportedNotice(unsupported: readonly string[]): Node[] {
  if (unsupported.length === 0) return [];
  return [
    warning(
      `These documents were re-typeset as PDF, and the template's ${unsupported.join(', ')} could not be carried over. Check one before sending them.`,
    ),
  ];
}

function updateProgress(completed: number, total: number): void {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  progressFill.style.width = `${percent}%`;
  progressLabel.textContent = `${completed} of ${total}`;
}

function setBusy(busy: boolean): void {
  generateButton.disabled = busy || !ready();
  saveFolderButton.disabled = busy || !ready();
  saveZipButton.disabled = busy || !ready();
  generateButton.textContent = busy ? 'Generating…' : 'Generate documents';
}

function ready(): boolean {
  return loadedTemplate !== undefined && (loadedData?.records.length ?? 0) > 0;
}

function refresh(): void {
  syncFormat();
  setBusy(false);
}

// --- presentation helpers ----------------------------------------------

function summaryLine(text: string): HTMLElement {
  return el('p', { className: 'name', text });
}

function fieldList(label: string, fields: readonly string[]): HTMLElement {
  return el('p', { className: 'fields', text: `${label} (${fields.length}): ${fields.join(', ')}` });
}

/** Human-readable byte size, for reporting how big a batch turned out. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
