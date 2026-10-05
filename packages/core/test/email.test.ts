import { describe, expect, it } from 'vitest';
import { checkEmailAddress, composeEmailDraft, fillText } from '../src/output/email.js';
import { runBatch, streamBatch } from '../src/batch/run.js';
import { readCsvRecords } from '../src/data/records.js';
import { DoclystError } from '../src/errors.js';
import { buildDocx, para, run } from './helpers/fixtures.js';

/**
 * Email drafts. Every address here is at example.com or example.org, which
 * are reserved for documentation and can never reach a real inbox.
 */

/** Just enough MIME parsing to read back what the composer wrote. */
function parseDraft(bytes: Uint8Array): {
  headers: Map<string, string>;
  rawHeaders: string;
  body: string;
  attachment: { headers: string; bytes: Uint8Array };
} {
  const text = new TextDecoder().decode(bytes);
  const [head, ...rest] = text.split('\r\n\r\n');
  const rawHeaders = head as string;
  // Unfold continuation lines before splitting into headers.
  const headers = new Map<string, string>();
  for (const line of rawHeaders.replace(/\r\n /g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('content-type') ?? '')?.[1] as string;
  const parts = rest
    .join('\r\n\r\n')
    .split(`--${boundary}`)
    .filter((part) => part.trim() !== '' && part.trim() !== '--');
  const decode = (part: string) => {
    const split = part.indexOf('\r\n\r\n');
    return {
      headers: part.slice(0, split),
      bytes: new Uint8Array(Buffer.from(part.slice(split + 4).replace(/\s+/g, ''), 'base64')),
    };
  };
  const [bodyPart, attachmentPart] = parts.map(decode);
  return {
    headers,
    rawHeaders,
    body: new TextDecoder().decode(bodyPart?.bytes),
    attachment: attachmentPart as { headers: string; bytes: Uint8Array },
  };
}

/** Decode an RFC 2047 header value, for checking what a mail client shows. */
function decodeHeader(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b64: string) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  );
}

const ATTACHMENT = { filename: 'Offer letter.pdf', bytes: new Uint8Array([37, 80, 68, 70, 0, 255, 10, 13]), contentType: 'application/pdf' };

