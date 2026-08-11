# How to use Doclyst

A practical walkthrough: prepare a template, prepare a spreadsheet, generate
one document per person. No programming needed for the browser version.

- [Opening Doclyst (no terminal needed)](#opening-doclyst-no-terminal-needed)
- [Try it in two minutes](#try-it-in-two-minutes)
- [Step 1 — Prepare your template](#step-1--prepare-your-template)
- [Step 2 — Prepare your spreadsheet](#step-2--prepare-your-spreadsheet)
- [Step 3 — Generate the documents](#step-3--generate-the-documents)
- [Naming the output files](#naming-the-output-files)
- [When a value is missing](#when-a-value-is-missing)
- [Large batches](#large-batches)
- [Using the command line](#using-the-command-line)
- [When something goes wrong](#when-something-goes-wrong)
- [Handling personal data responsibly](#handling-personal-data-responsibly)

---

## Opening Doclyst (no terminal needed)

You do **not** need to install anything or use a command line. Pick whichever
of these suits you.

### Option A — download one file and double-click it

This is the simplest, and the most private: there is no server involved at any
point, and it works with no internet connection at all.

1. Go to the repository on GitHub and open the **Actions** tab.
2. Click the most recent **“Build and publish the app”** run.
3. Scroll to **Artifacts** and download **`doclyst-single-file`**.
4. Unzip it. You get one file: **`doclyst.html`**.
5. **Double-click it.** It opens in your browser and is ready to use.

That single file *is* the whole application — about 480 KB, with everything
built in. Keep it on your desktop, email it to a colleague, or put it on a USB
stick. It never needs updating to keep working, and it works offline.

> Use **Chrome or Edge** if you can. They support saving straight to a folder,
> which matters for large batches. It still works in Firefox and Safari; you
> just download the files instead.

### Option B — a link you can bookmark

The app is published at:

**https://lancelaxa.github.io/doclyst/**

Open it in any browser — no sign-in, no download, nothing to install. Bookmark
it and share it with colleagues. It updates automatically whenever the project
is updated.

> **This link is public.** The repository is public, so anyone with the address
> can open the page. That is safe for the tool itself — it is a static page
> holding no data, and it cannot make network requests — but the link is not
> restricted to your team. If you would rather it were, share the
> `doclyst.html` file from Option A directly instead.

**Hosting the page does not mean hosting your data.** The page is downloaded to
your browser and does all its work there. Its Content-Security-Policy blocks it
from making network requests at all, so it could not send your spreadsheet
anywhere even if it tried. Once loaded, you can disconnect from the internet
and it keeps working.

*(If the link ever stops working, it is served by GitHub Pages: check
Settings → Pages → Source is set to **GitHub Actions**, then re-run the latest
workflow from the Actions tab.)*

### Option C — build it yourself

Only if you want to change the code. See [Try it in two
minutes](#try-it-in-two-minutes) below.

### Which files can I open it with?

However you open it, Doclyst runs entirely in your browser. Nothing is
uploaded, no account is needed, and closing the tab discards everything.

---

## Try it in two minutes

If you just want to see it work, generate a sample template and spreadsheet:

```bash
npm install
npm run build
node examples/make-example.mjs      # writes examples/offer-letter.docx + staff.csv
npm run dev:web
```

Open the address it prints, drop in `examples/offer-letter.docx` and
`examples/staff.csv`, and press **Generate documents**. You should get four
offer letters.

---

## Step 1 — Your template

You need **one** template. Doclyst fills it once per row of your spreadsheet.
Either kind uses the same `{{PLACEHOLDER}}` markers; what differs is what the
finished document looks like.

| | Word template | PDF template |
|---|---|---|
| Output | `.docx`, or PDF that is re-typeset | PDF, an **exact** copy of your design |
| Letterhead, logo, fonts | Kept in `.docx` output; lost in PDF output | Kept exactly |
| Tables, images, headers | Kept in `.docx` output; lost in PDF output | Kept exactly |
| Editing it | Straight from Word | Edit in Word, export, prepare again |
| Long values | Reflow normally | Must fit their box; checked in advance |

**Use a PDF template for anything a candidate, employee or regulator will
see.** Use a Word template when the output is a `.docx` anyway, or when the
wording matters more than the look.

Both start in Word, so this is not a decision you are locked into.

### Word templates (.docx)

Write the document as you normally would, and type a placeholder wherever a
value should go:

```
Dear {{FULL_NAME}},

We are pleased to offer you the position of {{JOB_TITLE}} at a monthly
salary of SGD {{BASIC_SALARY}}, commencing {{START_DATE}}.

Your staff number will be {{STAFF_ID}}.
```

Rules worth knowing:

- Placeholders are **case-insensitive** and forgiving about spacing, so
  `{{FULL_NAME}}`, `{{Full Name}}` and `{{full name}}` are the same field.
- They work in the **body, headers, footers and footnotes** — so letterhead
  fields like `{{DATE}}` and `{{REF_NO}}` are fine.
- Formatting is preserved. If `{{NAME}}` is bold, the name comes out bold.
- You can use the same placeholder as many times as you like.
- Word often splits a placeholder invisibly across its internal formatting.
  Doclyst handles that, so `{{NAME}}` works even when Word has mangled it
  behind the scenes.

> **Tip:** type the placeholder in one go. If you paste or edit it in pieces,
> Word sometimes autocorrects the braces into “smart quotes”, which stops it
> being recognised. If a field is not detected, delete it and retype it.

### PDF templates (.pdf) — for an exact letterhead

A PDF template is filled, not rebuilt, so the design that comes out is the
design you made: fonts, logo, spacing, margins and signature block, identical
every time.

You still write it in Word:

1. **Write the letter in Word** with `{{PLACEHOLDERS}}` where the values go,
   named after your spreadsheet columns.
2. **File → Save as → PDF.** Word does the layout, which is what preserves the
   appearance.
3. **Drop that PDF into Doclyst** and press **Prepare this template**. Every
   placeholder becomes a fillable field in the same position, size and
   typeface; nothing else on the page moves. Download the prepared template and
   reuse it for every batch after that.

No PDF editor needed. On the command line, step 3 is `doclyst prepare`.

A PDF **scan** cannot be used — there is no text in it to find, only a picture
of text. Password-protected PDFs are rejected rather than quietly stripped of
their protection; remove the password first.

#### If someone hands you a PDF with form fields already in it

That works too, and needs no preparing. Name each field after its column —
either `FULL_NAME` or `{{FULL_NAME}}`. Text boxes, checkboxes, dropdowns,
option lists and radio buttons are all supported. For checkboxes, the values
`Yes`, `Y`, `TRUE`, `1`, `X`, `checked` and `on` tick the box; anything else
leaves it clear.

---

## Step 2 — Your spreadsheet

A `.csv` or `.xlsx` where the **first row is the column headers** and each
following row is one person:

| Full Name | Job Title | Basic Salary | Start Date | Staff ID |
|---|---|---|---|---|
| Aisha Rahman | Analyst | 4500 | 2026-01-15 | EMP-0001 |
| Wei Lun Tan | Engineer | 5200 | 2026-02-01 | EMP-0002 |
| Priya Nair | Manager | 6100 | 2026-02-14 | EMP-0003 |

Headers are matched to placeholders loosely, so **`Full Name` fills
`{{FULL_NAME}}`** — you do not need to rename your columns to match. Case,
spaces, hyphens and dots are all ignored when matching.

What Doclyst does with your data:

- **Dates** in Excel are converted to `YYYY-MM-DD`. If you want a particular
  format such as `15 January 2026`, put it in the spreadsheet as text.
- **Numbers** keep exactly the digits you stored, so `5200.50` stays
  `5200.50`. Doclyst does not add currency symbols or thousands separators —
  put those in the template (`SGD {{SALARY}}`) or in the spreadsheet.
- **Formulas** are never calculated. Doclyst reads the result your spreadsheet
  last saved — what you see on screen. If a formula cell shows `#REF!`, that
  is what appears in the document, so you notice rather than getting a blank.
- **Multiple worksheets** are supported; pick one in the app, or with
  `--sheet` on the command line. The first sheet is used by default.

Two things are rejected outright, because both would silently produce wrong
documents:

- a **blank column header** in the middle of your headers;
- **two columns that mean the same field**, such as `Full Name` and
  `full_name` — Doclyst cannot know which one you meant.

---

## Step 3 — Generate the documents

### In the browser

1. Open the page (`npm run dev:web`, or open the built `index.html`).
2. **Drop your template** into the first box, or click to choose it.
   Doclyst lists the placeholders it found — check they look right.
   *If it is a PDF that still has `{{PLACEHOLDERS}}` written in it, press
   **Prepare this template** first.*
3. **Drop your spreadsheet** into the second box. It shows the row count and
   column names, and — for a PDF template — whether every field is big enough
   for your data.
4. Look for the green line: *“Every template placeholder has a matching
   column.”* If instead you see **“No column matches: …”**, fix that before
   generating — otherwise every row will fail.
5. Adjust anything under **Options** (most people do not need to). If you
   need PDFs rather than Word files, set **Output format** to *PDF*.
6. Press **Generate documents**, then download them individually or as a ZIP.

Nothing is uploaded at any point. The page is blocked by the browser from
making network requests at all, so your files never leave the machine.

### Reviewing before you commit

Always open one or two generated documents before sending anything. The most
common mistakes — a column mapped to the wrong placeholder, a date in an
unexpected format, a missing currency symbol — are obvious on sight and
invisible in a summary.

---

## Working with PDF templates

Everything in this section applies once you have chosen the PDF route in
Step 1. None of it is needed for a Word template.

### Where to put the placeholders

**Give a placeholder its own line, or put it at the end of one.** This matters
more than it sounds. A PDF cannot reflow: a field is a fixed box, so the words
after it on the same line do not move. If a placeholder sits mid-sentence:

- a **short** value leaves a visible gap before the following words;
- a **long** value has to shrink to fit rather than pushing them along.

Doclyst tells you which placeholders have text after them on the same line, so
you can move them in the Word document and prepare it again. Laid out as a form
— label on the left, value on the right — every field is free of the problem:

```
Name:            {{FULL_NAME}}
Position:        {{JOB_TITLE}}
Monthly salary:  {{BASIC_SALARY}}
```

### Making the fields wider

A real value is usually longer than `{{FULL_NAME}}`, and a form field hides
whatever does not fit. In the browser the fields are made the size of the
placeholder; on the command line, `--widen 1.5` makes each one half as wide
again:

```bash
node apps/cli/dist/bin.js prepare \
  --template offer-letter.pdf \
  --out offer-letter-template.pdf \
  --widen 1.5
```

A field is never widened over the text that follows it on a line, so this
cannot cause the two to overlap. Where there is not enough room, the value
shrinks to fit and you are told which fields that happened to.

If you would rather place the fields by hand, any PDF editor will do it —
Acrobat (Prepare a Form), LibreOffice Draw, or Xournal++. Doclyst fills a
hand-made template in exactly the same way.

### Changing a template later

**Keep the Word document. It is the master.** The prepared PDF is built from
it, the way a compiled file is built from source — you edit the Word file and
prepare again, never the PDF.

To change the wording, add a clause, or add a new field:

1. Edit the **Word** document. To add a field, type a new `{{PLACEHOLDER}}`
   named after the spreadsheet column that will fill it.
2. Save as PDF again.
3. Prepare it again, and use the new template.
4. Load it with your spreadsheet — Doclyst re-checks that every placeholder has
   a matching column and that every field is big enough. A column you have not
   added yet shows up here, not halfway through a batch.

Field names come from the placeholders, so as long as you do not rename one,
your existing spreadsheet keeps working. Rename a placeholder and you must
rename the column to match — Doclyst will tell you if you forget.

If you feed a prepared template back in by mistake, Doclyst recognises it and
says so rather than reporting a fault in your document.

**Keep the old template until the new one is checked.** Name them so you can
tell which is which — `offer-letter-2026-08.pdf` — and you can always go back
to the version a batch was actually produced with.

### Checking the template before you use it

Load the PDF template **and** your spreadsheet into Doclyst. It measures every
field against the widest value in your actual data and tells you straight away:

- *“Every field is big enough for the widest value in your data.”* — good to go.
- *“BASIC_SALARY: tight — row 12 shrinks from 11pt to 9pt.”* — nothing will be
  missing, but that field will look smaller than the rest. Widen it.
- *“CANDIDATE_ADDRESS: too small — the widest value (row 12) will not fit
  legibly.”* — **fix this before generating.** Widen the field or enable
  multiline.

On the command line the same check runs as part of `inspect`, and a field that
cannot fit exits non-zero so a scheduled job stops rather than sending letters
with a missing address.

The report names the **field and the row**, never the value, so it is safe to
paste into a ticket.

### What Doclyst does if something still does not fit

It never silently truncates. A value too wide for its box is shrunk to fit,
down to 6pt, and the affected fields are listed after the run. Below 6pt the
text would be there but unreadable, so that row fails and is reported instead.

### A note on fonts

A prepared field draws its value in the same font the placeholder was in, so
the value matches the text around it. Where the PDF's font is *subset* — cut
down to only the characters the document already used, which is what Word
does — Doclyst checks it can still spell an arbitrary name. If it cannot, that
field falls back to Helvetica and you are told which ones, because the
difference is visible.

---

## Getting PDFs from a Word template

Set **Output format** to *PDF* in the browser, or pass `--output pdf` on the
command line. A PDF template always produces PDF, so the setting only applies
to Word templates.

**What you get.** The wording is exactly the wording in your template, with
bold, italic, font sizes and paragraph alignment preserved. The layout is
re-created rather than copied, so the result will not look identical to the
Word file — line breaks and spacing may fall differently.

**Why not an exact copy?** Reproducing Word's layout faithfully needs a layout
engine, and none runs inside a browser tab. The only other way to do it would
be to upload your documents to a conversion service — which is the one thing
this tool is built never to do.

**If appearance matters, use a PDF template instead** — see Step 1. That route
is exact, because Doclyst fills your real PDF rather than rebuilding it.

**Two things to check before you run a batch as PDF:**

1. **Tables, images, bullet lists, headers and footers do not come across.**
   Doclyst tells you as soon as you choose PDF if your template uses any of
   them. If your letterhead lives in the Word header, it will not appear in the
   PDF — put it in the body of the document instead, or keep DOCX output.
2. **Names must use Western European characters.** PDF's built-in fonts do not
   include Chinese, Tamil, Malay in Jawi script, or other non-Latin writing.
   A row whose data needs them fails with a clear message instead of producing
   a document full of blanks — the rest of the batch still completes. **If your
   staff list includes such names, generate DOCX** and convert with Word or
   your usual PDF printer.

Generate one document and open it before running the whole batch. This is worth
doing every time, and doubly so the first time you use a template as PDF.

---

## Naming the output files

By default files are named `document-0001.docx`, `document-0002.docx`, and so
on. That is deliberate, and it is usually the right choice.

**A filename is visible without opening the file.** It shows in folder
listings, ZIP contents, email attachment bars and backup logs — to people who
may have no business reading the document itself. Naming a payslip after
someone's NRIC discloses that NRIC to all of them.

If you do want meaningful names, use any field:

| Pattern | Produces |
|---|---|
| *(blank)* | `document-0001.docx` |
| `{{STAFF_ID}}-offer` | `EMP-0001-offer.docx` |
| `letter-{{ROW}}` | `letter-0001.docx` |
| `{{DEPARTMENT}}-{{ROW}}` | `Finance-0001.docx` |

`{{ROW}}` is always available and is the row's position in your spreadsheet.

Doclyst warns if your pattern uses something identifying (NRIC, salary,
passport, date of birth, address, phone). It is only a warning — you may have
good reason — but it is worth a second thought. **A staff number is usually a
better choice than a personal identifier.**

Two people with the same name produce two files (`Aisha Rahman.docx` and
`Aisha Rahman (2).docx`), never one overwriting the other.

---

## When a value is missing

By default, if a placeholder has no matching value, **that row fails** and no
document is produced for it. The rest of the batch still completes, and you
get a list of which rows failed and why.

This is deliberate: for a contract or a payslip, a silently blank salary is
much worse than a missing file you can see.

| Setting | What happens | When to use it |
|---|---|---|
| **Fail that row** (default) | No document for that row; it is reported | Contracts, payslips, anything binding |
| **Leave blank** | Placeholder becomes empty text | Genuinely optional fields |
| **Leave the placeholder visible** | `{{FIELD}}` stays in the document | Drafts you will finish by hand |

**Treat a blank cell as a missing value** is separate. Off by default, an empty
cell is taken as a deliberate blank. Turn it on if an empty cell means the data
is incomplete rather than intentionally empty.

---

## Large batches

A few hundred documents is routine. For bigger or heavier jobs:

- **Save to folder…** and **Save as ZIP…** (Chrome and Edge) write each
  document straight to disk as it is made, so memory stays flat however large
  the batch. Your browser asks where to save; the page can only write there,
  and only for that visit.
- **Generate documents** holds everything in memory. That is fine for ordinary
  templates, but if your documents total more than a few hundred megabytes the
  browser may refuse to save the ZIP. Doclyst shows the total size and warns
  you when you are near that point.
- For very large jobs, or on Firefox and Safari, use the command line.

---

## Using the command line

Useful for repeat runs and scheduled jobs. Same engine, same results.

**Prepare a PDF template** — only for a PDF that still has placeholders
written into it, and only once per template:

```bash
node apps/cli/dist/bin.js prepare \
  --template offer-letter.pdf \
  --out offer-letter-template.pdf
```

**Check before you run** — this catches mapping mistakes, and sizing mistakes,
without producing anything:

```bash
node apps/cli/dist/bin.js inspect \
  --template offer-letter.docx \
  --data staff.csv
```

```
Template: offer-letter.docx (docx)
  Fields (5): FULL_NAME, JOB_TITLE, BASIC_SALARY, START_DATE, STAFF_ID
Data: staff.csv
  Rows: 4
  Columns (5): Full Name, Job Title, Basic Salary, Start Date, Staff ID

Every template placeholder has a matching column.
```

For a PDF template it also measures every field against the widest value in
your data, and exits non-zero if one cannot fit — so a scheduled job stops
rather than sending letters with a missing address.

**Generate:**

```bash
node apps/cli/dist/bin.js fill \
  --template offer-letter.docx \
  --data staff.csv \
  --out ./letters \
  --filename "{{STAFF_ID}}-offer"
```

Add `--dry-run` first to see what would be produced without writing anything.

Useful options:

| Option | What it does |
|---|---|
| `--zip out.zip` | Also (or instead) write one ZIP |
| `--sheet "Sheet2"` | Choose a worksheet by name or number |
| `--output pdf` | Write PDFs from a Word template (see above) |
| `--widen 1.5` | `prepare` only: make each field wider than its placeholder |
| `--missing empty` | Blank out missing values instead of failing the row |
| `--empty-is-missing` | Treat blank cells as missing |
| `--dry-run` | Report what would happen; write nothing |
| `--force` | Overwrite existing files |
| `--stop-on-error` | Stop at the first bad row instead of continuing |

Output goes into a folder only you can read (`0700`), with files only you can
read (`0600`), plus a `manifest.csv` recording which row produced which file
and what failed. The manifest contains **no field values** — only row numbers,
filenames and outcomes, so it is safe to keep or attach to a ticket.

Exit codes: `0` all good, `1` finished with some failed rows (or a template
field too small), `2` wrong usage.

Run `node apps/cli/dist/bin.js --help` for the full list.

---

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| **No column matches: SALARY** | The template wants a field your spreadsheet has no column for | Add the column, or rename the placeholder to match an existing one |
| **No value for placeholder "X" in row 7** | That cell is empty | Fill the cell, or switch missing values to *Leave blank* |
| **This PDF has no fillable form fields** | The placeholders are drawn as ordinary text | Add real form fields with a PDF editor, or use a Word template |
| **No placeholders found** | The braces were not recognised | Retype `{{FIELD}}` by hand — Word may have turned the braces into smart quotes |
| **The template must be a .docx or .pdf file** | The file is not really one of those, whatever its name | Re-save from Word as `.docx`, not `.doc` or `.rtf` |
| **Columns 2 and 5 resolve to the same field name** | Two headers mean the same field | Rename one so they are distinguishable |
| **Column 3 has an empty header** | A column has no name | Name it, or delete the column |
| **Row 12 has 6 values but the header defines 5 columns** | A stray value past the last column | Check row 12 for an extra comma or cell |
| **The CSV file ends inside a quoted value** | An unclosed `"` somewhere | Look for a lone quote mark; re-export from your spreadsheet if unsure |
| **The workbook has no worksheet named "X"** | Sheet name typo — the message lists the real ones | Use one of the names shown |
| **The value for "X" is not one of the options** | A PDF dropdown only accepts certain answers | Make the cell match one of the allowed options exactly |
| **Encrypted or password-protected PDFs are not supported** | The template is locked | Remove the password, then use it as a template |
| **The value for "X" is too long for that field** | A PDF form field is too small for the data, and a form field hides what does not fit | Widen the field in the template, tick multiline so it wraps, or shorten the value |
| **The text was shrunk to fit these form fields** | The values fitted, but only at a smaller size | Nothing is missing; widen those fields in the template so the documents read evenly |
| **This text cannot be written to a PDF with the built-in fonts** | A name or value uses characters outside the Western European set | Generate DOCX for that batch and convert with Word, or correct the cell if it is a stray character |
| **This template uses tables, images, … which cannot be carried into a re-typeset PDF** | PDF output re-lays the text and cannot reproduce those | Move the content into ordinary paragraphs, or keep DOCX output |
| **Refusing to overwrite an existing file** | Output already exists | Use a new folder, or add `--force` |
| **A ZIP this large may fail to save** | The batch is too big for an in-memory download | Use *Save to folder* / *Save as ZIP*, or the command line |

Error messages deliberately name the **row and the field** but never the value,
so they are safe to screenshot or paste into a support ticket.

---

## Handling personal data responsibly

Doclyst is built for sensitive data and does what it can on its side: nothing
is uploaded, nothing is retained, output is readable only by you, and template
authorship metadata is stripped from every document. The details are in
[PRIVACY.md](./PRIVACY.md).

> Doclyst is **not** a compliance product. It supports responsible handling of
> personal data; it does not make you PDPA-compliant. That depends on your
> policies, your basis for processing, and what you do with the documents.

The rest is down to how you use it. A short checklist:

- **Only include the columns you actually need.** If the letter does not
  mention NRIC, leave that column out of the spreadsheet entirely.
- **Prefer a staff number to a personal identifier** in filenames.
- **Check one or two documents** before sending anything to anyone.
- **Delete the output** once distributed. Generated documents are a second
  copy of everyone's data, sitting in a folder.
- **Mind where you save.** A synced or backed-up folder copies those documents
  somewhere else, often somewhere with different access rules.
- **Send them carefully.** How you distribute the documents is usually the
  riskiest step, and it is entirely outside this tool.
- **Keep the source spreadsheet somewhere sensible.** It holds everyone's data
  in one file, and its permissions are yours to manage.
