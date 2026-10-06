"""Export reference PDFs with the desktop Act 3, for pixel comparison.

Driven by compare-export.mjs — see that file for how to run the whole check.

usage:  python export-reference.py <act3-dir> <work-dir>

For each test case this writes two files into <work-dir>:
  case_<name>.ddsg   the exact model the web build must load
  ref_<name>.pdf     Act 3's own export of it

The .ddsg is written back out through to_dict() rather than copied, so both
versions demonstrably start from identical input even when a case overrides
something (such as forcing the longplay page on).
"""
import json
import os
import sys

ACT3 = os.path.abspath(sys.argv[1])
WORK = os.path.abspath(sys.argv[2])

sys.path.insert(0, ACT3)
os.chdir(ACT3)

from core.sheet_model import SheetModel          # noqa: E402
from utils.pdf_utils import export_sheet_to_pdf  # noqa: E402

# name -> (path relative to the Act 3 folder, attribute overrides)
CASES = {
    "tpl": ("assets/themes/default.json", {}),
    "karbon": ("Карбон Циан - Disco&Dragons.ddsg", {}),
    "karbon_lp": ("Карбон Циан - Disco&Dragons.ddsg", {"longplay_enabled": True}),
}

os.makedirs(WORK, exist_ok=True)

for name, (path, overrides) in CASES.items():
    if not os.path.exists(path):
        print(f"{name}: ПРОПУЩЕН (нет файла {path})")
        continue

    model = SheetModel.load(path)
    for key, value in overrides.items():
        setattr(model, key, value)

    with open(os.path.join(WORK, f"case_{name}.ddsg"), "w", encoding="utf-8") as fh:
        json.dump(model.to_dict(), fh, ensure_ascii=False)

    out = os.path.join(WORK, f"ref_{name}.pdf")
    export_sheet_to_pdf(model, out)
    pages = len(list(model.iter_pdf_pages()))
    print(f"{name}: {pages} стр. -> {os.path.getsize(out)} байт")
