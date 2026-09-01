# Doclyst

Fill a Word or PDF template from a spreadsheet — one document per row, hundreds
at a time, entirely on your own device.

```
Template + spreadsheet  →  one document per row  →  a folder or a ZIP
```

Built for documents that carry personal data: offer letters, payslips,
contracts, letters of employment. That assumption shapes the whole design.

## Nothing is uploaded

Your template, your spreadsheet and every value in them stay on your device.
The browser version is *blocked by the browser itself* from making network
requests — not a promise in a policy, a rule the browser enforces. There is no
account, no server, and no telemetry.

[PRIVACY.md](./PRIVACY.md) sets out exactly what is and is not done with your
data, in detail.

> **On PDPA.** Doclyst is designed with Singapore's PDPA principles in mind and
> implements technical controls that support responsible handling of personal
> data. It is **not** a compliance product and using it does not make any
> organisation PDPA-compliant. Compliance depends on your policies, your legal
> basis for processing, your retention practices, and how you distribute what
> you produce.

## Start here

**[GUIDE.md](./GUIDE.md)** — the walkthrough. Opening it, writing a template,
preparing your spreadsheet, generating documents, and what to do when something
goes wrong. No terminal needed at any point.

## Opening it

**Use the hosted page:** <https://lancelaxa.github.io/doclyst/>

**Or keep your own copy:** download `doclyst.html` from the latest
[Actions](../../actions) run — the artifact named `doclyst-single-file`. It is
the whole application in one file. Double-click it; it works offline, and it
keeps working if the link above ever goes away.

## What it does

- **Word or PDF templates.** Write `{{PLACEHOLDERS}}` where the values go, named
  after your spreadsheet columns.
- **Exact letterhead.** Save your Word letter as PDF and Doclyst turns each
  placeholder into a fillable field in place — your design, untouched.
- **CSV or Excel data.** The header row names the fields; `Full Name` fills
  `{{FULL_NAME}}`.
- **Checks before it runs.** It tells you if a placeholder has no column, or if a
  field is too small for the longest value in your data — before a single
  document is written.
- **Hundreds at a time.** Save straight to a folder or a ZIP; memory stays flat.

## Anything it cannot do, it says so

The tool is built around one rule: **never produce a document that is quietly
wrong.** A truncated address, a name that did not fit, a table that could not be
carried over — each of those stops the batch or is reported by name and row.
Messages never quote the value itself, so they are safe to paste into a ticket.

## Writing a template

**DOCX** — type placeholders directly into the document:

```
Dear {{NAME}},

Your monthly salary is {{SALARY}}, effective {{START_DATE}}.
```

Placeholders work in the body, headers, footers and footnotes. Word routinely
splits a placeholder across several internal text runs; Doclyst stitches them
back together, so `{{NAME}}` is found whether or not Word broke it up.

**PDF** — write the same `{{PLACEHOLDERS}}` into the document, save it as PDF,
and let `doclyst prepare` turn each one into a form field where it already
sits. Fields named `NAME` or `{{NAME}}` both work, so a template built by hand
in a PDF editor is filled the same way. Text fields, checkboxes, dropdowns,
option lists and radio groups are all supported.

A **scanned** PDF cannot be used: there is no text in it to find, only a picture
of text.

Placeholder text left drawn on the page is never substituted in place. PDF
stores positioned glyphs, not editable text, so swapping in a longer value
would overrun whatever follows it — which is why preparing replaces the
placeholder with a field that has a known box, rather than editing the page.

**A form field clips whatever does not fit its box**, which is the format's own
behaviour and produces a document containing a whole address while showing a
third of it — with nothing to say so. Doclyst measures every value against the
field before saving. By default it shrinks the text to fit, down to 6pt, and
names the fields it had to shrink so the fix can go into the template. Below
that the value would be present but unreadable, so the record fails instead.
Errors name the field and never quote the value.

## Keeping a template's exact appearance

Two routes produce PDF, and they trade off differently:

