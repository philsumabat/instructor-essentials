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
from omr.roster import normalize_student_id
from omr.vision import GroupResult, WarpResult

# BGR Color Palette
COLOR_CORRECT = (46, 125, 50)      # Forest Green
COLOR_INCORRECT = (30, 30, 210)    # Crimson Red
COLOR_MISSED = (0, 165, 255)       # Amber / Orange
COLOR_BANNER_BG = (245, 247, 250)  # Off-white / light slate
COLOR_BANNER_BORDER = (50, 50, 50) # Dark gray
COLOR_TEXT = (20, 20, 20)          # Near-black
COLOR_WHITE = (255, 255, 255)

# Translucent correction badge styling
COLOR_BADGE_INCORRECT_BG = (38, 38, 220)      # Crimson Red BGR
COLOR_BADGE_INCORRECT_BORDER = (20, 20, 180)  # Dark Crimson border
COLOR_BADGE_INCORRECT_TEXT = (15, 15, 150)    # High-contrast Dark Crimson text

COLOR_BADGE_VARIANT_BG = (129, 185, 16)       # Emerald Green BGR
COLOR_BADGE_VARIANT_BORDER = (35, 140, 40)    # Forest Green border
COLOR_BADGE_VARIANT_TEXT = (15, 80, 20)       # High-contrast Dark Forest Green text


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
        if grade.is_duplicate:
            status_color = (0, 140, 255)  # Orange
        else:
            status_color = COLOR_CORRECT if grade.percentage >= 60.0 else COLOR_INCORRECT
        cv2.rectangle(canvas, (banner_x1, banner_y1), (banner_x2, banner_y2), status_color, 2)

        # Content text
        font = cv2.FONT_HERSHEY_SIMPLEX
        dup_tag = " [DUPLICATE]" if grade.is_duplicate else ""
        norm_sid = normalize_student_id(grade.student_id)
        student_label = f"Student: {grade.student_name} (ID: {norm_sid}){dup_tag}"
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

        # Right-aligned Pass/Fail/Duplicate stamp
        if grade.is_duplicate:
            stamp = "DUPLICATE SCAN"
        else:
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
        score_text = f"{grade.score:g}/{grade.max_score:g}"
        scale = 0.65
        thick = 2
        (tw, th), _ = cv2.getTextSize(score_text, font, scale, thick)
        if tw > rw - 8:
            scale = scale * (rw - 8) / tw
            (tw, th), _ = cv2.getTextSize(score_text, font, scale, thick)

        tx = rx + max(4, (rw - tw) // 2)
        ty = ry + int((rh + th) / 2)

        cv2.putText(
            canvas,
            score_text,
            (tx, ty),
            font,
            scale,
            status_color,
            thick,
            cv2.LINE_AA,
        )

    def _draw_bubble_feedback(
        self,
        canvas: np.ndarray,
        item_grade: ItemGrade,
        group_res: GroupResult,
    ):
        """Draws green/red rings, review warnings, and correction markers on multiple choice bubbles."""
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
                meas.is_filled and not item_grade.is_multi and not item_grade.is_blank
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
                elif getattr(meas, "mark_type", "") in {"check_or_cross", "erasure", "faint"}:
                    # Ambiguous / non-standard mark flagged for review: Amber/Purple warning ring
                    warn_color = (247, 85, 168) if getattr(meas, "mark_type", "") == "check_or_cross" else COLOR_MISSED
                    cv2.circle(canvas, (cx, cy), r, warn_color, 2, cv2.LINE_AA)
                elif is_opt_correct:
                    # Missed correct answer: Green dashed/thick ring
                    cv2.circle(canvas, (cx, cy), r, COLOR_CORRECT, 2, cv2.LINE_AA)
                    # Mini green arrow / dot indicator
                    cv2.circle(canvas, (cx, cy), max(2, int(r * 0.3)), COLOR_CORRECT, -1, cv2.LINE_AA)

        if item_grade.is_blank:
            # Indicate missed or review-held answer near the question number
            if group_res.measurements:
                first_m = group_res.measurements[0]
                qx = first_m.detected_cx_px - int(round(8 * self.px_per_mm))
                qy = first_m.detected_cy_px
                tag = "REV" if group_res.review_reason else "MISS"
                cv2.putText(
                    canvas,
                    tag,
                    (qx - 25, qy + 4),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.38,
                    COLOR_MISSED,
                    1,
                    cv2.LINE_AA,
                )

    def _draw_roi_feedback(self, canvas: np.ndarray, item_grade: ItemGrade):
        """Draws outline, points badge, and visual correction overlays on handwritten answer boxes."""
        # Find corresponding ROI from layout
        roi = next((r for r in self.layout.graded_rois if r.key == item_grade.key), None)
        if not roi:
            return

        x = int(round(roi.x * self.px_per_mm))
        y = int(round(roi.y * self.px_per_mm))
        w = int(round(roi.w * self.px_per_mm))
        h = int(round(roi.h * self.px_per_mm))

        # True statement in Modified T/F where no correction was required: keep canvas clean
        if item_grade.max_points == 0.0 and not item_grade.correct_answer:
            if item_grade.is_correct:
                return

        resp = (item_grade.student_response or "").strip()
        if resp in {"[PENDING_INSPECTION]", "[INSPECT]"}:
            # Neutral indicator for items awaiting handwriting inspection
            cv2.rectangle(canvas, (x, y), (x + w, y + h), COLOR_MISSED, 2)
            badge_txt = "Pending"
            font = cv2.FONT_HERSHEY_SIMPLEX
            (bw, bh), _ = cv2.getTextSize(badge_txt, font, 0.45, 1)
            badge_x = x + w - bw - 10
            badge_y = y + bh + 8
            cv2.rectangle(
                canvas,
                (badge_x - 4, badge_y - bh - 4),
                (badge_x + bw + 4, badge_y + 4),
                COLOR_MISSED,
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
            return

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

        # Translucent visual correction overlay
        self._draw_roi_correction(canvas, x, y, w, h, item_grade)

    def _get_canonical_answer(self, item_grade: ItemGrade) -> str:
        corr = item_grade.correct_answer
        if isinstance(corr, list):
            return str(corr[0]).strip() if corr else ""
        elif corr is not None:
            return str(corr).split("|")[0].strip()
        return ""

    def draw_correction_badge(
        self,
        canvas: np.ndarray,
        x: int,
        y: int,
        w: int,
        h: int,
        text: str,
        badge_type: str = "incorrect",
        alpha: float = 0.35,
        position: str = "bottom",
    ):
        """
        Renders an alpha-blended correction overlay badge.
        Positioned along the bottom or top edge of the box to avoid occluding student handwriting.
        - 'incorrect': Translucent crimson red with high-contrast text.
        - 'accepted_variant': Translucent emerald green with high-contrast text.
        """
        if not text:
            return

        h_c, w_c = canvas.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.42
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness)

        badge_h = max(20, th + 8)
        if position == "top":
            by1 = y + 2
            by2 = y + 2 + badge_h
        else:  # "bottom"
            by1 = y + h - badge_h - 2
            by2 = y + h - 2

        badge_w = min(w - 6, tw + 12)
        bx2 = x + w - 3
        bx1 = bx2 - badge_w

        # Clamp coordinates to canvas bounds
        bx1 = max(0, min(bx1, w_c - 1))
        bx2 = max(0, min(bx2, w_c))
        by1 = max(0, min(by1, h_c - 1))
        by2 = max(0, min(by2, h_c))
        if bx2 <= bx1 or by2 <= by1:
            return

        # Colors in BGR
        if badge_type in {"accepted_variant", "variant", "mastery"}:
            bg_color = COLOR_BADGE_VARIANT_BG
            border_color = COLOR_BADGE_VARIANT_BORDER
            text_color = COLOR_BADGE_VARIANT_TEXT
        else:
            bg_color = COLOR_BADGE_INCORRECT_BG
            border_color = COLOR_BADGE_INCORRECT_BORDER
            text_color = COLOR_BADGE_INCORRECT_TEXT

        # Alpha-blend background
        sub = canvas[by1:by2, bx1:bx2]
        overlay = np.full_like(sub, bg_color)
        cv2.addWeighted(overlay, alpha, sub, 1.0 - alpha, 0, sub)
        canvas[by1:by2, bx1:bx2] = sub

        # Draw crisp border
        cv2.rectangle(canvas, (bx1, by1), (bx2, by2), border_color, 1, cv2.LINE_AA)

        # Ensure text fits badge width, adjusting font scale if necessary
        avail_w = bx2 - bx1 - 8
        if tw > avail_w and avail_w > 10:
            scale_factor = avail_w / tw
            font_scale = max(0.28, font_scale * scale_factor)
            (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness)

        tx = bx1 + 4
        ty = by1 + int((badge_h + th) / 2)
        cv2.putText(canvas, text, (tx, ty), font, font_scale, text_color, thickness, cv2.LINE_AA)

    def _draw_roi_correction(self, canvas: np.ndarray, x: int, y: int, w: int, h: int, item_grade: ItemGrade):
        """Determines and draws correction badge for an ROI item based on grading results."""
        # 1. Explicit badge specified on item_grade
        if getattr(item_grade, "feedback_badge", ""):
            b_type = item_grade.feedback_badge
            b_text = getattr(item_grade, "feedback_text", "")
            if not b_text:
                canonical = self._get_canonical_answer(item_grade)
                b_text = canonical
            self.draw_correction_badge(canvas, x, y, w, h, b_text, badge_type=b_type)
            return

        # 2. Incorrect answer (with points possible and expected key present)
        if not item_grade.is_correct and item_grade.max_points > 0:
            resp = (item_grade.student_response or "").strip()
            if resp not in {"[PENDING_INSPECTION]", "[INSPECT]"}:
                canonical = self._get_canonical_answer(item_grade)
                if canonical:
                    self.draw_correction_badge(canvas, x, y, w, h, canonical, badge_type="incorrect")
            return


        # 3. Accepted variant / alternate synonym / minor spelling variation
        if item_grade.is_correct and item_grade.max_points > 0:
            canonical = self._get_canonical_answer(item_grade)
            resp = item_grade.student_response.strip()
            if canonical and resp and resp not in {"[PENDING_INSPECTION]", "[INSPECT]"}:
                if resp.upper() != canonical.upper():
                    font = cv2.FONT_HERSHEY_SIMPLEX
                    cand_txt = f"{resp} -> {canonical}"
                    (cw, _), _ = cv2.getTextSize(cand_txt, font, 0.42, 1)
                    badge_text = cand_txt if cw + 12 <= (w - 6) else canonical
                    self.draw_correction_badge(
                        canvas, x, y, w, h, badge_text, badge_type="accepted_variant"
                    )

    def annotate(self, warped_bgr: np.ndarray, grade: ExamGrade, redact_names: bool = False) -> np.ndarray:
        """Produces a derivative visual feedback image."""
        annotated = warped_bgr.copy()

        # 1. Overlay score summary: directly in dedicated Score box if present, else fallback to banner
        if self.layout.score_roi:
            self._draw_score_box(annotated, grade, self.layout.score_roi)
        else:
            self._draw_banner(annotated, grade)

        # 1b. Optional student name redaction blackout
        if redact_names and self.layout.name_roi:
            nroi = self.layout.name_roi
            nx = int(round(nroi.x * self.px_per_mm))
            ny = int(round(nroi.y * self.px_per_mm))
            nw = int(round(nroi.w * self.px_per_mm))
            nh = int(round(nroi.h * self.px_per_mm))
            cv2.rectangle(annotated, (nx, ny), (nx + nw, ny + nh), (15, 23, 42), -1)
            lbl = "[NAME REDACTED]"
            font = cv2.FONT_HERSHEY_SIMPLEX
            (lw, lh), _ = cv2.getTextSize(lbl, font, 0.45, 1)
            cv2.putText(
                annotated,
                lbl,
                (nx + max(2, (nw - lw) // 2), ny + int((nh + lh) / 2)),
                font,
                0.45,
                COLOR_WHITE,
                1,
                cv2.LINE_AA,
            )

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
