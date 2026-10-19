import cv2
import numpy as np
import pytest

from omr.layout import Layout
from omr.simulator import ExamSimulator
from omr.vision import BubbleScanner, SheetWarper


@pytest.fixture
def sample_layout():
    return Layout.load("dist/exam-50/layout.json")


def test_warper_corrects_skew(sample_layout):
    sim = ExamSimulator(sample_layout, px_per_mm=10.0)
    # Generate an exam with -1.5 degrees skew
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Test Student",
        answers={"1": "A", "2": "C"},
        text_answers={"q61": "TEST"},
        skew_deg=-1.5,
        add_noise=False,
    )

    warper = SheetWarper(sample_layout, px_per_mm=10.0)
    res = warper.warp(img)

    expected_w = int(round(sample_layout.page_width * 10.0))
    expected_h = int(round(sample_layout.page_height * 10.0))

    assert res.warped_bgr.shape[1] == expected_w
    assert res.warped_bgr.shape[0] == expected_h
    assert len(res.detected_corners_px) == 4


def test_bubble_scanner_decodes_choices(sample_layout):
    sim = ExamSimulator(sample_layout, px_per_mm=10.0)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Alice",
        answers={"1": "A", "2": "C", "51": "T", "52": "F"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )

    warper = SheetWarper(sample_layout, px_per_mm=10.0)
    warp_res = warper.warp(img)

    scanner = BubbleScanner(sample_layout, px_per_mm=10.0)
    binary = scanner.preprocess(warp_res.warped_gray)
    results, decoded_sid = scanner.scan_all(warp_res.warped_gray, binary)

    if sample_layout.sid_groups:
        assert decoded_sid == "10482901"
    else:
        assert decoded_sid == ""
    assert results["1"].resolved_value == "A"
    assert results["2"].resolved_value == "C"
    assert results["51"].resolved_value == "T"
    assert results["52"].resolved_value == "F"


def test_bubble_scanner_shaded_sid():
    layout100 = Layout.load("dist/exam-100/layout.json")
    sim = ExamSimulator(layout100, px_per_mm=10.0)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Bob",
        answers={"1": "A"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )
    warper = SheetWarper(layout100, px_per_mm=10.0)
    warp_res = warper.warp(img)
    scanner = BubbleScanner(layout100, px_per_mm=10.0)
    binary = scanner.preprocess(warp_res.warped_gray)
    results, decoded_sid = scanner.scan_all(warp_res.warped_gray, binary)
    if layout100.sid_groups:
        assert decoded_sid == "10482901"
    else:
        assert decoded_sid == ""
    assert results["1"].resolved_value == "A"


