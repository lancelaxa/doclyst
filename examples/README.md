# Examples

Sample files for trying Doclyst. **Everyone here is invented** — no real
personal data appears in this repository.

```bash
node examples/make-example.mjs      # writes offer-letter.docx next to staff.csv
```

- `staff.csv` — four synthetic staff records.
- `make-example.mjs` — writes `offer-letter.docx`, a Word template using
  `{{FULL_NAME}}`, `{{JOB_TITLE}}`, `{{BASIC_SALARY}}`, `{{START_DATE}}` and
  `{{STAFF_ID}}`.

The template is generated rather than committed so the repository contains no
opaque binary files. See [../GUIDE.md](../GUIDE.md) for the walkthrough.
