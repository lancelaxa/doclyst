#!/usr/bin/env python3
"""
Regenerate the XLSX test fixture.

The fixture is produced by openpyxl -- an independent, widely used writer --
rather than by Doclyst's own code, so the parser is validated against a real
producer's output instead of against our own assumptions about the format.

All data is synthetic. Names, staff IDs, salaries and the NRIC-shaped string
are invented for testing and refer to no real person.

Usage:  python3 packages/core/test/fixtures/generate.py
"""
from datetime import date, datetime
from openpyxl import Workbook

wb = Workbook()

ws = wb.active
ws.title = "Staff"
ws.append(["Full Name", "Basic Salary", "Start Date", "Staff ID", "Confirmed", "Notes"])

rows = [
    ("Aisha Rahman",  4500,    date(2026, 1, 15), "EMP-0001", True,  "Joined via referral"),
    ("Wei Lun Tan",   5200.50, date(2026, 2, 1),  "EMP-0002", False, ""),
    ("Priya Nair",    6100,    date(2026, 2, 14), "EMP-0003", True,  "Bold and plain text"),
    ("Zoë Müller",    7000,    datetime(2026, 3, 1, 9, 30), "EMP-0004", True, "=1+1"),
]
for row in rows:
    ws.append(row)

# A sparse row: Excel omits empty cells entirely, so column alignment depends
# on cell references rather than position.
ws["A6"] = "Sparse Row"
ws["D6"] = "EMP-0005"

# A second sheet, to exercise sheet selection.
other = wb.create_sheet("Archive")
other.append(["Full Name", "Staff ID"])
other.append(["Former Person", "EMP-9999"])

wb.save("packages/core/test/fixtures/staff.xlsx")
print("wrote packages/core/test/fixtures/staff.xlsx")
