import { DoclystError } from '../errors.js';
import { findPlaceholders } from '../template/placeholder.js';

/**
 * Email drafts, written as `.eml` files.
 *
 * Doclyst does not send email. It writes one ready-to-send draft per document:
 * addressed, with a subject and message, and with that person's document
 * already attached. Opening the file in Outlook or Apple Mail shows a normal
 * new message with a Send button, so a person still reviews and sends each
 * one — and the pairing of document to recipient is fixed by the row it came
 * from rather than by someone attaching a hundred files by hand.
 *
 * Writing a file is all this does. Nothing here, or anywhere in the engine,
 * can reach a network.
 */

export interface EmailDraftOptions {
  /** Column holding each recipient's address. */
  readonly to: string;
  /** Subject line. May contain `{{FIELD}}` placeholders. */
  readonly subject: string;
  /** Message text. May contain `{{FIELD}}` placeholders. */
  readonly body: string;
  /**
   * Name the attachment carries inside the email, without extension. May
   * contain placeholders. Defaults to the document's own filename.
   *
   * Kept separate from the filename on disk on purpose: the recipient is
   * better served by "Offer letter.pdf" than by "document-0042.pdf", while
   * the folder on disk is better served by a name that discloses nothing.
   */
  readonly attachmentName?: string;
}

export interface EmailAttachment {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface EmailDraft {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachment: EmailAttachment;
}

/** Longest address the mail standards allow. */
const MAX_ADDRESS_LENGTH = 254;

const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Check that a cell holds exactly one plain email address.
 *
 * Returns the address, trimmed, or a reason it was refused. The reason never
 * repeats the value: it is shown on screen and may be pasted into a ticket.
 *
 * The strictness is deliberate. The one input here that can do real harm is
 * a line break: a cell holding `someone@example.com` followed by a new line
 * and `Bcc: someone-else@example.com` would add a hidden recipient to that
 * person's offer letter, and the draft would still show a single, ordinary
 * address in its To line. Refusing anything but one bare address closes that
 * off, along with the duller accidents — two addresses in one cell, or a
 * display name pasted in from an address book.
 */
export function checkEmailAddress(value: string): { ok: true; address: string } | { ok: false; reason: string } {
  const address = value.trim();
  if (address === '') return { ok: false, reason: 'is blank' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(address)) return { ok: false, reason: 'contains a line break or other hidden character' };
  if (/[,;]/.test(address)) return { ok: false, reason: 'contains more than one address — use one address per row' };
  if (/[<>"]/.test(address)) return { ok: false, reason: 'should be just the address, without a name or brackets' };
  if (/\s/.test(address)) return { ok: false, reason: 'contains a space' };
  if (address.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'is too long to be an email address' };

  const at = address.lastIndexOf('@');
  if (at <= 0 || address.indexOf('@') !== at) return { ok: false, reason: 'is not an email address' };
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) {
    return { ok: false, reason: 'is not a valid email address' };
  }
  return { ok: true, address };
}

/**
 * Fill `{{FIELD}}` placeholders in plain text, such as a subject line.
 *
 * Unlike a document, an email's subject and message are not XML, so this
 * substitutes into the string directly through the same resolver the
 * document uses — which keeps the missing-value rules identical in both.
 */
export function fillText(text: string, resolve: (key: string, original: string) => string): string {
  let result = '';
  let cursor = 0;
  for (const match of findPlaceholders(text)) {
    result += text.slice(cursor, match.start) + resolve(match.key, text.slice(match.start, match.end));
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

/**
 * Write a draft as an `.eml` file.
 *
 * `X-Unsent: 1` is what makes this work: without it, Outlook opens the file
 * as a message already received, read-only and with no Send button. There is
 * deliberately no From line, so the draft goes out from whichever account
 * opens it, and no Date, so the same input always produces the same file.
 */
export function composeEmailDraft(draft: EmailDraft): Uint8Array {
  const checked = checkEmailAddress(draft.to);
  if (!checked.ok) {
    throw new DoclystError('INVALID_DATA', `The email address ${checked.reason}.`);
  }

  const boundary = '=_doclyst_part_boundary';
  const { filename, bytes, contentType } = draft.attachment;

  const lines = [
    `To: ${checked.address}`,
    `Subject: ${encodeHeaderText(singleLine(draft.subject))}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(utf8(draft.body.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'))),
    `--${boundary}`,
    // The same convention Thunderbird writes: an encoded-word `name` for
    // clients that read the content type, and an RFC 2231 `filename*` for
    // those that read the disposition. A plain-ASCII `filename` fallback is
    // deliberately not added for non-ASCII names — some clients prefer it, and
    // "李伟 offer.pdf" would then arrive as "__ offer.pdf".
    `Content-Type: ${contentType}; name="${encodeHeaderText(filename)}"`,
    /^[\x20-\x7E]*$/.test(filename)
      ? `Content-Disposition: attachment; filename="${filename.replace(/["\\]/g, '_')}"`
      : `Content-Disposition: attachment; filename*=UTF-8''${percentEncode(filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(bytes),
    `--${boundary}--`,
    '',
  ];
  return utf8(lines.join('\r\n'));
}

/** The content type an attachment of this extension should declare. */
export function contentTypeFor(filename: string): string {
  if (/\.pdf$/i.test(filename)) return 'application/pdf';
  if (/\.docx$/i.test(filename)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
}

/** A header value must be one line: a break would start a new header. */
function singleLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Header text, as RFC 2047 encoded-words when it is not plain ASCII.
 *
 * Each encoded-word carries at most 45 bytes, which keeps it inside the
 * 75-character limit, and is split on character boundaries so no multi-byte
 * character is cut in half.
 */
function encodeHeaderText(text: string): string {
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (utf8(chunk + char).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${toBase64(utf8(word))}?=`).join('\r\n ');
}

function percentEncode(text: string): string {
  return Array.from(utf8(text), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64Lines(bytes: Uint8Array): string {
  const encoded = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Base64 without `Buffer`, which a browser does not have. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