| | DOCX template → PDF | PDF template → PDF |
|---|---|---|
| Appearance | Re-typeset; close, not identical | **Exact** — your file is filled, not rebuilt |
| Logo, fonts, letterhead | Not carried over | Preserved |
| Tables, images, headers/footers | Not carried over | Preserved |
| Long values | Reflow naturally | Must fit the field; checked in advance |
| Editing the template | Word | Word, then add form fields once |

**For anything a candidate, employee or regulator will see, use a PDF
template.** Design the letter in Word with `{{PLACEHOLDERS}}` in it, save as
PDF, and let Doclyst turn it into a fillable template:

Press **Prepare this template** in the browser. Every placeholder is found
where it sits, taken off the page, and replaced by a form field at the same
position, size and typeface — no PDF editor, and nothing else on the page
moves by so much as a point. The design survives because Word did the layout
and Doclyst never re-creates it.

One thing to know when writing the template: a PDF cannot reflow, so a
placeholder in the middle of a sentence becomes a fixed box — a short value
leaves a gap and a long one shrinks. Give each placeholder its own line, or put
it at the end of one. Doclyst reports the ones that are not.

Load the template and the data together and Doclyst measures every field
against the widest value your data actually contains, before generating
anything — so a field too narrow for one person in four hundred is found now
rather than after the letters have gone out. The report names the field and the
row, never the value.

## Choosing the output format

A DOCX template produces `.docx` by default and `.pdf` on request; a PDF
template always produces PDF.

Set **Options → Output format** to *PDF*.

PDF output is **re-typeset, not converted**. Doclyst reads the filled
document's text — its paragraphs, bold and italic, explicit font sizes and
alignment — and lays it out afresh in the PDF. The wording is exactly the
wording in the template; the appearance will not match Word pixel for pixel.

That choice is deliberate. Converting Word layout faithfully needs a layout
engine, and there is no layout engine that runs in a browser tab — the only
alternative would have been to send documents to a conversion service, which
is precisely what this tool exists to avoid.

Two limits follow from it, and both are reported rather than left to be
discovered:

- **Tables, images, automatic numbering, and headers and footers are not
  carried over.** Doclyst inspects the template before the run and warns if it
  uses any of them, in the browser as soon as you pick PDF, and on the command
  line before the first file is written.
- **Only the Western European character set is available.** PDF's built-in
  fonts cover Western European alphabets only, so a name in Chinese, Tamil or
  another script
  fails that row with a clear message rather than producing a document with
  missing glyphs — a mangled contract is worse than a failed one. The rest of
  the batch is unaffected. If your data needs those scripts, use DOCX output.

## Providing data

CSV or XLSX, with the header row naming the fields:

```csv
Full Name,Basic Salary,Staff ID
Aisha Rahman,4500,EMP-0001
Wei Lun Tan,5200,EMP-0002
```

Header matching is forgiving about case, spaces, hyphens and dots, so the
column `Full Name` fills `{{FULL_NAME}}`. Comma, semicolon, tab and pipe
delimiters are auto-detected, and a UTF-8 BOM is handled.

Two things are rejected rather than guessed at, because both make the mapping
ambiguous in a way that would quietly produce wrong documents: blank column
headers, and two headers that normalize to the same field name.

