from omr.grading import AnswerKey, GradingEngine
from omr.layout import Layout
from omr.roster import RosterMatch
from omr.vision import GroupResult


def test_grading_mcq_and_written_items():
    layout = Layout.load("dist/exam-50/layout.json")
    key = AnswerKey.load("data/bio101_key.json")
    grader = GradingEngine(key, layout)

    dummy_bubbles = {
        "1": GroupResult(key="1", kind="mcq", label="1", measurements=[], resolved_value="A"),
        "2": GroupResult(key="2", kind="mcq", label="2", measurements=[], resolved_value="B"),  # Wrong, key is C
        "3": GroupResult(key="3", kind="mcq", label="3", measurements=[], resolved_value="?"),  # Blank
        "4": GroupResult(key="4", kind="mcq", label="4", measurements=[], resolved_value="*"),  # Multi
    }

    from omr.ocr import OCRResult
    dummy_ocr = {
        "q61": OCRResult(roi_id="q61", key="q61", label="61", text="mitochondria", confidence=0.9, cropped_bgr=None, preprocessed_gray=None),
        "q62": OCRResult(roi_id="q62", key="q62", label="62", text="MRNA", confidence=0.9, cropped_bgr=None, preprocessed_gray=None),
    }

    roster_match = RosterMatch("exact", "10482901")
    exam_grade = grader.grade("exam1", dummy_bubbles, dummy_ocr, "10482901", roster_match)

    assert exam_grade.items["1"].is_correct is True
    assert exam_grade.items["1"].points_awarded == 1.0

    assert exam_grade.items["2"].is_correct is False
    assert exam_grade.items["2"].points_awarded == 0.0

    assert exam_grade.items["3"].is_blank is True
    assert exam_grade.items["4"].is_multi is True

    # Written text item: case-insensitive check
    assert exam_grade.items["q61"].is_correct is True
    assert exam_grade.items["q61"].points_awarded == 2.0

    assert exam_grade.items["q62"].is_correct is False
