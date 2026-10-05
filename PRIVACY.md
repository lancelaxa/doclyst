# Privacy and security design

Doclyst assumes every value it processes is personal data — names, NRIC/FIN
numbers, salaries, addresses, phone numbers, dates of birth. This document
describes the controls that follow from that assumption, and is meant to be
specific enough to verify against the code.

## In short

For anyone who needs the answer rather than the reasoning:

- **Nothing is uploaded.** There is no server, no account and no telemetry. The
  browser version is blocked by the browser itself from making any network
  request, so it could not transmit your data even if it were asked to.
- **Nothing is kept.** Documents are built in memory and written only where you
  say. No temporary files, no caches, no database, no history. Closing the tab
  discards everything.
- **Generated files are private on disk.** They are readable only by the person
  who created them, so a folder of payslips cannot become readable by everyone
  on a shared machine.
- **Personal data never reaches an error message or a log.** Messages name the
  field and the row — never the value — so they are safe to screenshot or paste
  into a ticket.
- **The author's details do not travel.** The template's author, company,
  timestamps, review comments and tracked-change names are stripped from every
  generated document by default. One gap remains, noted below: images a Word
  template loads from the internet.
- **It never sends email.** It can write an email for each letter, as a file
  you open and send yourself. Every address is checked first, and the result
  is shown by row number, never by address.
- **Checking signed copies happens here too.** Letters you sent and copies that
  came back are compared in the same tab, and the results name a page and a
  place, never the text.
- **No AI is involved.** No model, no inference, no third-party service. It is
  a deterministic tool: the same inputs always produce the same bytes.

Everything below is the detail behind those claims, written to be checked
against the code rather than taken on trust.

## Scope and limits

**Doclyst is not a compliance product.** It is designed with Singapore PDPA
principles in mind, and it implements technical controls that support
responsible handling of personal data. It does not make any organisation
PDPA-compliant, and this document is not legal advice.

Compliance depends on things the tool cannot see or control: your legal basis
for processing, your consent and notification practices, your retention
schedule, who you give the generated documents to, and how you transmit them.
Doclyst helps with *generating* the documents, *preparing* the emails that
carry them, and *checking* signed copies that come back. It does not send,
store or track anything.

The tool is also only one link in the chain. Your source spreadsheet, the
folder you write into, your backups, and whatever you do with the documents
afterwards are all outside its control and are usually where the real risk sits.

## Data flow

```
CSV / XLSX ──┐
             ├─→ [ in-memory rendering ] ─→ files you named
template ────┘
```

That is the whole flow. Specifically:

- Data is read from the paths you pass on the command line.
- Rendering happens entirely in memory.
- Output is written only to the `--out` directory and/or the `--zip` path.
- The process then exits.

There is no other destination. No temporary files, no cache directory, no
database, no state carried between runs.

## No network access

Doclyst makes no outbound network requests of any kind. There is no telemetry,
no analytics, no update check, no error reporting and no cloud component.

This is structural rather than a policy: `packages/core`, which does all the
document processing, imports no networking or filesystem API. Its entire
interface is bytes in, bytes out. Verifiable in one command:

```bash
grep -rE "fetch|http|net|dns|child_process|node:fs" packages/core/src
```

The engine's runtime dependencies are two focused, widely used libraries —
`fflate` (ZIP) and `pdf-lib` (PDF) — both pure computation with no network
capability. The CSV parser, the XLSX reader and the DOCX engine are
implemented in-repo, which keeps the amount of third-party code touching
personal data small. The browser page adds one more, pdf.js, described under
*Checking signed copies*.

The spreadsheet reader is deliberately in-repo rather than a dependency. The
two realistic options were both disqualifying for this threat model: `xlsx`
(SheetJS) is frozen on npm at a version carrying unfixed prototype-pollution
and ReDoS advisories, and `exceljs` depends on `tmp`, which spools workbook
contents through temporary files and would break the retention guarantee
below. Reading cell values out of a ZIP of XML is a bounded problem, so the
code that touches an untrusted spreadsheet is small enough to audit.

## Retention

Nothing is retained. Documents exist in memory during the run and are written
only where you ask. Doclyst never writes a temporary file, so there is no
partially-rendered payslip left in `/tmp` for someone to find later.

Deleting the output directory deletes the generated personal data.

