import {
  DoclystError,
  buildZip,
  checkEmailAddress,
  checkFilenameTemplate,
  checkReturnedLetters,
  checkPdfTemplateFit,
  detectTemplateKind,
  normalizeKey,
  preparePdfTemplate,
  readCsvRecords,
  readSheetNames,
  readTemplateFields,
  readUnsupportedForPdf,
  readXlsxRecords,
  runBatch,
  safeErrorSummary,
  streamBatch,
  type BatchFailure,
  type BatchOptions,
  type ReturnedCheck,
  type ReturnedLetterReport,
  type ReturnedStatus,
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
const makeEmails = byId<HTMLInputElement>('make-emails');
const emailFields = byId<HTMLDivElement>('email-fields');
const emailColumn = byId<HTMLSelectElement>('email-column');
const emailCheck = byId<HTMLDivElement>('email-check');
const emailSubject = byId<HTMLInputElement>('email-subject');
const attachmentName = byId<HTMLInputElement>('attachment-name');
const emailBody = byId<HTMLTextAreaElement>('email-body');
const sentDrop = byId<HTMLLabelElement>('sent-drop');
const sentInput = byId<HTMLInputElement>('sent-input');
const returnedDrop = byId<HTMLLabelElement>('returned-drop');
const returnedInput = byId<HTMLInputElement>('returned-input');
const checkButton = byId<HTMLButtonElement>('check-returned');
const checkResults = byId<HTMLDivElement>('check-results');
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
const fitReport = byId<HTMLDivElement>('fit-report');
const preparePanel = byId<HTMLDivElement>('prepare-panel');
const prepareButton = byId<HTMLButtonElement>('prepare');
const prepareIntro = byId<HTMLParagraphElement>('prepare-intro');
const downloadPreparedButton = byId<HTMLButtonElement>('download-prepared');
const prepareResult = byId<HTMLDivElement>('prepare-result');

/** The prepared template, kept so it can be downloaded and reused. */
let preparedTemplate: { bytes: Uint8Array; filename: string } | undefined;

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
              ? 'This PDF has no fillable form fields yet.'
              : 'No placeholders found. Add {{FIELD}} markers to the template.',
          ),
    );

    // A PDF with no fields is usually one exported straight from Word with the
    // placeholders still written into it — which Doclyst can turn into a
    // template itself, rather than sending someone to a PDF editor.
    preparedTemplate = undefined;
    clear(prepareResult);
    downloadPreparedButton.hidden = true;
    prepareButton.hidden = false;
    prepareIntro.hidden = false;
    preparePanel.hidden = !(template.kind === 'pdf' && fields.length === 0);
  });
});

prepareButton.addEventListener('click', () => {
  void withStatus(prepareResult, async () => {
    const loaded = loadedTemplate;
    if (loaded === undefined || loaded.template.kind !== 'pdf') return;

    const result = await preparePdfTemplate(loaded.template.bytes);
    const template: Template = { kind: 'pdf', bytes: result.bytes };
    const fields = await readTemplateFields(template);

    // The prepared file becomes the template in use, so a batch can be run
    // straight away without a round trip through the filesystem.
    loadedTemplate = { template, filename: loaded.filename, fields };
    preparedTemplate = {
      bytes: result.bytes,
      filename: loaded.filename.replace(/\.pdf$/i, '') + '-template.pdf',
    };
    // The invitation and its button have done their job; leaving them would
    // read as though nothing had happened.
    downloadPreparedButton.hidden = false;
    prepareButton.hidden = true;
    prepareIntro.hidden = true;

    replaceChildren(
      templateSummary,
      summaryLine(`${loaded.filename} — PDF, prepared`),
      fieldList('Fields', fields),
    );

    const notes: Node[] = [
      el('p', {
        className: 'ok',
        text: `Placed ${result.fields.length} field${result.fields.length === 1 ? '' : 's'}. The rest of the page is unchanged.`,
      }),
    ];
    for (const skip of result.skipped) {
      notes.push(warning(`"${skip.name}" was not turned into a field because ${skip.reason}.`));
    }
    const inline = result.fields.filter((field) => field.inline);
    if (inline.length > 0) {
      notes.push(
        warning(
          `${inline.length} placeholder(s) have text after them on the same line: ${inline.map((field) => field.name).join(', ')}. A PDF cannot reflow, so a short value leaves a gap before the following words and a long one shrinks to fit. Putting those placeholders on their own line in the source document avoids both.`,
        ),
      );
    }

    const swapped = result.fields.filter((field) => !field.keptFont);
    if (swapped.length > 0) {
      notes.push(
        warning(
          `${swapped.length} field(s) will draw their value in Helvetica, because the template's own font does not carry every letter a value might need. Check one document before sending a batch.`,
        ),
      );
    }
    notes.push(
      el('p', {
        className: 'fields',
        text: 'Download the prepared template to reuse it next time without this step.',
      }),
    );
    replaceChildren(prepareResult, ...notes);
    preparePanel.hidden = false;
    refresh();
  });
});

