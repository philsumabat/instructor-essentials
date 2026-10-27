"""Grading Engine.

Evaluates parsed OMR bubble selections and OCR handwritten strings against
a JSON answer key. Computes item-level scores, accuracy, points, and maps
results to student identities from the roster.
"""
from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omr.layout import Layout
from omr.ocr import OCRResult
from omr.roster import RosterMatch, Student
from omr.vision import GroupResult


class AnswerKeyError(ValueError):
    pass


@dataclass(frozen=True)
class ItemKey:
    """Expected answer specification for a single question."""

    key: str
    kind: str  # "mcq", "tf", "text"
    correct_answer: str | list[str]  # e.g. "A", ["MITOCHONDRIA", "MITOCHONDRION"]
    points: float = 1.0
    rubric: str = "exact"  # "exact", "case_insensitive", "regex"


@dataclass(frozen=True)
class ItemGrade:
    """Grading evaluation for a single item."""

    key: str
    kind: str
    student_response: str
    correct_answer: str | list[str]
    is_correct: bool
    points_awarded: float
    max_points: float
    is_blank: bool
    is_multi: bool
    details: str = ""
    feedback_badge: str = ""  # "incorrect", "accepted_variant", or ""
    feedback_text: str = ""


@dataclass
class ExamGrade:
    """Complete grading outcome for an individual student exam."""

    exam_id: str
    decoded_sid: str
    roster_match: RosterMatch
    items: dict[str, ItemGrade]
    score: float = 0.0
    max_score: float = 0.0
    percentage: float = 0.0
    bubble_results: dict[str, GroupResult] = field(default_factory=dict, repr=False)
    ocr_results: dict[str, OCRResult] = field(default_factory=dict, repr=False)
    is_duplicate: bool = False
    duplicate_note: str = ""
    review_notes: list[str] = field(default_factory=list)

    @property
    def student_name(self) -> str:
        if self.roster_match.student:
            return self.roster_match.student.full_name
        return "Unknown Student"

    @property
    def student_id(self) -> str:
        if self.roster_match.student:
            return self.roster_match.student.student_id
        return self.decoded_sid

    def to_dict(self) -> dict[str, Any]:
        return {
            "exam_id": self.exam_id,
            "student_id": self.student_id,
            "student_name": self.student_name,
            "roster_match": self.roster_match.to_dict(),
            "score": round(self.score, 2),
            "max_score": round(self.max_score, 2),
            "percentage": round(self.percentage, 2),
            "is_duplicate": self.is_duplicate,
            "duplicate_note": self.duplicate_note,
            "review_notes": list(self.review_notes),
            "items": {
                k: {
                    "response": v.student_response,
                    "correct": v.correct_answer,
                    "is_correct": v.is_correct,
                    "points": v.points_awarded,
                    "max_points": v.max_points,
                    "details": v.details,
                    "feedback_badge": v.feedback_badge,
                    "feedback_text": v.feedback_text,
                }
                for k, v in self.items.items()
            },
        }


