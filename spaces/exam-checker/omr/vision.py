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


# Canonical 4x4 bit grids for DICT_4X4_50 markers 0..5 (1 = white cell, 0 = black cell)
ARUCO_4X4_PAYLOADS: dict[int, np.ndarray] = {
    0: np.array([[1, 0, 1, 1], [0, 1, 0, 1], [0, 0, 1, 1], [0, 0, 1, 0]], dtype=np.uint8),
    1: np.array([[0, 0, 0, 0], [1, 1, 1, 1], [1, 0, 0, 1], [1, 0, 1, 0]], dtype=np.uint8),
    2: np.array([[0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 0], [1, 1, 0, 1]], dtype=np.uint8),
    3: np.array([[1, 0, 0, 1], [1, 0, 0, 1], [0, 1, 0, 0], [0, 1, 1, 0]], dtype=np.uint8),
    4: np.array([[0, 1, 0, 1], [0, 1, 0, 0], [1, 0, 0, 1], [1, 1, 1, 0]], dtype=np.uint8),
    5: np.array([[0, 1, 1, 1], [1, 0, 0, 1], [1, 1, 0, 0], [1, 1, 0, 1]], dtype=np.uint8),
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
    mark_type: str = "blank"  # "shaded" | "check_or_cross" | "erasure" | "faint" | "blank"
    quadrant_densities: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    uniformity: float = 0.0
    paper_halo_lum: float = 255.0


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
    zone_offset_px: tuple[int, int] = (0, 0)

    @property
    def is_blank(self) -> bool:
        return self.resolved_value == "?"

    @property
    def is_multi(self) -> bool:
        return self.resolved_value == "*"

    @property
    def needs_review(self) -> bool:
        return bool(self.review_reason or self.is_ambiguous)


@dataclass
class WarpResult:
    """Rectified sheet image and transformation matrix."""

    warped_bgr: np.ndarray
    warped_gray: np.ndarray
    homography: np.ndarray
    inv_homography: np.ndarray
    px_per_mm: float
    detected_corners_px: dict[int, np.ndarray]  # ArUco id -> (4, 2) corner coords
    rotation_deg: int = 0
    recovered_fiducial_ids: list[int] = field(default_factory=list)
    review_notes: list[str] = field(default_factory=list)


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

    def _decode_quad_bitgrid(self, gray: np.ndarray, quad_pts: np.ndarray) -> tuple[int, int] | None:
        """Verifies a 4-corner quad against DICT_4X4_50 6x6 bit matrices across 0/90/180/270 deg.

        Returns:
            (marker_id, rotation_steps_ccw) or None if not a valid ArUco marker.
        """
        patch_size = 36  # 6x6 cells, 6x6 px per cell
        dst = np.array(
            [[0, 0], [patch_size - 1, 0], [patch_size - 1, patch_size - 1], [0, patch_size - 1]],
            dtype=np.float32,
        )
        M = cv2.getPerspectiveTransform(quad_pts.astype(np.float32), dst)
        patch = cv2.warpPerspective(gray, M, (patch_size, patch_size), flags=cv2.INTER_LINEAR)
        _, thresh = cv2.threshold(patch, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)

        # Sample central 4x4 region of each of the 6x6 cells
        grid = np.zeros((6, 6), dtype=np.uint8)
        for r in range(6):
            for c in range(6):
                cell = thresh[r * 6 + 1 : r * 6 + 5, c * 6 + 1 : c * 6 + 5]
                grid[r, c] = 1 if np.mean(cell) > 127.0 else 0

        # Outer 1-cell border must be predominantly black (0)
        border_vals = np.concatenate([grid[0, :], grid[5, :], grid[1:5, 0], grid[1:5, 5]])
        if np.sum(border_vals == 0) < 16:  # At least 16 of 20 border cells black
            return None

        inner = grid[1:5, 1:5]
        best_id = None
        best_rot = 0
        best_dist = 3  # Max Hamming distance allowed = 2 out of 16 bits

        for mid, payload in ARUCO_4X4_PAYLOADS.items():
            for rot in range(4):
                # Rotate canonical payload clockwise by `rot` steps to match rotated scan
                rotated_payload = np.rot90(payload, k=-rot)
                dist = int(np.sum(inner != rotated_payload))
                if dist < best_dist:
                    best_dist = dist
                    best_id = mid
                    best_rot = rot

        if best_id is not None:
            return best_id, best_rot
        return None

    def _detect_markers_contour_fallback(
        self, gray: np.ndarray, existing_map: dict[int, np.ndarray]
    ) -> dict[int, np.ndarray]:
        """Stage 1 fallback: locates dark quadrilateral contours and decodes 6x6 ArUco bit grids."""
        out = dict(existing_map)
        required_ids = {f.id for f in self.layout.fiducials}
        if required_ids.issubset(out.keys()):
            return out

        h, w = gray.shape[:2]
        min_area = max(64.0, (min(h, w) * 0.012) ** 2)
        max_area = (min(h, w) * 0.18) ** 2

        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        block_sz = max(31, int(round(min(h, w) * 0.08)) | 1)
        bin_adapt31 = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 7
        )
        bin_adapt_large = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block_sz, 7
        )
        _, bin_otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)

        for binary in (bin_adapt31, bin_adapt_large, bin_otsu):
            if required_ids.issubset(out.keys()):
                break
            contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

            for cnt in contours:
                area = cv2.contourArea(cnt)
                if not (min_area <= area <= max_area):
                    continue
                peri = cv2.arcLength(cnt, True)
                approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
                if len(approx) != 4 or not cv2.isContourConvex(approx):
                    continue

                pts = approx.reshape(4, 2).astype(np.float32)
                # Order 4 vertices cyclically clockwise around centroid starting at top-left (min x+y)
                center = np.mean(pts, axis=0)
                angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
                cw_order = np.argsort(angles)
                cyc_pts = pts[cw_order]
                tl_idx = int(np.argmin(cyc_pts.sum(axis=1)))
                ordered = np.roll(cyc_pts, shift=-tl_idx, axis=0)

                # Check aspect ratio of quad
                w_top = np.linalg.norm(ordered[1] - ordered[0])
                h_left = np.linalg.norm(ordered[3] - ordered[0])
                if h_left < 4 or not (0.55 <= (w_top / h_left) <= 1.80):
                    continue

                decoded = self._decode_quad_bitgrid(gray, ordered)
                if decoded is not None:
                    mid, rot_cw = decoded
                    if mid in required_ids and mid not in out:
                        # Roll corners so corner 0 is the marker's canonical TL corner
                        canonical_corners = np.roll(ordered, shift=-rot_cw, axis=0)
                        out[mid] = canonical_corners

        return out

    def _infer_rotation_deg(self, detected_map: dict[int, np.ndarray]) -> int:
        """Infers sheet rotation (0, 90, 180, 270 degrees CW) from marker corner vectors."""
        angles: list[float] = []
        for pts in detected_map.values():
            # Vector from marker corner 0 (TL) to corner 1 (TR)
            vec = pts[1] - pts[0]
            ang = math.degrees(math.atan2(float(vec[1]), float(vec[0]))) % 360.0
            angles.append(ang)
        if not angles:
            return 0
        # Circular mean of angles snapped to nearest 90 degrees
        sin_sum = sum(math.sin(math.radians(a)) for a in angles)
        cos_sum = sum(math.cos(math.radians(a)) for a in angles)
        mean_ang = math.degrees(math.atan2(sin_sum, cos_sum)) % 360.0
        snapped = int(round(mean_ang / 90.0) * 90) % 360
        return snapped

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

        # 1. Primary OpenCV ArUco detection
        corners, ids = self._detect_markers(gray)

        # If markers missing, attempt CLAHE contrast enhancement
        if ids is None or len(ids) < 4:
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(gray)
            c2, i2 = self._detect_markers(enhanced)
            if i2 is not None and (ids is None or len(i2) > len(ids)):
                corners, ids = c2, i2

        detected_map: dict[int, np.ndarray] = {}
        if ids is not None:
            for i, marker_id in enumerate(ids.flatten()):
                detected_map[int(marker_id)] = corners[i][0]  # shape (4, 2)

        required_ids = [f.id for f in self.layout.fiducials]
        missing = [fid for fid in required_ids if fid not in detected_map]

        # 2. Stage 1 Contour + 4x4 Bit-Grid Fallback if any markers are still missing
        if missing:
            detected_map = self._detect_markers_contour_fallback(gray, detected_map)
            missing = [fid for fid in required_ids if fid not in detected_map]

        rotation_deg = self._infer_rotation_deg(detected_map)
        recovered_ids: list[int] = []
        review_notes: list[str] = []

        if missing:
            # 3-Marker Parallelogram Recovery when exactly 3 of 4 markers are verified
            if len([fid for fid in required_ids if fid in detected_map]) >= 3 and len(missing) == 1:
                detected_map = self._estimate_missing_fiducial(detected_map, missing[0])
                recovered_ids.append(missing[0])
                review_notes.append("Aligned using 3 of 4 corner markers")
            else:
                raise VisionError(
                    f"Needs Review: Corner markers not clearly visible. Expected 4 markers {required_ids}, found {list(detected_map.keys())}. Missing: {missing}"
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
            # Anchor each marker's centroid with 4x weight so non-planar curl on mobile scans
            # cannot cause one page corner to be dropped as a RANSAC outlier.
            mc_src = np.mean(marker_corners_px, axis=0)
            mc_dst = np.mean(
                [(mm_x * self.px_per_mm, mm_y * self.px_per_mm) for mm_x, mm_y in fid_spec.corners],
                axis=0,
            )
            for _ in range(4):
                src_pts.append((float(mc_src[0]), float(mc_src[1])))
                dst_pts.append((float(mc_dst[0]), float(mc_dst[1])))

        src_arr = np.array(src_pts, dtype=np.float32)
        dst_arr = np.array(dst_pts, dtype=np.float32)

        # Compute optimal least-squares homography anchoring all 4 corner fiducials
        H, _ = cv2.findHomography(src_arr, dst_arr, 0)
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
            rotation_deg=rotation_deg,
            recovered_fiducial_ids=tuple(recovered_ids),
            review_notes=review_notes,
        )

    def _estimate_missing_fiducial(self, detected: dict[int, np.ndarray], missing_id: int) -> dict[int, np.ndarray]:
        """Estimate 4th marker position via affine parallelogram completion when 3 markers are present."""
        fid_by_id = {f.id: f for f in self.layout.fiducials}
        missing_corner = fid_by_id[missing_id].corner

        # Parallelogram relation: TL + BR = TR + BL
        centers = {}
        rel_vectors = []
        for mid, pts in detected.items():
            if mid in fid_by_id:
                c_pt = np.mean(pts, axis=0)
                centers[fid_by_id[mid].corner] = c_pt
                rel_vectors.append(pts - c_pt)

        needed = {"tl", "tr", "br", "bl"} - {missing_corner}
        if not needed.issubset(centers.keys()) or not rel_vectors:
            return detected

        if missing_corner == "bl":
            est_center = centers["tl"] + centers["br"] - centers["tr"]
        elif missing_corner == "br":
            est_center = centers["tr"] + centers["bl"] - centers["tl"]
        elif missing_corner == "tr":
            est_center = centers["tl"] + centers["br"] - centers["bl"]
        else:  # tl
            est_center = centers["tr"] + centers["bl"] - centers["br"]

        ref_pts = np.mean(rel_vectors, axis=0)
        est_corners = (ref_pts + est_center).astype(np.float32)
        out = dict(detected)
        out[missing_id] = est_corners
        return out


