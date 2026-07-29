"""Render each released NYSED question as a compact image card.

The official PDF remains the source of truth. This build-time helper crops the
question region from its mapped source page so equations, diagrams, and layout
stay intact without shipping OCR-derived question text.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import tempfile
import urllib.request
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageChops
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "src" / "education-official.json"
OUTPUT = ROOT / "assets" / "education-cards"
PDFTOPPM = (
    Path.home()
    / ".cache"
    / "codex-runtimes"
    / "codex-primary-runtime"
    / "dependencies"
    / "native"
    / "poppler"
    / "Library"
    / "bin"
    / "pdftoppm.exe"
)
RENDER_DPI = 132


def trim_question(card: Image.Image) -> Image.Image:
    """Remove page-footer whitespace while preserving the complete question."""
    gray = card.convert("L")
    ink = ImageChops.invert(gray).point(lambda value: 255 if value > 22 else 0)
    rows = []
    for y in range(ink.height):
        rows.append(ink.crop((0, y, ink.width, y + 1)).getbbox() is not None)
    last_ink = 0
    blank_start = None
    for y, occupied in enumerate(rows):
        if occupied:
            last_ink = y
            blank_start = None
        elif blank_start is None:
            blank_start = y
        elif y - blank_start >= 70 and blank_start > 90:
            # A footer after a large blank area is not part of the question.
            return card.crop((0, 0, card.width, min(card.height, blank_start + 16)))
    return card.crop((0, 0, card.width, min(card.height, last_ink + 22)))


def get_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Boolean education card builder"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def question_positions(reader: PdfReader, question_pages: dict[str, int]) -> dict[int, float]:
    positions: dict[int, float] = {}
    for number_text, page_number in question_pages.items():
        number = int(number_text)
        page = reader.pages[page_number - 1]
        candidates: list[tuple[float, float]] = []

        def visit(text, _cm, tm, _font, size):
            if text.strip() == number_text and tm[4] < 120 and 35 < tm[5] < float(page.mediabox.height) - 30:
                candidates.append((tm[5], size))

        page.extract_text(visitor_text=visit)
        if candidates:
            positions[number] = max(candidates, key=lambda value: (value[1], value[0]))[0]
    return positions


def interpolated_y(number: int, page_numbers: list[int], positions: dict[int, float], page_height: float) -> float:
    if number in positions:
        return positions[number]
    index = page_numbers.index(number)
    before = next((value for value in reversed(page_numbers[:index]) if value in positions), None)
    after = next((value for value in page_numbers[index + 1 :] if value in positions), None)
    if before is not None and after is not None:
        span = page_numbers.index(after) - page_numbers.index(before)
        offset = index - page_numbers.index(before)
        return positions[before] + (positions[after] - positions[before]) * offset / span
    if before is not None:
        return max(60.0, positions[before] - 115.0 * (index - page_numbers.index(before)))
    if after is not None:
        return min(page_height - 55.0, positions[after] + 115.0 * (page_numbers.index(after) - index))
    usable = page_height - 110.0
    return page_height - 55.0 - usable * index / max(1, len(page_numbers))


def render_exam(exam: dict, work: Path) -> int:
    pdf_bytes = get_bytes(exam["examUrl"])
    reader = PdfReader(io.BytesIO(pdf_bytes))
    question_pages = {str(key): int(value) for key, value in exam["questionPages"].items()}
    positions = question_positions(reader, question_pages)
    pdf_path = work / f"{exam['id']}.pdf"
    pdf_path.write_bytes(pdf_bytes)
    prefix = work / exam["id"]
    subprocess.run(
        [str(PDFTOPPM), "-jpeg", "-r", str(RENDER_DPI), "-jpegopt", "quality=88", str(pdf_path), str(prefix)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    by_page: dict[int, list[int]] = defaultdict(list)
    for number_text, page_number in question_pages.items():
        by_page[page_number].append(int(number_text))
    exam_output = OUTPUT / exam["id"]
    exam_output.mkdir(parents=True, exist_ok=True)
    scale = RENDER_DPI / 72.0
    written = 0
    for page_number, numbers in sorted(by_page.items()):
        numbers.sort()
        image_path = Path(f"{prefix}-{page_number:02d}.jpg")
        if not image_path.exists():
            image_path = Path(f"{prefix}-{page_number}.jpg")
        with Image.open(image_path) as source:
            page_height = float(reader.pages[page_number - 1].mediabox.height)
            y_values = {number: interpolated_y(number, numbers, positions, page_height) for number in numbers}
            for index, number in enumerate(numbers):
                top = max(0, round((page_height - y_values[number] - 20) * scale))
                if index + 1 < len(numbers):
                    next_number = numbers[index + 1]
                    bottom = min(source.height, round((page_height - y_values[next_number] - 20) * scale))
                else:
                    bottom = min(source.height, round((page_height - 38) * scale))
                if bottom - top < 115:
                    bottom = min(source.height, top + 240)
                left = max(0, round(34 * scale))
                right = min(source.width, round((float(reader.pages[page_number - 1].mediabox.width) - 34) * scale))
                card = trim_question(source.crop((left, top, right, bottom)).convert("RGB"))
                if card.width > 1100:
                    height = round(card.height * 1100 / card.width)
                    card = card.resize((1100, max(1, height)), Image.Resampling.LANCZOS)
                card.save(exam_output / f"{number}.webp", "WEBP", quality=84, method=6)
                written += 1
    return written


def main() -> None:
    if not PDFTOPPM.exists():
        raise SystemExit(f"pdftoppm not found: {PDFTOPPM}")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    shutil.rmtree(OUTPUT, ignore_errors=True)
    OUTPUT.mkdir(parents=True)
    total = 0
    with tempfile.TemporaryDirectory(prefix="boollm-education-") as temp:
        work = Path(temp)
        for exam in catalog["exams"]:
            count = render_exam(exam, work)
            total += count
            print(f"{exam['id']}: {count} cards")
    print(f"Wrote {total} official question cards to {OUTPUT}")


if __name__ == "__main__":
    main()