class AnswerKey:
    """Container for grading answers and rubrics."""

    def __init__(self, items: dict[str, ItemKey], title: str = ""):
        self.items = items
        self.title = title

    @property
    def total_points(self) -> float:
        return sum(item.points for item in self.items.values())

    @classmethod
    def load(cls, path: str | Path) -> "AnswerKey":
        p = Path(path)
        if p.is_dir():
            for cand in ("answer_key.csv", "key.csv", "answer_key.json", "key.json", "answer_key_template.csv"):
                if (p / cand).is_file():
                    if cand.endswith(".json"):
                        with open(p / cand, encoding="utf-8") as fh:
                            return cls.from_dict(json.load(fh))
                    return cls.from_csv(p / cand)
            csvs = [f for f in sorted(p.glob("*key*.csv")) if f.name.lower() != "answer_key_template.csv"]
            if csvs:
                return cls.from_csv(csvs[0])
            jsons = sorted(p.glob("*key*.json"))
            if jsons:
                with open(jsons[0], encoding="utf-8") as fh:
                    return cls.from_dict(json.load(fh))
            other_csvs = sorted(p.glob("*.csv"))
            if other_csvs:
                return cls.from_csv(other_csvs[0])
            raise FileNotFoundError(f"No answer key CSV or JSON found in directory {p}")

        if p.suffix.lower() == ".zip" and p.is_file():
            import io
            import zipfile

            with zipfile.ZipFile(p, "r") as zf:
                names = zf.namelist()
                # 1. Exact priority files (actual keys before templates)
                for cand in ("answer_key.csv", "key.csv", "answer_key.json", "key.json"):
                    for n in names:
                        if Path(n).name.lower() == cand:
                            with zf.open(n) as bfh:
                                if cand.endswith(".json"):
                                    return cls.from_dict(json.load(bfh))
                                text = io.TextIOWrapper(bfh, encoding="utf-8", errors="replace").read()
                                return cls.from_csv_text(text, title=Path(n).stem)
                # 2. Key patterns (excluding template)
                for n in names:
                    base = Path(n).name.lower()
                    if "key" in base and base.endswith(".csv") and base != "answer_key_template.csv":
                        with zf.open(n) as bfh:
                            text = io.TextIOWrapper(bfh, encoding="utf-8", errors="replace").read()
                            return cls.from_csv_text(text, title=Path(n).stem)
                for n in names:
                    base = Path(n).name.lower()
                    if "key" in base and base.endswith(".json"):
                        with zf.open(n) as bfh:
                            return cls.from_dict(json.load(bfh))
                # 3. Fallback to answer_key_template.csv
                for n in names:
                    if Path(n).name.lower() == "answer_key_template.csv":
                        with zf.open(n) as bfh:
                            text = io.TextIOWrapper(bfh, encoding="utf-8", errors="replace").read()
                            return cls.from_csv_text(text, title=Path(n).stem)
                raise FileNotFoundError(f"No answer key CSV or JSON found in zip package {p}")

        if p.suffix.lower() == ".csv":
            return cls.from_csv(p)
        with open(p, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    @classmethod
    def from_csv_text(cls, csv_text: str, title: str = "") -> "AnswerKey":
        import csv
        import io

        items: dict[str, ItemKey] = {}
        fh = io.StringIO(csv_text)
        reader = csv.reader(fh)
        header = next(reader, None)
        if not header:
            raise AnswerKeyError("Answer key CSV is empty")
        h_lower = [col.strip().lower() for col in header]

        item_col = -1
        for idx, col in enumerate(h_lower):
            if any(k in col for k in ("item", "question", "#")):
                item_col = idx
                break

        ans_col = -1
        for idx, col in enumerate(h_lower):
            if any(k in col for k in ("answer", "key")):
                ans_col = idx
                break
        if ans_col == -1:
            ans_col = 1 if len(h_lower) > 1 else 0

        pts_col = -1
        for idx, col in enumerate(h_lower):
            if any(k in col for k in ("point", "pts", "score")):
                pts_col = idx
                break

        kind_col = -1
        for idx, col in enumerate(h_lower):
            if any(k in col for k in ("kind", "type")):
                kind_col = idx
                break

        rubric_col = -1
        for idx, col in enumerate(h_lower):
            if any(k in col for k in ("rubric", "mode")):
                rubric_col = idx
                break

        row_idx = 1
        for row in reader:
            if not row or not any(cell.strip() for cell in row):
                continue
            key_str = row[item_col].strip() if item_col != -1 and item_col < len(row) else str(row_idx)
            if not key_str:
                key_str = str(row_idx)
            ans = row[ans_col].strip() if ans_col < len(row) else ""
            pts = 1.0
            if pts_col != -1 and pts_col < len(row):
                try:
                    pts = float(row[pts_col].strip())
                except ValueError:
                    pts = 1.0

            raw_kind = row[kind_col].strip().lower() if kind_col != -1 and kind_col < len(row) else ""
            raw_rubric = row[rubric_col].strip() if rubric_col != -1 and rubric_col < len(row) else ""

            norm_ans = ans.strip()
            if norm_ans.upper() == "TRUE":
                norm_ans = "T"
            elif norm_ans.upper() == "FALSE":
                norm_ans = "F"
            elif len(norm_ans) == 1 and norm_ans.isalpha():
                norm_ans = norm_ans.upper()

            is_tf = norm_ans in {"T", "F"}
            is_mcq = len(norm_ans) == 1 and norm_ans.upper() in "ABCDE"
            if raw_kind:
                if any(k in raw_kind for k in ("text", "short", "essay")):
                    kind = "text"
                elif any(k in raw_kind for k in ("tf", "true")):
                    kind = "tf"
                elif any(k in raw_kind for k in ("mcq", "choice")):
                    kind = "mcq"
                else:
                    kind = "tf" if is_tf else ("mcq" if is_mcq else "text")
            else:
                kind = "tf" if is_tf else ("mcq" if is_mcq else "text")

            rubric = raw_rubric or ("case_insensitive" if kind == "text" else "exact")

            items[key_str] = ItemKey(
                key=key_str,
                kind=kind,
                correct_answer=norm_ans,
                points=pts,
                rubric=rubric,
            )
            row_idx += 1
        return cls(items, title=title)

    @classmethod
    def from_csv(cls, path: str | Path) -> "AnswerKey":
        p = Path(path)
        with open(p, encoding="utf-8", errors="replace") as fh:
            return cls.from_csv_text(fh.read(), title=p.stem)

    @classmethod
    def from_dict(cls, data: dict) -> "AnswerKey":
        title = data.get("title", "")
        raw_items = data.get("items", {})
        if not isinstance(raw_items, dict):
            raise AnswerKeyError("Answer key 'items' must be a JSON object mapping item key to answer.")

        parsed_items: dict[str, ItemKey] = {}
        for key, val in raw_items.items():
            if isinstance(val, dict):
                ans = val.get("answer")
                raw_pts = val.get("points")
                try:
                    pts = float(raw_pts) if raw_pts is not None else 1.0
                except (ValueError, TypeError):
                    pts = 1.0
                raw_kind = str(val.get("kind") or "").strip().lower()
                raw_rubric = val.get("rubric")
            elif isinstance(val, (str, list)):
                ans = val
                pts = 1.0
                raw_kind = ""
                raw_rubric = None
            else:
                raise AnswerKeyError(f"Invalid answer format for item {key}: {val}")

            if isinstance(ans, str):
                norm_ans = ans.strip()
                if norm_ans.upper() == "TRUE":
                    norm_ans = "T"
                elif norm_ans.upper() == "FALSE":
                    norm_ans = "F"
                ans = norm_ans
                is_tf = norm_ans in {"T", "F"}
                is_mcq = len(norm_ans) == 1 and norm_ans.upper() in "ABCDE"
            else:
                is_tf = False
                is_mcq = False

            if raw_kind:
                if any(k in raw_kind for k in ("text", "short", "essay")):
                    kind = "text"
                elif any(k in raw_kind for k in ("tf", "true")):
                    kind = "tf"
                elif any(k in raw_kind for k in ("mcq", "choice")):
                    kind = "mcq"
                else:
                    kind = "tf" if is_tf else ("mcq" if is_mcq else "text")
            else:
                kind = "tf" if is_tf else ("mcq" if is_mcq else "text")

            rubric = raw_rubric or ("case_insensitive" if kind == "text" else "exact")

            parsed_items[str(key)] = ItemKey(
                key=str(key),
                kind=kind,
                correct_answer=ans,
                points=pts,
                rubric=rubric,
            )
        return cls(parsed_items, title=title)


class GradingEngine:
    """Evaluates student exam responses against an answer key."""

    def __init__(self, key: AnswerKey, layout: Layout | None = None):
        self.key = key
        self.layout = layout

    def evaluate_item(
        self,
        key_spec: ItemKey,
        response: str,
        is_blank: bool = False,
        is_multi: bool = False,
        review_reason: str = "",
        crop: np.ndarray | None = None,
        enforce_underline: bool = False,
    ) -> ItemGrade:
        """Grades a single item based on response, rubric, and optional handwriting crop."""
        if key_spec.points == 0.0 and not key_spec.correct_answer:
            return ItemGrade(
                key=key_spec.key,
                kind=key_spec.kind,
                student_response=response.strip() if response not in {"?", ""} else "",
                correct_answer="",
                is_correct=True,
                points_awarded=0.0,
                max_points=0.0,
                is_blank=(is_blank or response in {"?", ""}),
                is_multi=False,
                details="No correction required",
            )

        if is_blank or response in {"?", ""}:
            return ItemGrade(
                key=key_spec.key,
                kind=key_spec.kind,
                student_response="",
                correct_answer=key_spec.correct_answer,
                is_correct=False,
                points_awarded=0.0,
                max_points=key_spec.points,
                is_blank=True,
                is_multi=False,
                details=review_reason or "Unanswered",
            )

        if is_multi or response == "*":
            return ItemGrade(
                key=key_spec.key,
                kind=key_spec.kind,
                student_response="*",
                correct_answer=key_spec.correct_answer,
                is_correct=False,
                points_awarded=0.0,
                max_points=key_spec.points,
                is_blank=False,
                is_multi=True,
                details=review_reason or "Multiple answers filled",
            )

        # Standard MCQ/TF evaluation
        if key_spec.kind in {"mcq", "tf"}:
            correct = key_spec.correct_answer
            is_match = False
            if isinstance(correct, list):
                is_match = response.upper() in [c.upper() for c in correct]
            else:
                is_match = response.upper() == str(correct).upper()

            points = key_spec.points if is_match else 0.0
            return ItemGrade(
                key=key_spec.key,
                kind=key_spec.kind,
                student_response=response,
                correct_answer=key_spec.correct_answer,
                is_correct=is_match,
                points_awarded=points,
                max_points=key_spec.points,
                is_blank=False,
                is_multi=False,
                details=review_reason,
            )

        # Handwritten text item evaluation
        cleaned_resp = response.strip()
        correct_ans = key_spec.correct_answer
        is_correct = False

        # Gather candidate target strings, splitting pipe-delimited alternatives (e.g. "Condenser | Abbe condenser")
        candidates: list[str] = []
        if isinstance(correct_ans, list):
            for c in correct_ans:
                for sub in str(c).split("|"):
                    s = sub.strip()
                    if s:
                        candidates.append(s)
        elif isinstance(correct_ans, str) and "|" in correct_ans:
            candidates = [sub.strip() for sub in correct_ans.split("|") if sub.strip()]
        elif correct_ans is not None and str(correct_ans).strip() != "":
            candidates = [str(correct_ans).strip()]

        f_badge = ""
        f_text = ""
        item_details = review_reason or ""

        if not candidates:
            # Blank expected answer (e.g. 0-point correction ROI for a True statement)
            is_correct = True if key_spec.points == 0.0 else (cleaned_resp == "")
        elif key_spec.rubric == "scientific_name":
            norm_resp = cleaned_resp.upper()
            def is_match_text(resp: str, target: str) -> bool:
                r = resp.strip()
                t = target.upper().strip()
                if not r or not t:
                    return r == t
                if r == t:
                    return True
                if len(t) >= 5 and difflib.SequenceMatcher(None, r, t).ratio() >= 0.85:
                    return True
                return False

            base_match = any(is_match_text(norm_resp, c) for c in candidates)
            valid_cap = bool(cleaned_resp and cleaned_resp[0].isupper())

            has_underline = None
            if crop is not None:
                from omr.vision import detect_underline_stroke
                has_underline = detect_underline_stroke(crop)

            if not base_match:
                is_correct = False
            elif not valid_cap:
                is_correct = False
                item_details = "Scientific name requires a capital first letter (ICN formatting error)"
                f_badge = "incorrect"
                f_text = f"Capitalize: {candidates[0]}"
            elif enforce_underline and has_underline is False:
                is_correct = False
                item_details = "Scientific name must be underlined when handwritten (ICN formatting error)"
                f_badge = "incorrect"
                f_text = f"Underline: {candidates[0]}"
            else:
                is_correct = True
                if has_underline is False:
                    item_details = "Note: Underline stroke was not detected"
        elif key_spec.rubric == "case_insensitive" or key_spec.kind == "text":
            norm_resp = cleaned_resp.upper()
            def is_match_text(resp: str, target: str) -> bool:
                r = resp.strip()
                t = target.upper().strip()
                if not r or not t:
                    return r == t
                if r == t:
                    return True
                # Allow minor OCR character noise for long words (e.g. D vs O in MITOCHONORIA)
                if len(t) >= 5 and difflib.SequenceMatcher(None, r, t).ratio() >= 0.85:
                    return True
                return False

            is_correct = any(is_match_text(norm_resp, c) for c in candidates)
        elif key_spec.rubric == "regex":
            def _safe_re_match(pat: str, text: str) -> bool:
                try:
                    return bool(re.search(str(pat), text, re.IGNORECASE))
                except re.error:
                    return False
            is_correct = any(_safe_re_match(p, cleaned_resp) for p in candidates)
        else:  # exact
            is_correct = any(cleaned_resp == c for c in candidates)

        # Automatic feedback badges
        if not is_correct and key_spec.points > 0:
            canonical = candidates[0] if candidates else ""
            if not f_badge:
                f_badge = "incorrect"
                f_text = canonical if canonical else ""
        elif is_correct and candidates:
            canonical = candidates[0]
            if cleaned_resp.upper() != canonical.upper():
                if not f_badge:
                    f_badge = "accepted_variant"
                    cand_txt = f"{cleaned_resp} -> {canonical}"
                    f_text = cand_txt if len(cand_txt) <= 24 else canonical

        points = key_spec.points if is_correct else 0.0
        return ItemGrade(
            key=key_spec.key,
            kind=key_spec.kind,
            student_response=cleaned_resp,
            correct_answer=key_spec.correct_answer,
            is_correct=is_correct,
            points_awarded=points,
            max_points=key_spec.points,
            is_blank=False,
            is_multi=False,
            details=item_details,
            feedback_badge=f_badge,
            feedback_text=f_text,
        )


    def grade(
        self,
        exam_id: str,
        bubble_results: dict[str, GroupResult],
        ocr_results: dict[str, OCRResult],
        decoded_sid: str,
        roster_match: RosterMatch,
    ) -> ExamGrade:
        """Grades an exam and computes totals."""
        item_grades: dict[str, ItemGrade] = {}
        total_points = 0.0
        max_points = 0.0

        for key, key_spec in self.key.items.items():
            if key_spec.kind in {"mcq", "tf"}:
                grp = bubble_results.get(key)
                if grp:
                    grade = self.evaluate_item(
                        key_spec,
                        grp.resolved_value,
                        is_blank=grp.is_blank,
                        is_multi=grp.is_multi,
                        review_reason=getattr(grp, "review_reason", ""),
                    )
                else:
                    grade = self.evaluate_item(key_spec, "?", is_blank=True)
            else:  # text
                ocr_item = ocr_results.get(key)
                resp_text = ocr_item.text if ocr_item else ""
                grade = self.evaluate_item(key_spec, resp_text, is_blank=not bool(resp_text))

            item_grades[key] = grade
            total_points += grade.points_awarded
            max_points += grade.max_points

        pct = (total_points / max_points * 100.0) if max_points > 0 else 0.0

        review_notes = [
            getattr(grp, "review_reason", "")
            for grp in bubble_results.values()
            if getattr(grp, "review_reason", "")
        ]

        return ExamGrade(
            exam_id=exam_id,
            decoded_sid=decoded_sid,
            roster_match=roster_match,
            items=item_grades,
            score=total_points,
            max_score=max_points,
            percentage=pct,
            bubble_results=bubble_results,
            ocr_results=ocr_results,
            review_notes=review_notes,
        )


def check_scientific_name(
    response: str,
    expected: str | list[str],
    crop: np.ndarray | None = None,
    enforce_underline: bool = False,
) -> dict[str, Any]:
    """Validates student response against botanical scientific name (ICN) conventions:
    - Capital initial letter for genus / scientific name.
    - Underline stroke in handwriting crop (underlining represents italics).
    """
    resp = (response or "").strip()
    issues: list[str] = []

    # 1. Capitalization check
    valid_cap = bool(resp and resp[0].isupper())
    if not valid_cap and resp:
        issues.append("Scientific name must begin with a capital letter (ICN formatting error).")

    # 2. Underline detection on crop (if provided)
    has_underline = None
    if crop is not None:
        from omr.vision import detect_underline_stroke
        has_underline = detect_underline_stroke(crop)
        if not has_underline and enforce_underline:
            issues.append("Scientific name must be underlined when handwritten.")

    # 3. Base name match
    candidates: list[str] = []
    if isinstance(expected, list):
        for e in expected:
            candidates.extend([s.strip() for s in str(e).split("|") if s.strip()])
    else:
        candidates = [s.strip() for s in str(expected).split("|") if s.strip()]

    matched = any(
        resp.upper() == c.upper()
        or (len(c) >= 5 and difflib.SequenceMatcher(None, resp.upper(), c.upper()).ratio() >= 0.85)
        for c in candidates
    )

    is_valid = matched and valid_cap
    if enforce_underline and has_underline is False:
        is_valid = False

    return {
        "is_valid": is_valid,
        "matched_term": matched,
        "valid_capitalization": valid_cap,
        "has_underline": has_underline,
        "issues": issues,
    }
