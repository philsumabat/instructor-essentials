import numpy as np
from omr.barcode import decode_code39_scanline, decode_barcode_image, CODE39_PATTERNS
from omr.grading import ExamGrade
from omr.pipeline import OMRPipeline
from omr.roster import RosterMatch


def test_code39_scanline_decoder():
    # Encode SHT-8F42-9B into synthetic scanline
    text = "*SHT-8F42-9B*"
    runs = []
    for i, ch in enumerate(text):
        pat = CODE39_PATTERNS[ch]
        for j, bit in enumerate(pat):
            is_black = (j % 2 == 0)
            width = 2.5 if bit == "1" else 1.0
            runs.append((is_black, width))
        if i < len(text) - 1:
            runs.append((False, 1.0))

    pixels = [0] * 20
    for is_b, w in runs:
        count = int(round(w * 3))
        pixels.extend([1 if is_b else 0] * count)
    pixels.extend([0] * 20)

    decoded = decode_code39_scanline(pixels)
    assert decoded == "SHT-8F42-9B"


def test_barcode_image_decoder():
    text = "*SHT-TEST*"
    runs = []
    for i, ch in enumerate(text):
        pat = CODE39_PATTERNS[ch]
        for j, bit in enumerate(pat):
            is_black = (j % 2 == 0)
            width = 2.5 if bit == "1" else 1.0
            runs.append((is_black, width))
        if i < len(text) - 1:
            runs.append((False, 1.0))

    img_w = 300
    img_h = 30
    total_units = sum(w for _, w in runs) + 8  # + 2*4 quiet margin
    img = np.full((img_h, img_w), 255, dtype=np.uint8)

    curr_unit = 4.0
    for is_b, w in runs:
        x_start = int(round((curr_unit / total_units) * img_w))
        x_end = int(round(((curr_unit + w) / total_units) * img_w))
        if is_b:
            img[:, x_start:x_end] = 10
        curr_unit += w

    decoded = decode_barcode_image(img)
    assert decoded == "SHT-TEST"


def test_detect_duplicates_with_barcodes():
    class DummyPipeline:
        detect_duplicates = OMRPipeline.detect_duplicates

    pipe = DummyPipeline()

    # Case 1: Same barcode -> Physical Duplicate Scan
    g1 = ExamGrade(
        exam_id="scan1.jpg",
        sheet_barcode="SHT-8F42-9B",
        decoded_sid="10482901",
        roster_match=RosterMatch("exact", "10482901"),
        items={},
        score=50.0,
        max_score=50.0,
        percentage=100.0,
    )
    g2 = ExamGrade(
        exam_id="scan2.jpg",
        sheet_barcode="SHT-8F42-9B",
        decoded_sid="10482901",
        roster_match=RosterMatch("exact", "10482901"),
        items={},
        score=50.0,
        max_score=50.0,
        percentage=100.0,
    )

    dups = pipe.detect_duplicates([g1, g2])
    assert len(dups) == 1
    assert dups[0]["type"] == "sheet_barcode_collision"
    assert g1.is_duplicate is True
    assert g2.is_duplicate is True
    assert "Duplicate physical scan" in g1.duplicate_note

    # Case 2: Different barcodes with identical answers -> Distinct Physical Sheets (not double-scanned)
    from omr.grading import ItemGrade

    items = {
        str(i): ItemGrade(
            key=str(i),
            kind="mcq",
            student_response="A",
            correct_answer="A",
            is_correct=True,
            points_awarded=1.0,
            max_points=1.0,
            is_blank=False,
            is_multi=False,
        )
        for i in range(1, 15)
    }

    g3 = ExamGrade(
        exam_id="scan3.jpg",
        sheet_barcode="SHT-1111-AA",
        decoded_sid="10482903",
        roster_match=RosterMatch("exact", "10482903"),
        items=dict(items),
        score=14.0,
        max_score=14.0,
        percentage=100.0,
    )
    g4 = ExamGrade(
        exam_id="scan4.jpg",
        sheet_barcode="SHT-2222-BB",
        decoded_sid="10482904",
        roster_match=RosterMatch("exact", "10482904"),
        items=dict(items),
        score=14.0,
        max_score=14.0,
        percentage=100.0,
    )

    dups2 = pipe.detect_duplicates([g3, g4])
    assert len(dups2) == 0  # NOT flagged as duplicate scans!
    assert g3.is_duplicate is False
    assert g4.is_duplicate is False
    assert any("Distinct physical sheets" in note for note in g3.review_notes)
    assert any("Distinct physical sheets" in note for note in g4.review_notes)