## File permissions

Output directories are created `0700` and files `0600` — readable and writable
only by the user who ran the command.

This matters because the default umask on many systems produces `0644` files,
which on a shared machine, an NFS mount or a server makes a folder of payslips
readable by every account on the box.

Every output file is created exclusively (`O_CREAT | O_EXCL`) rather than
opened for writing. On a shared machine that closes two gaps at once: a symlink
planted in the output directory can no longer redirect a generated document
over some other file, and there is no window between checking whether a path
exists and writing to it. `--force` unlinks the existing entry first, which
removes a symlink itself rather than following it, and then still creates
exclusively — so losing the race means failing, not writing through.

Note that permissions on the *source* spreadsheet and the ZIP you send onward
are yours to manage.

## Filenames

Filenames get separate treatment because they are visible without opening the
file — a directory listing, a ZIP index, an email attachment bar and a backup
log all display them to people who may have no reason to read the contents.

- The default name is positional (`document-0001.docx`) and discloses nothing.
- Naming files from data is opt-in via `--filename`.
- Doclyst warns when the pattern uses a field that looks identifying (NRIC,
  FIN, passport, salary, bank account, date of birth, address, phone, email).
  It warns rather than refuses, because it may be exactly what you intend.
- All names are sanitized: path separators and `..` sequences neutralized,
  Windows-illegal characters replaced, reserved device names escaped, length
  capped.
- Collisions are disambiguated with ` (2)`, never overwritten — two people with
  the same name must produce two documents.

## What gets logged

**No field value is ever written to a log, an error message, a warning or the
manifest.** Diagnostics identify problems by *location* — row 12, field
`SALARY` — which is enough to fix a spreadsheet without disclosing its
contents.

- Error messages are constructed to be safe to display, screenshot and paste
  into a ticket.
- Errors thrown by third-party parsers are **not** surfaced verbatim; only the
  error type is kept. A ZIP or PDF parser will happily quote the buffer it
  choked on, and that buffer may be personal data.
- `manifest.csv` records row number, filename, status and error code only.

The redaction helpers in `packages/core/src/privacy/redact.ts` describe values
structurally (`<text:12 chars>`) for any diagnostic that needs to mention one.
Numbers are described rather than shown, because a salary or an account number
is as identifying as a name.

## Metadata in generated documents

Office and PDF files carry metadata that is easy to forget and travels to every
recipient. By default Doclyst removes, from each generated file:

- **DOCX** — `dc:creator`, `cp:lastModifiedBy`, `cp:lastPrinted`,
  `dc:description`, `cp:category`, plus `Company` and `Manager`. Also the
  template's **review comments** (which Word shows in the margin, so a note
  left on the template would be read by every recipient), the list of
  commenters with their email addresses, custom document properties, the
  names and times on tracked changes, and the path to the template on the
  author's machine. The package's relationships and content types are updated
  to match, so Word does not report the file as damaged.
- **PDF** — title, author, subject, keywords, producer and creator, with
  creation and modification dates fixed to a constant; any further fields a
  producer added to the document information; the XMP metadata block, which
  Word writes on every "Save as PDF" and which repeats the author's name;
  application-private data; sticky-note comments and their pop-ups; and the
  author and timestamps on any other annotation. Objects removed this way are
  deleted from the file, not merely unlinked — an unlinked object is still in
  the file for anything that looks.

Whatever the metadata setting, a filled PDF also loses any script, open action
or attached file the template carried. A letter has no use for them, and they
would otherwise reach every recipient.

Two more things are removed from every generated Word document, whatever the
metadata setting, because they are content rather than metadata: **tracked
changes are accepted**, so words deleted from the template with Track Changes
on do not travel (a struck-out salary band is one click away for any
recipient otherwise), and **hidden text is removed**. The letter that goes out
is the one the author saw in Word's ordinary "No Markup" view.

A Word template that **links** to something outside itself — a picture
inserted with "Link to File", an object linked rather than embedded — keeps
that link, because Doclyst cannot fetch the content to embed it and removing
it would leave a broken picture. Each recipient's Word would fetch it when the
letter is opened, telling whoever runs that address who opened it, or sending
a network share the recipient's sign-in details. So Doclyst **warns** about it
as soon as the template is loaded, and again in the results: embed the
picture instead. Clickable hyperlinks are not warned about; they go nowhere
until clicked.

