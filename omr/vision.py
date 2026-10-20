"""Computer Vision OMR Pipeline.

Ingests scanned images (JPEG, PNG), performs fiducial detection and perspective
rectification against the canonical layout coordinates, isolates bubble
bounding boxes via contour analysis & adaptive thresholding, and measures pixel
fill ratios to decode student marks.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import cv2
import numpy as np

from omr.layout import BubbleGroup, Fiducial, Layout

# Default rendering resolution for rectified canonical sheet (dots per mm).
# 10 px/mm = 254 DPI, offering high precision for 4mm bubbles and fiducials.
DEFAULT_PX_PER_MM = 10.0

ARUCO_DICT_MAP = {
    "DICT_4X4_50": cv2.aruco.DICT_4X4_50,
    "DICT_4X4_100": cv2.aruco.DICT_4X4_100,
    "DICT_4X4_250": cv2.aruco.DICT_4X4_250,
    "DICT_5X5_50": cv2.aruco.DICT_5X5_50,
    "DICT_6X6_50": cv2.aruco.DICT_6X6_50,
}


class VisionError(RuntimeError):
    """Raised when fiducials cannot be localized or perspective warping fails."""


@dataclass(frozen=True)
class BubbleMeasurement:
    """Quantitative measurement for a single option bubble."""

    value: str
    target_cx_mm: float
    target_cy_mm: float
    target_cx_px: int
    target_cy_px: int
    detected_cx_px: int
    detected_cy_px: int
    detected_radius_px: int
    fill_ratio: float  # Dark pixel density inside inner bubble core [0.0, 1.0]
    is_filled: bool
    contour_found: bool


@dataclass
class GroupResult:
    """Decoded result for a question or student-ID column."""

    key: str
    kind: str  # "sid", "mcq", "tf"
    label: str
    measurements: list[BubbleMeasurement]
    selected_values: list[str] = field(default_factory=list)
    resolved_value: str = "?"  # Single chosen value, "?" (blank), or "*" (multi)
    fill_margin: float = 0.0  # Gap between highest fill ratio and runner-up/threshold
    is_ambiguous: bool = False
    review_reason: str = ""

    @property
    def is_blank(self) -> bool:
        return self.resolved_value == "?"

    @property
    def is_multi(self) -> bool:
        return self.resolved_value == "*"


@dataclass
class WarpResult:
    """Rectified sheet image and transformation matrix."""

    warped_bgr: np.ndarray
    warped_gray: np.ndarray
    homography: np.ndarray
    inv_homography: np.ndarray
    px_per_mm: float
    detected_corners_px: dict[int, np.ndarray]  # ArUco id -> (4, 2) corner coords


class SheetWarper:
    """Detects ArUco fiducials and rectifies scanned sheets to layout space."""

    def __init__(self, layout: Layout, px_per_mm: float = DEFAULT_PX_PER_MM):
        self.layout = layout
        self.px_per_mm = px_per_mm
        self.target_w_px = int(round(layout.page_width * px_per_mm))
        self.target_h_px = int(round(layout.page_height * px_per_mm))

        dict_id = ARUCO_DICT_MAP.get(layout.dictionary, cv2.aruco.DICT_4X4_50)
        self.aruco_dict = cv2.aruco.getPredefinedDictionary(dict_id)
        if hasattr(cv2.aruco, "ArucoDetector"):
            params = cv2.aruco.DetectorParameters()
            params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
            self.detector = cv2.aruco.ArucoDetector(self.aruco_dict, params)
        else:
            self.detector = None

    def _detect_markers(self, gray: np.ndarray):
        """Locates ArUco markers returning corners and IDs."""
        if self.detector is not None:
            corners, ids, _ = self.detector.detectMarkers(gray)
        else:
            params = cv2.aruco.DetectorParameters_create()
            corners, ids, _ = cv2.aruco.detectMarkers(gray, self.aruco_dict, parameters=params)
        return corners, ids

    def warp(self, image: np.ndarray) -> WarpResult:
        """Correct skew, scale, and rotation to align with layout geometry."""
        if image is None or image.size == 0:
            raise VisionError("Empty image provided to warp.")

        if len(image.shape) == 2:
            gray = image
            bgr = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        else:
            bgr = image
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # 1. Primary detection
        corners, ids = self._detect_markers(gray)

        # If markers missing, attempt gentle adaptive thresholding or CLAHE for low-contrast scans
        if ids is None or len(ids) < 4:
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            corners, ids = self._detect_markers(enhanced)

        detected_map: dict[int, np.ndarray] = {}
        if ids is not None:
            for i, marker_id in enumerate(ids.flatten()):
                detected_map[int(marker_id)] = corners[i][0]  # shape (4, 2)

        required_ids = [f.id for f in self.layout.fiducials]
        missing = [fid for fid in required_ids if fid not in detected_map]

        if missing:
            # Fallback: if 3 markers detected, reconstruct 4th affine corner
            if len(detected_map) >= 3 and len(missing) == 1:
                detected_map = self._estimate_missing_fiducial(detected_map, missing[0])
            else:
                raise VisionError(
                    f"Fiducial detection failed. Expected 4 markers {required_ids}, found {list(detected_map.keys())}. Missing: {missing}"
                )

        # Build source and destination point correspondences
        # Each marker provides 4 corners (TL, TR, BR, BL in ArUco convention), yielding 16 point pairs
        src_pts: list[tuple[float, float]] = []
        dst_pts: list[tuple[float, float]] = []

        fid_dict: dict[int, Fiducial] = {f.id: f for f in self.layout.fiducials}
        for fid in required_ids:
            marker_corners_px = detected_map[fid]  # (4, 2)
            fid_spec = fid_dict[fid]
            for c_idx, (mm_x, mm_y) in enumerate(fid_spec.corners):
                src_pts.append(marker_corners_px[c_idx])
                dst_pts.append((mm_x * self.px_per_mm, mm_y * self.px_per_mm))

        src_arr = np.array(src_pts, dtype=np.float32)
        dst_arr = np.array(dst_pts, dtype=np.float32)

        # Compute optimal homography using RANSAC
        H, _ = cv2.findHomography(src_arr, dst_arr, cv2.RANSAC, 5.0)
        if H is None:
            raise VisionError("Could not calculate homography matrix from detected markers.")

        try:
            inv_H = np.linalg.inv(H)
        except np.linalg.LinAlgError as exc:
            raise VisionError(f"Singular homography matrix calculated from detected markers: {exc}") from exc
        warped_bgr = cv2.warpPerspective(
            bgr,
            H,
            (self.target_w_px, self.target_h_px),
            flags=cv2.INTER_LANCZOS4,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )
        warped_gray = cv2.cvtColor(warped_bgr, cv2.COLOR_BGR2GRAY)

        return WarpResult(
            warped_bgr=warped_bgr,
            warped_gray=warped_gray,
            homography=H,
            inv_homography=inv_H,
            px_per_mm=self.px_per_mm,
            detected_corners_px=detected_map,
        )

    def _estimate_missing_fiducial(self, detected: dict[int, np.ndarray], missing_id: int) -> dict[int, np.ndarray]:
        """Estimate 4th marker position via affine parallelogram completion when 3 markers are present."""
        fid_by_id = {f.id: f for f in self.layout.fiducials}
        corner_to_id = {f.corner: f.id for f in self.layout.fiducials}
        missing_corner = fid_by_id[missing_id].corner

        # Parallelogram relation: TL + BR = TR + BL
        # Vector estimation for missing corner
        centers = {}
        for mid, pts in detected.items():
            centers[fid_by_id[mid].corner] = np.mean(pts, axis=0)

        needed = {"tl", "tr", "br", "bl"} - {missing_corner}
        if not needed.issubset(centers.keys()):
            return detected

        if missing_corner == "bl":
            est_center = centers["tl"] + centers["br"] - centers["tr"]
            ref_pts = detected[corner_to_id["tl"]] - centers["tl"]
        elif missing_corner == "br":
            est_center = centers["tr"] + centers["bl"] - centers["tl"]
            ref_pts = detected[corner_to_id["tr"]] - centers["tr"]
        elif missing_corner == "tr":
            est_center = centers["tl"] + centers["br"] - centers["bl"]
            ref_pts = detected[corner_to_id["tl"]] - centers["tl"]
        else:  # tl
            est_center = centers["tr"] + centers["bl"] - centers["br"]
            ref_pts = detected[corner_to_id["tr"]] - centers["tr"]

        est_corners = ref_pts + est_center
        out = dict(detected)
        out[missing_id] = est_corners
        return out


class BubbleScanner:
    """Analyzes rectified sheets to detect and decode filled bubbles."""

    def __init__(
        self,
        layout: Layout,
        px_per_mm: float = DEFAULT_PX_PER_MM,
        fill_threshold: float = 0.35,
        min_contrast_delta: float = 0.12,
    ):
        self.layout = layout
        self.px_per_mm = px_per_mm
        self.fill_threshold = fill_threshold
        self.min_contrast_delta = min_contrast_delta
        self.expected_radius_px = int(round((layout.bubble_diameter / 2.0) * px_per_mm))

    def preprocess(self, gray: np.ndarray) -> np.ndarray:
        """Generate binary mask highlighting dark pencil marks (filled areas = 255)."""
        # Gaussian blur to suppress scanner sensor noise
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Adaptive thresholding: pencil fills become white (255), background stays black (0)
        # Using THRESH_BINARY_INV with a block size scaled to bubble size (~2x bubble diameter)
        block_size = int(round(self.expected_radius_px * 3.5))
        if block_size % 2 == 0:
            block_size += 1
        block_size = max(11, block_size)

        binary = cv2.adaptiveThreshold(
            blurred,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            block_size,
            C=12,
        )
        return binary

    def _refine_bubble_center(
        self, gray: np.ndarray, binary: np.ndarray, expected_cx: int, expected_cy: int, search_radius: int
    ) -> tuple[int, int, int, bool]:
        """Uses contour analysis and circular ring alignment to pinpoint the true bubble circle."""
        h, w = binary.shape[:2]
        x1 = max(0, expected_cx - search_radius)
        y1 = max(0, expected_cy - search_radius)
        x2 = min(w, expected_cx + search_radius)
        y2 = min(h, expected_cy + search_radius)

        roi = binary[y1:y2, x1:x2]
        best_center = (expected_cx, expected_cy)
        best_radius = self.expected_radius_px
        best_score = float("inf")
        found = False

        exp_r = self.expected_radius_px
        if roi.size > 0:
            contours, _ = cv2.findContours(roi, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours:
                area = cv2.contourArea(cnt)
                # Filter contours by expected bubble bounding area
                if area < math.pi * (exp_r * 0.4) ** 2:
                    continue

                (cx_rel, cy_rel), r = cv2.minEnclosingCircle(cnt)
                # Proximity to nominal center + size ratio score
                dist = math.hypot(cx_rel - (expected_cx - x1), cy_rel - (expected_cy - y1))
                size_diff = abs(r - exp_r) / exp_r

                if dist < search_radius * 0.8 and size_diff < 0.45:
                    score = dist + size_diff * 10
                    if score < best_score:
                        best_score = score
                        best_center = (int(round(x1 + cx_rel)), int(round(y1 + cy_rel)))
                        best_radius = int(round(r))
                        found = True

        # Fallback/refinement via circular ring intensity on gray:
        # Especially valuable for empty or lightly marked bubbles on wavy paper
        if not found and gray is not None and gray.size > 0:
            angles = [2 * math.pi * k / 12 for k in range(12)]
            cos_sin = [(math.cos(a) * exp_r, math.sin(a) * exp_r) for a in angles]
            best_ring_lum = float("inf")
            step = max(1, search_radius // 6)
            for dy in range(-search_radius, search_radius + 1, step):
                for dx in range(-search_radius, search_radius + 1, step):
                    cx = expected_cx + dx
                    cy = expected_cy + dy
                    lum_sum = 0
                    valid = True
                    for ca, sa in cos_sin:
                        px = int(round(cx + ca))
                        py = int(round(cy + sa))
                        if 0 <= px < w and 0 <= py < h:
                            lum_sum += int(gray[py, px])
                        else:
                            valid = False
                            break
                    if valid and lum_sum < best_ring_lum:
                        best_ring_lum = lum_sum
                        best_center = (cx, cy)
                        found = True

        return best_center[0], best_center[1], best_radius, found

    def measure_bubble(
        self,
        gray: np.ndarray,
        binary: np.ndarray,
        bubble_mm_cx: float,
        bubble_mm_cy: float,
        value: str,
    ) -> BubbleMeasurement:
        """Measures the fill ratio of a single bubble."""
        target_cx = int(round(bubble_mm_cx * self.px_per_mm))
        target_cy = int(round(bubble_mm_cy * self.px_per_mm))

        # Search window for contour alignment (~0.5x diameter)
        search_r = max(4, int(round(self.expected_radius_px * 0.8)))
        det_cx, det_cy, det_r, contour_found = self._refine_bubble_center(
            gray, binary, target_cx, target_cy, search_r
        )

        # Core mask: measure density within 75% of bubble radius to avoid the printed border
        inner_r = max(2, int(round(det_r * 0.72)))
        h, w = gray.shape[:2]

        # Create localized circular mask
        y_min = max(0, det_cy - inner_r)
        y_max = min(h, det_cy + inner_r + 1)
        x_min = max(0, det_cx - inner_r)
        x_max = min(w, det_cx + inner_r + 1)

        y_coords, x_coords = np.ogrid[y_min:y_max, x_min:x_max]
        dist_from_center = (x_coords - det_cx) ** 2 + (y_coords - det_cy) ** 2
        circle_mask = dist_from_center <= (inner_r**2)

        roi_binary = binary[y_min:y_max, x_min:x_max]
        if np.count_nonzero(circle_mask) == 0:
            fill_ratio = 0.0
        else:
            filled_pixels = np.count_nonzero(roi_binary[circle_mask])
            total_mask_pixels = np.count_nonzero(circle_mask)
            fill_ratio = float(filled_pixels / total_mask_pixels)

        return BubbleMeasurement(
            value=value,
            target_cx_mm=bubble_mm_cx,
            target_cy_mm=bubble_mm_cy,
            target_cx_px=target_cx,
            target_cy_px=target_cy,
            detected_cx_px=det_cx,
            detected_cy_px=det_cy,
            detected_radius_px=det_r,
            fill_ratio=fill_ratio,
            is_filled=fill_ratio >= self.fill_threshold,
            contour_found=contour_found,
        )

    def scan_group(self, gray: np.ndarray, binary: np.ndarray, group: BubbleGroup) -> GroupResult:
        """Decodes an answer choice or ID digit by evaluating all candidate bubbles."""
        measurements: list[BubbleMeasurement] = []
        for opt in group.options:
            meas = self.measure_bubble(gray, binary, opt.cx, opt.cy, opt.value)
            measurements.append(meas)

        # Sort options descending by fill ratio
        sorted_m = sorted(measurements, key=lambda m: m.fill_ratio, reverse=True)
        top = sorted_m[0]
        second = sorted_m[1] if len(sorted_m) > 1 else None

        filled_options = [m.value for m in measurements if m.is_filled]

        # Dynamic differential thresholding:
        # A bubble can be accepted if it clearly stands out from the rest, even if faint
        is_distinct = False
        if second is not None:
            margin = top.fill_ratio - second.fill_ratio
            if top.fill_ratio > 0.22 and margin >= self.min_contrast_delta:
                is_distinct = True
        else:
            margin = top.fill_ratio
            is_distinct = top.fill_ratio >= self.fill_threshold

        resolved = "?"
        ambiguous = False

        if len(filled_options) == 1:
            resolved = filled_options[0]
        elif len(filled_options) > 1:
            # Over-marked / multiple marks
            # If one mark is overwhelmingly darker than the second (e.g. erasure smudge), accept it
            if is_distinct and (top.fill_ratio - second.fill_ratio >= 0.20):
                resolved = top.value
            else:
                resolved = "*"
                ambiguous = True
        elif is_distinct:
            # Faint single mark above delta
            resolved = top.value

        return GroupResult(
            key=group.key,
            kind=group.kind,
            label=group.label,
            measurements=measurements,
            selected_values=filled_options if len(filled_options) > 0 else ([resolved] if resolved != "?" else []),
            resolved_value=resolved,
            fill_margin=float(margin) if second else top.fill_ratio,
            is_ambiguous=ambiguous,
        )

    def scan_all(self, gray: np.ndarray, binary: np.ndarray) -> tuple[dict[str, GroupResult], str]:
        """Processes all groups defined in the template.

        Returns:
            (dict of item_key -> GroupResult, decoded student_id string)
        """
        results: dict[str, GroupResult] = {}
        for group in self.layout.groups:
            res = self.scan_group(gray, binary, group)
            results[group.key] = res

        # Assemble student ID string
        sid_chars: list[str] = []
        for sid_group in self.layout.sid_groups:
            res = results.get(sid_group.key)
            if res:
                sid_chars.append(res.resolved_value)
            else:
                sid_chars.append("?")

        decoded_sid = "".join(sid_chars)
        return results, decoded_sid
