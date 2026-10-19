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
            "items": {
                k: {
                    "response": v.student_response,
                    "correct": v.correct_answer,
                    "is_correct": v.is_correct,
                    "points": v.points_awarded,
                    "max_points": v.max_points,
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
            for cand in ("answer_key_template.csv", "key.csv", "answer_key.csv"):
                if (p / cand).is_file():
                    return cls.from_csv(p / cand)
            csvs = sorted(p.glob("*key*.csv")) or sorted(p.glob("*.csv"))
            if csvs:
                return cls.from_csv(csvs[0])
            for cand in ("key.json", "answer_key.json"):
                if (p / cand).is_file():
                    with open(p / cand, encoding="utf-8") as fh:
                        return cls.from_dict(json.load(fh))
            jsons = sorted(p.glob("*key*.json"))
            if jsons:
                with open(jsons[0], encoding="utf-8") as fh:
                    return cls.from_dict(json.load(fh))
            raise FileNotFoundError(f"No answer key CSV or JSON found in directory {p}")

        if p.suffix.lower() == ".zip" and p.is_file():
            import io
            import zipfile

            with zipfile.ZipFile(p, "r") as zf:
                names = zf.namelist()
                for n in names:
                    base = Path(n).name.lower()
                    if base in ("answer_key_template.csv", "key.csv", "answer_key.csv") or ("key" in base and base.endswith(".csv")):
                        with zf.open(n) as bfh:
                            text = io.TextIOWrapper(bfh, encoding="utf-8", errors="replace").read()
                            return cls.from_csv_text(text, title=Path(n).stem)
                for n in names:
                    base = Path(n).name.lower()
                    if "key" in base and base.endswith(".json"):
                        with zf.open(n) as bfh:
                            return cls.from_dict(json.load(bfh))
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

            norm_ans = ans.strip()
            if norm_ans.upper() == "TRUE":
                norm_ans = "T"
            elif norm_ans.upper() == "FALSE":
                norm_ans = "F"
            elif len(norm_ans) == 1 and norm_ans.isalpha():
                norm_ans = norm_ans.upper()

            is_tf = norm_ans in {"T", "F"}
            is_mcq = len(norm_ans) == 1 and norm_ans.upper() in "ABCDE"
            kind = "tf" if is_tf else ("mcq" if is_mcq else "text")

            items[key_str] = ItemKey(
                key=key_str,
                kind=kind,
                correct_answer=norm_ans,
                points=pts,
                rubric="exact",
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
                pts = float(val.get("points", 1.0))
                kind = val.get("kind", "mcq")
                rubric = val.get("rubric", "exact")
            elif isinstance(val, (str, list)):
                ans = val
                pts = 1.0
                kind = "mcq"
                rubric = "exact"
            else:
                raise AnswerKeyError(f"Invalid answer format for item {key}: {val}")

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

    def __init__(self, key: AnswerKey, layout: Layout):
        self.key = key
        self.layout = layout

    def evaluate_item(
        self,
        key_spec: ItemKey,
        response: str,
        is_blank: bool = False,
        is_multi: bool = False,
    ) -> ItemGrade:
        """Grades a single item based on response and rubric."""
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
                details="Unanswered",
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
                details="Multiple answers filled",
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
            )

        # Handwritten text item evaluation
        cleaned_resp = response.strip()
        correct_ans = key_spec.correct_answer
        is_correct = False

        if key_spec.rubric == "case_insensitive" or key_spec.kind == "text":
            norm_resp = cleaned_resp.upper()
            def is_match_text(resp: str, target: str) -> bool:
                r = resp.strip()
                t = target.upper().strip()
                if r == t:
                    return True
                # Allow minor OCR character noise for long words (e.g. D vs O in MITOCHONORIA)
                if len(t) >= 5 and difflib.SequenceMatcher(None, r, t).ratio() >= 0.85:
                    return True
                return False

            if isinstance(correct_ans, list):
                is_correct = any(is_match_text(norm_resp, c) for c in correct_ans)
            else:
                is_correct = is_match_text(norm_resp, str(correct_ans))
        elif key_spec.rubric == "regex":
            patterns = correct_ans if isinstance(correct_ans, list) else [correct_ans]
            def _safe_re_match(pat: str, text: str) -> bool:
                try:
                    return bool(re.search(str(pat), text, re.IGNORECASE))
                except re.error:
                    return False
            is_correct = any(_safe_re_match(p, cleaned_resp) for p in patterns)
        else:  # exact
            if isinstance(correct_ans, list):
                is_correct = cleaned_resp in correct_ans
            else:
                is_correct = cleaned_resp == str(correct_ans)

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
        )