downloadPreparedButton.addEventListener('click', () => {
  if (preparedTemplate === undefined) return;
  downloadBytes(preparedTemplate.bytes, preparedTemplate.filename);
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
  populateEmailColumns();
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
  let emailsWritten = 0;
  let bytesWritten = 0;

  const stream = streamBatch(loadedTemplate.template, loadedData.records, {
    ...batchOptions(),
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
        const { filename, bytes, email } = next.value.document;
        if (zipWriter) {
          // A generated .docx is already a ZIP and a PDF is largely
          // compressed, so entries are stored rather than deflated again.
          await zipWriter.add(filename, bytes, false);
          // An email is base64 text, which does compress.
          if (email) await zipWriter.add(email.filename, email.bytes, true);
        } else {
          await writeFileTo(destination!, filename, bytes);
          if (email) await writeFileTo(destination!, email.filename, email.bytes);
        }
        written += 1;
        if (email) emailsWritten += 1;
        bytesWritten += bytes.length;
      }
      next = await stream.next();
    }

    await zipWriter?.close();
    showStreamResult(next.value, target, written, emailsWritten, bytesWritten, failures);
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
  emailsWritten: number,
  bytesWritten: number,
  failures: readonly BatchFailure[],
): void {
  const nodes: Node[] = [
    el('p', {
      className: failures.length > 0 ? 'partial' : 'ok',
      text:
        `${written} document${written === 1 ? '' : 's'}` +
        (emailsWritten > 0 ? ` and ${emailsWritten} email${emailsWritten === 1 ? '' : 's'}` : '') +
        ' written ' +
        `${target === 'zip' ? 'to the ZIP' : 'to the folder'} (${formatBytes(bytesWritten)})` +
        (failures.length > 0 ? `, ${failures.length} row(s) failed` : ''),
    }),
  ];

  if (summary.unmatchedFields.length > 0) {
    nodes.push(warning(`No column matched: ${summary.unmatchedFields.join(', ')}`));
  }

  nodes.push(
    ...unsupportedNotice(summary.unsupported),
    ...shrunkNotice(summary.shrunkFields),
    ...sharedAddressNotice(summary.sharedAddresses),
    ...sendingHint(emailsWritten),
  );

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
      ...batchOptions(),
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

  const emails = result.documents.filter((document) => document.email !== undefined).length;
  nodes.push(
    el('p', {
      className: result.failures.length > 0 ? 'partial' : 'ok',
      text:
        `${result.documents.length} document${result.documents.length === 1 ? '' : 's'}` +
        (emails > 0 ? ` and ${emails} email${emails === 1 ? '' : 's'}` : '') +
        ' ready' +
        (result.failures.length > 0 ? `, ${result.failures.length} row(s) failed` : ''),
    }),
  );

  nodes.push(
    ...unsupportedNotice(result.unsupported),
    ...shrunkNotice(result.shrunkFields),
    ...sharedAddressNotice(result.sharedAddresses),
    ...sendingHint(emails),
  );

  if (result.documents.length > 0) {
    const totalBytes = result.documents.reduce((sum, document) => sum + document.bytes.length, 0);
    nodes.push(el('p', { className: 'fields', text: `Total size: ${formatBytes(totalBytes)}` }));

    const zipButton = el('button', { className: 'btn btn-primary', text: 'Download all as ZIP' });
    zipButton.addEventListener('click', () => {
      const archive = buildZip(
        result.documents.flatMap((document) => [
          { name: document.filename, bytes: document.bytes },
          ...(document.email ? [{ name: document.email.filename, bytes: document.email.bytes }] : []),
        ]),
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
      const item = el('li', {}, [link]);
      const email = document.email;
      if (email) {
        const emailLink = el('button', { className: 'link', text: 'email' });
        emailLink.addEventListener('click', () => downloadBytes(email.bytes, email.filename));
        // Not `document.createTextNode`: `document` here is the generated one.
        item.append(el('span', { text: ' · ' }), emailLink);
      }
      list.append(item);
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
  return (
    loadedTemplate !== undefined &&
    (loadedData?.records.length ?? 0) > 0 &&
    // Emails asked for but no column chosen to address them from.
    (!makeEmails.checked || emailColumn.value !== '')
  );
}

function refresh(): void {
  syncFormat();
  void reportTemplateFit();
  setBusy(false);
}

/**
 * Guards against an earlier, slower check overwriting a newer one when the
 * template or data is swapped twice in quick succession.
 */
let fitCheckToken = 0;

/**
 * Say, before anything is generated, whether every field is big enough for the
 * data that is going into it.
 *
 * A PDF form field hides whatever does not fit, and filling is per-record, so a
 * field too narrow for one person in four hundred would otherwise surface on
 * that row alone — after the batch had run and the letters had gone out.
 */
async function reportTemplateFit(): Promise<void> {
  const token = (fitCheckToken += 1);
  clear(fitReport);
  if (!loadedTemplate || !loadedData) return;
  if (loadedTemplate.template.kind !== 'pdf') return;

  let reports;
  try {
    reports = await checkPdfTemplateFit(loadedTemplate.template.bytes, loadedData.records);
  } catch {
    // A template this cannot be read from will report itself properly when the
    // batch runs; a status line is not the place to raise it first.
    return;
  }
  if (token !== fitCheckToken) return;

  const tight = reports.filter((report) => report.outcome !== 'fits');
  if (tight.length === 0) {
    fitReport.append(
      el('p', {
        className: 'ok',
        text: 'Every field is big enough for the widest value in your data.',
      }),
    );
    return;
  }

  for (const report of tight) {
    fitReport.append(
      warning(
        report.outcome === 'overflows'
          ? `${report.field}: too small — the widest value (row ${report.worstRow}) will not fit legibly. Widen this field in the template.`
          : `${report.field}: tight — row ${report.worstRow} shrinks from ${report.templateSizePt}pt to ${report.fittedSizePt}pt.`,
      ),
    );
  }
}

// --- email drafts --------------------------------------------------------

/** The options every run uses, read from the form. */
function batchOptions(): BatchOptions {
  const email =
    makeEmails.checked && emailColumn.value !== ''
      ? {
          to: emailColumn.value,
          subject: emailSubject.value,
          body: emailBody.value,
          attachmentName: attachmentName.value,
        }
      : undefined;
  return {
    missing: missingSelect.value as MissingValuePolicy,
    outputFormat: outputFormat(),
    treatEmptyAsMissing: emptyIsMissing.checked,
    filenameTemplate: filenameInput.value.trim() || undefined,
    docx: { scrubMetadata: scrubMetadata.checked },
    pdf: { scrubMetadata: scrubMetadata.checked, flatten: flattenPdf.checked },
    ...(email ? { email } : {}),
  };
}

makeEmails.addEventListener('change', () => {
  emailFields.hidden = !makeEmails.checked;
  checkEmails();
  refresh();
});

emailColumn.addEventListener('change', () => {
  checkEmails();
  refresh();
});

/**
 * Offer the data's columns as the address source, keeping the current choice
 * if it still exists and otherwise picking the one that looks like an email.
 */
function populateEmailColumns(): void {
  const previous = emailColumn.value;
  clear(emailColumn);
  emailColumn.append(el('option', { text: 'Choose a column', attrs: { value: '' } }));
  const fields = loadedData?.fields ?? [];
  for (const field of fields) {
    emailColumn.append(el('option', { text: field, attrs: { value: field } }));
  }
  if (fields.includes(previous)) emailColumn.value = previous;
  else emailColumn.value = fields.find((field) => /e-?mail/i.test(field)) ?? '';
  checkEmails();
}

/**
 * Check every address before anything is generated.
 *
 * Row numbers only: the addresses themselves are personal data and are never
 * put on screen.
 */
function checkEmails(): void {
  clear(emailCheck);
  if (!makeEmails.checked || !loadedData) return;
  if (emailColumn.value === '') {
    emailCheck.append(warning('Choose the column that holds each person’s email address.'));
    return;
  }

  const bad: number[] = [];
  const seen = new Map<string, number[]>();
  loadedData.records.forEach((record, index) => {
    const checked = checkEmailAddress(String(record[emailColumn.value] ?? ''));
    if (!checked.ok) {
      bad.push(index + 1);
      return;
    }
    const key = checked.address.toLowerCase();
    seen.set(key, [...(seen.get(key) ?? []), index + 1]);
  });

  if (bad.length > 0) {
    emailCheck.append(
      warning(
        `${bad.length === 1 ? 'Row' : 'Rows'} ${listRows(bad)}: the address is blank, or is not one valid email address. ${bad.length === 1 ? 'That row' : 'Those rows'} will fail until fixed.`,
      ),
    );
  }
  emailCheck.append(...sharedAddressNotice([...seen.values()].filter((rows) => rows.length > 1)));
  if (emailCheck.childElementCount === 0) {
    emailCheck.append(
      el('p', {
        className: 'ok',
        text: `All ${loadedData.records.length} addresses look right, and no two rows share one.`,
      }),
    );
  }
}

/** Warn about rows that share an address — usually a copy-paste slip. */
function sharedAddressNotice(groups: readonly (readonly number[])[]): Node[] {
  return groups.map((rows) =>
    warning(
      `Rows ${listRows(rows)} have the same email address. Check that each person gets their own letter.`,
    ),
  );
}

/** What to do with the email files, said once they exist. */
function sendingHint(emails: number): Node[] {
  if (emails === 0) return [];
  return [
    el('p', {
      className: 'fields',
      text: 'To send: double-click each .eml file. It opens in Outlook as a new email, addressed and with the document attached. Check it, then press Send.',
    }),
  ];
}

/** "3, 7 and 12", or the first ten and a count when the list is long. */
function listRows(rows: readonly number[]): string {
  const shown = rows.slice(0, 10).map(String);
  if (rows.length > 10) return `${shown.join(', ')} and ${rows.length - 10} more`;
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

// --- checking signed letters -------------------------------------------

let sentFiles: readonly File[] = [];
let returnedFiles: readonly File[] = [];

/** A drop zone that takes many files at once. */
function enableMultiDropZone(zone: HTMLElement, input: HTMLInputElement): void {
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const transfer = new DataTransfer();
    for (const file of Array.from(files)) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
}

enableMultiDropZone(sentDrop, sentInput);
enableMultiDropZone(returnedDrop, returnedInput);

sentInput.addEventListener('change', () => {
  sentFiles = pdfsFrom(sentInput);
  markMultiZone(sentDrop, sentFiles.length, 'sent');
  syncCheckButton();
});

returnedInput.addEventListener('change', () => {
  returnedFiles = pdfsFrom(returnedInput);
  markMultiZone(returnedDrop, returnedFiles.length, 'returned');
  syncCheckButton();
});

function pdfsFrom(input: HTMLInputElement): File[] {
  return Array.from(input.files ?? []).filter((file) => /\.pdf$/i.test(file.name));
}

function markMultiZone(zone: HTMLElement, count: number, which: 'sent' | 'returned'): void {
  zone.classList.toggle('loaded', count > 0);
  const text = zone.querySelector('.dz-text');
  const meta = zone.querySelector('.dz-meta');
  if (!text || !meta) return;
  const label = which === 'sent' ? 'letter' : 'signed copy';
  const plural = which === 'sent' ? 'letters' : 'signed copies';
  if (count === 0) {
    replaceChildren(text as HTMLElement, el('strong', { text: which === 'sent' ? 'Letters you sent' : 'Signed copies you got back' }));
    meta.textContent = which === 'sent' ? 'PDFs from step 4 — choose or drop them all' : 'PDFs — choose or drop them all';
    return;
  }
  replaceChildren(text as HTMLElement, el('strong', { text: `${count} ${count === 1 ? label : plural}` }));
  meta.textContent = 'Click or drop to replace';
}

function syncCheckButton(): void {
  checkButton.disabled = sentFiles.length === 0 || returnedFiles.length === 0;
}

checkButton.addEventListener('click', () => {
  void runCheck();
});

async function runCheck(): Promise<void> {
  checkButton.disabled = true;
  checkButton.textContent = 'Checking…';
  replaceChildren(checkResults, el('p', { className: 'fields', text: 'Reading the letters…' }));
  try {
    const read = async (files: readonly File[]) =>
      Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const report = await checkReturnedLetters(await read(sentFiles), await read(returnedFiles), {
      onProgress: async (completed, total) => {
        if (completed % 5 === 0) {
          replaceChildren(checkResults, el('p', { className: 'fields', text: `Reading ${completed} of ${total}…` }));
          await nextFrame();
        }
      },
    });
    showCheck(report);
  } catch (error) {
    replaceChildren(checkResults, warning(describeError(error)));
  } finally {
    checkButton.textContent = 'Check signed letters';
    syncCheckButton();
  }
}

/** Most serious first, so the letters that need attention are at the top. */
const STATUS_ORDER: readonly ReturnedStatus[] = ['changed', 'unreadable', 'unmatched', 'review', 'unsigned', 'signed'];

const STATUS_LABEL: Readonly<Record<ReturnedStatus, string>> = {
  changed: 'Changed — do not accept as it is',
  unreadable: 'Cannot be checked',
  unmatched: 'No matching letter',
  review: 'Check by eye',
  unsigned: 'Not signed',
  signed: 'Signed, nothing changed',
};

/** The same, as counted in the summary line. */
const STATUS_SHORT: Readonly<Record<ReturnedStatus, string>> = {
  changed: 'changed',
  unreadable: 'cannot be checked',
  unmatched: 'unmatched',
  review: 'to check by eye',
  unsigned: 'not signed',
  signed: 'signed',
};

function showCheck(report: ReturnedCheck): void {
  const counts = new Map<ReturnedStatus, number>();
  for (const item of report.returned) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);

  const parts = STATUS_ORDER.filter((status) => counts.has(status)).map(
    (status) => `${counts.get(status)} ${STATUS_SHORT[status]}`,
  );
  const allGood = (counts.get('signed') ?? 0) === report.returned.length;
  const nodes: Node[] = [
    el('p', { className: allGood ? 'ok' : 'partial', text: `Checked ${report.returned.length}: ${parts.join(' · ')}` }),
  ];

  if (report.unreadableSent.length > 0) {
    nodes.push(
      warning(
        `These sent letters could not be read, so nothing can be matched to them: ${report.unreadableSent.join(', ')}.`,
      ),
    );
  }

  const list = el('ul', { className: 'check-list' });
  const sorted = [...report.returned].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  for (const item of sorted) list.append(checkItem(item));
  nodes.push(list);

  if (report.notReturned.length > 0) {
    const details = el('details', { className: 'not-returned' }, [
      el('summary', {
        text: `${report.notReturned.length} letter${report.notReturned.length === 1 ? '' : 's'} not back yet`,
      }),
      el('p', { className: 'fields', text: report.notReturned.join(', ') }),
    ]);
    nodes.push(details);
  }

  replaceChildren(checkResults, ...nodes);
}

function checkItem(item: ReturnedLetterReport): HTMLElement {
  const head = el('div', { className: 'check-head' }, [
    el('span', { className: `badge ${item.status}`, text: STATUS_LABEL[item.status] }),
    el('span', { className: 'check-file', text: item.file }),
  ]);
  if (item.letter !== undefined && item.letter !== item.file) {
    head.append(el('span', { className: 'fields', text: `matches ${item.letter}` }));
  }
  const node = el('li', { className: `check-item ${item.status}` }, [head]);
  for (const finding of item.findings) {
    node.append(el('p', { className: `check-finding${item.status === 'changed' ? ' bad' : ''}`, text: finding }));
  }
  if (item.status === 'unsigned') {
    node.append(el('p', { className: 'check-finding', text: 'Nothing has been added to it. It may have been sent back without signing.' }));
  }
  for (const addition of item.additions) {
    node.append(el('p', { className: 'check-addition', text: `Added: ${addition}` }));
  }
  return node;
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
