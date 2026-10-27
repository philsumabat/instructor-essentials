"""Roster ingestion (CSV) and OMR student-ID matching.

The roster must provide a student identifier and a display name. Header names
are matched case/punctuation-insensitively, so ``Student ID``, ``student_id``
and ``StudentID`` are all accepted; ``Full Name`` may alternatively be built
from ``First Name`` + ``Last Name`` columns.

Decoded OMR IDs use ``?`` for a column with no mark and ``*`` for a column with
multiple marks. Matching escalates from exact → zero-normalised → wildcard
inference → single-digit-error recovery, and flags every non-exact match for
human review.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

ID_ALIASES = {"studentid", "id", "sid", "studentnumber", "studentno", "idnumber", "idno", "learnerid"}
NAME_ALIASES = {"fullname", "name", "studentname", "displayname"}
FIRST_ALIASES = {"firstname", "givenname", "first"}
LAST_ALIASES = {"lastname", "surname", "familyname", "last"}
CLASS_ALIASES = {"class", "offerno", "offer_no", "offer", "section", "course", "subject", "sched", "classsched"}

BLANK = "?"
MULTI = "*"


class RosterError(ValueError):
    pass


def _norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (h or "").lower())


def normalize_student_id(raw: str | None) -> str:
    """Normalizes student identifiers (e.g., '26-1-0142' -> '26100142', '26-1-706' -> '26100706').

    Standardizes hyphenated student numbers (<year>-<sem/campus>-<num>) into 8-digit strings,
    supporting both 2-digit ('26-1-0142') and 4-digit ('2026-1-0142') year prefixes,
    preserving standard IDs when not matching the hyphenated pattern.
    """
    if not raw:
        return ""
    s = str(raw).strip()
    if s == "PENDING" or s.startswith("["):
        return s

    # Pattern: 2 or 4-digit year, 1-digit term/campus, 1-5 digit sequence number with hyphens/dashes/dots
    m = re.match(r"^(?:20)?(\d{2})[\s\-–—.]+(\d)[\s\-–—.]+(\d{1,5})$", s)
    if m:
        year, term, seq = m.groups()
        return f"{year}{term}{int(seq):05d}"

    # Stripped punctuation if contains hyphens/dots
    if re.search(r"[\-–—.]", s):
        cleaned = re.sub(r"[\s\-–—.]+", "", s)
        if re.fullmatch(r"\d{8}", cleaned):
            return cleaned
        if re.fullmatch(r"20\d{8}", cleaned):
            return cleaned[2:]

    # 10-digit format starting with 20 (e.g., 2026100142)
    if re.fullmatch(r"20\d{8}", s):
        return s[2:]

    return s


def normalize_offer_number(raw: str | None) -> str:
    """Normalizes class offer numbers (e.g., 'E-326' -> 'E326', 'Offer No. E-065' -> 'E065')."""
    if not raw:
        return ""
    s = str(raw).strip().upper()
    if s == "PENDING" or s.startswith("["):
        return s
    # Strip common label prefixes
    s = re.sub(r"^(?:OFFER(?:\s*NO\.?)?|SECTION|SEC)[\s#:.-]*", "", s)
    return re.sub(r"[\s\-–—.]+", "", s)



@dataclass(frozen=True)
class Student:
    student_id: str
    full_name: str
    extra: dict = field(default_factory=dict, compare=False, hash=False)

    @property
    def class_offer(self) -> str:
        for k in ("class", "offerno", "offer_no", "offer", "section", "course", "subject"):
            for ek, ev in self.extra.items():
                if _norm_header(ek) == k and ev:
                    return normalize_offer_number(str(ev).strip())
        return ""


@dataclass(frozen=True)
class RosterMatch:
    status: str  # exact | normalized | inferred | probable | ambiguous | unmatched | no_roster
    decoded_id: str
    student: Student | None = None
    candidates: tuple[Student, ...] = ()
    note: str = ""

    @property
    def matched(self) -> bool:
        return self.student is not None

    @property
    def needs_review(self) -> bool:
        return self.status not in {"exact", "normalized"}

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "decoded_id": self.decoded_id,
            "student_id": self.student.student_id if self.student else None,
            "full_name": self.student.full_name if self.student else None,
            "candidates": [c.student_id for c in self.candidates],
            "needs_review": self.needs_review,
            "note": self.note,
        }


class Roster:
    def __init__(self, students: Iterable[Student], source: str | None = None):
        self.source = source
        self.warnings: list[str] = []
        self._by_id: dict[str, Student] = {}
        for s in students:
            if s.student_id in self._by_id:
                self.warnings.append(f"Duplicate student ID {s.student_id!r} ({self._by_id[s.student_id].full_name} / {s.full_name}); keeping the first")
                continue
            self._by_id[s.student_id] = s
        self._by_stripped: dict[str, list[Student]] = {}
        for s in self._by_id.values():
            self._by_stripped.setdefault(s.student_id.lstrip("0") or "0", []).append(s)

    # ---- container protocol ------------------------------------------------
    def __len__(self) -> int:
        return len(self._by_id)

    def __iter__(self) -> Iterator[Student]:
        return iter(self._by_id.values())

    def __contains__(self, student_id: str) -> bool:
        return student_id in self._by_id

    def get(self, student_id: str) -> Student | None:
        return self._by_id.get(student_id)

    # ---- loading -------------------------------------------------------------
    @classmethod
    def load(cls, path: str | Path) -> "Roster":
        path = Path(path)
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                with open(path, newline="", encoding=enc) as fh:
                    sample = fh.read(4096)
                    fh.seek(0)
                    try:
                        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
                    except csv.Error:
                        dialect = csv.excel
                    reader = csv.DictReader(fh, dialect=dialect)
                    return cls.from_rows(reader, reader.fieldnames or [], source=str(path))
            except UnicodeDecodeError:
                continue

        with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
            sample = fh.read(4096)
            fh.seek(0)
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
            except csv.Error:
                dialect = csv.excel
            reader = csv.DictReader(fh, dialect=dialect)
            return cls.from_rows(reader, reader.fieldnames or [], source=str(path))

    @classmethod
    def from_rows(cls, rows: Iterable[dict], fieldnames: list[str], source: str | None = None) -> "Roster":
        normalized = {_norm_header(h): h for h in fieldnames if h}
        id_col = next((normalized[a] for a in normalized if a in ID_ALIASES), None)
        name_col = next((normalized[a] for a in normalized if a in NAME_ALIASES), None)
        first_col = next((normalized[a] for a in normalized if a in FIRST_ALIASES), None)
        last_col = next((normalized[a] for a in normalized if a in LAST_ALIASES), None)
        if id_col is None:
            raise RosterError(f"Roster has no student ID column (headers: {fieldnames}); expected e.g. 'Student ID'")
        if name_col is None and not (first_col and last_col):
            raise RosterError(f"Roster has no name column (headers: {fieldnames}); expected 'Full Name' or 'First Name'+'Last Name'")

        students: list[Student] = []
        problems: list[str] = []
        for line_no, row in enumerate(rows, start=2):
            raw_sid = (row.get(id_col) or "").strip()
            sid = normalize_student_id(raw_sid)
            if name_col:
                name = (row.get(name_col) or "").strip()
            else:
                name = f"{(row.get(first_col) or '').strip()} {(row.get(last_col) or '').strip()}".strip()
            if not sid and not name:
                continue  # blank line
            if not sid:
                problems.append(f"line {line_no}: missing student ID for {name!r}")
                continue
            if re.fullmatch(r"\d+(\.0+)?", sid) and "." in sid:
                sid = sid.split(".")[0]  # spreadsheet float artefact "20231234.0"
            extra = {k: v for k, v in row.items() if k not in {id_col, name_col, first_col, last_col} and k}
            students.append(Student(sid, name or sid, extra))
        roster = cls(students, source=source)
        roster.warnings[:0] = problems
        non_numeric = [s.student_id for s in roster if not s.student_id.isdigit()]
        if non_numeric:
            roster.warnings.append(f"{len(non_numeric)} roster ID(s) are not purely numeric and can never match an OMR bubble ID (e.g. {non_numeric[0]!r})")
        return roster

    def validate_against(self, id_digits: int) -> list[str]:
        """Warn about roster IDs that cannot be encoded on a sheet with ``id_digits`` columns."""
        too_long = [s.student_id for s in self if len(s.student_id) > id_digits]
        return [f"{len(too_long)} roster ID(s) exceed the sheet's {id_digits} ID columns (e.g. {too_long[0]!r})"] if too_long else []

    # ---- matching --------------------------------------------------------------
    def match(self, decoded_id: str) -> RosterMatch:
        decoded = decoded_id or ""
        norm_decoded = normalize_student_id(decoded)
        if not norm_decoded or set(norm_decoded) <= {BLANK}:
            return RosterMatch("unmatched", decoded, note="no student ID bubbles were filled")

        # 1. Exact match (full decoded or normalized)
        for cand in (norm_decoded, decoded):
            if cand.isdigit() and cand in self._by_id:
                return RosterMatch("exact", decoded, self._by_id[cand], note="" if cand == decoded else "matched via normalized student ID")

        # 2. Leading zero normalisation
        for cand in (norm_decoded, decoded):
            if cand.isdigit():
                hits = self._by_stripped.get(cand.lstrip("0") or "0", [])
                if len(hits) == 1:
                    return RosterMatch("normalized", decoded, hits[0], note="matched after removing leading zeros")

        # 3. Tolerating unused leading/trailing columns for short IDs
        for cand in (decoded.lstrip(BLANK), decoded.rstrip(BLANK), norm_decoded.lstrip(BLANK), norm_decoded.rstrip(BLANK)):
            if cand and cand.isdigit() and cand in self._by_id:
                return RosterMatch("exact", decoded, self._by_id[cand], note="unused ID columns ignored")

        # 4. Wildcard inference for blank / multi-marked columns
        patterns_to_test = [decoded]
        trimmed = decoded.strip(BLANK)
        if trimmed and trimmed != decoded:
            patterns_to_test.append(trimmed)

        for pat_str in patterns_to_test:
            if BLANK in pat_str or MULTI in pat_str:
                regex_str = "^" + "".join(r"\d" if ch in (BLANK, MULTI) else re.escape(ch) for ch in pat_str) + "$"
                pattern = re.compile(regex_str)
                hits = tuple(s for s in self if pattern.match(s.student_id))
                if len(hits) == 1:
                    return RosterMatch("inferred", decoded, hits[0], hits, note="unreadable ID column(s) inferred from roster")
                if len(hits) > 1:
                    return RosterMatch("ambiguous", decoded, None, hits[:10], note=f"{len(hits)} roster IDs fit the partial ID")

        if BLANK in decoded or MULTI in decoded:
            # Fallback: wildcard pattern with at most 1 mismatch among known characters
            candidates_with_noise: list[tuple[int, int, Student]] = []
            cand_patterns = [decoded]
            if trimmed != decoded:
                cand_patterns.append(trimmed)

            for target_pat in cand_patterns:
                for s in self:
                    if len(s.student_id) == len(target_pat):
                        mismatches = sum(
                            1 for a, b in zip(s.student_id, target_pat) if b not in (BLANK, MULTI) and a != b
                        )
                        matching_known = sum(
                            1 for a, b in zip(s.student_id, target_pat) if b not in (BLANK, MULTI) and a == b
                        )
                        if mismatches <= 1 and matching_known >= 2:
                            candidates_with_noise.append((mismatches, -matching_known, s))

            if len(candidates_with_noise) == 1:
                return RosterMatch("inferred", decoded, candidates_with_noise[0][2], note="inferred with 1-character OCR recovery")
            elif candidates_with_noise:
                candidates_with_noise.sort(key=lambda t: (t[0], t[1]))
                best_diff, best_match, best_student = candidates_with_noise[0]
                if len(candidates_with_noise) == 1 or candidates_with_noise[1][0] > best_diff:
                    return RosterMatch("inferred", decoded, best_student, note="inferred with 1-character OCR recovery")
            return RosterMatch("unmatched", decoded, note="no roster ID fits the partial ID")

        # 4. single mis-bubbled digit (Hamming distance 1 among equal-length IDs)
        near = tuple(s for s in self if len(s.student_id) == len(trimmed) and sum(a != b for a, b in zip(s.student_id, trimmed)) == 1)
        if len(near) == 1:
            return RosterMatch("probable", decoded, near[0], near, note="one ID digit differs from the roster")
        if near:
            return RosterMatch("ambiguous", decoded, None, near[:10], note="several roster IDs differ by one digit")
        return RosterMatch("unmatched", decoded, note="ID not found in roster")
