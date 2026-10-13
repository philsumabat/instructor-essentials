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
    assert decoded_sid == "10482901"
    assert results["1"].resolved_value == "A"
