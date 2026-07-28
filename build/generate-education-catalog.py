"""Build the free NYSED released-exam catalog used by Boollm Education.

The generated JSON contains links and scoring metadata, not copied exam text.
Run from the repository root with the bundled Codex Python runtime.
"""

from __future__ import annotations

import io
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

import openpyxl
from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src" / "education-official.json"
YEARS = range(2021, 2026)
MONTH_PRIORITY = ("6", "8", "1")
SUBJECTS = {
    "regentsAlgebra": {
        "name": "Regents - Algebra I",
        "page": "https://www.nysedregents.org/algebraone/",
    },
    "regentsGeometry": {
        "name": "Regents - Geometry",
        "page": "https://www.nysedregents.org/geometryre/",
    },
    "regentsEla": {
        "name": "Regents - English Language Arts",
        "page": "https://www.nysedregents.org/hsela/",
    },
    "regentsScience": {
        "name": "Regents - Living Environment",
        "page": "https://www.nysedregents.org/livingenvironment/",
    },
    "regentsHistory": {
        "name": "Regents - U.S. History",
        "page": "https://www.nysedregents.org/us-history-govt/home.html",
    },
}


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href = ""
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            self._href = dict(attrs).get("href") or ""
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href:
            self.links.append((self._href, " ".join(self._text).strip()))
            self._href = ""
            self._text = []


def get_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Boollm education catalog"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def admin_code(href: str) -> tuple[int, str] | None:
    match = re.search(r"/?([168])(\d{2})/", href)
    if not match:
        return None
    year = 2000 + int(match.group(2))
    return year, match.group(1)


def sheet_rows(url: str) -> list[tuple]:
    workbook = openpyxl.load_workbook(io.BytesIO(get_bytes(url)), data_only=True)
    return [tuple(row) for row in workbook.active.iter_rows(values_only=True)]


def scoring_data(url: str) -> tuple[dict[str, int], dict[str, int]]:
    rows = sheet_rows(url)
    header_index = next(
        index for index, row in enumerate(rows)
        if any(str(value or "").strip() == "Question Number" for value in row)
    )
    header = [str(value or "").strip() for value in rows[header_index]]
    question_col = header.index("Question Number")
    key_col = header.index("Scoring Key")
    type_col = header.index("Question Type")
    credit_col = header.index("Credit")
    answers: dict[str, int] = {}
    credits: dict[str, int] = {}
    for row in rows[header_index + 1:]:
        question = row[question_col] if question_col < len(row) else None
        if not isinstance(question, (int, float)):
            continue
        number = str(int(question))
        credit = row[credit_col] if credit_col < len(row) else 0
        credits[number] = int(credit or 0)
        if str(row[type_col] or "").strip().upper() == "MC":
            key = row[key_col]
            if isinstance(key, (int, float)):
                answers[number] = int(key)
    return answers, credits


def conversion_data(url: str) -> dict[str, int]:
    rows = sheet_rows(url)
    result: dict[str, int] = {}
    for row in rows:
        for start in range(0, len(row) - 1, 4):
            raw, scale = row[start:start + 2]
            if isinstance(raw, (int, float)) and isinstance(scale, (int, float)):
                result[str(int(raw))] = int(scale)
    return result


def question_pages(url: str, question_count: int) -> dict[str, int]:
    """Map each numbered question to its first PDF page without copying exam text."""
    reader = PdfReader(io.BytesIO(get_bytes(url)))
    candidates: dict[int, list[int]] = {number: [] for number in range(1, question_count + 1)}
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        for marker in re.finditer(r"(?m)^\s*(\d{1,3})\s+(?=[A-Z])", text):
            number = int(marker.group(1))
            if 1 <= number <= question_count:
                candidates[number].append(page_number)
    resolved: dict[int, int] = {}
    last_page = 1
    for number in range(1, question_count + 1):
        page = next((value for value in candidates[number] if value >= last_page), None)
        if page is not None:
            resolved[number] = page
            last_page = page
    for number in range(1, question_count + 1):
        if number in resolved:
            continue
        previous = next((resolved[value] for value in range(number - 1, 0, -1) if value in resolved), 2)
        following = next((resolved[value] for value in range(number + 1, question_count + 1) if value in resolved), previous)
        resolved[number] = max(previous, min(following, previous + 1))
    pages = {str(number): resolved[number] for number in range(1, question_count + 1)}
    return pages


