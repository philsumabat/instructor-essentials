"""Visual Exam Annotator.

Generates derivative JPEG images using OpenCV drawing routines to superimpose
visual grading feedback (green correct markers, red error outlines, missed
correct answers, and composite score banners) onto the scan.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from omr.grading import ExamGrade, ItemGrade
from omr.layout import Layout, TextROI
from omr.vision import GroupResult, WarpResult

# BGR Color Palette
COLOR_CORRECT = (46, 125, 50)      # Forest Green
COLOR_INCORRECT = (30, 30, 210)    # Crimson Red
COLOR_MISSED = (0, 165, 255)       # Amber / Orange
COLOR_BANNER_BG = (245, 247, 250)  # Off-white / light slate
COLOR_BANNER_BORDER = (50, 50, 50) # Dark gray
COLOR_TEXT = (20, 20, 20)          # Near-black
COLOR_WHITE = (255, 255, 255)


class ExamAnnotator:
    """Superimposes visual grading feedback onto rectified scan images."""

    def __init__(self, layout: Layout, px_per_mm: float):
        self.layout = layout
        self.px_per_mm = px_per_mm

    def _draw_banner(self, canvas: np.ndarray, grade: ExamGrade):
        """Renders an executive score banner at the top of the sheet."""
        h, w = canvas.shape[:2]
        # Position banner cleanly in the top header zone between the ArUco markers (y: 3.5mm to 17mm)
        banner_y1 = int(round(3.5 * self.px_per_mm))
        banner_h = int(round(13.5 * self.px_per_mm))
        banner_y2 = banner_y1 + banner_h

        # Inset horizontally between ArUco quiet zones
        inset_mm = max(self.layout.fiducials[0].corners[1][0] + 3.0, self.layout.margin)
        banner_x1 = int(round(inset_mm * self.px_per_mm))
        banner_x2 = int(round((self.layout.page_width - inset_mm) * self.px_per_mm))

        # Semi-transparent background card
        sub = canvas[banner_y1:banner_y2, banner_x1:banner_x2]
        card = np.full_like(sub, COLOR_BANNER_BG)
        cv2.addWeighted(card, 0.92, sub, 0.08, 0, sub)
        canvas[banner_y1:banner_y2, banner_x1:banner_x2] = sub

        # Outline
        status_color = COLOR_CORRECT if grade.percentage >= 60.0 else COLOR_INCORRECT
        cv2.rectangle(canvas, (banner_x1, banner_y1), (banner_x2, banner_y2), status_color, 2)

        # Content text
        font = cv2.FONT_HERSHEY_SIMPLEX
        student_label = f"Student: {grade.student_name} (ID: {grade.student_id})"
        score_label = f"Score: {grade.score:.1f} / {grade.max_score:.1f}  ({grade.percentage:.1f}%)"

        cv2.putText(
            canvas,
            student_label,
            (banner_x1 + 18, banner_y1 + int(banner_h * 0.42)),
            font,
            0.65,
            COLOR_TEXT,
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            canvas,
            score_label,
            (banner_x1 + 18, banner_y1 + int(banner_h * 0.82)),
            font,
            0.75,
            status_color,
            2,
            cv2.LINE_AA,
        )

        # Right-aligned Pass/Fail stamp
        stamp = "PASS" if grade.percentage >= 60.0 else "NEEDS REVIEW"
        (sw, _), _ = cv2.getTextSize(stamp, font, 0.8, 2)
        cv2.putText(
            canvas,
            stamp,
            (banner_x2 - sw - 20, banner_y1 + int(banner_h * 0.65)),
            font,
            0.8,
            status_color,
            2,
            cv2.LINE_AA,
        )

    def _draw_score_box(self, canvas: np.ndarray, grade: ExamGrade, roi: TextROI):
        """Renders score and pass/review stamp directly into the designated Score field box."""
        rx = int(round(roi.x * self.px_per_mm))
        ry = int(round(roi.y * self.px_per_mm))
        rw = int(round(roi.w * self.px_per_mm))
        rh = int(round(roi.h * self.px_per_mm))

        status_color = COLOR_CORRECT if grade.percentage >= 60.0 else COLOR_INCORRECT

        # Tint inside score box
        sub = canvas[ry : ry + rh, rx : rx + rw]
        card = np.full_like(sub, (235, 248, 235) if grade.percentage >= 60.0 else (235, 235, 252))
        cv2.addWeighted(card, 0.40, sub, 0.60, 0, sub)
        canvas[ry : ry + rh, rx : rx + rw] = sub

        # Clean border
        cv2.rectangle(canvas, (rx, ry), (rx + rw, ry + rh), status_color, 2)

        font = cv2.FONT_HERSHEY_SIMPLEX
        score_text = f"{grade.score:.1f}/{grade.max_score:.1f}"
        pct_text = f"{grade.percentage:.1f}%"
        stamp = "PASS" if grade.percentage >= 60.0 else "REVIEW"

        # Fit typography inside box height rh
        cv2.putText(
            canvas,
            f"Score: {score_text}",
            (rx + 6, ry + int(rh * 0.46)),
            font,
            0.48,
            status_color,
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            canvas,
            f"{pct_text}  {stamp}",
            (rx + 6, ry + int(rh * 0.86)),
            font,
            0.40,
            COLOR_TEXT,
            1,
            cv2.LINE_AA,
        )

    def _draw_bubble_feedback(
        self,
        canvas: np.ndarray,
        item_grade: ItemGrade,
        group_res: GroupResult,
    ):
        """Draws green/red rings and correction markers on multiple choice bubbles."""
        corr_ans = (
            item_grade.correct_answer
            if isinstance(item_grade.correct_answer, list)
            else [str(item_grade.correct_answer)]
        )

        for meas in group_res.measurements:
            cx, cy = meas.detected_cx_px, meas.detected_cy_px
            r = meas.detected_radius_px + 2

            is_opt_correct = meas.value in corr_ans
            was_selected = meas.value == item_grade.student_response or (
                meas.is_filled and not item_grade.is_multi
            )

            if item_grade.is_correct:
                if was_selected:
                    # Student got it right: Green halo ring
                    cv2.circle(canvas, (cx, cy), r, COLOR_CORRECT, 3, cv2.LINE_AA)
            else:
                if was_selected:
                    # Student selected wrong answer: Red cross / red ring
                    cv2.circle(canvas, (cx, cy), r, COLOR_INCORRECT, 3, cv2.LINE_AA)
                    # Small red X over wrong selection
                    d = int(r * 0.65)
                    cv2.line(canvas, (cx - d, cy - d), (cx + d, cy + d), COLOR_INCORRECT, 2, cv2.LINE_AA)
                    cv2.line(canvas, (cx - d, cy + d), (cx + d, cy - d), COLOR_INCORRECT, 2, cv2.LINE_AA)
                elif is_opt_correct:
                    # Missed correct answer: Green dashed/thick ring
                    cv2.circle(canvas, (cx, cy), r, COLOR_CORRECT, 2, cv2.LINE_AA)
                    # Mini green arrow / dot indicator
                    cv2.circle(canvas, (cx, cy), max(2, int(r * 0.3)), COLOR_CORRECT, -1, cv2.LINE_AA)

        if item_grade.is_blank:
            # Indicate missed answer with an amber box near the question number
            if group_res.measurements:
                first_m = group_res.measurements[0]
                qx = first_m.detected_cx_px - int(round(8 * self.px_per_mm))
                qy = first_m.detected_cy_px
                cv2.putText(
                    canvas,
                    "MISS",
                    (qx - 25, qy + 4),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.38,
                    COLOR_MISSED,
                    1,
                    cv2.LINE_AA,
                )

    def _draw_roi_feedback(self, canvas: np.ndarray, item_grade: ItemGrade):
        """Draws outline and points badge on handwritten answer boxes."""
        # Find corresponding ROI from layout
        roi = next((r for r in self.layout.graded_rois if r.key == item_grade.key), None)
        if not roi:
            return

        x = int(round(roi.x * self.px_per_mm))
        y = int(round(roi.y * self.px_per_mm))
        w = int(round(roi.w * self.px_per_mm))
        h = int(round(roi.h * self.px_per_mm))

        color = COLOR_CORRECT if item_grade.is_correct else COLOR_INCORRECT
        cv2.rectangle(canvas, (x, y), (x + w, y + h), color, 2)

        # Points stamp in top-right of ROI
        badge_txt = f"{item_grade.points_awarded:g}/{item_grade.max_points:g} pts"
        font = cv2.FONT_HERSHEY_SIMPLEX
        (bw, bh), _ = cv2.getTextSize(badge_txt, font, 0.45, 1)

        badge_x = x + w - bw - 10
        badge_y = y + bh + 8
        cv2.rectangle(
            canvas,
            (badge_x - 4, badge_y - bh - 4),
            (badge_x + bw + 4, badge_y + 4),
            color,
            -1,
        )
        cv2.putText(
            canvas,
            badge_txt,
            (badge_x, badge_y),
            font,
            0.45,
            COLOR_WHITE,
            1,
            cv2.LINE_AA,
        )

        # Subtitle OCR recognition feedback if wrong
        if not item_grade.is_correct and item_grade.student_response:
            ocr_note = f"Read: '{item_grade.student_response}'"
            cv2.putText(
                canvas,
                ocr_note,
                (x + 6, y + h - 6),
                font,
                0.40,
                COLOR_INCORRECT,
                1,
                cv2.LINE_AA,
            )

    def annotate(self, warped_bgr: np.ndarray, grade: ExamGrade) -> np.ndarray:
        """Produces a derivative visual feedback image."""
        annotated = warped_bgr.copy()

        # 1. Overlay score summary: directly in dedicated Score box if present, else fallback to banner
        if self.layout.score_roi:
            self._draw_score_box(annotated, grade, self.layout.score_roi)
        else:
            self._draw_banner(annotated, grade)

        # 2. Overlay MCQ / TF bubble annotations
        for key, item_grade in grade.items.items():
            if item_grade.kind in {"mcq", "tf"}:
                grp_res = grade.bubble_results.get(key)
                if grp_res:
                    self._draw_bubble_feedback(annotated, item_grade, grp_res)
            elif item_grade.kind == "text":
                self._draw_roi_feedback(annotated, item_grade)

        return annotated

    def save(self, image: np.ndarray, path: str | Path, quality: int = 92) -> Path:
        """Saves annotated scan to disk as high-quality JPEG."""
        out_path = Path(path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), image, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return out_path
