"""End-to-End OMR & Grading Pipeline Orchestrator.

Processes batches of scanned exam image files (JPEG, PNG):
1. Normalizes images via ArUco fiducial perspective registration.
2. Decodes student ID and question bubble fill matrices.
3. Maps student ID against CSV roster.
4. Extracts handwritten text answers from ROIs via OCR.
5. Evaluates answers against JSON answer key.
6. Generates annotated feedback JPEGs.
7. Computes cohort psychometrics and generates HTML report.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import cv2
import numpy as np

from omr.annotator import ExamAnnotator
from omr.grading import AnswerKey, ExamGrade, GradingEngine
from omr.layout import Layout
from omr.ocr import OCREngine, ROIExtractor
from omr.pdf import extract_pdf_pages, is_pdf
from omr.report import BatchPsychometrics, PsychometricAnalyzer, ReportGenerator
from omr.roster import Roster
from omr.vision import BubbleScanner, SheetWarper, VisionError


@dataclass
class PipelineResult:
    """Batch execution summary."""

    grades: list[ExamGrade]
    psychometrics: BatchPsychometrics
    output_dir: Path
    annotated_paths: list[Path]
    report_path: Path
    grades_json_path: Path
    failed_scans: list[tuple[str, str]]  # (filename, error_message)


class OMRPipeline:
    """Batch grader orchestrator."""

    def __init__(
        self,
        layout: Layout,
        answer_key: AnswerKey,
        roster: Roster | None = None,
        px_per_mm: float = 10.0,
        ocr_engine: OCREngine | None = None,
    ):
        self.layout = layout
        self.answer_key = answer_key
        self.roster = roster
        self.px_per_mm = px_per_mm

        self.warper = SheetWarper(layout, px_per_mm=px_per_mm)
        self.scanner = BubbleScanner(layout, px_per_mm=px_per_mm)
        self.extractor = ROIExtractor(layout, px_per_mm=px_per_mm, engine=ocr_engine)
        self.grader = GradingEngine(answer_key, layout)
        self.annotator = ExamAnnotator(layout, px_per_mm=px_per_mm)
        self.analyzer = PsychometricAnalyzer(answer_key)
        self.reporter = ReportGenerator()

    def process_image(self, image: np.ndarray, exam_id: str) -> tuple[ExamGrade, np.ndarray]:
        """Processes a single scan image returning its grade and annotated visual."""
        # 1. Perspective rectification
        warp_res = self.warper.warp(image)

        # 2. Bubble reading
        binary = self.scanner.preprocess(warp_res.warped_gray)
        bubble_results, decoded_sid = self.scanner.scan_all(warp_res.warped_gray, binary)

        # In modified T/F, don't scan the write-in box if the statement is true
        skip_ocr_keys: set[str] = set()
        for q_key, b_res in bubble_results.items():
            corr_key = f"{q_key}_corr"
            key_spec = self.answer_key.items.get(q_key)
            is_key_true = False
            if key_spec:
                ans_str = str(key_spec.correct_answer).strip().upper()
                is_key_true = ans_str in {"T", "TRUE"}
            is_student_true = b_res.resolved_value == "T"
            if is_key_true or is_student_true:
                skip_ocr_keys.add(corr_key)

        # 3. Handwritten text OCR
        ocr_results = self.extractor.process_all(warp_res.warped_bgr, skip_keys=skip_ocr_keys)

        # If Student ID uses handwritten digit recognition (shading: false)
        if self.layout.sid_roi and not self.layout.sid_groups:
            sid_item = ocr_results.get(self.layout.sid_roi.key)
            if sid_item and sid_item.text:
                decoded_sid = sid_item.text.strip()

        # 3.5 Sheet Barcode Decoding
        sheet_barcode = ""
        bc_roi = getattr(self.layout, "barcode_roi", None)
        if bc_roi is not None:
            try:
                from omr.barcode import decode_barcode_image

                px_x = int(round(bc_roi.x * self.px_per_mm))
                px_y = int(round(bc_roi.y * self.px_per_mm))
                px_w = int(round(bc_roi.w * self.px_per_mm))
                px_h = int(round(bc_roi.h * self.px_per_mm))

                crop = warp_res.warped_bgr[px_y : px_y + px_h, px_x : px_x + px_w]
                decoded_bc = decode_barcode_image(crop)
                if decoded_bc:
                    sheet_barcode = decoded_bc
            except Exception:
                pass

        # 4. Roster matching
        if self.roster is not None:
            roster_match = self.roster.match(decoded_sid)
        else:
            from omr.roster import RosterMatch

            roster_match = RosterMatch("no_roster", decoded_sid, note="No roster provided")

        # 5. Grading
        grade = self.grader.grade(
            exam_id=exam_id,
            bubble_results=bubble_results,
            ocr_results=ocr_results,
            decoded_sid=decoded_sid,
            roster_match=roster_match,
            sheet_barcode=sheet_barcode,
        )
        if getattr(warp_res, "review_notes", None):
            grade.review_notes = list(warp_res.review_notes) + grade.review_notes

        # 6. Annotation
        annotated_bgr = self.annotator.annotate(warp_res.warped_bgr, grade)

        return grade, annotated_bgr

    def process_file(self, file_path: str | Path) -> tuple[ExamGrade, np.ndarray]:
        """Loads and processes a single image or single-page PDF file."""
        path = Path(file_path)
        if is_pdf(path):
            dpi = max(150.0, self.px_per_mm * 25.4)
            pages = extract_pdf_pages(path, dpi=dpi)
            if not pages:
                raise VisionError(f"No pages extracted from PDF {path}")
            exam_id = path.stem if len(pages) == 1 else pages[0][0]
            return self.process_image(pages[0][1], exam_id=exam_id)

        img = cv2.imread(str(path))
        if img is None:
            raise VisionError(f"Failed to decode image file {path}")
        return self.process_image(img, exam_id=path.stem)

    def process_pdf(
        self,
        pdf_path: str | Path,
        dpi: float | None = None,
    ) -> list[tuple[str, ExamGrade, np.ndarray]]:
        """Processes all pages of a scanned PDF document."""
        path = Path(pdf_path)
        actual_dpi = dpi if dpi is not None else max(150.0, self.px_per_mm * 25.4)
        pages = extract_pdf_pages(path, dpi=actual_dpi)
        results = []
        for page_name, page_img in pages:
            grade, annotated = self.process_image(page_img, exam_id=page_name)
            results.append((page_name, grade, annotated))
        return results

    def process_batch(
        self,
        image_paths: Sequence[str | Path],
        output_dir: str | Path,
    ) -> PipelineResult:
        """Processes an entire batch of exams (images and/or PDFs) and outputs all derivatives."""
        out = Path(output_dir)
        annotated_dir = out / "annotated"
        annotated_dir.mkdir(parents=True, exist_ok=True)

        grades: list[ExamGrade] = []
        annotated_paths: list[Path] = []
        failed: list[tuple[str, str]] = []
        total_scans_attempted = 0

        for p in image_paths:
            path = Path(p)
            if is_pdf(path):
                try:
                    dpi = max(150.0, self.px_per_mm * 25.4)
                    pages = extract_pdf_pages(path, dpi=dpi)
                except Exception as exc:
                    failed.append((path.name, f"Failed to extract PDF: {exc}"))
                    total_scans_attempted += 1
                    continue

                total_scans_attempted += len(pages)
                for page_name, page_img in pages:
                    try:
                        grade, annotated = self.process_image(page_img, exam_id=page_name)
                        save_p = self.annotator.save(annotated, annotated_dir / f"{page_name}_graded.jpg")
                        grades.append(grade)
                        annotated_paths.append(save_p)
                    except Exception as exc:
                        failed.append((page_name, str(exc)))
            else:
                total_scans_attempted += 1
                try:
                    grade, annotated = self.process_file(path)
                    save_p = self.annotator.save(annotated, annotated_dir / f"{path.stem}_graded.jpg")
                    grades.append(grade)
                    annotated_paths.append(save_p)
                except Exception as exc:
                    failed.append((path.name, str(exc)))

        if not grades:
            raise RuntimeError(f"All {total_scans_attempted} scans failed to process. Errors: {failed}")

        # Check for duplicates across the batch
        duplicates = self.detect_duplicates(grades)

        # Compute psychometrics (using non-duplicate exams to prevent statistical skew)
        eval_grades = [g for g in grades if not g.is_duplicate] or grades
        psychometrics = self.analyzer.analyze(eval_grades)

        # Save HTML report
        report_path = out / "item_analysis_report.html"
        self.reporter.save(psychometrics, report_path)

        # Save JSON grades summary
        grades_json_path = out / "grades_summary.json"
        summary_payload = {
            "template_id": self.layout.template_id,
            "exam_title": self.answer_key.title,
            "processed_count": len(grades),
            "duplicate_count": len(duplicates),
            "duplicates": duplicates,
            "failed_count": len(failed),
            "failures": [{"file": f, "error": err} for f, err in failed],
            "grades": [g.to_dict() for g in grades],
            "psychometrics": psychometrics.to_dict(),
        }
        grades_json_path.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")

        return PipelineResult(
            grades=grades,
            psychometrics=psychometrics,
            output_dir=out,
            annotated_paths=annotated_paths,
            report_path=report_path,
            grades_json_path=grades_json_path,
            failed_scans=failed,
        )

    def detect_duplicates(self, grades: list[ExamGrade]) -> list[dict[str, Any]]:
        """Identifies duplicate scans in a batch based on sheet barcode, student ID collisions, and bubble answer matches."""
        duplicates: list[dict[str, Any]] = []
        n = len(grades)

        # 1. Sheet Barcode Collisions (100% definitive physical double-scans)
        by_barcode: dict[str, list[int]] = {}
        for idx, g in enumerate(grades):
            bc = g.sheet_barcode.strip() if g.sheet_barcode else ""
            if bc and len(bc) >= 4:
                by_barcode.setdefault(bc, []).append(idx)

        for bc, indices in by_barcode.items():
            if len(indices) > 1:
                dup_exams = [grades[i].exam_id for i in indices]
                duplicates.append({
                    "type": "sheet_barcode_collision",
                    "sheet_barcode": bc,
                    "exam_ids": dup_exams,
                    "message": f"Sheet Barcode {bc} was scanned multiple times: {', '.join(dup_exams)}",
                })
                for i in indices:
                    grades[i].is_duplicate = True
                    other_sheets = [e for e in dup_exams if e != grades[i].exam_id]
                    grades[i].duplicate_note = f"Duplicate physical scan: Sheet {bc} also on {', '.join(other_sheets)}"

        # 2. Student ID collisions (for non-empty, non-anonymous IDs)
        by_sid: dict[str, list[int]] = {}
        for idx, g in enumerate(grades):
            sid = g.student_id.strip() if g.student_id else ""
            if sid and not sid.startswith("STU-") and set(sid) > {"?"}:
                by_sid.setdefault(sid, []).append(idx)

        for sid, indices in by_sid.items():
            if len(indices) > 1:
                dup_exams = [grades[i].exam_id for i in indices]
                name = grades[indices[0]].student_name
                already_bc = any(
                    d.get("type") == "sheet_barcode_collision" and all(grades[i].exam_id in d.get("exam_ids", []) for i in indices)
                    for d in duplicates
                )
                if not already_bc:
                    duplicates.append({
                        "type": "student_id_collision",
                        "student_id": sid,
                        "student_name": name,
                        "exam_ids": dup_exams,
                        "message": f"Student ID {sid} ({name}) appears on multiple sheets: {', '.join(dup_exams)}",
                    })
                    for i in indices:
                        grades[i].is_duplicate = True
                        other_sheets = [e for e in dup_exams if e != grades[i].exam_id]
                        grades[i].duplicate_note = f"Duplicate scan: Student ID {sid} also on {', '.join(other_sheets)}"

        # 3. Bubble response vector collisions (>= 96% identical answers across MCQs)
        for i in range(n):
            for j in range(i + 1, n):
                g1, g2 = grades[i], grades[j]
                common_keys = [
                    k for k in g1.items
                    if g1.items[k].kind in {"mcq", "tf"} and k in g2.items and g2.items[k].kind in {"mcq", "tf"}
                ]
                if len(common_keys) >= 10:
                    matches = sum(
                        1 for k in common_keys
                        if g1.items[k].student_response == g2.items[k].student_response
                        and g1.items[k].student_response not in {"", "?", "BLANK"}
                    )
                    ratio = matches / len(common_keys)
                    if ratio >= 0.96:
                        already = any(
                            (d["type"] == "student_id_collision" or d.get("type") == "sheet_barcode_collision")
                            and g1.exam_id in d["exam_ids"]
                            and g2.exam_id in d["exam_ids"]
                            for d in duplicates
                        )
                        if not already:
                            pct_str = f"{round(ratio * 100, 1)}%"
                            has_both = bool(g1.sheet_barcode and g2.sheet_barcode)
                            diff_barcodes = has_both and (g1.sheet_barcode != g2.sheet_barcode)

                            if diff_barcodes:
                                # Separate physical sheets: potential collusion, NOT double-scan
                                g1.review_notes.append(
                                    f"Distinct physical sheets ({g1.sheet_barcode} & {g2.sheet_barcode}) with {pct_str} identical answers"
                                )
                                g2.review_notes.append(
                                    f"Distinct physical sheets ({g2.sheet_barcode} & {g1.sheet_barcode}) with {pct_str} identical answers"
                                )
                            else:
                                duplicates.append({
                                    "type": "identical_responses",
                                    "exam_ids": [g1.exam_id, g2.exam_id],
                                    "match_ratio": round(ratio * 100, 1),
                                    "message": f"{g1.exam_id} and {g2.exam_id} share {pct_str} identical bubble answers (likely double-scan)",
                                })
                                g1.is_duplicate = True
                                g2.is_duplicate = True
                                g1.duplicate_note = f"Likely duplicate scan: {pct_str} identical answers to {g2.exam_id}"
                                g2.duplicate_note = f"Likely duplicate scan: {pct_str} identical answers to {g1.exam_id}"

        return duplicates