def choose_administration(links: list[tuple[str, str]], year: int) -> str | None:
    available = {month for href, _ in links if (code := admin_code(href)) and code[0] == year for month in [code[1]]}
    return next((month for month in MONTH_PRIORITY if month in available), None)


def build_subject(subject_id: str, subject: dict[str, str]) -> list[dict]:
    parser = LinkParser()
    parser.feed(get_bytes(subject["page"]).decode("utf-8", errors="replace"))
    links = [(urllib.parse.urljoin(subject["page"], href), text) for href, text in parser.links]
    records: list[dict] = []
    for year in YEARS:
        month = choose_administration(links, year)
        if not month:
            continue
        candidates = [(url, text) for url, text in links if admin_code(url) == (year, month)]
        exam_url = next((
            url for url, text in candidates
            if "regular size" in text.lower() and "examlt" not in url.lower()
            and re.search(r"examw?\.pdf(?:\?|$)", url, re.I)
        ), None)
        key_xlsx = next((url for url, text in candidates if "excel" in text.lower() and re.search(r"-sk(?:-rev)?\.xlsx$", url, re.I)), None)
        key_pdf = next((url for url, text in candidates if "pdf" in text.lower() and re.search(r"-sk(?:-rev)?\.pdf$", url, re.I)), None)
        conversion_xlsx = next((url for url, text in candidates if "excel" in text.lower() and re.search(r"-cc\.xlsx$", url, re.I)), None)
        conversion_pdf = next((url for url, text in candidates if "pdf" in text.lower() and re.search(r"-cc\.pdf$", url, re.I)), None)
        rating_urls = [
            url for url, text in candidates
            if ("rating guide" in text.lower() or re.search(r"-rg[a-z0-9]*\.pdf$", url, re.I))
            and url.lower().endswith(".pdf")
        ]
        if not exam_url or not key_xlsx:
            continue
        answers, credits = scoring_data(key_xlsx)
        scale = conversion_data(conversion_xlsx) if conversion_xlsx else {}
        question_count = max((int(number) for number in credits), default=0)
        pages = question_pages(exam_url, question_count)
        administration = {"1": "January", "6": "June", "8": "August"}[month]
        records.append({
            "id": f"{subject_id}-{year}-{month}",
            "subject": subject_id,
            "name": subject["name"],
            "year": year,
            "administration": administration,
            "label": f"{administration} {year}",
            "examUrl": exam_url,
            "keyUrl": key_pdf or key_xlsx,
            "ratingUrls": list(dict.fromkeys(rating_urls)),
            "conversionUrl": conversion_pdf or conversion_xlsx,
            "answers": answers,
            "credits": credits,
            "scale": scale,
            "questionPages": pages,
            "questionCount": question_count,
            "multipleChoiceCount": len(answers),
            "durationMinutes": 180,
            "sourcePage": subject["page"],
            "attribution": (
                f"From the New York State Education Department. {subject['name']}, "
                f"{administration} {year}. Available from {subject['page']}; "
                "catalog accessed 28 July 2026."
            ),
        })
    return records


def main() -> None:
    exams = [
        exam
        for subject_id, subject in SUBJECTS.items()
        for exam in build_subject(subject_id, subject)
    ]
    payload = {
        "generatedAt": "2026-07-28",
        "termsUrl": "https://www.nysed.gov/terms-of-use",
        "exams": exams,
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(exams)} released exams to {OUTPUT}")


if __name__ == "__main__":
    main()
