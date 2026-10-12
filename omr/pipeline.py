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

        # 3. Handwritten text OCR
        ocr_results = self.extractor.process_all(warp_res.warped_bgr)

        # If Student ID uses handwritten digit recognition (shading: false)
        if self.layout.sid_roi and not self.layout.sid_groups:
            sid_item = ocr_results.get(self.layout.sid_roi.key)
            if sid_item and sid_item.text:
                decoded_sid = sid_item.text.strip()

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
        )

        # 6. Annotation
        annotated_bgr = self.annotator.annotate(warp_res.warped_bgr, grade)

        return grade, annotated_bgr

    def process_file(self, file_path: str | Path) -> tuple[ExamGrade, np.ndarray]:
        """Loads and processes a single image file."""
        path = Path(file_path)
        img = cv2.imread(str(path))
        if img is None:
            raise VisionError(f"Failed to decode image file {path}")
        return self.process_image(img, exam_id=path.stem)

    def process_batch(
        self,
        image_paths: Sequence[str | Path],
        output_dir: str | Path,
    ) -> PipelineResult:
        """Processes an entire batch of exams and outputs all derivatives."""
        out = Path(output_dir)
        annotated_dir = out / "annotated"
        annotated_dir.mkdir(parents=True, exist_ok=True)

        grades: list[ExamGrade] = []
        annotated_paths: list[Path] = []
        failed: list[tuple[str, str]] = []

        for p in image_paths:
            path = Path(p)
            try:
                grade, annotated = self.process_file(path)
                save_p = self.annotator.save(annotated, annotated_dir / f"{path.stem}_graded.jpg")
                grades.append(grade)
                annotated_paths.append(save_p)
            except Exception as exc:
                failed.append((path.name, str(exc)))

        if not grades:
            raise RuntimeError(f"All {len(image_paths)} scans failed to process. Errors: {failed}")

        # Compute psychometrics
        psychometrics = self.analyzer.analyze(grades)

        # Save HTML report
        report_path = out / "item_analysis_report.html"
        self.reporter.save(psychometrics, report_path)

        # Save JSON grades summary
        grades_json_path = out / "grades_summary.json"
        summary_payload = {
            "template_id": self.layout.template_id,
            "exam_title": self.answer_key.title,
            "processed_count": len(grades),
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