describe('checkEmailAddress', () => {
  it.each(['aisha.rahman@example.com', 'a+offers@example.org', '  padded@example.com  ', "o'neil@sub.example.com"])(
    'accepts %s',
    (address) => {
      const result = checkEmailAddress(address);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.address).toBe(address.trim());
    },
  );

  it.each([
    ['', 'is blank'],
    ['victim@example.com\r\nBcc: someone@example.org', 'line break'],
    ['victim@example.com\nBcc: someone@example.org', 'line break'],
    ['a@example.com, b@example.com', 'more than one address'],
    ['a@example.com; b@example.com', 'more than one address'],
    ['Aisha Rahman <aisha@example.com>', 'without a name'],
    ['aisha rahman@example.com', 'space'],
    ['aisha.example.com', 'not an email address'],
    ['aisha@@example.com', 'not an email address'],
    ['aisha@example', 'not a valid'],
    ['.aisha@example.com', 'not a valid'],
    ['aisha@exa_mple.com', 'not a valid'],
  ])('refuses %j', (address, reason) => {
    const result = checkEmailAddress(address);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('never repeats the value in its reason', () => {
    const result = checkEmailAddress('S1234567D-secret@@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('S1234567D');
  });
});

describe('composeEmailDraft', () => {
  const draft = () =>
    composeEmailDraft({
      to: 'aisha.rahman@example.com',
      subject: 'Your offer letter',
      body: 'Hello,\n\nAttached.\n',
      attachment: ATTACHMENT,
    });

  it('opens as an unsent draft, addressed and with no sender or date', () => {
    const { headers } = parseDraft(draft());
    expect(headers.get('to')).toBe('aisha.rahman@example.com');
    expect(headers.get('subject')).toBe('Your offer letter');
    // Without this, Outlook opens the file read-only, as a received message.
    expect(headers.get('x-unsent')).toBe('1');
    expect(headers.has('from')).toBe(false);
    expect(headers.has('date')).toBe(false);
    expect(headers.has('bcc')).toBe(false);
    expect(headers.has('cc')).toBe(false);
  });

  it('attaches the document byte for byte', () => {
    const { attachment } = parseDraft(draft());
    expect(attachment.bytes).toEqual(ATTACHMENT.bytes);
    expect(attachment.headers).toContain('application/pdf');
    expect(attachment.headers).toContain('filename="Offer letter.pdf"');
  });

  it('writes the message with standard line endings', () => {
    expect(parseDraft(draft()).body).toBe('Hello,\r\n\r\nAttached.\r\n');
  });

  it('is the same every time for the same input', () => {
    expect(draft()).toEqual(draft());
  });

  it('refuses an address that would add a hidden recipient', () => {
    expect(() =>
      composeEmailDraft({
        to: 'victim@example.com\r\nBcc: someone@example.org',
        subject: 'Your payslip',
        body: '',
        attachment: ATTACHMENT,
      }),
    ).toThrow(DoclystError);
  });

  it('keeps a subject on one line, whatever the data put in it', () => {
    const { headers, rawHeaders } = parseDraft(
      composeEmailDraft({
        to: 'aisha@example.com',
        subject: 'Offer\r\nBcc: someone@example.org',
        body: '',
        attachment: ATTACHMENT,
      }),
    );
    expect(headers.has('bcc')).toBe(false);
    expect(rawHeaders).not.toMatch(/^Bcc:/im);
    expect(headers.get('subject')).toBe('Offer Bcc: someone@example.org');
  });

  it('carries non-Latin text in the subject and attachment name intact', () => {
    const { headers, attachment } = parseDraft(
      composeEmailDraft({
        to: 'li.wei@example.com',
        subject: '李伟 — your offer letter, with a long tail to force more than one encoded word',
        body: '你好',
        attachment: { ...ATTACHMENT, filename: '李伟 offer.pdf' },
      }),
    );
    expect(decodeHeader(headers.get('subject') as string)).toBe(
      '李伟 — your offer letter, with a long tail to force more than one encoded word',
    );
    // Each encoded word must stay inside the 75-character limit.
    for (const word of (headers.get('subject') as string).split(' ')) expect(word.length).toBeLessThanOrEqual(75);
    expect(attachment.headers).toContain(`filename*=UTF-8''%E6%9D%8E%E4%BC%9F%20offer.pdf`);
    // No lossy ASCII fallback, which some clients would prefer.
    expect(attachment.headers).not.toMatch(/filename="/);
  });
});

describe('fillText', () => {
  it('fills placeholders through the given resolver', () => {
    expect(fillText('Dear {{NAME}}, your {{ ROLE }} offer', (key) => key.toLowerCase())).toBe('Dear name, your role offer');
  });

  it('leaves text without placeholders alone', () => {
    expect(fillText('Hello,\n\nAttached.', () => 'x')).toBe('Hello,\n\nAttached.');
  });
});

const TEMPLATE = buildDocx(para(run('Dear {{NAME}}, your salary is {{SALARY}}.')));

const CSV = `NAME,SALARY,Email
Aisha Rahman,4500,aisha.rahman@example.com
Wei Lun Tan,5200,"weilun@example.com
Bcc: someone@example.org"
Priya Nair,6100,
Dan Lim,3900,AISHA.RAHMAN@example.com
`;

const EMAIL = {
  to: 'Email',
  subject: 'Your offer, {{NAME}}',
  body: 'Dear {{NAME}},\n\nYour letter is attached.',
  attachmentName: 'Offer letter',
};

describe('batches with email drafts', () => {
  it('writes one draft per document, attaching that document', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records, { email: EMAIL });

    expect(result.documents.map((document) => document.row)).toEqual([1, 4]);
    for (const document of result.documents) {
      const draft = parseDraft(document.email?.bytes as Uint8Array);
      expect(document.email?.filename).toBe(document.filename.replace(/\.docx$/, '.eml'));
      expect(draft.attachment.bytes).toEqual(document.bytes);
      expect(draft.attachment.headers).toContain('filename="Offer letter.docx"');
    }

    const first = parseDraft(result.documents[0]?.email?.bytes as Uint8Array);
    expect(first.headers.get('to')).toBe('aisha.rahman@example.com');
    expect(first.headers.get('subject')).toBe('Your offer, Aisha Rahman');
    expect(first.body).toBe('Dear Aisha Rahman,\r\n\r\nYour letter is attached.');
  });

  it('fails a row with a bad or blank address, naming the row and never the value', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records, { email: EMAIL, missing: 'empty' });

    expect(result.failures.map((failure) => failure.row)).toEqual([2, 3]);
    expect(result.failures[0]?.message).toBe('The email address in column "Email" in row 2 contains a line break or other hidden character.');
    // "Leave blank" is for document fields, not for where the letter goes.
    expect(result.failures[1]?.message).toContain('row 3 is blank');
    for (const failure of result.failures) {
      expect(failure.field).toBe('Email');
      expect(failure.message).not.toContain('example');
    }
  });

  it('reports rows that share an address, ignoring case', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records, { email: EMAIL });
    expect(result.sharedAddresses).toEqual([[1, 4]]);
  });

  it('fails a row when the address column does not exist', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records, { email: { ...EMAIL, to: 'Work Email' } });
    expect(result.documents).toHaveLength(0);
    expect(result.failures[0]?.message).toBe('No email address in column "Work Email" in row 1.');
  });

  it('defaults the attachment name to the document filename', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records.slice(0, 1), {
      email: { to: 'Email', subject: 'Offer', body: '' },
    });
    expect(parseDraft(result.documents[0]?.email?.bytes as Uint8Array).attachment.headers).toContain(
      'filename="document-0001.docx"',
    );
  });

  it('writes no drafts unless asked', async () => {
    const { records } = readCsvRecords(CSV);
    const result = await runBatch({ kind: 'docx', bytes: TEMPLATE }, records);
    expect(result.documents.every((document) => document.email === undefined)).toBe(true);
    expect(result.sharedAddresses).toEqual([]);
  });

  it('streams drafts alongside documents', async () => {
    const { records } = readCsvRecords(CSV);
    const events = [];
    for await (const event of streamBatch({ kind: 'docx', bytes: TEMPLATE }, records, { email: EMAIL })) events.push(event);
    expect(events.filter((event) => event.type === 'document' && event.document.email)).toHaveLength(2);
  });
});