A PDF template is checked before it is parsed, as returned copies are, and
refused if its compressed content would expand past 200 MB.

Archive timestamps are also fixed, so the file does not record when each record
was processed. Use `--keep-metadata` to opt out.

PDF form fields are **flattened** by default: values become page content, so
the recipient cannot edit them back out, and the interactive field objects —
which hold their own copy of every value — are removed rather than shipped
alongside the rendered text. `--no-flatten` opts out.

A PDF rendered from a DOCX template carries less still: it is built from the
template's text, so nothing from the original file's document properties,
revision history or embedded objects reaches it in the first place. Its
metadata is scrubbed on the same setting.

A value that does not fit its form field is never silently clipped. PDF hides
the overflow with no indication, so a truncated address would reach the data
subject looking deliberate. Values are measured before saving, shrunk to fit
where that stays legible, and the record fails where it does not. The error
names the field and not the value.

## Preparing a PDF template

Turning a PDF's `{{PLACEHOLDERS}}` into form fields rewrites the page's content
stream to drop those glyphs. The stream being replaced is **deleted**, not left
unreferenced: an orphaned stream is invisible to a reader and perfectly legible
to anything that inflates the file, so leaving it would keep a copy of the text
that was just removed. Nothing is covered over — covering leaves the words in
the file and visible the moment the cover is taken off.

This runs in the same process as everything else, on the machine holding the
file. No page, glyph or field name is sent anywhere.

## Email drafts

Doclyst writes email drafts; it does not send them. Each draft is an `.eml`
file — an addressed message with one document attached — written alongside the
document, the same way the document is. The page's network block is unchanged,
and nothing in the engine can open a connection. Sending is done by a person, in
their own email program, one message at a time.

What the drafts are designed to prevent is a misdirected letter:

- **Pairing is fixed by the row.** A document and the address it goes to are
  read from the same row at the same moment, so one person's letter cannot be
  attached to another person's email.
- **Each address must be exactly one plain address.** A cell holding an address
  followed by a line break and `Bcc: someone@example.org` would otherwise add a
  hidden recipient to that letter — one the To line of the draft would not show.
  Any control character, comma, semicolon, space, angle bracket or quote in an
  address fails the row. The subject is reduced to a single line for the same
  reason. Both checks are covered by tests that were confirmed to fail when the
  checks are removed.
- **A blank address fails the row** whatever the missing-values setting says.
  "Leave blank" is meaningful for a middle name, not for where a letter goes.
- **Shared addresses are reported** before and after the run, by row number.
- **Addresses never appear in messages.** Problems are reported by row and
  column; the page's pre-run check counts rows rather than listing addresses.

The drafts have no sender and no date, so the same input gives the same file,
and the message goes out from whichever account opens it. Once sent, an email
and its attachment are in your organisation's email system, and its rules
apply.

## Preparing for DocuSeal

Doclyst can make the spreadsheet for signing letters online in DocuSeal. Making
it happens in the tab like everything else; **uploading it to DocuSeal is a
transfer of personal data to a third party**, done by the person who uploads
it, and from then on DocuSeal's own terms and controls apply.

Doclyst keeps that transfer as small and as correct as it can:

- **Only the fields the letter uses**, plus each candidate's name and email
  address, are written. Every other column — NRIC, bank details, notes —
  stays out, and the page lists what was left out.
- **No blank values and no unmatched fields.** DocuSeal locks imported values,
  so a blank would be a blank, locked salary, and a field with no column would
  be filled in by the candidate. Such rows, or the whole batch, are held back.
- **Columns cannot be matched to the wrong field.** DocuSeal matches by
  substring; the headers are the exact field names, in an order that matches
  cleanly, and any names that could still be confused are reported.
- **Addresses are checked** exactly as for email drafts.

DocuSeal is reported to host its EU service in Ireland and its global service
in the United States. Either way the data leaves Singapore, so the PDPA's
obligations on overseas transfers apply; a data processing agreement with
DocuSeal is the usual way to meet them. That is for the organisation to
arrange and review. The guide lists what to confirm before paying.

## Checking signed copies

The check runs entirely in the tab. Letters sent and copies returned are read
with the same PDF reader the rest of the tool uses, compared in memory, and
discarded when the tab closes.

