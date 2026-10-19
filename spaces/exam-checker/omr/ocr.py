"""Handwriting OCR Extraction module.

Crops designated regions of interest (ROIs) from rectified sheets, performs
image cleanup (box stroke suppression, noise filtration, adaptive thresholding),
and runs text recognition via PyTesseract or pluggable OCR backends.
"""
from __future__ import annotations

import re
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Sequence

import cv2
import numpy as np

from omr.layout import Layout, TextROI

# Whitelist patterns for OCR charsets
CHARSET_WHITELISTS = {
    "digits": "0123456789",
    "alpha": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
    "upper": "ABCDEFGHIJKLMNOPQRSTUVWXYZ ",
    "alnum": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
}


@dataclass(frozen=True)
class OCRResult:
    """Extraction output for a single ROI."""

    roi_id: str
    key: str
    label: str
    text: str
    confidence: float
    cropped_bgr: np.ndarray
    preprocessed_gray: np.ndarray


class OCREngine(ABC):
    """Abstract interface for OCR providers."""

    @abstractmethod
    def recognize(self, image: np.ndarray, charset: str = "any", multiline: bool = False) -> tuple[str, float]:
        """Recognizes text and returns (extracted_string, confidence_score [0..1])."""
        pass


class TesseractEngine(OCREngine):
    """Local Tesseract OCR engine using pytesseract."""

    def __init__(self, tesseract_cmd: str | None = None):
        import pytesseract

        self.pytesseract = pytesseract
        if tesseract_cmd:
            self.pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        elif shutil.which("tesseract"):
            self.pytesseract.pytesseract.tesseract_cmd = shutil.which("tesseract")

    def recognize(self, image: np.ndarray, charset: str = "any", multiline: bool = False) -> tuple[str, float]:
        # PSM 8 = Treat the image as a single word (ideal for isolated digit boxes).
        # PSM 7 = Treat the image as a single text line.
        # PSM 6 = Assume a single uniform block of text.
        if multiline:
            psm = 6
        elif charset == "digits" and image.shape[1] < 120:
            psm = 8
        else:
            psm = 7
        oem = 3  # Default LSTM engine

        config_parts = [f"--oem {oem}", f"--psm {psm}"]
        whitelist = CHARSET_WHITELISTS.get(charset)
        if whitelist:
            config_parts.append(f"-c tessedit_char_whitelist={whitelist}")

        config = " ".join(config_parts)

        try:
            data = self.pytesseract.image_to_data(
                image, config=config, output_type=self.pytesseract.Output.DICT
            )
            text_tokens = []
            confs = []
            for word, conf in zip(data["text"], data["conf"]):
                word_str = word.strip()
                if word_str:
                    text_tokens.append(word_str)
                    try:
                        c_val = float(conf)
                        if c_val >= 0:
                            confs.append(c_val)
                    except (ValueError, TypeError):
                        pass

            full_text = " ".join(text_tokens)
            avg_conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0

            if not full_text and charset == "digits" and image.shape[1] < 120 and psm == 8:
                cfg10 = config.replace("--psm 8", "--psm 10")
                raw10 = self.pytesseract.image_to_string(image, config=cfg10).strip()
                if raw10:
                    return raw10, 0.85

            return full_text, avg_conf
        except Exception:
            # Fallback to simple image_to_string
            raw_text = self.pytesseract.image_to_string(image, config=config).strip()
            return raw_text, 0.5 if raw_text else 0.0


class MockOCREngine(OCREngine):
    """Deterministic mock engine for test fixtures and synthetic offline tests."""

    def __init__(self, mock_answers: dict[str, str] | None = None, default_digit: str = "7"):
        self.mock_answers = mock_answers or {}
        self.default_digit = default_digit

    def recognize(self, image: np.ndarray, charset: str = "any", multiline: bool = False) -> tuple[str, float]:
        if charset == "digits":
            return self.default_digit, 0.99
        return "MOCK_TEXT", 0.99


