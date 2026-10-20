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