It compares what each page *draws*, not what the file contains: every character,
with its position, including the values inside flattened form fields, plus
every painted shape, image and visible annotation. A returned copy passes only
if everything the sent letter drew is still there, in place, **and still
visible**: text that is still in the file but drawn in white, in an invisible
mode, fully transparent, or clipped away counts as changed, as does a page
whose visible area has been shrunk or turned. Anything new is treated as the
signature unless it overlaps the original text — and a filled rectangle of any
colour, or a pale fill of any shape, over the original text is reported as a
cover-up outright, since a signature is ink and never a box.

Every returned file is supplied by someone outside the organisation, so it is
treated as hostile. There are fixed limits on file size (50 MB), on how much
can be decompressed (64 MB, checked before the file is parsed and enforced as
it is read), on how many times embedded drawings may be drawn, and on how many
marks a file may hold. A file past any of them is reported as unable to be
checked rather than allowed to freeze the page.

**It also compares how each page looks.** A PDF can say one thing and show
another: a font whose "4" is drawn as a "9", a layer switched off, a pattern
painted over the text. So both versions of each page are also rendered to
pixels and compared. Wherever the sent page had ink and the returned page
does not, the copy is reported as changed; new ink that the structural
comparison cannot account for is sent for review. This is what catches a
forger who understands PDF internals, which the structural comparison alone
does not.

Rendering is done by **pdf.js**, Mozilla's PDF renderer (the one in Firefox),
bundled into the page — it is why the single-file app is about 2.2 MB rather
than 0.5 MB. It runs in the same tab, on bytes already in memory, configured to
load nothing: no font downloads, no WebAssembly decoders, no form scripting.
Pages are rendered only after a file has passed the size and complexity limits
above. A browser test checks a returned copy and asserts that no request of
any kind, to any origin, is made while it does.

**What it still does not do.** It cannot prove who signed. It compares what
the page shows on screen; a PDF built to print differently from how it
displays is not compared in print form, though one using layers — the usual
way to do that — is sent for review. The letter you sent remains the record of
what was offered; keep it.

