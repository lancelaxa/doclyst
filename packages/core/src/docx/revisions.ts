import { replaceElements } from './xml.js';

/**
 * Settle a Word part to what its author sees: tracked changes accepted, and
 * hidden text gone.
 *
 * Both are invisible to the author in the ordinary view and fully legible to
 * anyone who receives the file. A template edited with Track Changes on
 * still carries every deleted word — "salary band: 6,000 to 7,500" struck out
 * of an offer letter is one click away for every candidate who gets it. Hidden
 * text is the same: a note the author hid rather than deleted.
 *
 * Accepting the changes, rather than rejecting them, is what keeps the letter
 * the one the author approved: it is the "No Markup" view they were looking at.
 *
 * This runs on every generated document, whatever the metadata setting,
 * because it is about what the letter says, not who wrote it.
 */
export function acceptRevisionsAndDropHidden(xml: string): string {
  let out = xml;

  // Deleted and moved-away content goes, along with the paragraph-mark
  // deletion markers that sit inside run properties.
  for (const tag of ['w:del', 'w:moveFrom']) {
    out = replaceElements(out, tag, (element) => (nests(element.body, tag) ? undefined : ''));
  }
  // Inserted and moved-in content stays; only its wrapper goes.
  for (const tag of ['w:ins', 'w:moveTo']) {
    out = replaceElements(out, tag, (element) => (nests(element.body, tag) ? undefined : (element.body ?? '')));
  }
  // The record of earlier formatting, and the markers of moved and changed
  // table cells. Each names its author.
  for (const tag of [
    'w:rPrChange',
    'w:pPrChange',
    'w:sectPrChange',
    'w:tblPrChange',
    'w:tblPrExChange',
    'w:tblGridChange',
    'w:tcPrChange',
    'w:trPrChange',
    'w:numberingChange',
    'w:moveFromRangeStart',
    'w:moveFromRangeEnd',
    'w:moveToRangeStart',
    'w:moveToRangeEnd',
    'w:cellIns',
    'w:cellDel',
    'w:cellMerge',
  ]) {
    out = replaceElements(out, tag, (element) => (nests(element.body, tag) ? undefined : ''));
  }

  // Hidden runs.
  return replaceElements(out, 'w:r', (element) => (isHiddenRun(element.body) ? '' : undefined));
}

/**
 * Whether an element's body contains another of the same name.
 *
 * The scanner pairs an opener with the first closer after it, which is wrong
 * for nested elements — a run inside a text box inside a run, say. Such an
 * element is left exactly as it was rather than cut at the wrong place, which
 * would leave Word unable to open the file.
 */
function nests(body: string | undefined, tag: string): boolean {
  if (body === undefined) return false;
  const opener = new RegExp(`<${tag}[\\s/>]`);
  return opener.test(body);
}

/** A run whose own properties say it is hidden. */
function isHiddenRun(body: string | undefined): boolean {
  if (body === undefined || nests(body, 'w:r')) return false;
  // The run's properties are its first child; a `w:vanish` anywhere else
  // belongs to something else.
  const properties = /^\s*<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(body)?.[1];
  if (properties === undefined) return false;
  const vanish = /<w:vanish\b([^>]*)\/>/.exec(properties);
  if (vanish === null) return false;
  const value = /w:val="([^"]*)"/.exec(vanish[1] ?? '')?.[1];
  return value === undefined || !['false', '0', 'off'].includes(value);
}
