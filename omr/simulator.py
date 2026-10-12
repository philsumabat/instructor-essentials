"""Realistic Exam Scan Simulator.

Synthesizes realistic scanned exam sheets from layout geometry:
- Renders ArUco fiducials, grid bubbles, and text prompts.
- Simulates realistic pencil graphite fills with natural jitter and textures.
- Renders simulated handwriting in designated answer ROIs.
- Injects scanner distortions: rotation skew, perspective shift, and sensor noise.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

import cv2
import numpy as np

from omr.layout import Layout


class ExamSimulator:
    """Generates synthetic scanned exam sheets for automated verification."""

    def __init__(self, layout: Layout, px_per_mm: float = 10.0):
        self.layout = layout
        self.px_per_mm = px_per_mm
        self.width_px = int(round(layout.page_width * px_per_mm))
        self.height_px = int(round(layout.page_height * px_per_mm))

        # Prepare ArUco dictionary
        from omr.vision import ARUCO_DICT_MAP
        dict_id = ARUCO_DICT_MAP.get(layout.dictionary, cv2.aruco.DICT_4X4_50)
        self.aruco_dict = cv2.aruco.getPredefinedDictionary(dict_id)

    def _render_blank_sheet(self) -> np.ndarray:
        """Draws the crisp template baseline with fiducials and bubbles."""
        canvas = np.full((self.height_px, self.width_px, 3), 255, dtype=np.uint8)

        # 1. Draw ArUco markers at corner positions
        for fid in self.layout.fiducials:
            x_px = int(round(fid.corners[0][0] * self.px_per_mm))
            y_px = int(round(fid.corners[0][1] * self.px_per_mm))
            size_px = int(round(fid.size * self.px_per_mm))

            marker_img = cv2.aruco.generateImageMarker(self.aruco_dict, fid.id, size_px)
            marker_bgr = cv2.cvtColor(marker_img, cv2.COLOR_GRAY2BGR)
            canvas[y_px : y_px + size_px, x_px : x_px + size_px] = marker_bgr

        # 2. Draw Title & Footer
        font = cv2.FONT_HERSHEY_SIMPLEX
        title_y = int(round(self.layout.fiducials[0].size * self.px_per_mm / 2 + 15))
        (tw, _), _ = cv2.getTextSize(self.layout.title, font, 0.75, 2)
        cv2.putText(
            canvas,
            self.layout.title,
            ((self.width_px - tw) // 2, title_y),
            font,
            0.75,
            (0, 0, 0),
            2,
            cv2.LINE_AA,
        )

        # 3. Draw Zone Boxes and Elements
        for z in self.layout.zones:
            zx, zy, zw, zh = [int(round(v * self.px_per_mm)) for v in z.bbox]
            cv2.rectangle(canvas, (zx, zy), (zx + zw, zy + zh), (0, 0, 0), 1)

            if z.label:
                cv2.putText(
                    canvas,
                    z.label,
                    (zx + 8, zy + 18),
                    font,
                    0.5,
                    (0, 0, 0),
                    1,
                    cv2.LINE_AA,
                )

            # Draw bubbles
            for g in z.groups:
                for opt in g.options:
                    cx = int(round(opt.cx * self.px_per_mm))
                    cy = int(round(opt.cy * self.px_per_mm))
                    r = int(round((self.layout.bubble_diameter / 2.0) * self.px_per_mm))
                    # Bubble ring
                    cv2.circle(canvas, (cx, cy), r, (0, 0, 0), 1, cv2.LINE_AA)
                    # Label inside bubble
                    (ow, oh), _ = cv2.getTextSize(opt.value, font, 0.32, 1)
                    cv2.putText(
                        canvas,
                        opt.value,
                        (cx - ow // 2, cy + oh // 2),
                        font,
                        0.32,
                        (140, 140, 140),
                        1,
                        cv2.LINE_AA,
                    )

            # Draw write-in boxes for text ROIs
            for roi in z.rois:
                rx, ry, rw, rh = [int(round(v * self.px_per_mm)) for v in (roi.x, roi.y, roi.w, roi.h)]
                cv2.rectangle(canvas, (rx, ry), (rx + rw, ry + rh), (0, 0, 0), 1)
                if roi.role == "student_id":
                    digits_count = roi.digits if roi.digits > 0 else 8
                    col_w_px = rw / digits_count
                    for d in range(1, digits_count):
                        div_x = int(round(rx + d * col_w_px))
                        cv2.line(canvas, (div_x, ry), (div_x, ry + rh), (0, 0, 0), 1)
                elif roi.label:
                    cv2.putText(
                        canvas,
                        roi.label[:45],
                        (rx, ry - 6),
                        font,
                        0.40,
                        (0, 0, 0),
                        1,
                        cv2.LINE_AA,
                    )

        return canvas

    def _fill_bubble(self, canvas: np.ndarray, cx: int, cy: int, r: int, darkness: float = 0.85):
        """Fills a bubble with realistic graphite pencil simulation."""
        # Add slight natural hand tremor / center offset
        dx = random.randint(-1, 1)
        dy = random.randint(-1, 1)
        center = (cx + dx, cy + dy)

        # Draw filled circle with slight noise
        fill_r = max(2, int(r * random.uniform(0.78, 0.95)))
        color_val = int(round(255 * (1.0 - darkness)))
        # Graphite gray (40-60)
        cv2.circle(canvas, center, fill_r, (color_val, color_val, color_val), -1, cv2.LINE_AA)

        # Soft edge feathering
        cv2.circle(canvas, center, fill_r + 1, (color_val + 30, color_val + 30, color_val + 30), 1, cv2.LINE_AA)

    def _render_handwriting(self, canvas: np.ndarray, x: int, y: int, text: str, h: int = 75):
        """Renders simulated handwriting inside an ROI box."""
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 0.55 if h < 90 else 0.65
        thickness = 2
        # Dark blue/black ink
        ink_color = (random.randint(15, 35), random.randint(15, 30), random.randint(20, 45))
        base_y = y + int(h * 0.68)
        cv2.putText(canvas, text, (x + 10, base_y), font, scale, ink_color, thickness, cv2.LINE_AA)

    def _render_digits(self, canvas: np.ndarray, x: int, y: int, w: int, h: int, text: str):
        """Renders individual digits centered inside partitioned digit boxes."""
        font = cv2.FONT_HERSHEY_SIMPLEX
        digits = list(text)
        n = max(1, len(digits))
        col_w = w / n
        ink_color = (random.randint(15, 35), random.randint(15, 30), random.randint(20, 45))
        base_y = int(round(y + h * 0.76))
        for i, ch in enumerate(digits):
            cell_cx = x + i * col_w + col_w / 2.0
            jx = random.randint(-1, 1)
            jy = random.randint(-1, 1)
            cx = int(round(cell_cx + jx))
            cy = base_y + jy
            if ch == "0":
                cv2.ellipse(
                    canvas,
                    (cx, int(round(y + h * 0.54 + jy))),
                    (11, 18),
                    0,
                    0,
                    360,
                    ink_color,
                    2,
                    cv2.LINE_AA,
                )
            elif ch == "1":
                top_y = cy - 28
                cv2.line(canvas, (cx, top_y), (cx, cy), ink_color, 2, cv2.LINE_AA)
                cv2.line(canvas, (cx, top_y), (cx - 5, top_y + 6), ink_color, 2, cv2.LINE_AA)
            else:
                (tw, th), _ = cv2.getTextSize(ch, font, 1.05, 2)
                cv2.putText(
                    canvas,
                    ch,
                    (int(round(cx - tw / 2.0)), cy),
                    font,
                    1.05,
                    ink_color,
                    2,
                    cv2.LINE_AA,
                )

    def generate_exam(
        self,
        student_id: str,
        student_name: str,
        answers: dict[str, str],
        text_answers: dict[str, str],
        skew_deg: float = 1.0,
        add_noise: bool = True,
    ) -> np.ndarray:
        """Synthesizes a complete filled and scanned exam."""
        sheet = self._render_blank_sheet()

        # 1. Fill student ID column bubbles if present
        sid_groups = self.layout.sid_groups
        if sid_groups:
            for i, ch in enumerate(student_id):
                if i < len(sid_groups):
                    grp = sid_groups[i]
                    for opt in grp.options:
                        if opt.value == ch:
                            cx = int(round(opt.cx * self.px_per_mm))
                            cy = int(round(opt.cy * self.px_per_mm))
                            r = int(round((self.layout.bubble_diameter / 2.0) * self.px_per_mm))
                            self._fill_bubble(sheet, cx, cy, r, darkness=0.88)

        # 2. Fill question answer bubbles
        for grp in self.layout.question_groups:
            chosen = answers.get(grp.key)
            if chosen:
                for opt in grp.options:
                    if opt.value == chosen:
                        cx = int(round(opt.cx * self.px_per_mm))
                        cy = int(round(opt.cy * self.px_per_mm))
                        r = int(round((self.layout.bubble_diameter / 2.0) * self.px_per_mm))
                        self._fill_bubble(sheet, cx, cy, r, darkness=0.85)

        # 3. Fill text ROIs
        for roi in self.layout.rois:
            rx = int(round(roi.x * self.px_per_mm))
            ry = int(round(roi.y * self.px_per_mm))
            rw = int(round(roi.w * self.px_per_mm))
            rh = int(round(roi.h * self.px_per_mm))
            if roi.role == "name":
                self._render_handwriting(sheet, rx, ry, student_name, rh)
            elif roi.role == "student_id" or roi.key == "sid":
                self._render_digits(sheet, rx, ry, rw, rh, student_id)
            elif roi.key in text_answers:
                self._render_handwriting(sheet, rx, ry, text_answers[roi.key], rh)

        # 4. Apply scanner distortion (rotation + perspective homography)
        h, w = sheet.shape[:2]
        center = (w / 2.0, h / 2.0)
        M_rot = cv2.getRotationMatrix2D(center, skew_deg, 1.0)
        # Pad slightly to avoid clipping corners during rotation
        pad = 60
        padded = cv2.copyMakeBorder(sheet, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(250, 250, 250))
        h_p, w_p = padded.shape[:2]
        center_p = (w_p / 2.0, h_p / 2.0)
        M_rot_p = cv2.getRotationMatrix2D(center_p, skew_deg, 1.0)
        rotated = cv2.warpAffine(padded, M_rot_p, (w_p, h_p), borderValue=(245, 245, 245))

        # Add slight perspective keystoning (scanner feed angle)
        src_corners = np.float32([[0, 0], [w_p, 0], [w_p, h_p], [0, h_p]])
        jitter_x = random.uniform(-10, 10)
        jitter_y = random.uniform(-10, 10)
        dst_corners = np.float32(
            [
                [0 + jitter_x, 0],
                [w_p - jitter_x, 0 + jitter_y],
                [w_p, h_p],
                [0, h_p - jitter_y],
            ]
        )
        H = cv2.getPerspectiveTransform(src_corners, dst_corners)
        distorted = cv2.warpPerspective(rotated, H, (w_p, h_p), borderValue=(240, 240, 240))

        if add_noise:
            # Gaussian sensor noise
            noise = np.random.normal(0, 3, distorted.shape).astype(np.float32)
            distorted = np.clip(distorted.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        return distorted
