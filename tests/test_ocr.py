import numpy as np
import pytest

from omr.layout import Layout, TextROI
from omr.ocr import MockOCREngine, ROIExtractor


@pytest.fixture
def dummy_layout():
    return Layout.load("dist/exam-50/layout.json")


def test_process_partitioned_digits_single_digit_box(dummy_layout):
    """Verify single digit box with roi.digits=1 and role='student_id' is processed properly."""
    engine = MockOCREngine(default_digit="9")
    extractor = ROIExtractor(dummy_layout, px_per_mm=10.0, engine=engine)

    # 100x100 white image
    img = np.full((300, 300, 3), 255, dtype=np.uint8)

    single_digit_roi = TextROI(
        id="sid.0",
        key="sid_0",
        label="Digit 1",
        zone_id="sid",
        x=20.0,
        y=20.0,
        w=6.0,
        h=7.5,
        charset="digits",
        multiline=False,
        ocr=True,
        graded=False,
        role="student_id",
        digits=1,
    )

    text, conf = extractor.process_partitioned_digits(img, single_digit_roi)
    assert text == "9"
    assert conf > 0.9

    res = extractor.process_roi(img, single_digit_roi)
    assert res.text == "9"
    assert res.confidence > 0.9
    assert res.cropped_bgr.size > 0
    assert res.preprocessed_gray.size > 0


def test_process_partitioned_digits_multi_digit_sid(dummy_layout):
    """Verify standard multi-digit student ID write-in box (e.g. 8 digits)."""
    engine = MockOCREngine(default_digit="4")
    extractor = ROIExtractor(dummy_layout, px_per_mm=10.0, engine=engine)

    img = np.full((400, 800, 3), 255, dtype=np.uint8)

    sid_roi = TextROI(
        id="info.sid",
        key="sid",
        label="Student ID",
        zone_id="info",
        x=20.0,
        y=20.0,
        w=48.0,
        h=7.5,
        charset="digits",
        multiline=False,
        ocr=True,
        graded=False,
        role="student_id",
        digits=8,
    )

    text, conf = extractor.process_partitioned_digits(img, sid_roi)
    assert text == "44444444"
    assert len(text) == 8
    assert conf > 0.9

    res = extractor.process_roi(img, sid_roi)
    assert res.text == "44444444"
    assert res.confidence > 0.9


def test_crop_roi_small_single_digit_box_no_collapse(dummy_layout):
    """Verify very narrow/compact single-digit box does not collapse to 0 size."""
    extractor = ROIExtractor(dummy_layout, px_per_mm=10.0, engine=MockOCREngine(default_digit="3"))
    img = np.full((200, 200, 3), 255, dtype=np.uint8)

    compact_roi = TextROI(
        id="compact_sid",
        key="compact_sid",
        label="ID Digit",
        zone_id="info",
        x=10.0,
        y=10.0,
        w=2.5,
        h=3.5,
        charset="digits",
        multiline=False,
        ocr=True,
        graded=False,
        role="student_id",
        digits=1,
    )

    cropped = extractor.crop_roi(img, compact_roi)
    assert cropped.size > 0
    assert cropped.shape[0] > 0
    assert cropped.shape[1] > 0

    text, conf = extractor.process_partitioned_digits(img, compact_roi)
    assert text == "3"


def test_stage4_strip_box_walls_removes_borders_and_preserves_handwriting(dummy_layout):
    """Stage 4: Morphological box-wall stripping removes >75% perimeter walls while keeping interior strokes."""
    gray = np.full((60, 120), 255, dtype=np.uint8)

    # Draw printed box borders along top (y=2), bottom (y=57), left (x=2), right (x=117)
    gray[2, 2:118] = 30
    gray[57, 2:118] = 30
    gray[2:58, 2] = 30
    gray[2:58, 117] = 30

    # Draw a vertical handwriting stroke at x=50 that touches the top border wall at y=2..45
    gray[2:45, 50:52] = 20
    # Draw handwriting near the left edge (x=10, well inside the 4% inset, which an old 15% inset would clip)
    gray[15:45, 10:13] = 25

    cleaned = ROIExtractor.strip_box_walls(gray)

    # Unconnected top/bottom/left/right border pixels should be erased to white (255)
    assert cleaned[2, 25] == 255
    assert cleaned[57, 25] == 255
    assert cleaned[30, 2] == 255
    assert cleaned[30, 117] == 255

    # The vertical handwriting stroke at x=50..51 (including where it meets the top wall) is preserved
    assert cleaned[2, 50] < 50
    assert cleaned[25, 50] < 50
    # Handwriting near the left margin (x=10) is preserved
    assert cleaned[25, 11] < 50

