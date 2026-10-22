from omr.grading import AnswerKey, ExamGrade, ItemGrade
from omr.report import PsychometricAnalyzer, ReportGenerator, compute_pearson_r
from omr.roster import RosterMatch


def test_pearson_r():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [2.0, 4.0, 6.0, 8.0, 10.0]
    r = compute_pearson_r(x, y)
    assert abs(r - 1.0) < 1e-4

    y_inv = [5.0, 4.0, 3.0, 2.0, 1.0]
    r_inv = compute_pearson_r(x, y_inv)
    assert abs(r_inv - (-1.0)) < 1e-4


def test_pearson_r_edge_cases():
    # Mismatched lengths
    x = [1.0, 2.0, 3.0]
    y = [1.0, 2.0]
    assert compute_pearson_r(x, y) == 0.0

    # Length < 2
    assert compute_pearson_r([1.0], [1.0]) == 0.0
    assert compute_pearson_r([], []) == 0.0

    # Zero variance (constant values)
    # Both constant
    assert compute_pearson_r([1.0, 1.0, 1.0], [2.0, 2.0, 2.0]) == 0.0
    # X constant
    assert compute_pearson_r([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]) == 0.0
    # Y constant
    assert compute_pearson_r([1.0, 2.0, 3.0], [5.0, 5.0, 5.0]) == 0.0


def test_psychometric_analyzer():
    key = AnswerKey.from_dict({
        "title": "Test Exam",
        "items": {
            "1": {"kind": "mcq", "answer": "A", "points": 1.0},
            "2": {"kind": "mcq", "answer": "B", "points": 1.0},
        }
    })

    # Create 4 synthetic grades
    # Student 1: 2/2 (A, B)
    # Student 2: 2/2 (A, B)
    # Student 3: 1/2 (A, C)
    # Student 4: 0/2 (C, C)
    grades = []
    responses = [
        ("S1", "A", "B", 2.0),
        ("S2", "A", "B", 2.0),
        ("S3", "A", "C", 1.0),
        ("S4", "C", "C", 0.0),
    ]

    for sid, r1, r2, total in responses:
        ig1 = ItemGrade("1", "mcq", r1, "A", is_correct=(r1 == "A"), points_awarded=1.0 if r1 == "A" else 0.0, max_points=1.0, is_blank=False, is_multi=False)
        ig2 = ItemGrade("2", "mcq", r2, "B", is_correct=(r2 == "B"), points_awarded=1.0 if r2 == "B" else 0.0, max_points=1.0, is_blank=False, is_multi=False)
        g = ExamGrade(
            exam_id=sid,
            decoded_sid=sid,
            roster_match=RosterMatch("exact", sid),
            items={"1": ig1, "2": ig2},
            score=total,
            max_score=2.0,
            percentage=total / 2.0 * 100.0,
        )
        grades.append(g)

    analyzer = PsychometricAnalyzer(key)
    metrics = analyzer.analyze(grades)

    assert metrics.num_students == 4
    assert metrics.mean_score == 1.25
    assert metrics.items[0].key == "1"
    # Item 1 facility: 3/4 = 0.75
    assert abs(metrics.items[0].facility_index - 0.75) < 1e-3
    # Item 2 facility: 2/4 = 0.50
    assert abs(metrics.items[1].facility_index - 0.50) < 1e-3

    # Render HTML report
    reporter = ReportGenerator()
    html = reporter.render(metrics)
    assert "<!doctype html>" in html
    assert "Facility (P)" in html
    assert "Cronbach's Alpha" in html