Results are written to be safe to share: they give a page and a region ("Page 1,
near the top"), never the words found there. A scanned or photographed copy has
no text to compare, so it is reported as unable to be checked rather than
passed.

What this does not do: it does not establish who signed. A drawn signature is
evidence that someone signed, not proof of identity.

## Rendering DOCX to PDF

PDF output re-typesets the filled document rather than converting it, and it
does so in the same process as everything else — no conversion service, no
headless Office, no upload. That is the reason for the approach: an accurate
conversion would need a layout engine that cannot run in a browser, and the
alternatives all involve sending the document somewhere.

Two consequences are surfaced rather than hidden, because both are the kind of
thing that is only noticed after a document has been sent:

- Content the renderer cannot reproduce — tables, images, automatic numbering,
  and headers and footers — is detected in the template and reported before the
  batch runs.
- Text outside the WinAnsi character set cannot be written with PDF's built-in
  fonts. That row fails; the batch continues. The error **counts** the
  offending characters and does not quote them, because the text that failed is
  most often somebody's name.

## Handling hostile input

Both the template and the data file are treated as untrusted.

| Risk | Control |
|---|---|
| Markup injection via a cell value | Values are XML-escaped into DOCX; a payload such as `</w:t><w:r>` lands as literal text |
| Spreadsheet formula injection | Manifest cells starting `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` |
| Zip bomb | Total declared expansion of a DOCX is capped (200 MB) before decompression |
| Path traversal in a template's archive entries | Entry names are validated; `..`, absolute and drive-letter paths are rejected |
| Path traversal via a generated filename | Sanitized in the engine, then re-checked against the output root before writing |
| Traversal written *into* our ZIP | Entry names re-validated at archive-build time |
| Symlink planted in the output directory | Files are created with `O_EXCL`, which refuses to follow a symlink; `--force` unlinks the link itself, never its target |
| Reserved Windows device names | Escaped, including suffixed forms such as `CON.log` |
| Wrong file type | Templates identified by magic bytes, not by file extension |
| Encrypted PDF silently downgraded | Rejected, rather than filled and saved without its protection |
| Spreadsheet formulas | Never evaluated; only cached results are read |
| Remote/external workbook links | Not followed; those parts are ignored |
| A workbook part pointing outside the archive | Relationship targets resolved and traversal rejected |
| Oversized values | Single values capped at 100,000 characters |
| Control characters corrupting output | Stripped from values and filenames |
| Runaway batch | Row and column limits (50,000 / 512) |

Doclyst does not evaluate formulas, execute macros, resolve external
references, or follow links found in a template or a data file.

### XXE and external entities

Neither the DOCX engine nor the XLSX reader uses a general XML parser. It operates on `<w:t>` text
nodes directly and resolves only the five predefined XML entities plus numeric
character references. There is no DTD processing and no entity resolution, so
XXE and billion-laughs expansion are not reachable.

## The browser interface

`apps/web` runs the same engine in a browser tab. It is a static page: there is
no server, no upload endpoint and no backend to compromise.

- **The browser enforces it.** The page declares
  `default-src 'none'; connect-src 'none'; form-action 'none'` and loads no
  remote scripts, styles, fonts or images. Even if a future change tried to
  send a record somewhere, the browser would refuse. Verified in the tests by
  attempting a `fetch` from inside the page and asserting it is blocked.
- **Doclyst's own code makes no network calls.** Nothing under `apps/web/src`
  or `packages/core/src` uses `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource` or `sendBeacon`, and Vite's modulepreload polyfill, which
  calls `fetch`, is disabled. The bundle does include pdf.js, whose general
  design includes loading PDFs from web addresses; Doclyst only ever hands it
  bytes already in memory, configures it to fetch nothing, and the page's
  policy above would block it regardless. Tests drive the real page through a
  batch and a signed-copy check and assert no request leaves it.
- **It will not run inside another site's page.** A page that framed it could
  lay its own controls over Doclyst's. GitHub Pages cannot send the header
  that forbids framing, so the page checks for itself and refuses to start.
- **Nothing is persisted.** No `localStorage`, no `sessionStorage`, no
  `indexedDB`, no cookies and no service worker. Asserted after a full batch.
  Closing the tab disposes of every record.
- **Downloads are local.** Generated documents are handed over as object URLs,
  which address an in-memory blob in that tab, not a location on a server. Each
  handle is released after use rather than kept for the life of the page.
- **Writing to disk is scoped and temporary.** “Save to folder” and “Save as
  ZIP” use the File System Access API, so the browser — not this page — decides
  what may be written and where, after the user picks a location. That grant
  covers only the chosen location and only that visit: the directory handle is
  deliberately **never persisted**. Storing it in IndexedDB is the usual way to
  reuse a folder across visits, and doing so would both break the no-storage
  guarantee above and leave a standing write capability over someone's disk.
  Streaming also means a failed write leaves no half-written document behind:
  the writable is aborted rather than closed, and a partial ZIP is discarded.
- **No markup injection.** Column headers, sheet names, placeholder keys and
  filenames all come from user files and are only ever assigned to
  `textContent`. There is no `innerHTML` in the app.

## Multi-user considerations

The CLI runs as a single local user against paths that user already controls,
and the web interface runs entirely in one browser tab. Neither has a server,
so there is no cross-tenant boundary to breach, no shared storage and no
guessable output URL. Access control is the filesystem's, tightened by the
`0700`/`0600` defaults above.

If a hosted, networked interface is ever added, this section needs rewriting
around isolation, authentication and unpredictable output URLs — none of which
apply today, because today nothing is hosted.

## Testing

Every value in the test suite is synthetic. DOCX and PDF templates are
constructed in code rather than committed as binary fixtures, so the repository
contains almost no opaque files and no real personal data can be introduced
through one.

The single committed binary, `packages/core/test/fixtures/staff.xlsx`, is
generated by openpyxl so the parser is tested against a real writer rather than
our own encoder. Its contents are synthetic and it is reproducible from
`fixtures/generate.py`.

`.gitignore` additionally excludes common output directories, ZIPs and local
template/data folders, so a real run inside a working copy is not committed by
accident.

Privacy properties are asserted rather than assumed. The suite checks that
error messages omit record values, that the manifest contains no values, that
metadata is scrubbed from the produced bytes, that filenames cannot escape the
output directory, and that output files are `0600`.

## Reporting a problem

Please open an issue for anything that looks like a disclosure path. Do not
attach real personal data to a bug report — a synthetic reproduction is more
useful anyway.
