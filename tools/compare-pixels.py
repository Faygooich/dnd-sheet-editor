"""Compare ref_<name>.pdf against web_<name>.pdf page by page, pixel by pixel.

usage:  python compare-pixels.py <work-dir>

Photo boxes whose source the browser genuinely cannot reach (an absolute path
on someone's disk, which is meaningless in a browser) are masked out: that
difference is expected and documented in the README. Everything else must
match.

Writes diff_<name>_<page>.png for any page that differs, with the difference
amplified 6x so it is actually visible.
"""
import json
import os
import sys

import fitz
from PIL import Image, ImageChops, ImageDraw

WORK = os.path.abspath(sys.argv[1])
CASES = ("tpl", "karbon", "karbon_lp")

ZOOM = 2.0                 # render at 144 dpi
NOISE_THRESHOLD = 24       # below this is antialiasing, not a real difference
FAIL_FRACTION = 0.05       # percent of the page allowed to differ


def unreachable_photos(case_path):
    """Photo fields whose image a browser cannot load."""
    with open(case_path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = []
    for field in data["fields"]:
        if field["field_type"] not in ("photo_user", "photo_static"):
            continue
        src = (field["static_image_path"] if field["field_type"] == "photo_static"
               else data["values"].get(field["name"], ""))
        if src and "assets/" not in src.replace("\\", "/") and not src.startswith("data:"):
            out.append(field)
    return out


def render(doc, index):
    pm = doc[index].get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)
    return Image.frombytes("RGB", (pm.width, pm.height), pm.samples).convert("L")


ok = True

for name in CASES:
    ref_path = os.path.join(WORK, f"ref_{name}.pdf")
    web_path = os.path.join(WORK, f"web_{name}.pdf")
    if not (os.path.exists(ref_path) and os.path.exists(web_path)):
        print(f"\n== {name}: ПРОПУЩЕН (нет обоих PDF)")
        continue

    masked = unreachable_photos(os.path.join(WORK, f"case_{name}.ddsg"))
    ref, web = fitz.open(ref_path), fitz.open(web_path)
    print(f"\n== {name}: Act 3 {len(ref)} стр., веб {len(web)} стр."
          f"  (маскируем недостижимых фото: {len(masked)})")

    if len(ref) != len(web):
        print("   РАЗНОЕ ЧИСЛО СТРАНИЦ")
        ok = False
        continue

    for i in range(len(ref)):
        a, b = render(ref, i), render(web, i)
        if a.size != b.size:
            print(f"   стр. {i}: РАЗНЫЙ РАЗМЕР {a.size} vs {b.size}")
            ok = False
            continue

        diff = ImageChops.difference(a, b)
        draw = ImageDraw.Draw(diff)
        for f in masked:
            draw.rectangle(
                [f["x"] * ZOOM - 2, f["y"] * ZOOM - 2,
                 (f["x"] + f["width"]) * ZOOM + 2, (f["y"] + f["height"]) * ZOOM + 2],
                fill=0)

        hist = diff.histogram()
        differing = sum(hist[NOISE_THRESHOLD:])
        total = a.size[0] * a.size[1]
        pct = 100.0 * differing / total

        if differing == 0:
            verdict = "ИДЕНТИЧНО"
        elif pct < FAIL_FRACTION:
            verdict = "почти идентично"
        else:
            verdict = "РАСХОЖДЕНИЕ"
            ok = False

        print(f"   стр. {i}: отличается {differing} px ({pct:.4f}%)"
              f"  макс>96: {sum(hist[96:])}  -> {verdict}")

        if differing:
            diff.point(lambda v: min(255, v * 6)).save(
                os.path.join(WORK, f"diff_{name}_{i}.png"))

print("\nИТОГ:", "СОВПАДАЕТ" if ok else "ЕСТЬ РАСХОЖДЕНИЯ — смотрите diff_*.png")
sys.exit(0 if ok else 1)
