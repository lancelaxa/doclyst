# Privacy and security design

Doclyst assumes every value it processes is personal data — names, NRIC/FIN
numbers, salaries, addresses, phone numbers, dates of birth. This document
describes the controls that follow from that assumption, and is meant to be
specific enough to verify against the code.

## Scope and limits

**Doclyst is not a compliance product.** It is designed with Singapore PDPA
principles in mind, and it implements technical controls that support
responsible handling of personal data. It does not make any organisation
PDPA-compliant, and this document is not legal advice.

Compliance depends on things the tool cannot see or control: your legal basis
for processing, your consent and notification practices, your retention
schedule, who you give the generated documents to, and how you transmit them.
Doclyst helps with the *generation* step and nothing else.

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

Runtime dependencies are two focused, widely used libraries — `fflate` (ZIP)
and `pdf-lib` (PDF) — both pure computation with no network capability. The
CSV parser, the XLSX reader and the DOCX engine are implemented in-repo, which
keeps the amount of third-party code touching personal data small.

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
  `dc:description`, `cp:category`, plus `Company` and `Manager`.
- **PDF** — title, author, subject, keywords, producer and creator, with
  creation and modification dates fixed to a constant.

Archive timestamps are also fixed, so the file does not record when each record
was processed. Use `--keep-metadata` to opt out.

PDF form fields are **flattened** by default: values become page content, so
the recipient cannot edit them back out, and the interactive field objects —
which hold their own copy of every value — are removed rather than shipped
alongside the rendered text. `--no-flatten` opts out.

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

## Multi-user considerations

The CLI runs as a single local user against paths that user already controls,
so there is no cross-tenant boundary to breach and no server component. Access
control is the filesystem's, tightened by the `0700`/`0600` defaults above.

If a networked interface is added later, this section needs to be rewritten
around isolation, authentication and unpredictable output URLs — none of which
apply today.

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