def test_stage1_three_marker_parallelogram_recovery(sample_layout):
    """Stage 1: Recover 1 missing corner marker via affine parallelogram completion."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Three Marker Student",
        answers={"1": "B", "2": "D"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )

    # White-out corner marker 3 (bottom-left)
    m3 = next(f for f in sample_layout.fiducials if f.id == 3)
    cx = int(np.mean([pt[0] for pt in m3.corners]) * px_per_mm)
    cy = int(np.mean([pt[1] for pt in m3.corners]) * px_per_mm)
    half = int(m3.size * px_per_mm * 0.75)
    img[max(0, cy - half) : cy + half, max(0, cx - half) : cx + half] = 255

    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    warp_res = warper.warp(img)

    assert warp_res.recovered_fiducial_ids == (3,)
    assert any("Aligned using 3 of 4 corner markers" in note for note in warp_res.review_notes)

    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary = scanner.preprocess(warp_res.warped_gray)
    results, _ = scanner.scan_all(warp_res.warped_gray, binary)
    assert results["1"].resolved_value == "B"
    assert results["2"].resolved_value == "D"


def test_stage1_insufficient_markers_raises_review_message(sample_layout):
    """Stage 1: Obscuring 2 corner markers raises VisionError with clear review note."""
    from omr.vision import VisionError

    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Two Marker Student",
        answers={"1": "A"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )

    # White-out corner markers 2 and 3
    for fid_id in (2, 3):
        m = next(f for f in sample_layout.fiducials if f.id == fid_id)
        cx = int(np.mean([pt[0] for pt in m.corners]) * px_per_mm)
        cy = int(np.mean([pt[1] for pt in m.corners]) * px_per_mm)
        half = int(m.size * px_per_mm * 0.75)
        img[max(0, cy - half) : cy + half, max(0, cx - half) : cx + half] = 255

    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    with pytest.raises(VisionError, match="Needs Review: Corner markers not clearly visible"):
        warper.warp(img)


def test_stage1_auto_rotation_and_contour_bitgrid_decoder(sample_layout):
    """Stage 1: Auto-detect 180 deg and 90 deg scan rotations and verify contour bit-grid decoder."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Rotated Student",
        answers={"1": "E", "3": "C"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )

    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)

    # Verify custom contour 6x6 bit-grid decoder directly finds all 4 markers
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners = warper._detect_markers_contour_fallback(gray, {})
    assert set(corners.keys()) == {0, 1, 2, 3}

    # Rotate upside down (180 degrees)
    img_180 = cv2.rotate(img, cv2.ROTATE_180)
    res_180 = warper.warp(img_180)
    assert res_180.rotation_deg == 180

    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary_180 = scanner.preprocess(res_180.warped_gray)
    results_180, _ = scanner.scan_all(res_180.warped_gray, binary_180)
    assert results_180["1"].resolved_value == "E"
    assert results_180["3"].resolved_value == "C"


def test_stage2_local_zone_offset_snapping(sample_layout):
    """Stage 2: Projection-profile zone border snapping recovers local translation offset."""
    px_per_mm = 10.0
    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    w = int(round(sample_layout.page_width * px_per_mm))
    h = int(round(sample_layout.page_height * px_per_mm))
    gray = np.full((h, w), 255, dtype=np.uint8)

    zone = sample_layout.zones[0]
    zx, zy, zw, zh = zone.bbox
    shift_x_px = 14  # +1.4 mm shift
    shift_y_px = -11  # -1.1 mm shift
    x1 = int(round(zx * px_per_mm)) + shift_x_px
    y1 = int(round(zy * px_per_mm)) + shift_y_px
    x2 = int(round((zx + zw) * px_per_mm)) + shift_x_px
    y2 = int(round((zy + zh) * px_per_mm)) + shift_y_px
    cv2.rectangle(gray, (x1, y1), (x2, y2), 20, thickness=2)

    dx, dy = scanner.compute_zone_offset(gray, zone)
    assert abs(dx - shift_x_px) <= 3.0
    assert abs(dy - shift_y_px) <= 3.0
    assert abs(dx) <= 2.5 * px_per_mm
    assert abs(dy) <= 2.5 * px_per_mm


