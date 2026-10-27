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


def test_answer_key_pipe_delimited_and_zero_points():
    csv_text = """Item #,Answer,Points,Kind,Rubric
1,C,1.0,mcq,exact
33,Condenser | Abbe condenser,1.0,text,case_insensitive
69,T,2.0,tf,exact
69_corr,,0.0,text,case_insensitive
70,F,1.0,tf,exact
70_corr,Glass,1.0,text,case_insensitive
"""
    key = AnswerKey.from_csv_text(csv_text, title="Test Key")
    assert key.total_points == 6.0
    assert key.items["33"].points == 1.0
    assert key.items["69_corr"].points == 0.0

    grader = GradingEngine(key)

    # Candidate 1: "Condenser"
    grade_c1 = grader.evaluate_item(key.items["33"], "Condenser")
    assert grade_c1.is_correct is True
    assert grade_c1.points_awarded == 1.0

    # Candidate 2: "Abbe condenser" (case-insensitive)
    grade_c2 = grader.evaluate_item(key.items["33"], "abbe condenser")
    assert grade_c2.is_correct is True
    assert grade_c2.points_awarded == 1.0

    # Wrong answer
    grade_c3 = grader.evaluate_item(key.items["33"], "Objective lens")
    assert grade_c3.is_correct is False
    assert grade_c3.points_awarded == 0.0

    # Zero-points blank correction item
    grade_corr = grader.evaluate_item(key.items["69_corr"], "")
    assert grade_corr.is_correct is True
    assert grade_corr.points_awarded == 0.0
    assert grade_corr.max_points == 0.0


def test_answer_key_load_priority(tmp_path):
    # Directory with both answer_key_template.csv and answer_key.csv
    template_csv = tmp_path / "answer_key_template.csv"
    template_csv.write_text("Item #,Answer,Points\n1,A,2.0\n", encoding="utf-8")

    real_csv = tmp_path / "answer_key.csv"
    real_csv.write_text("Item #,Answer,Points\n1,B,1.0\n", encoding="utf-8")

    loaded = AnswerKey.load(tmp_path)
    # Must load answer_key.csv (1.0 pt, ans B), NOT answer_key_template.csv (2.0 pt, ans A)
    assert loaded.items["1"].correct_answer == "B"
    assert loaded.items["1"].points == 1.0

    # Test ZIP priority
    import zipfile
    zip_path = tmp_path / "exam.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("answer_key_template.csv", "Item #,Answer,Points\n1,A,2.0\n")
        zf.writestr("answer_key.csv", "Item #,Answer,Points\n1,C,1.0\n")

    loaded_zip = AnswerKey.load(zip_path)
    assert loaded_zip.items["1"].correct_answer == "C"
    assert loaded_zip.items["1"].points == 1.0


def test_answer_key_from_dict_points_and_kind():
    data = {
        "title": "Test Key",
        "items": {
            "1": {"answer": "A", "points": None},  # None points -> default 1.0
            "2": "B",  # shorthand string -> 1.0 pt, mcq
            "33": {"answer": "Condenser | Abbe condenser"},  # inferred text, case_insensitive, default 1.0 pt
            "69_corr": {"answer": "", "points": 0.0},  # 0.0 pt preserved
        }
    }
    key = AnswerKey.from_dict(data)
    assert key.items["1"].points == 1.0
    assert key.items["1"].kind == "mcq"

    assert key.items["2"].points == 1.0
    assert key.items["2"].kind == "mcq"

    assert key.items["33"].points == 1.0
    assert key.items["33"].kind == "text"
    assert key.items["33"].rubric == "case_insensitive"

    assert key.items["69_corr"].points == 0.0
    assert key.items["69_corr"].kind == "text"


def test_scientific_name_rubric_and_conventions():
    from omr.grading import AnswerKey, GradingEngine, check_scientific_name

    csv_text = """Item #,Answer,Points,Kind,Rubric
50,Volvox,1.0,text,scientific_name
"""
    key = AnswerKey.from_csv_text(csv_text, title="Botany Key")
    grader = GradingEngine(key)

    # 1. Correct genus with capital letter
    g1 = grader.evaluate_item(key.items["50"], "Volvox")
    assert g1.is_correct is True
    assert g1.points_awarded == 1.0

    # 2. Lowercase genus fails capitalization under ICN conventions
    g2 = grader.evaluate_item(key.items["50"], "volvox")
    assert g2.is_correct is False
    assert g2.points_awarded == 0.0
    assert "capital" in g2.details.lower()
    assert g2.feedback_badge == "incorrect"
    assert "Volvox" in g2.feedback_text

    # 3. Direct check_scientific_name function
    chk_pass = check_scientific_name("Volvox", "Volvox")
    assert chk_pass["is_valid"] is True
    assert chk_pass["valid_capitalization"] is True

    chk_fail_cap = check_scientific_name("volvox", "Volvox")
    assert chk_fail_cap["is_valid"] is False
    assert chk_fail_cap["valid_capitalization"] is False
    assert any("capital" in s.lower() for s in chk_fail_cap["issues"])


def test_detect_underline_stroke():
    import numpy as np
    import cv2
    from omr.vision import detect_underline_stroke

    # Blank image with outer box border
    crop_blank = np.full((90, 400, 3), 255, dtype=np.uint8)
    cv2.rectangle(crop_blank, (0, 0), (399, 89), (0, 0, 0), 2)
    assert detect_underline_stroke(crop_blank) is False

    # Image with handwriting AND horizontal underline stroke
    crop_underlined = crop_blank.copy()
    cv2.putText(crop_underlined, "Volvox", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 2)
    cv2.line(crop_underlined, (45, 68), (170, 68), (0, 0, 0), 2)
    assert detect_underline_stroke(crop_underlined) is True


def test_annotator_correction_badges():
    import numpy as np
    from omr.annotator import ExamAnnotator
    from omr.grading import ItemGrade
    from omr.layout import Layout

    layout = Layout.load("dist/exam-50/layout.json")
    annotator = ExamAnnotator(layout, px_per_mm=10.0)

    canvas = np.full((1200, 800, 3), 255, dtype=np.uint8)

    # 1. Test incorrect badge rendering
    annotator.draw_correction_badge(
        canvas, x=100, y=100, w=300, h=90, text="Key: CONDENSER", badge_type="incorrect"
    )
    # The badge area should be altered from pure white (255, 255, 255)
    badge_crop = canvas[160:185, 105:250]
    assert not np.all(badge_crop == 255)

    # 2. Test accepted variant badge rendering
    annotator.draw_correction_badge(
        canvas, x=100, y=250, w=300, h=90, text="Accepted: STEREOMICROSCOPE", badge_type="accepted_variant"
    )
    badge_crop2 = canvas[310:335, 105:250]
    assert not np.all(badge_crop2 == 255)