class BubbleScanner:
    """Analyzes rectified sheets to detect and decode filled bubbles using 4-stage morphology."""

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
        self.last_zone_offsets_px: dict[str, tuple[int, int]] = {}

    def preprocess(self, gray: np.ndarray) -> np.ndarray:
        """Generate binary mask highlighting dark pencil marks (filled areas = 255)."""
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

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

    def compute_zone_offset(
        self, gray: np.ndarray, bbox_mm: tuple[float, float, float, float] | object
    ) -> tuple[int, int]:
        """Stage 2: Local section/ID box snapping via horizontal and vertical projection profiles.

        Searches within +/- 3.0mm of expected zone border lines and clamps offset to <= 2.5mm.
        """
        if gray is None or gray.size == 0:
            return 0, 0

        if hasattr(bbox_mm, "bbox"):
            bbox_mm = getattr(bbox_mm, "bbox")

        h, w = gray.shape[:2]
        zx = int(round(bbox_mm[0] * self.px_per_mm))
        zy = int(round(bbox_mm[1] * self.px_per_mm))
        zw = int(round(bbox_mm[2] * self.px_per_mm))
        zh = int(round(bbox_mm[3] * self.px_per_mm))

        if zw < 20 or zh < 15:
            return 0, 0

        search_px = max(3, int(round(3.0 * self.px_per_mm)))
        max_clamp_px = max(2, int(round(2.5 * self.px_per_mm)))

        # Horizontal span for top/bottom border projection (inset 10% from corners)
        x_in1 = max(0, zx + int(round(zw * 0.10)))
        x_in2 = min(w, zx + zw - int(round(zw * 0.10)))
        # Vertical span for left/right border projection (inset 10% from corners)
        y_in1 = max(0, zy + int(round(zh * 0.10)))
        y_in2 = min(h, zy + zh - int(round(zh * 0.10)))

        dx_candidates: list[int] = []
        dy_candidates: list[int] = []

        # Helper to find border line shift in a 1D projection profile
        def _find_border_shift(profile_dark_ratio: np.ndarray, nominal_idx: int) -> int | None:
            if profile_dark_ratio.size == 0:
                return None
            peak_idx = int(np.argmax(profile_dark_ratio))
            peak_val = float(profile_dark_ratio[peak_idx])
            median_val = float(np.median(profile_dark_ratio))
            # Require continuous straight line (>45% dark along border and distinct peak)
            if peak_val >= 0.45 and (peak_val - median_val) >= 0.22:
                shift = peak_idx - nominal_idx
                if abs(shift) <= max_clamp_px:
                    return shift
            return None

        if x_in2 - x_in1 >= 15:
            # Top border band around zy
            ty1 = max(0, zy - search_px)
            ty2 = min(h, zy + search_px + 1)
            if ty2 > ty1:
                band = gray[ty1:ty2, x_in1:x_in2]
                prof = np.mean(band < 160, axis=1)
                shift_top = _find_border_shift(prof, zy - ty1)
                if shift_top is not None:
                    dy_candidates.append(shift_top)

            # Bottom border band around zy + zh
            by_nom = zy + zh
            by1 = max(0, by_nom - search_px)
            by2 = min(h, by_nom + search_px + 1)
            if by2 > by1:
                band = gray[by1:by2, x_in1:x_in2]
                prof = np.mean(band < 160, axis=1)
                shift_bot = _find_border_shift(prof, by_nom - by1)
                if shift_bot is not None:
                    dy_candidates.append(shift_bot)

        if y_in2 - y_in1 >= 12:
            # Left border band around zx
            lx1 = max(0, zx - search_px)
            lx2 = min(w, zx + search_px + 1)
            if lx2 > lx1:
                band = gray[y_in1:y_in2, lx1:lx2]
                prof = np.mean(band < 160, axis=0)
                shift_left = _find_border_shift(prof, zx - lx1)
                if shift_left is not None:
                    dx_candidates.append(shift_left)

            # Right border band around zx + zw
            rx_nom = zx + zw
            rx1 = max(0, rx_nom - search_px)
            rx2 = min(w, rx_nom + search_px + 1)
            if rx2 > rx1:
                band = gray[y_in1:y_in2, rx1:rx2]
                prof = np.mean(band < 160, axis=0)
                shift_right = _find_border_shift(prof, rx_nom - rx1)
                if shift_right is not None:
                    dx_candidates.append(shift_right)

        dx = int(round(float(np.mean(dx_candidates)))) if dx_candidates else 0
        dy = int(round(float(np.mean(dy_candidates)))) if dy_candidates else 0
        dx = max(-max_clamp_px, min(max_clamp_px, dx))
        dy = max(-max_clamp_px, min(max_clamp_px, dy))
        return dx, dy

    def _build_ring_score_map(self, gray: np.ndarray) -> np.ndarray:
        """Precompute 16-ray outward-gradient ring score across the grayscale image.

        Measures how strongly a circle of radius expected_radius_px transitions from dark ink
        on the ring (0.98r) to lighter paper in the outer halo (1.28r) across all 16 angles.
        """
        h, w = gray.shape[:2]
        exp_r = self.expected_radius_px
        r_in = max(2.0, exp_r * 0.98)
        r_out = max(r_in + 2.0, exp_r * 1.28)
        angles = [2.0 * math.pi * k / 16.0 for k in range(16)]
        ring_offsets = [(int(round(math.cos(a) * r_in)), int(round(math.sin(a) * r_in))) for a in angles]
        halo_offsets = [(int(round(math.cos(a) * r_out)), int(round(math.sin(a) * r_out))) for a in angles]
        pad = int(math.ceil(r_out)) + 2
        if h <= 2 * pad or w <= 2 * pad:
            return np.zeros((h, w), dtype=np.float32)

        g_f = gray.astype(np.float32)
        ring_score = np.zeros((h, w), dtype=np.float32)
        ih = h - 2 * pad
        iw = w - 2 * pad
        acc = np.zeros((ih, iw), dtype=np.float32)
        for (rx, ry), (hx, hy) in zip(ring_offsets, halo_offsets):
            ring_p = g_f[pad + ry : pad + ry + ih, pad + rx : pad + rx + iw]
            halo_p = g_f[pad + hy : pad + hy + ih, pad + hx : pad + hx + iw]
            acc += np.clip(halo_p - ring_p, 0.0, 60.0)
        ring_score[pad : h - pad, pad : w - pad] = acc
        return ring_score

    def _refine_bubble_center(
        self, gray: np.ndarray, binary: np.ndarray, expected_cx: int, expected_cy: int, search_radius: int
    ) -> tuple[int, int, int, bool]:
        """Stage 3.1: Uses 16-ray outward-gradient ring alignment to lock onto the printed bubble circle."""
        h, w = binary.shape[:2]
        exp_r = self.expected_radius_px
        best_center = (expected_cx, expected_cy)
        best_radius = exp_r
        found = False

        if gray is not None and gray.size > 0:
            r_in = max(2.0, exp_r * 0.98)
            r_out = max(r_in + 2.0, exp_r * 1.28)
            angles = [2.0 * math.pi * k / 16.0 for k in range(16)]
            ray_vecs = [
                (
                    int(round(math.cos(a) * r_in)),
                    int(round(math.sin(a) * r_in)),
                    int(round(math.cos(a) * r_out)),
                    int(round(math.sin(a) * r_out)),
                )
                for a in angles
            ]
            best_grad_score = -1e9
            step = 1 if search_radius <= 6 else max(1, search_radius // 6)
            for dy in range(-search_radius, search_radius + 1, step):
                for dx in range(-search_radius, search_radius + 1, step):
                    cx = expected_cx + dx
                    cy = expected_cy + dy
                    grad_sum = 0.0
                    pos_rays = 0
                    valid = True
                    for rx, ry, hx, hy in ray_vecs:
                        px_r, py_r = cx + rx, cy + ry
                        px_h, py_h = cx + hx, cy + hy
                        if 0 <= px_r < w and 0 <= py_r < h and 0 <= px_h < w and 0 <= py_h < h:
                            diff = float(gray[py_h, px_h]) - float(gray[py_r, px_r])
                            if diff > 0.0:
                                grad_sum += min(60.0, diff)
                                if diff >= 8.0:
                                    pos_rays += 1
                        else:
                            valid = False
                            break
                    if valid:
                        score = grad_sum - math.hypot(dx, dy) * 3.5
                        if pos_rays >= 8 and score > best_grad_score:
                            best_grad_score = score
                            best_center = (cx, cy)
                            found = True

        return best_center[0], best_center[1], best_radius, found

    def _refine_group_offset(
        self,
        gray: np.ndarray,
        binary: np.ndarray,
        group: BubbleGroup,
        seed_offset_px: tuple[int, int] = (0, 0),
        max_step_px: int = 20,
        ring_score_map: np.ndarray | None = None,
        constellation_pts_px: list[tuple[int, int]] | None = None,
    ) -> tuple[int, int]:
        """Stage 3.0: Jointly aligns a local constellation of bubble rings so bowed mobile scans stay locked."""
        if gray is None or gray.size == 0 or not group.options:
            return 0, 0

        h, w = gray.shape[:2]
        if constellation_pts_px is not None and len(constellation_pts_px) > 0:
            nom_pts = [(px + seed_offset_px[0], py + seed_offset_px[1]) for px, py in constellation_pts_px]
        else:
            nom_pts = [
                (
                    int(round(o.cx * self.px_per_mm)) + seed_offset_px[0],
                    int(round(o.cy * self.px_per_mm)) + seed_offset_px[1],
                )
                for o in group.options
            ]

        search_r = max(4, int(max_step_px))
        if ring_score_map is None:
            ring_score_map = self._build_ring_score_map(gray)

        best_score = -1e9
        best_shift = (0, 0)
        for dy in range(-search_r, search_r + 1):
            for dx in range(-search_r, search_r + 1):
                s = 0.0
                valid = 0
                for ncx, ncy in nom_pts:
                    px = ncx + dx
                    py = ncy + dy
                    if 0 <= px < w and 0 <= py < h:
                        s += float(ring_score_map[py, px])
                        valid += 1
                if valid > 0:
                    score = (s / valid) - math.hypot(dx, dy) * 2.5
                    if score > best_score:
                        best_score = score
                        best_shift = (dx, dy)

        return best_shift

    def measure_bubble(
        self,
        gray: np.ndarray,
        binary: np.ndarray,
        bubble_mm_cx: float,
        bubble_mm_cy: float,
        value: str,
        zone_offset_px: tuple[int, int] = (0, 0),
        fine_search_px: int | None = None,
    ) -> BubbleMeasurement:
        """Stage 3: Measures fill density, local paper halo contrast, and 4-quadrant/8-sector morphology."""
        target_cx = int(round(bubble_mm_cx * self.px_per_mm)) + zone_offset_px[0]
        target_cy = int(round(bubble_mm_cy * self.px_per_mm)) + zone_offset_px[1]

        # Search window for 16-point circumference ring snap (+/- 1.5mm standalone, or tight fine snap after group lock)
        if fine_search_px is not None:
            search_r = max(2, int(fine_search_px))
        else:
            search_r = max(4, int(round(min(1.5 * self.px_per_mm, self.expected_radius_px * 0.85))))
        det_cx, det_cy, det_r, contour_found = self._refine_bubble_center(
            gray, binary, target_cx, target_cy, search_r
        )

        # Inner core radius (70-72% of bubble radius to exclude printed ring)
        inner_r = max(2, int(round(det_r * 0.72)))
        halo_r_in = max(inner_r + 2, int(round(det_r * 1.15)))
        halo_r_out = max(halo_r_in + 2, int(round(det_r * 1.40)))
        h, w = gray.shape[:2]

        # 1. Local Paper Halo Normalization (1.15r to 1.40r)
        hy1 = max(0, det_cy - halo_r_out)
        hy2 = min(h, det_cy + halo_r_out + 1)
        hx1 = max(0, det_cx - halo_r_out)
        hx2 = min(w, det_cx + halo_r_out + 1)
        hy_grid, hx_grid = np.ogrid[hy1:hy2, hx1:hx2]
        h_dist2 = (hx_grid - det_cx) ** 2 + (hy_grid - det_cy) ** 2
        halo_mask = (h_dist2 >= halo_r_in**2) & (h_dist2 <= halo_r_out**2)
        halo_pixels = gray[hy1:hy2, hx1:hx2][halo_mask]
        if halo_pixels.size > 0:
            # Use 75th percentile of annulus to ignore neighboring text/marks while capturing paper shadow
            paper_halo_lum = float(max(80.0, np.percentile(halo_pixels, 75)))
        else:
            paper_halo_lum = 245.0

        # 2. Inner Core Extraction & 4-Quadrant + 8-Sector Decomposition
        y_min = max(0, det_cy - inner_r)
        y_max = min(h, det_cy + inner_r + 1)
        x_min = max(0, det_cx - inner_r)
        x_max = min(w, det_cx + inner_r + 1)

        y_coords, x_coords = np.ogrid[y_min:y_max, x_min:x_max]
        dx_grid = x_coords - det_cx
        dy_grid = y_coords - det_cy
        dist2 = dx_grid**2 + dy_grid**2
        circle_mask = dist2 <= (inner_r**2)

        roi_binary = binary[y_min:y_max, x_min:x_max]
        roi_gray = gray[y_min:y_max, x_min:x_max]

        total_mask_pixels = int(np.count_nonzero(circle_mask))
        if total_mask_pixels == 0:
            return BubbleMeasurement(
                value=value,
                target_cx_mm=bubble_mm_cx,
                target_cy_mm=bubble_mm_cy,
                target_cx_px=target_cx,
                target_cy_px=target_cy,
                detected_cx_px=det_cx,
                detected_cy_px=det_cy,
                detected_radius_px=det_r,
                fill_ratio=0.0,
                is_filled=False,
                contour_found=contour_found,
                mark_type="blank",
                quadrant_densities=(0.0, 0.0, 0.0, 0.0),
                uniformity=0.0,
                paper_halo_lum=paper_halo_lum,
            )

        # Combine binary mask with local paper halo contrast so light grey smudges are measured proportionally
        # Pixels darker than 74% of local paper halo (and darker than printed option letter gray 138)
        contrast_dark_thresh = min(132.0, paper_halo_lum * 0.74)
        active_mask = ((roi_binary > 0) & (roi_gray < contrast_dark_thresh)) | (
            roi_gray < contrast_dark_thresh * 0.92
        )

        binary_fill = float(np.count_nonzero(active_mask & circle_mask) / total_mask_pixels)

        # Also measure continuous halo-normalized grey contrast (captures uniform light grey erasures)
        core_lums = roi_gray[circle_mask].astype(np.float32)
        # Discount small central option character by taking mean contrast of pixels darker than paper halo
        norm_contrasts = np.clip((paper_halo_lum - core_lums) / max(1.0, paper_halo_lum), 0.0, 1.0)
        # Baseline printed letter in empty bubble contributes ~0.03 mean contrast; subtract 0.025 floor
        halo_contrast_fill = float(max(0.0, float(np.mean(norm_contrasts)) - 0.025))
        fill_ratio = float(min(1.0, max(binary_fill, halo_contrast_fill)))

        # 4-Quadrant densities: TL (dx<0, dy<0), TR (dx>=0, dy<0), BL (dx<0, dy>=0), BR (dx>=0, dy>=0)
        q_masks = [
            circle_mask & (dx_grid < 0) & (dy_grid < 0),
            circle_mask & (dx_grid >= 0) & (dy_grid < 0),
            circle_mask & (dx_grid < 0) & (dy_grid >= 0),
            circle_mask & (dx_grid >= 0) & (dy_grid >= 0),
        ]
        q_densities: list[float] = []
        for qm in q_masks:
            q_tot = int(np.count_nonzero(qm))
            if q_tot > 0:
                q_bin = float(np.count_nonzero(active_mask & qm) / q_tot)
                q_con = float(
                    max(
                        0.0,
                        float(
                            np.mean(
                                np.clip(
                                    (paper_halo_lum - roi_gray[qm].astype(np.float32))
                                    / max(1.0, paper_halo_lum),
                                    0.0,
                                    1.0,
                                )
                            )
                        )
                        - 0.025,
                    )
                )
                q_densities.append(max(q_bin, q_con))
            else:
                q_densities.append(0.0)

        max_q = max(q_densities) if q_densities else 0.0
        min_q = min(q_densities) if q_densities else 0.0
        sorted_q = sorted(q_densities)
        second_lowest_q = sorted_q[1] if len(sorted_q) >= 2 else min_q
        uniformity = float(second_lowest_q / max_q) if max_q > 1e-4 else 0.0

        # Mid-outer core ring (0.42 * inner_r <= d <= inner_r) vs center crosshair (d < 0.42 * inner_r)
        center_r2 = (inner_r * 0.42) ** 2
        center_mask = dist2 < center_r2
        mid_outer_mask = circle_mask & (dist2 >= center_r2)

        # High-contrast ink/pencil stroke check (strictly darker than printed gray=140 label)
        stroke_thresh = min(115.0, paper_halo_lum * 0.55)
        stroke_mask = (roi_gray < stroke_thresh) & (roi_binary > 0)
        mid_outer_total = max(1, int(np.count_nonzero(mid_outer_mask)))
        mid_outer_stroke_px = int(np.count_nonzero(stroke_mask & mid_outer_mask))
        mid_outer_bin = float(np.count_nonzero(active_mask & mid_outer_mask) / mid_outer_total)
        mid_outer_con = float(
            max(
                0.0,
                float(
                    np.mean(
                        np.clip(
                            (paper_halo_lum - roi_gray[mid_outer_mask].astype(np.float32))
                            / max(1.0, paper_halo_lum),
                            0.0,
                            1.0,
                        )
                    )
                )
                - 0.025,
            )
        )
        mid_outer_fill = max(mid_outer_bin, mid_outer_con)
        center_total = max(1, int(np.count_nonzero(center_mask)))
        center_fill = float(np.count_nonzero(active_mask & center_mask) / center_total)
        inner_core_mask = dist2 <= ((inner_r * 0.68) ** 2)
        inner_core_stroke_px = int(np.count_nonzero(stroke_mask & inner_core_mask))

        # 8-Sector angular decomposition in mid-outer ring (centered on 0, 45, 90, 135, ... deg via +pi/8 shift)
        angles_grid = (np.arctan2(dy_grid, dx_grid) + 2 * math.pi + (math.pi / 8.0)) % (2 * math.pi)
        sector_fills: list[float] = []
        for s_idx in range(8):
            a_low = s_idx * (math.pi / 4.0)
            a_high = (s_idx + 1) * (math.pi / 4.0)
            s_mask = mid_outer_mask & (angles_grid >= a_low) & (angles_grid < a_high)
            s_tot = int(np.count_nonzero(s_mask))
            if s_tot > 0:
                s_bin = float(np.count_nonzero(active_mask & s_mask) / s_tot)
                s_con = float(
                    max(
                        0.0,
                        float(
                            np.mean(
                                np.clip(
                                    (paper_halo_lum - roi_gray[s_mask].astype(np.float32))
                                    / max(1.0, paper_halo_lum),
                                    0.0,
                                    1.0,
                                )
                            )
                        )
                        - 0.025,
                    )
                )
                sector_fills.append(max(s_bin, s_con))
            else:
                sector_fills.append(0.0)

        max_sec = max(sector_fills) if sector_fills else 0.0
        hollow_sectors = sum(1 for sf in sector_fills if sf < max(0.20, max_sec * 0.35))
        filled_quads = sum(1 for qd in q_densities if qd >= max(0.14, max_q * 0.40))

        # Check alternating cardinal (0, 2, 4, 6) vs diagonal (1, 3, 5, 7) sector contrast for thick X or + marks
        cardinal_mean = float(np.mean([sector_fills[i] for i in (0, 2, 4, 6)])) if len(sector_fills) == 8 else 0.0
        diagonal_mean = float(np.mean([sector_fills[i] for i in (1, 3, 5, 7)])) if len(sector_fills) == 8 else 0.0
        alt_sector_gap = abs(diagonal_mean - cardinal_mean)
        min_axis_mean = min(cardinal_mean, diagonal_mean)

        # Detect check_or_cross:
        # Must have high-contrast dark stroke pixels in the mid-outer ring AND inside the 0.68*inner_r interior,
        # span at least 2 quadrants (rejecting 1-quadrant border rim nicks), and not be a uniform 4-quadrant pencil shade.
        has_sharp_outer_stroke = mid_outer_stroke_px >= max(3, int(round(mid_outer_total * 0.06)))
        has_interior_stroke = inner_core_stroke_px >= 3 and (filled_quads >= 2 or center_fill >= 0.15)
        is_uniform_pencil_shade = (
            filled_quads == 4
            and uniformity >= 0.40
            and fill_ratio >= 0.44
            and alt_sector_gap < 0.28
        )
        is_lopsided_stroke = (
            filled_quads <= 2
            or uniformity < 0.35
            or (min_q < max_q * 0.15 and fill_ratio < 0.42)
        )
        is_crosshair_stroke = (
            (hollow_sectors >= 3 and mid_outer_fill < 0.58 and (center_fill >= 0.32 or max_sec >= 0.32))
            or (center_fill >= 0.65 and alt_sector_gap >= 0.28 and min_axis_mean < 0.40)
        )

        is_check_or_cross = (
            has_sharp_outer_stroke
            and has_interior_stroke
            and not is_uniform_pencil_shade
            and 0.10 <= fill_ratio < 0.72
            and (is_lopsided_stroke or is_crosshair_stroke)
        )

        if is_check_or_cross:
            mark_type = "check_or_cross"
            is_filled = False  # Strict Shading Policy: do not auto-score checkmarks or crosses
        elif fill_ratio >= self.fill_threshold and filled_quads >= 3 and uniformity >= 0.35:
            mark_type = "shaded"
            is_filled = True
        elif fill_ratio >= 0.13:
            mark_type = "faint"
            is_filled = False
        else:
            mark_type = "blank"
            is_filled = False

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
            is_filled=is_filled,
            contour_found=contour_found,
            mark_type=mark_type,
            quadrant_densities=(q_densities[0], q_densities[1], q_densities[2], q_densities[3]),
            uniformity=uniformity,
            paper_halo_lum=paper_halo_lum,
        )

    def scan_group(
        self,
        gray: np.ndarray,
        binary: np.ndarray,
        group: BubbleGroup,
        zone_offset_px: tuple[int, int] = (0, 0),
        fine_search_px: int | None = None,
    ) -> GroupResult:
        """Decodes an answer choice or ID digit using Strict Shading Policy and explicit review flags."""
        measurements: list[BubbleMeasurement] = []
        for opt in group.options:
            meas = self.measure_bubble(
                gray,
                binary,
                opt.cx,
                opt.cy,
                opt.value,
                zone_offset_px=zone_offset_px,
                fine_search_px=fine_search_px,
            )
            measurements.append(meas)

        sorted_m = sorted(measurements, key=lambda m: m.fill_ratio, reverse=True)
        top = sorted_m[0]
        second = sorted_m[1] if len(sorted_m) > 1 else None
        margin = (top.fill_ratio - second.fill_ratio) if second is not None else top.fill_ratio

        # Row baseline from the lowest-density bubbles in the group (accounts for printed option letters)
        if len(sorted_m) >= 3:
            row_baseline = float(np.median([m.fill_ratio for m in sorted_m[2:]]))
        elif second is not None:
            row_baseline = float(second.fill_ratio)
        else:
            row_baseline = 0.0

        # Check for non-standard marks (Check / Cross) that rise meaningfully above the row baseline
        check_cross_bubbles = [
            m
            for m in measurements
            if m.mark_type == "check_or_cross"
            and m.fill_ratio >= 0.12
            and (m.fill_ratio - row_baseline) >= 0.07
        ]
        filled_options = [m.value for m in measurements if m.is_filled]

        # When at least one bubble is properly shaded (filled_options non-empty), a secondary mark on
        # another bubble is either sub-threshold border noise or a possible erasure, not a primary check/cross answer.
        if filled_options and top.is_filled:
            check_cross_bubbles = []

        resolved = "?"
        ambiguous = False
        review_reason = ""

        q_label = f"Q{group.key}" if group.kind != "sid" else group.label

        if check_cross_bubbles:
            # Strict Shading Policy: checkmarks and crosses are flagged for instructor review, not auto-scored
            measurements = [
                BubbleMeasurement(
                    value=m.value,
                    target_cx_mm=m.target_cx_mm,
                    target_cy_mm=m.target_cy_mm,
                    target_cx_px=m.target_cx_px,
                    target_cy_px=m.target_cy_px,
                    detected_cx_px=m.detected_cx_px,
                    detected_cy_px=m.detected_cy_px,
                    detected_radius_px=m.detected_radius_px,
                    fill_ratio=m.fill_ratio,
                    is_filled=False,
                    contour_found=m.contour_found,
                    mark_type=m.mark_type,
                    quadrant_densities=m.quadrant_densities,
                    uniformity=m.uniformity,
                    paper_halo_lum=m.paper_halo_lum,
                )
                for m in measurements
            ]
            resolved = "?"
            ambiguous = True
            review_reason = f"Needs Review: Non-standard mark (Check/Cross) on {q_label}"
        elif len(filled_options) == 1:
            # Check if runner-up bubble shows an erasure smudge (0.14 <= D2 < D1 and elevated above row baseline)
            if (
                second is not None
                and second.fill_ratio >= 0.14
                and (second.fill_ratio - row_baseline) >= 0.08
                and not (top.fill_ratio >= 0.85 and second.fill_ratio < 0.22)
            ):
                resolved = filled_options[0] if group.kind == "sid" else "?"
                # Reclassify runner-up as erasure, and for non-sid items clear is_filled on top so it is held for review
                measurements = [
                    BubbleMeasurement(
                        value=m.value,
                        target_cx_mm=m.target_cx_mm,
                        target_cy_mm=m.target_cy_mm,
                        target_cx_px=m.target_cx_px,
                        target_cy_px=m.target_cy_px,
                        detected_cx_px=m.detected_cx_px,
                        detected_cy_px=m.detected_cy_px,
                        detected_radius_px=m.detected_radius_px,
                        fill_ratio=m.fill_ratio,
                        is_filled=(m.is_filled if group.kind == "sid" else False),
                        contour_found=m.contour_found,
                        mark_type=("erasure" if m.value == second.value else m.mark_type),
                        quadrant_densities=m.quadrant_densities,
                        uniformity=m.uniformity,
                        paper_halo_lum=m.paper_halo_lum,
                    )
                    for m in measurements
                ]
                ambiguous = True
                review_reason = f"Needs Review: Possible erasure on {q_label}"
            else:
                resolved = filled_options[0]
        elif len(filled_options) > 1:
            # Multiple shaded bubbles: check if one is an erasure smudge vs double-shaded
            if second is not None and (top.fill_ratio - second.fill_ratio >= 0.15):
                resolved = (
                    top.value
                    if group.kind == "sid"
                    else ("?" if len(filled_options) == 2 else "*")
                )
                measurements = [
                    BubbleMeasurement(
                        value=m.value,
                        target_cx_mm=m.target_cx_mm,
                        target_cy_mm=m.target_cy_mm,
                        target_cx_px=m.target_cx_px,
                        target_cy_px=m.target_cy_px,
                        detected_cx_px=m.detected_cx_px,
                        detected_cy_px=m.detected_cy_px,
                        detected_radius_px=m.detected_radius_px,
                        fill_ratio=m.fill_ratio,
                        is_filled=(
                            False
                            if m.value == second.value or resolved == "?"
                            else m.is_filled
                        ),
                        contour_found=m.contour_found,
                        mark_type=("erasure" if m.value == second.value else m.mark_type),
                        quadrant_densities=m.quadrant_densities,
                        uniformity=m.uniformity,
                        paper_halo_lum=m.paper_halo_lum,
                    )
                    for m in measurements
                ]
                ambiguous = True
                review_reason = f"Needs Review: Possible erasure on {q_label}"
            else:
                resolved = "*"
                ambiguous = True
                review_reason = f"Needs Review: Multiple marks on {q_label}"
        else:
            # Zero shaded bubbles: check for faint mark (0.13 <= D < threshold and delta >= 0.08 above peers)
            if (
                top.fill_ratio >= 0.13
                and (top.fill_ratio - row_baseline) >= 0.08
            ):
                measurements = [
                    BubbleMeasurement(
                        value=m.value,
                        target_cx_mm=m.target_cx_mm,
                        target_cy_mm=m.target_cy_mm,
                        target_cx_px=m.target_cx_px,
                        target_cy_px=m.target_cy_px,
                        detected_cx_px=m.detected_cx_px,
                        detected_cy_px=m.detected_cy_px,
                        detected_radius_px=m.detected_radius_px,
                        fill_ratio=m.fill_ratio,
                        is_filled=False,
                        contour_found=m.contour_found,
                        mark_type="faint",
                        quadrant_densities=m.quadrant_densities,
                        uniformity=m.uniformity,
                        paper_halo_lum=m.paper_halo_lum,
                    )
                    if m.value == top.value
                    else m
                    for m in measurements
                ]
                resolved = "?"
                ambiguous = True
                review_reason = f"Needs Review: Faint mark on {q_label}"

        final_selected = [m.value for m in measurements if m.is_filled]
        return GroupResult(
            key=group.key,
            kind=group.kind,
            label=group.label,
            measurements=measurements,
            selected_values=final_selected if final_selected else ([resolved] if resolved not in {"?", "*"} else []),
            resolved_value=resolved,
            fill_margin=float(margin),
            is_ambiguous=ambiguous,
            review_reason=review_reason,
            zone_offset_px=zone_offset_px,
        )

    def _compute_interzone_corridor_dy(self, gray: np.ndarray, ring_score_map: np.ndarray) -> dict[str, int]:
        """Detect large vertical zone shifts across horizontal inter-zone corridors (e.g. 3-marker recovery)."""
        corridor_dy: dict[str, int] = {}
        h, w = gray.shape[:2]
        zones_sorted = sorted(self.layout.zones, key=lambda z: z.bbox[1])
        for idx in range(1, len(zones_sorted)):
            z_prev = zones_sorted[idx - 1]
            z_curr = zones_sorted[idx]
            prev_bot_mm = z_prev.bbox[1] + z_prev.bbox[3]
            curr_top_mm = z_curr.bbox[1]
            gap_mm = curr_top_mm - prev_bot_mm
            if not (2.0 <= gap_mm <= 16.0):
                continue

            y1_nom = int(round(prev_bot_mm * self.px_per_mm))
            y2_nom = int(round(curr_top_mm * self.px_per_mm))
            gap_px = y2_nom - y1_nom
            if gap_px < 15:
                continue

            zx = int(round(z_curr.bbox[0] * self.px_per_mm))
            zw = int(round(z_curr.bbox[2] * self.px_per_mm))
            x1 = max(0, zx + int(round(zw * 0.08)))
            x2 = min(w, zx + zw - int(round(zw * 0.08)))
            if x2 - x1 < 40:
                continue

            best_dy = 0
            best_c_score = -1e9
            for dy in range(-25, 46):
                ya = y1_nom + dy
                yb = y2_nom + dy
                if ya < 5 or yb >= h - 5:
                    continue
                corridor_dark = float(np.mean(gray[ya + 4 : yb - 3, x1:x2] < 180))
                b1_dark = float(np.mean(gray[ya - 2 : ya + 3, x1:x2] < 175))
                b2_dark = float(np.mean(gray[yb - 2 : yb + 3, x1:x2] < 175))
                c_score = (b1_dark + b2_dark) - corridor_dark * 2.5 - abs(dy) * 0.002
                if c_score > best_c_score:
                    best_c_score = c_score
                    best_dy = dy

            if abs(best_dy) >= 12:
                # Verify that shifting the zone's bubbles by best_dy genuinely improves ring alignment
                z_groups = [g for g in self.layout.groups if g.zone_id == z_curr.id and g.options]
                pts = [
                    (int(round(o.cx * self.px_per_mm)), int(round(o.cy * self.px_per_mm)))
                    for g in z_groups
                    for o in g.options
                ]
                if pts:
                    s0 = float(
                        np.mean([ring_score_map[py, px] for px, py in pts if 0 <= px < w and 0 <= py < h])
                    )
                    s_dy = float(
                        np.mean(
                            [
                                ring_score_map[py + best_dy, px]
                                for px, py in pts
                                if 0 <= px < w and 0 <= py + best_dy < h
                            ]
                        )
                    )
                    if s_dy > s0 * 1.15 + 40.0:
                        corridor_dy[z_curr.id] = best_dy
        return corridor_dy

    def scan_all(self, gray: np.ndarray, binary: np.ndarray) -> tuple[dict[str, GroupResult], str]:
        """Processes all groups defined in the template with Stage 2 local constellation snapping and Stage 3 morphology.

        Returns:
            (dict of item_key -> GroupResult, decoded student_id string)
        """
        # Stage 2: Compute zone border offsets and precompute 16-ray outward-gradient ring score map
        zone_offsets: dict[str, tuple[int, int]] = {}
        for z in self.layout.zones:
            zone_offsets[z.id] = self.compute_zone_offset(gray, z.bbox)
        self.last_zone_offsets_px = zone_offsets

        ring_score_map = self._build_ring_score_map(gray)
        corridor_dy_map = self._compute_interzone_corridor_dy(gray, ring_score_map)

        results: dict[str, GroupResult] = {}
        search_r = max(6, int(round(2.4 * self.px_per_mm)))
        fine_r = max(3, int(round(0.40 * self.px_per_mm)))

        # Pre-index non-SID groups by (zone_id, column_x_mm) for local 3-row constellation snapping
        col_groups: dict[tuple[str, float], list[BubbleGroup]] = {}
        sid_pts_by_zone: dict[str, list[tuple[int, int]]] = {}
        for g in self.layout.groups:
            if not g.options:
                continue
            if g.kind == "sid":
                sid_pts_by_zone.setdefault(g.zone_id, []).extend(
                    (int(round(o.cx * self.px_per_mm)), int(round(o.cy * self.px_per_mm)))
                    for o in g.options
                )
            else:
                col_key = (g.zone_id, round(g.options[0].cx / 5.0) * 5.0)
                col_groups.setdefault(col_key, []).append(g)

        sid_zone_shifts: dict[str, tuple[int, int]] = {}
        for zid, pts in sid_pts_by_zone.items():
            if pts and self.layout.sid_groups:
                g0 = self.layout.sid_groups[0]
                sid_zone_shifts[zid] = self._refine_group_offset(
                    gray,
                    binary,
                    g0,
                    seed_offset_px=(0, 0),
                    max_step_px=search_r,
                    ring_score_map=ring_score_map,
                    constellation_pts_px=pts,
                )

        for group in self.layout.groups:
            if group.options and group.kind != "sid":
                col_key = (group.zone_id, round(group.options[0].cx / 5.0) * 5.0)
                peers = col_groups.get(col_key, [group])
                gy = group.options[0].cy
                local_pts = [
                    (int(round(o.cx * self.px_per_mm)), int(round(o.cy * self.px_per_mm)))
                    for pg in peers
                    if abs(pg.options[0].cy - gy) <= 7.5
                    for o in pg.options
                ]
                seed_off = (0, corridor_dy_map.get(group.zone_id, 0))
                g_shift = self._refine_group_offset(
                    gray,
                    binary,
                    group,
                    seed_offset_px=seed_off,
                    max_step_px=search_r,
                    ring_score_map=ring_score_map,
                    constellation_pts_px=local_pts,
                )
                total_shift = (seed_off[0] + g_shift[0], seed_off[1] + g_shift[1])
                res = self.scan_group(
                    gray, binary, group, zone_offset_px=total_shift, fine_search_px=fine_r
                )
            else:
                z_off = sid_zone_shifts.get(group.zone_id, zone_offsets.get(group.zone_id, (0, 0)))
                res = self.scan_group(
                    gray, binary, group, zone_offset_px=z_off, fine_search_px=fine_r
                )
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