def test_stage3_strict_shading_policy_morphology(sample_layout):
    """Stage 3: Ring-locked 4-quadrant morphology distinguishes shaded, check/cross, erasure, and faint marks."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Morphology Student",
        answers={"1": "A"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )
    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    warp_res = warper.warp(img)
    gray = warp_res.warped_gray.copy()

    # Helper to find bubble pixel coordinates
    r_px = int(round((sample_layout.bubble_diameter / 2.0) * px_per_mm))
    q_groups = {g.key: g for g in sample_layout.question_groups}

    def _bubble_px(q_key: str, label: str) -> tuple[int, int, int]:
        grp = q_groups[q_key]
        b = next(opt for opt in grp.options if opt.value == label)
        return (
            int(round(b.cx * px_per_mm)),
            int(round(b.cy * px_per_mm)),
            r_px,
        )

    # Q2: Draw a sharp 'X' cross on option B (should be flagged as check_or_cross, NOT auto-scored)
    cx2, cy2, r2 = _bubble_px("2", "B")
    span = int(round(r2 * 0.60))
    # Clear printed option letter first so we test a crisp thin 'X' mark
    cv2.circle(gray, (cx2, cy2), int(round(r2 * 0.72)), 250, -1)
    cv2.line(gray, (cx2 - span, cy2 - span), (cx2 + span, cy2 + span), 20, 2)
    cv2.line(gray, (cx2 - span, cy2 + span), (cx2 + span, cy2 - span), 20, 2)

    # Q3: Shade option C darkly, and leave an erasure smudge on option A
    cx3c, cy3c, r3c = _bubble_px("3", "C")
    cv2.circle(gray, (cx3c, cy3c), int(round(r3c * 0.78)), 25, -1)
    cx3a, cy3a, r3a = _bubble_px("3", "A")
    cv2.circle(gray, (cx3a, cy3a), int(round(r3a * 0.70)), 185, -1)

    # Q4: Leave a faint pencil mark on option D (all other options blank)
    cx4d, cy4d, r4d = _bubble_px("4", "D")
    cv2.circle(gray, (cx4d, cy4d), int(round(r4d * 0.70)), 195, -1)

    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary = scanner.preprocess(gray)
    results, _ = scanner.scan_all(gray, binary)

    # Q1: Properly shaded 'A' -> auto-scored
    assert results["1"].resolved_value == "A"
    assert not results["1"].is_blank
    assert results["1"].review_reason == ""

    # Q2: Cross 'X' on 'B' -> NOT auto-scored, flagged for review
    assert results["2"].resolved_value == "?"
    assert results["2"].is_blank
    assert "Non-standard mark (Check/Cross) on Q2" in results["2"].review_reason

    # Q3: Shaded 'C' + erasure on 'A' -> held for review with erasure reason
    assert results["3"].resolved_value == "?"
    assert results["3"].is_blank
    assert "Possible erasure on Q3" in results["3"].review_reason

    # Q4: Faint mark on 'D' -> blank + flagged for review
    assert results["4"].resolved_value == "?"
    assert results["4"].is_blank
    assert "Faint mark on Q4" in results["4"].review_reason

    # Q5: Draw an asymmetric checkmark ('✓') on option E -> flagged as check_or_cross, NOT auto-scored
    cx5, cy5, r5 = _bubble_px("5", "E")
    cv2.circle(gray, (cx5, cy5), int(round(r5 * 0.72)), 250, -1)
    # Short down-right tick in bottom-left quadrant + long up-right stroke to top-right
    p1 = (cx5 - int(round(r5 * 0.45)), cy5 + int(round(r5 * 0.05)))
    p2 = (cx5 - int(round(r5 * 0.10)), cy5 + int(round(r5 * 0.48)))
    p3 = (cx5 + int(round(r5 * 0.55)), cy5 - int(round(r5 * 0.52)))
    cv2.line(gray, p1, p2, 20, 2)
    cv2.line(gray, p2, p3, 20, 2)

    binary2 = scanner.preprocess(gray)
    results2, _ = scanner.scan_all(gray, binary2)
    assert results2["5"].resolved_value == "?"
    assert results2["5"].is_blank
    assert "Non-standard mark (Check/Cross) on Q5" in results2["5"].review_reason


def test_stage3_uneven_shadow_paper_halo_normalization(sample_layout):
    """Stage 3: Local paper halo normalization (1.15r-1.40r) preserves bubble reading under dark phone shadow."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Shadow Student",
        answers={"1": "C", "2": "D", "3": "A"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )
    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    warp_res = warper.warp(img)
    gray = warp_res.warped_gray.copy()

    # Cast a heavy shadow across the top half of the sheet (reducing paper luminance from 255 to ~175)
    h, w = gray.shape
    shadow_region = gray[: h // 2, :].astype(np.float32) * 0.68
    gray[: h // 2, :] = np.clip(shadow_region, 0, 255).astype(np.uint8)

    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary = scanner.preprocess(gray)
    results, decoded_sid = scanner.scan_all(gray, binary)

    assert results["1"].resolved_value == "C"
    assert results["2"].resolved_value == "D"
    assert results["3"].resolved_value == "A"
    assert results["4"].is_blank


def test_stage1_landscape_90_and_270_rotations(sample_layout):
    """Stage 1: Verify 90 deg CW and 270 deg CW landscape-rotated scans rectify and decode accurately."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Landscape Rotated",
        answers={"1": "D", "2": "B"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )
    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)

    for rot_code, expected_deg in (
        (cv2.ROTATE_90_CLOCKWISE, 90),
        (cv2.ROTATE_90_COUNTERCLOCKWISE, 270),
    ):
        rot_img = cv2.rotate(img, rot_code)
        res = warper.warp(rot_img)
        assert res.rotation_deg == expected_deg
        binary = scanner.preprocess(res.warped_gray)
        results, _ = scanner.scan_all(res.warped_gray, binary)
        assert results["1"].resolved_value == "D"
        assert results["2"].resolved_value == "B"


def test_stage3_thick_cross_and_halo_spilling_checkmark_and_annotator(sample_layout):
    """Stage 3: Verify thick felt-tip X cross, halo-spilling checkmark, and erasure annotator safety."""
    from omr.annotator import COLOR_INCORRECT, ExamAnnotator
    from omr.grading import AnswerKey, GradingEngine, ItemKey
    from omr.roster import RosterMatch

    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Edge Case Student",
        answers={"1": "A"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )
    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    warp_res = warper.warp(img)
    gray = warp_res.warped_gray.copy()
    r_px = int(round((sample_layout.bubble_diameter / 2.0) * px_per_mm))
    q_groups = {g.key: g for g in sample_layout.question_groups}

    def _bubble_px(q_key: str, label: str) -> tuple[int, int, int]:
        grp = q_groups[q_key]
        b = next(opt for opt in grp.options if opt.value == label)
        return int(round(b.cx * px_per_mm)), int(round(b.cy * px_per_mm)), r_px

    # Q2: Thick felt-tip 'X' cross (thickness=4) -> still classified as check_or_cross, not shaded
    cx2, cy2, r2 = _bubble_px("2", "B")
    span = int(round(r2 * 0.65))
    cv2.circle(gray, (cx2, cy2), int(round(r2 * 0.72)), 250, -1)
    cv2.line(gray, (cx2 - span, cy2 - span), (cx2 + span, cy2 + span), 15, 4)
    cv2.line(gray, (cx2 - span, cy2 + span), (cx2 + span, cy2 - span), 15, 4)

    # Q3: Thick felt-tip checkmark ('✓') whose tail spills out into the 1.15r-1.40r paper halo annulus
    cx3, cy3, r3 = _bubble_px("3", "C")
    cv2.circle(gray, (cx3, cy3), int(round(r3 * 0.72)), 250, -1)
    p1 = (cx3 - int(round(r3 * 0.45)), cy3 + int(round(r3 * 0.05)))
    p2 = (cx3 - int(round(r3 * 0.08)), cy3 + int(round(r3 * 0.50)))
    p3 = (cx3 + int(round(r3 * 1.35)), cy3 - int(round(r3 * 1.35)))  # Spills into 1.15r-1.40r halo!
    cv2.line(gray, p1, p2, 15, 3)
    cv2.line(gray, p2, p3, 15, 3)

    # Q4: Shaded correct option 'D' + erasure smudge on 'A'
    cx4d, cy4d, r4d = _bubble_px("4", "D")
    cv2.circle(gray, (cx4d, cy4d), int(round(r4d * 0.78)), 25, -1)
    cx4a, cy4a, r4a = _bubble_px("4", "A")
    cv2.circle(gray, (cx4a, cy4a), int(round(r4a * 0.70)), 185, -1)

    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary = scanner.preprocess(gray)
    results, decoded_sid = scanner.scan_all(gray, binary)

    assert results["2"].resolved_value == "?"
    assert "Non-standard mark (Check/Cross) on Q2" in results["2"].review_reason

    assert results["3"].resolved_value == "?"
    assert "Non-standard mark (Check/Cross) on Q3" in results["3"].review_reason
    m3c = next(m for m in results["3"].measurements if m.value == "C")
    assert m3c.paper_halo_lum >= 235.0  # 75th-percentile halo estimator unaffected by spilling tail

    # Q4 erasure: held as '?' and neither option has is_filled=True so annotator never marks 'D' wrong
    assert results["4"].resolved_value == "?"
    assert results["4"].selected_values == []
    assert all(not m.is_filled for m in results["4"].measurements)

    key = AnswerKey(
        {
            "1": ItemKey("1", "mcq", "A"),
            "2": ItemKey("2", "mcq", "B"),
            "3": ItemKey("3", "mcq", "C"),
            "4": ItemKey("4", "mcq", "D"),
        }
    )
    grader = GradingEngine(key, sample_layout)
    grade = grader.grade("exam_edge", results, {}, decoded_sid, RosterMatch("no_roster", decoded_sid))
    assert any("Possible erasure on Q4" in n for n in grade.review_notes)

    annotator = ExamAnnotator(sample_layout, px_per_mm=px_per_mm)
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    annotated = annotator.annotate(bgr, grade)
    # Center of shaded 'D' on Q4 must NOT have a crimson red COLOR_INCORRECT X drawn across it
    center_pixel_bgr = tuple(int(v) for v in annotated[cy4d, cx4d])
    assert center_pixel_bgr != COLOR_INCORRECT


def test_stage1_and_stage3_nonplanar_corner_curl_and_constellation_snap(sample_layout):
    """Stage 1 & 3: Least-squares corner-anchored homography and local 3-row constellation snapping
    recover answers accurately on curled mobile scans without dropping the 4th corner marker."""
    px_per_mm = 10.0
    sim = ExamSimulator(sample_layout, px_per_mm=px_per_mm)
    img = sim.generate_exam(
        student_id="10482901",
        student_name="Curled Scan Student",
        answers={"1": "B", "2": "D", "25": "A", "50": "C"},
        text_answers={},
        skew_deg=0.0,
        add_noise=False,
    )

    # Simulate non-planar corner curl by shifting the bottom-right corner marker (id=2) by (+12, +10) px
    # (Enough to exceed a 5.0px RANSAC threshold on a 3-marker fit, which previously dropped marker 2!)
    h, w = img.shape[:2]
    m2 = next(f for f in sample_layout.fiducials if f.id == 2)
    cx = int(np.mean([pt[0] for pt in m2.corners]) * px_per_mm)
    cy = int(np.mean([pt[1] for pt in m2.corners]) * px_per_mm)
    pad = int(m2.size * px_per_mm * 0.85)
    patch = img[cy - pad : cy + pad, cx - pad : cx + pad].copy()
    img[cy - pad : cy + pad, cx - pad : cx + pad] = 255
    img[cy - pad + 10 : cy + pad + 10, cx - pad + 12 : cx + pad + 12] = patch

    warper = SheetWarper(sample_layout, px_per_mm=px_per_mm)
    warp_res = warper.warp(img)
    scanner = BubbleScanner(sample_layout, px_per_mm=px_per_mm)
    binary = scanner.preprocess(warp_res.warped_gray)
    results, _ = scanner.scan_all(warp_res.warped_gray, binary)

    assert results["1"].resolved_value == "B"
    assert results["2"].resolved_value == "D"
    assert results["25"].resolved_value == "A"
    assert results["50"].resolved_value == "C"