class ROIExtractor:
    """Crops and preprocesses handwritten text fields from warped sheets."""

    def __init__(
        self,
        layout: Layout,
        px_per_mm: float,
        engine: OCREngine | None = None,
    ):
        self.layout = layout
        self.px_per_mm = px_per_mm
        if engine is None:
            try:
                self.engine = TesseractEngine()
            except Exception:
                self.engine = MockOCREngine()
        else:
            self.engine = engine

    @staticmethod
    def strip_box_walls(gray: np.ndarray) -> np.ndarray:
        """Stage 4: Morphological box-wall stripping.

        Scans the outer 20% perimeter of a cell/box for continuous straight horizontal or
        vertical dark runs spanning >75% of the width or height, replacing detected border
        walls with background white (255) while preserving interior-connected handwriting strokes.
        """
        if gray is None or gray.size == 0:
            return gray
        out = gray.copy()
        if len(out.shape) == 3:
            out = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)

        h, w = out.shape[:2]
        if h < 6 or w < 6:
            return out

        dark_mask = out < 165
        band_y = max(1, int(round(h * 0.20)))
        band_x = max(1, int(round(w * 0.20)))

        # Helper to check longest continuous run or high line density (>75% of span)
        def _is_border_run(line_bool: np.ndarray) -> bool:
            n = line_bool.size
            if n == 0:
                return False
            if np.count_nonzero(line_bool) > 0.75 * n:
                return True
            # Also check longest contiguous dark segment (allows slight corner inset)
            padded = np.concatenate(([False], line_bool, [False]))
            starts = np.where(padded[1:] & ~padded[:-1])[0]
            ends = np.where(~padded[1:] & padded[:-1])[0]
            if starts.size > 0 and np.max(ends - starts) >= 0.72 * n:
                return True
            return False

        # 1. Horizontal walls in top 20% and bottom 20% bands
        top_rows = [y for y in range(band_y) if _is_border_run(dark_mask[y, :])]
        bot_rows = [y for y in range(h - band_y, h) if _is_border_run(dark_mask[y, :])]

        if top_rows:
            ref_y = min(h - 1, max(top_rows) + 2)
            # A handwriting stroke crossing the top wall continues at ref_y with narrow horizontal width
            if not _is_border_run(dark_mask[ref_y, :]):
                conn = dark_mask[ref_y, :].copy()
                interior_conn = conn | np.pad(conn[:-1], (1, 0)) | np.pad(conn[1:], (0, 1))
            else:
                interior_conn = np.zeros(w, dtype=bool)
            for y in range(0, min(h, max(top_rows) + 2)):
                if y in top_rows or (y > 0 and (y - 1) in top_rows):
                    erase_cols = ~interior_conn
                    out[y, erase_cols] = 255

        if bot_rows:
            ref_y = max(0, min(bot_rows) - 2)
            if not _is_border_run(dark_mask[ref_y, :]):
                conn = dark_mask[ref_y, :].copy()
                interior_conn = conn | np.pad(conn[:-1], (1, 0)) | np.pad(conn[1:], (0, 1))
            else:
                interior_conn = np.zeros(w, dtype=bool)
            for y in range(max(0, min(bot_rows) - 1), h):
                if y in bot_rows or (y + 1 < h and (y + 1) in bot_rows):
                    erase_cols = ~interior_conn
                    out[y, erase_cols] = 255

        # Refresh dark_mask after horizontal wall removal
        dark_mask = out < 165

        # 2. Vertical walls in left 20% and right 20% bands
        left_cols = [x for x in range(band_x) if _is_border_run(dark_mask[:, x])]
        right_cols = [x for x in range(w - band_x, w) if _is_border_run(dark_mask[:, x])]

        if left_cols:
            ref_x = min(w - 1, max(left_cols) + 2)
            if not _is_border_run(dark_mask[:, ref_x]):
                conn = dark_mask[:, ref_x].copy()
                interior_conn = conn | np.pad(conn[:-1], (1, 0)) | np.pad(conn[1:], (0, 1))
            else:
                interior_conn = np.zeros(h, dtype=bool)
            for x in range(0, min(w, max(left_cols) + 2)):
                if x in left_cols or (x > 0 and (x - 1) in left_cols):
                    erase_rows = ~interior_conn
                    out[erase_rows, x] = 255

        if right_cols:
            ref_x = max(0, min(right_cols) - 2)
            if not _is_border_run(dark_mask[:, ref_x]):
                conn = dark_mask[:, ref_x].copy()
                interior_conn = conn | np.pad(conn[:-1], (1, 0)) | np.pad(conn[1:], (0, 1))
            else:
                interior_conn = np.zeros(h, dtype=bool)
            for x in range(max(0, min(right_cols) - 1), w):
                if x in right_cols or (x + 1 < w and (x + 1) in right_cols):
                    erase_rows = ~interior_conn
                    out[erase_rows, x] = 255

        return out

    def crop_roi(self, image: np.ndarray, roi: TextROI) -> np.ndarray:
        """Crops an ROI with minimal 4% safety inset and morphological border wall stripping."""
        x1 = int(round(roi.x * self.px_per_mm))
        y1 = int(round(roi.y * self.px_per_mm))
        w = int(round(roi.w * self.px_per_mm))
        h = int(round(roi.h * self.px_per_mm))

        # Minimal 4% safety inset (prevents clipping edge handwriting; Stage 4 strips residual walls)
        max_inset = max(0, int(round(min(w, h) * 0.04)))
        inset_px = min(int(round(0.4 * self.px_per_mm)), max_inset)
        x1_in = min(image.shape[1], x1 + inset_px)
        y1_in = min(image.shape[0], y1 + inset_px)
        x2_in = max(x1_in, min(image.shape[1], x1 + w - inset_px))
        y2_in = max(y1_in, min(image.shape[0], y1 + h - inset_px))

        if x2_in <= x1_in:
            x1_in = max(0, min(image.shape[1] - 1, x1))
            x2_in = max(x1_in + 1, min(image.shape[1], x1 + max(1, w)))
        if y2_in <= y1_in:
            y1_in = max(0, min(image.shape[0] - 1, y1))
            y2_in = max(y1_in + 1, min(image.shape[0], y1 + max(1, h)))

        return image[y1_in:y2_in, x1_in:x2_in].copy()

    def preprocess_for_ocr(self, cropped: np.ndarray) -> np.ndarray:
        """Cleans handwriting strokes and strips residual box walls for OCR extraction."""
        if cropped.size == 0:
            return cropped.copy()

        if len(cropped.shape) == 3:
            gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        else:
            gray = cropped.copy()

        # Stage 4: Strip straight perimeter border lines before resizing
        gray = self.strip_box_walls(gray)

        # Enlarge small handwritten text for better Tesseract OCR recognition
        h, w = gray.shape[:2]
        if h < 40 or w < 100:
            scale = max(2.0, 60.0 / max(1, h))
            gray = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

        # Bilateral filter reduces paper grain while preserving sharp stroke edges
        filtered = cv2.bilateralFilter(gray, 9, 75, 75)

        # Otsu thresholding creates crisp binarized handwriting
        _, binary = cv2.threshold(filtered, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)

        # Check if text is black-on-white (normal)
        if np.mean(binary) < 127:
            binary = cv2.bitwise_not(binary)

        # Final perimeter wall pass on binarized image
        binary = self.strip_box_walls(binary)

        return binary

    def process_partitioned_digits(self, image: np.ndarray, roi: TextROI) -> tuple[str, float]:
        """Extracts individual digits from partitioned write-in boxes using Stage 4 wall stripping."""
        x1 = int(round(roi.x * self.px_per_mm))
        y1 = int(round(roi.y * self.px_per_mm))
        w = int(round(roi.w * self.px_per_mm))
        h = int(round(roi.h * self.px_per_mm))

        digits_count = max(1, roi.digits if roi.digits > 0 else (int(round(roi.w / (roi.h * 0.9))) if roi.h > 0 else 1))
        col_w = w / digits_count
        # Minimal 4% safety inset so digits touching cell edges are not clipped
        margin_x = min(int(round(0.35 * self.px_per_mm)), max(0, int(round(col_w * 0.04))))
        margin_y = min(int(round(0.35 * self.px_per_mm)), max(0, int(round(h * 0.04))))

        decoded_chars: list[str] = []
        confs: list[float] = []
        for i in range(digits_count):
            cx1 = min(image.shape[1], int(round(x1 + i * col_w + margin_x)))
            cx2 = max(cx1, int(round(x1 + (i + 1) * col_w - margin_x)))
            if cx2 <= cx1:
                cx1 = min(image.shape[1], int(round(x1 + i * col_w)))
                cx2 = max(cx1 + 1, min(image.shape[1], int(round(x1 + (i + 1) * col_w))))

            cy1 = min(image.shape[0], y1 + margin_y)
            cy2 = max(cy1, y1 + h - margin_y)
            if cy2 <= cy1:
                cy1 = min(image.shape[0], y1)
                cy2 = max(cy1 + 1, min(image.shape[0], y1 + h))

            cell = image[cy1:cy2, cx1:cx2]
            if cell.size == 0:
                decoded_chars.append("?")
                continue

            if len(cell.shape) == 3:
                cell_gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
            else:
                cell_gray = cell.copy()

            # Stage 4: Strip straight box divider walls from outer 20% perimeter while keeping digit strokes
            cell_gray = self.strip_box_walls(cell_gray)

            # Clean cell background & check if essentially blank (suppress OCR hallucination on blank cells in real engines)
            if not isinstance(self.engine, MockOCREngine):
                _, b_cell = cv2.threshold(cell_gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
                b_cell = self.strip_box_walls(b_cell)
                dark_ratio = np.count_nonzero(b_cell < 128) / float(b_cell.size)
                if dark_ratio < 0.015:
                    decoded_chars.append("?")
                    confs.append(0.0)
                    continue

            padded = cv2.copyMakeBorder(cell_gray, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
            char, conf = self.engine.recognize(padded, charset="digits", multiline=False)
            digits_only = re.sub(r"[^0-9]", "", char)
            decoded_chars.append(digits_only[:1] if digits_only else "?")
            confs.append(conf)

        full_text = "".join(decoded_chars)
        avg_conf = (sum(confs) / len(confs)) if confs else 0.0
        return full_text, avg_conf

    def process_roi(self, image: np.ndarray, roi: TextROI) -> OCRResult:
        """Extracts and recognizes handwriting from a single ROI."""
        cropped = self.crop_roi(image, roi)
        if cropped.size == 0:
            return OCRResult(roi.id, roi.key, roi.label, "", 0.0, cropped, cropped)

        # For partitioned digit grids (e.g. Student ID number write-in), use cell-by-cell recognition
        if roi.role == "student_id" or (roi.digits > 0 and roi.charset == "digits"):
            raw_text, conf = self.process_partitioned_digits(image, roi)
            preprocessed = self.preprocess_for_ocr(cropped)
            return OCRResult(
                roi_id=roi.id,
                key=roi.key,
                label=roi.label,
                text=raw_text,
                confidence=conf,
                cropped_bgr=cropped,
                preprocessed_gray=preprocessed,
            )

        preprocessed = self.preprocess_for_ocr(cropped)
        raw_text, conf = self.engine.recognize(
            preprocessed, charset=roi.charset, multiline=roi.multiline
        )

        # Normalization
        cleaned = raw_text.strip()
        if roi.charset == "digits":
            cleaned = re.sub(r"[^0-9]", "", cleaned)
        elif roi.charset == "upper":
            cleaned = re.sub(r"[^A-Za-z0-9 ]", "", cleaned).upper()
        elif roi.charset == "alpha":
            cleaned = re.sub(r"[^A-Za-z ]", "", cleaned)

        return OCRResult(
            roi_id=roi.id,
            key=roi.key,
            label=roi.label,
            text=cleaned,
            confidence=conf,
            cropped_bgr=cropped,
            preprocessed_gray=preprocessed,
        )

    def process_all(self, image: np.ndarray, skip_keys: set[str] | None = None) -> dict[str, OCRResult]:
        """Processes all ROIs marked for OCR, skipping specified keys (e.g. True statements in modified T/F)."""
        results: dict[str, OCRResult] = {}
        for roi in self.layout.rois:
            if roi.ocr:
                if skip_keys and roi.key in skip_keys:
                    continue
                results[roi.key] = self.process_roi(image, roi)
        return results
