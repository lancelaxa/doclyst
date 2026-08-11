# Doclyst

Privacy-first batch document automation. Fill PDF and DOCX templates from
structured data — hundreds of records at a time — entirely on your own machine.

```
Template + Data  →  one document per record  →  folder and/or ZIP
```

Doclyst is built for documents that carry personal data: offer letters,
payslips, contracts, letters of employment. That assumption shapes the design
throughout, not just the marketing.

> **On PDPA.** Doclyst is designed with Singapore's PDPA principles in mind and
> implements technical controls that support responsible handling of personal
> data. It is **not** a compliance product and using it does not make you
> PDPA-compliant. Compliance depends on your policies, your legal basis for
> processing, your retention practices and how you distribute what you produce.
> See [PRIVACY.md](./PRIVACY.md) for exactly what the tool does and does not do.

## Two ways to use it

**In your browser** — a local page; nothing is uploaded.

```bash
npm install && npm run build
npm run dev:web            # or open apps/web/dist/index.html
```

**From the command line** — for scripted or repeatable runs.

```bash
npm install
npm run build

# What does this template need, and does my data provide it?
node apps/cli/dist/bin.js inspect --template offer.docx --data staff.csv

# Render one document per row.
node apps/cli/dist/bin.js fill \
  --template offer.docx \
  --data staff.csv \
  --out ./out \
  --zip ./offers.zip
```

## Writing a template

**DOCX** — type placeholders directly into the document:

```
Dear {{NAME}},

Your monthly salary is {{SALARY}}, effective {{START_DATE}}.
```

Placeholders work in the body, headers, footers and footnotes. Word routinely
splits a placeholder across several internal text runs; Doclyst stitches them
back together, so `{{NAME}}` is found whether or not Word broke it up.

**PDF** — add AcroForm form fields and name them after your columns, either
`NAME` or `{{NAME}}`. Text fields, checkboxes, dropdowns, option lists and
radio groups are all supported.

PDFs whose placeholder text is *drawn on the page* rather than held in a form
field cannot be filled. PDF stores positioned glyphs, not editable text, so
substituting a longer value would require re-flowing the page — a half-correct
payslip is worse than a clear error, so Doclyst reports one.

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

For **XLSX**, the first worksheet is read unless you pass `--sheet` with a name
or a 0-based index; `doclyst inspect --data book.xlsx` lists what is available.
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

```bash
--filename "{{STAFF_ID}}-offer"     # → EMP-0001-offer.docx
--filename "letter-{{ROW}}"         # → letter-0001.docx
```

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

| `--missing` | Behaviour |
|---|---|
| `error` (default) | Fail the row and report it |
| `empty` | Substitute an empty string |
| `keep` | Leave `{{PLACEHOLDER}}` visible in the output |

Add `--empty-is-missing` to treat a blank cell as absent rather than as a
deliberate empty value.

One bad row does not discard the batch: the remaining documents are still
written, failures are listed on stderr and recorded in `manifest.csv`, and the
exit code is `1`. Use `--stop-on-error` for all-or-nothing.

## CLI reference

```
doclyst inspect --template <file> [--data <file>]
doclyst fill --template <file> --data <file> (--out <dir> | --zip <file>) [options]
```

| Option | Meaning |
|---|---|
| `--sheet <name\|index>` | Worksheet to read from an `.xlsx`; defaults to the first |
| `--filename <pattern>` | Output name pattern; `{{ROW}}` is always available |
| `--missing <policy>` | `error` (default), `empty`, `keep` |
| `--empty-is-missing` | Treat a blank cell as a missing value |
| `--stop-on-error` | Abort at the first failing row |
| `--dry-run` | Report what would be produced; write nothing |
| `--force` | Overwrite existing output files |
| `--no-flatten` | Keep PDF form fields editable |
| `--keep-metadata` | Keep template author/company metadata in the output |

Exit codes: `0` success, `1` completed with failures, `2` bad usage.

## Privacy and security controls

Summarised here, detailed in [PRIVACY.md](./PRIVACY.md).

- **No network.** The tool makes no outbound requests. Nothing is uploaded, and
  there is no telemetry, no analytics and no cloud component.
- **No retention.** Documents are built in memory and written only where you
  ask. No temporary files, no caches, no databases.
