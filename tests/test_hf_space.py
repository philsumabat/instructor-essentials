"""Tests for Hugging Face Spaces Exam Checker bundle and pipeline execution."""
import os
import re
import sys
from pathlib import Path

# Add spaces/exam-checker directory to sys.path
SPACE_DIR = Path(__file__).resolve().parent.parent / "spaces" / "exam-checker"
if str(SPACE_DIR) not in sys.path:
    sys.path.insert(0, str(SPACE_DIR))

from app import run_grading_pipeline, load_built_in_sample, _extract_path


def test_hf_space_readme_metadata():
    readme_path = SPACE_DIR / "README.md"
    assert readme_path.exists(), "README.md must exist in spaces/exam-checker/"
    content = readme_path.read_text(encoding="utf-8")

    # Frontmatter check
    assert content.startswith("---"), "README.md must start with YAML frontmatter"
    frontmatter_match = re.search(r"^---\n(.*?)\n---", content, re.DOTALL)
    assert frontmatter_match, "Valid YAML frontmatter block required"
    fm = frontmatter_match.group(1)

    assert "sdk: gradio" in fm, "sdk must be gradio"
    assert "sdk_version: 4.44.0" in fm, "sdk_version must be 4.44.0"
    assert "app_file: app.py" in fm, "app_file must be app.py"
    assert "title:" in fm, "title header required"
    assert "emoji:" in fm, "emoji header required"


def test_hf_space_requirements():
    req_path = SPACE_DIR / "requirements.txt"
    assert req_path.exists(), "requirements.txt must exist"
    reqs = req_path.read_text(encoding="utf-8")

    expected_pkgs = [
        "gradio",
        "opencv-python-headless",
        "numpy",
        "pytesseract",
        "jinja2",
        "scipy",
        "pandas",
    ]
    for pkg in expected_pkgs:
        assert pkg in reqs, f"{pkg} must be listed in requirements.txt"


def test_hf_space_sample_data():
    sample_dir = SPACE_DIR / "sample_data"
    assert sample_dir.exists(), "sample_data directory must exist"
    assert (sample_dir / "layout.json").exists(), "layout.json sample must exist"
    assert (sample_dir / "bio101_key.json").exists(), "bio101_key.json sample must exist"
    assert (sample_dir / "bio101_roster.csv").exists(), "bio101_roster.csv sample must exist"

    scans = list((sample_dir / "scans").glob("*.jpg"))
    assert len(scans) >= 10, f"Expected at least 10 sample scans, found {len(scans)}"


def test_hf_space_load_built_in_sample():
    scans, layout, key, roster, fallback = load_built_in_sample()
    assert len(scans) >= 10
    assert layout is not None and Path(layout).exists()
    assert key is not None and Path(key).exists()
    assert roster is not None and Path(roster).exists()
    assert fallback is True


def test_hf_space_run_grading_pipeline():
    # Run pipeline with sample fallback enabled
    (
        metrics_html,
        table_rows,
        gallery_items,
        zip_path,
        report_html,
        report_path,
        grades_json_path,
    ) = run_grading_pipeline(
        scans_input=None,
        layout_input=None,
        key_input=None,
        roster_input=None,
        pass_threshold=60.0,
        resolution=10.0,
        use_sample_fallback=True,
    )

    # 1. Metrics card
    assert "Exams Graded" in metrics_html
    assert "Cronbach's Alpha" in metrics_html
    assert "Mean Score" in metrics_html

    # 2. Table rows (10 graded exams)
    assert len(table_rows) == 10
    # Verify columns: Exam ID, Student ID, Name, Score, Max, Pct, Status
    for row in table_rows:
        assert len(row) == 7
        assert "PASS" in row[6] or "FAIL" in row[6]

    # 3. Gallery items
    assert len(gallery_items) == 10
    for img_path, caption in gallery_items:
        assert Path(img_path).exists()
        assert "Score:" in caption

    # 4. Zip archive
    assert zip_path is not None
    assert Path(zip_path).exists()
    assert Path(zip_path).stat().st_size > 0

    # 5. HTML Item analysis report
    assert "<iframe" in report_html
    assert report_path is not None and Path(report_path).exists()
    assert grades_json_path is not None and Path(grades_json_path).exists()


def test_hf_space_extract_path(tmp_path):
    # None
    assert _extract_path(None) is None

    # Existing file path
    f = tmp_path / "sample.txt"
    f.write_text("test")
    assert _extract_path(str(f)) == f
    assert _extract_path(f) == f

    # Non-existent
    assert _extract_path(tmp_path / "nonexistent.txt") is None

    # Dict with 'path'
    assert _extract_path({"path": str(f)}) == f
    # Dict with 'name'
    assert _extract_path({"name": str(f)}) == f
    assert _extract_path({"path": "/no/such/path"}) is None

    # Object with .path attribute
    class DummyPathObj:
        def __init__(self, path):
            self.path = path

    assert _extract_path(DummyPathObj(str(f))) == f

    # Object with .name attribute
    class DummyNameObj:
        def __init__(self, name):
            self.name = name

    assert _extract_path(DummyNameObj(str(f))) == f
