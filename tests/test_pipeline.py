import pytest
from unittest.mock import MagicMock
from omr.pipeline import OMRPipeline
from omr.grading import ExamGrade, ItemGrade
from omr.roster import RosterMatch, Student

def create_mock_exam_grade(exam_id: str, student_id: str, student_name: str, mcq_answers: dict[str, str]) -> ExamGrade:
    """Helper to create a simplified ExamGrade object for testing."""
    if student_id or student_name != "Unknown Student":
        student = Student(student_id=student_id, full_name=student_name)
        roster_match = RosterMatch("exact", student_id, student=student)
    else:
        roster_match = RosterMatch("exact", student_id)

    items = {}
    for key, ans in mcq_answers.items():
        # Using placeholder properties where exactness doesn't matter for duplicate detection
        items[key] = ItemGrade(
            key=key,
            kind="mcq",
            student_response=ans,
            correct_answer=ans,
            is_correct=True,
            points_awarded=1.0,
            max_points=1.0,
            is_blank=(ans in {"", "?", "BLANK"}),
            is_multi=False,
            details="",
        )

    return ExamGrade(
        exam_id=exam_id,
        decoded_sid=student_id,
        roster_match=roster_match,
        items=items,
        score=float(len(mcq_answers)),
        max_score=float(len(mcq_answers)),
        percentage=100.0,
    )

@pytest.fixture
def mock_pipeline():
    # Provide a minimal mock for the pipeline since we only need the detect_duplicates method
    # It does not rely on self state, so we can mock dependencies.
    pipeline = OMRPipeline.__new__(OMRPipeline)
    return pipeline

def test_detect_duplicates_empty_or_no_duplicates(mock_pipeline):
    """Test happy path when there are no duplicates."""
    grades = [
        create_mock_exam_grade("exam1", "123", "Alice", {"q1": "A", "q2": "B"}),
        create_mock_exam_grade("exam2", "456", "Bob", {"q1": "B", "q2": "C"}),
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 0
    assert not grades[0].is_duplicate
    assert not grades[1].is_duplicate

def test_detect_duplicates_student_id_collision(mock_pipeline):
    """Test that same student IDs trigger a collision duplicate."""
    grades = [
        create_mock_exam_grade("exam1", "123", "Alice", {"q1": "A", "q2": "B"}),
        create_mock_exam_grade("exam2", "123", "Alice", {"q1": "C", "q2": "D"}), # Same ID, different answers to avoid ratio overlap
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 1
    assert duplicates[0]["type"] == "student_id_collision"
    assert duplicates[0]["student_id"] == "123"
    assert set(duplicates[0]["exam_ids"]) == {"exam1", "exam2"}

    assert grades[0].is_duplicate
    assert grades[1].is_duplicate
    assert "exam2" in grades[0].duplicate_note
    assert "exam1" in grades[1].duplicate_note

def test_detect_duplicates_ignore_special_student_ids(mock_pipeline):
    """Test that empty IDs, 'STU-' IDs, or '?' IDs are not flagged as collisions."""
    grades = [
        create_mock_exam_grade("exam1", "", "Unknown", {"q1": "A"}),
        create_mock_exam_grade("exam2", "", "Unknown", {"q1": "B"}),
        create_mock_exam_grade("exam3", "STU-01", "Anonymous", {"q1": "C"}),
        create_mock_exam_grade("exam4", "STU-02", "Anonymous", {"q1": "D"}),
        create_mock_exam_grade("exam5", "????", "Unknown", {"q1": "E"}),
        create_mock_exam_grade("exam6", "????", "Unknown", {"q1": "F"}),
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 0

def test_detect_duplicates_bubble_collision(mock_pipeline):
    """Test that >= 96% matching answers on >= 10 items triggers an identical responses warning."""
    # Create 10 identical answers
    identical_answers = {f"q{i}": "A" for i in range(1, 11)}

    grades = [
        create_mock_exam_grade("exam1", "111", "Alice", identical_answers),
        create_mock_exam_grade("exam2", "222", "Bob", identical_answers.copy()),
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 1
    assert duplicates[0]["type"] == "identical_responses"
    assert set(duplicates[0]["exam_ids"]) == {"exam1", "exam2"}

    assert grades[0].is_duplicate
    assert grades[1].is_duplicate

def test_detect_duplicates_no_bubble_collision_if_few_questions(mock_pipeline):
    """Test that it doesn't trigger bubble collision if there are < 10 shared questions."""
    # Only 9 identical answers
    identical_answers = {f"q{i}": "A" for i in range(1, 10)}

    grades = [
        create_mock_exam_grade("exam1", "111", "Alice", identical_answers),
        create_mock_exam_grade("exam2", "222", "Bob", identical_answers.copy()),
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 0

def test_detect_duplicates_no_bubble_collision_if_ratio_low(mock_pipeline):
    """Test that it doesn't trigger if the match ratio is < 96%."""
    # 9 identical answers out of 10 -> 90% match ratio
    ans1 = {f"q{i}": "A" for i in range(1, 11)}
    ans2 = ans1.copy()
    ans2["q10"] = "B" # Different answer

    grades = [
        create_mock_exam_grade("exam1", "111", "Alice", ans1),
        create_mock_exam_grade("exam2", "222", "Bob", ans2),
    ]

    duplicates = mock_pipeline.detect_duplicates(grades)

    assert len(duplicates) == 0