- **Restrictive permissions.** Output directories are created `0700` and files
  `0600`, so the default umask cannot make a batch of payslips world-readable.
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

## The browser interface

The page at `apps/web` does the same work as the CLI, in the browser, with no
server involved at any point. Pick a template, pick a spreadsheet, generate, and
download the documents individually or as a ZIP.

Because everything runs in the tab, the privacy story is stronger than "we
promise not to look":

- The page ships a Content-Security-Policy with `connect-src 'none'`, so the
  **browser** refuses to let it open a network connection — fetch, XHR,
  WebSocket and EventSource are all blocked. The guarantee does not depend on
  our code staying careful.
- The built bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `localStorage`, `indexedDB` or service worker at all. That is checkable with
  `grep`, and it is asserted by the tests.
- There are no remote fonts, scripts, styles or images, and the favicon is
  inlined, so the page issues no requests beyond loading its own two assets.
- Nothing is persisted. Close the tab and every record is gone.
- Values are only ever written to the page as text, never as markup, so a
  column header or filename out of an untrusted spreadsheet cannot inject
  anything.

The browser tests drive the real page in Chromium and assert the central claim
behaviourally: loading a template and a spreadsheet and generating a whole
batch produces **no off-origin request**, and an attempt to `fetch` out of the
page is blocked by its own policy.

## Project layout

```
packages/core   Engine: bytes in, bytes out. No filesystem, no network.
apps/cli        Command-line interface. Owns all file I/O.
apps/web        Local browser interface. Static; no server, no upload.
```

The engine is deliberately pure. Because nothing in `packages/core` can read a
file or open a socket, "the engine cannot transmit your data anywhere" is a
property of the code rather than a promise.

Output is deterministic: identical inputs produce byte-identical files, so runs
are reproducible and no processing timestamps are embedded.

A batch unzips, validates and scrubs the template **once** rather than per
record, and stores already-compressed parts (embedded images, fonts) instead of
deflating them a second time. On a typical 180 KB letterhead template that is
about 3× faster over 500 records, with byte-identical output. A malformed
template now fails once, up front, instead of producing one identical failure
per row.

## Development

```bash
npm install
npm run typecheck   # tsc --build across all packages
npm test            # vitest
npm run check       # both
```

The test suite uses only synthetic data. DOCX and PDF templates are built in
code rather than committed as binaries, so nothing opaque is in the repository
and no real personal data ever enters it.

The one committed binary is `packages/core/test/fixtures/staff.xlsx`, which is
generated by openpyxl — an independent writer — so the XLSX parser is validated
against a real producer's output rather than against our own encoder. Its
contents are synthetic and it is reproducible via `fixtures/generate.py`.

## Scale

Measured on a 400-record batch with a typical ~180 KB letterhead template:

| | Time | Notes |
|---|---|---|
| CLI, DOCX | 1.1 s | ~2.8 ms/record, ~180 MB RSS |
| CLI, PDF | 1.8 s | ~4.5 ms/record; the template is re-parsed per record |
| Browser, DOCX | 2.1 s | JS heap 7 MB → 48 MB, page stays responsive |
| Browser, ZIP | 3.0 s | 31 MB archive |

Row count is rarely the constraint — **total output size is**. Every generated
document is held in memory until you download it, and building a ZIP holds a
second copy. A few hundred ordinary documents is untroubled; the same count
from a template carrying megabytes of embedded imagery is a different matter.

In the browser specifically, once a batch's documents total a few hundred MB
the tab can hold over a gigabyte during the ZIP step, and browsers cancel very
large blob downloads *silently* — the button appears to do nothing. Doclyst
reports the total size after generating and warns past 300 MB, suggesting
downloading files individually (unaffected, since each document is small) or
using the CLI, which writes straight to disk and has no such ceiling.

For very large or very heavy batches, prefer the CLI.

## Limitations

Known and deliberate, rather than hidden:

- XLSX is read, not written, and macro-enabled `.xlsm` is not supported.
- PDF templates require AcroForm fields (see above).
- Encrypted or password-protected PDFs are rejected rather than silently saved
  without their protection.

## Licence

MIT — see [LICENSE](./LICENSE).