For a workbook with more than one sheet, a **Worksheet** picker appears; the
first sheet is used unless you choose another.
Dates are converted to `YYYY-MM-DD` (Excel stores them as bare numbers, so this
depends on the cell's format), decimals keep their stored precision, booleans
render as `TRUE`/`FALSE`, and sparse rows stay aligned with their headers.

Formulas are **never evaluated**. Doclyst reads the result the spreadsheet last
cached — what the operator saw on screen — and a formula with no cached result
reads as empty. Error cells such as `#REF!` are passed through rather than
blanked, so a broken source cell is visible in the output instead of silently
missing.

## Naming the output

By default files are named `document-0001.docx`, `document-0002.docx`, …

That default is deliberate. **A filename is visible without opening the file** —
in a folder listing, a ZIP index, an email attachment bar, a backup log — so
naming a document after an NRIC discloses it to everyone who can see the
folder, including people with no reason to read the document itself.

You can name files from your data when you want to:

| Pattern in **File naming** | Produces |
|---|---|
| *(blank)* | `document-0001.docx` |
| `{{STAFF_ID}}-offer` | `EMP-0001-offer.docx` |
| `letter-{{ROW}}` | `letter-0001.docx` |

Doclyst warns when a filename pattern uses a field that looks identifying
(NRIC, salary, passport, date of birth, address, phone, and similar). It is a
warning, not a refusal — it may well be what you intend.

Names are always sanitized: path separators and traversal sequences are
neutralized, Windows-illegal characters and reserved device names are handled,
and collisions get ` (2)`, ` (3)` suffixes rather than overwriting. Two people
with the same name produce two documents, never one.

## Missing values

By default a placeholder with no value **fails that row**. These are contracts
and payslips; a silently blank salary is worse than a failed row.

| **Missing values** | Behaviour |
|---|---|
| **Fail that row** (default) | No document for that row; it is reported |
| **Leave blank** | Substitute an empty string |
| **Leave the placeholder visible** | Leave `{{PLACEHOLDER}}` visible in the output |

Tick **Treat a blank cell as a missing value** to treat a blank cell as absent rather than as a
deliberate empty value.

One bad row does not discard the batch. Every other document is still written,
and you get a list of which rows failed and why.

## Privacy and security controls

Summarised here, detailed in [PRIVACY.md](./PRIVACY.md).

- **No network.** The tool makes no outbound requests. Nothing is uploaded, and
  there is no telemetry, no analytics and no cloud component.
- **No retention.** Documents are built in memory and written only where you
  ask. No temporary files, no caches, no databases.
- **Private by default on disk.** Generated files are readable only by the
  person who made them, so a folder of payslips cannot end up readable by
  everyone on a shared machine.
- **Metadata scrubbed.** The template author, company, manager and timestamps
  are removed from generated files by default, so they do not travel to every
  recipient. PDFs are flattened so values cannot be edited back out.
- **Values never logged.** Errors, warnings and the manifest reference a row
  number and a field name, never a value. Errors from third-party parsers are
  summarised rather than echoed, because they can embed document bytes.
- **Injection handled at the boundaries.** Values are XML-escaped into DOCX, so
  a hostile cell cannot inject Word markup; the CSV manifest neutralises
  formula-injection payloads (`=`, `+`, `-`, `@`) because it is meant to be
  opened in a spreadsheet. Spreadsheet formulas are read as cached values and
  never evaluated.
- **Hostile input rejected.** Templates are identified by content rather than
  file extension, zip-bomb expansion is capped, and archive entries with
  traversal paths are refused.

## Keeping your own copy

`doclyst.html` is the whole application in a single file. Download it from the
latest [Actions](../../actions) run and double-click it: no install, no server,
and it works with the network off. Keep a copy and it keeps working whatever
happens to the hosted link.

## Limitations

Known and deliberate, rather than hidden:

- XLSX is read, not written, and macro-enabled `.xlsm` is not supported.
- A PDF template needs form fields. **Prepare this template** adds them from
  your `{{PLACEHOLDERS}}`, but a scanned PDF is a picture of text with nothing
  to find.
- A PDF cannot reflow, so a placeholder mid-sentence becomes a fixed box: a
  short value leaves a gap, a long one shrinks. Reported per field.
- PDF made from a Word template is re-typeset, so tables, images, numbering and
  headers are not carried over, and only Western European characters can be
  drawn. Both are reported before a batch runs.
- A PDF template can only draw the alphabets its own font covers. A name
  outside them fails that one record, with a message naming the field — rather
  than leaving the field blank.
- Each filled PDF is a complete copy of its template, so total output size is
  roughly the template size times the number of records. Filling a PDF form
  cannot share fonts between files.
- Encrypted or password-protected PDFs are rejected rather than silently saved
  without their protection.

## For developers

Building it, the command-line version, the project layout and the measured
performance figures are in **[DEVELOPING.md](./DEVELOPING.md)**.

## Licence

MIT — see [LICENSE](./LICENSE).
