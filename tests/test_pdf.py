"""Tests for PDF scan ingestion and multi-page processing."""
import io
from pathlib import Path

import cv2
import numpy as np
import pytest

from omr.grading import AnswerKey
from omr.layout import Layout
from omr.pdf import extract_pdf_pages, is_pdf
from omr.pipeline import OMRPipeline


def test_is_pdf_detection(tmp_path):
    pdf_file = tmp_path / "sample.pdf"
    pdf_file.write_bytes(b"%PDF-1.4\n%test\n")
    assert is_pdf(pdf_file)
    assert is_pdf(str(pdf_file))
    assert is_pdf("document.PDF")
    assert is_pdf("document.pdf")

    txt_file = tmp_path / "sample.txt"
    txt_file.write_text("hello")
    assert not is_pdf(txt_file)
    assert not is_pdf("scan.jpg")


def test_answer_key_load_csv(tmp_path):
    csv_file = tmp_path / "key.csv"
    csv_file.write_text(
        "Item #,Answer,Points,Bloom\n"
        "1,A,1.0,Remember\n"
        "2,B,2.0,Understand\n"
        "3,TRUE,1.5,Apply\n"
        "4,FALSE,1.0,Analyze\n"
        "5,short text,3.0,Evaluate\n",
        encoding="utf-8",
    )
    key = AnswerKey.load(csv_file)
    assert len(key.items) == 5
    assert key.items["1"].correct_answer == "A"
    assert key.items["1"].kind == "mcq"
    assert key.items["1"].points == 1.0

    assert key.items["2"].correct_answer == "B"
    assert key.items["2"].points == 2.0

    assert key.items["3"].correct_answer == "T"
    assert key.items["3"].kind == "tf"
    assert key.items["3"].points == 1.5

    assert key.items["4"].correct_answer == "F"
    assert key.items["4"].kind == "tf"

    assert key.items["5"].correct_answer == "short text"
    assert key.items["5"].kind == "text"
    assert key.items["5"].points == 3.0


def test_pdf_extraction_real_batch():
    test_pdf = Path("test-run/Adobe Scan Oct 18, 2026.pdf")
    if not test_pdf.exists():
        pytest.skip("Test run PDF not present")

    assert is_pdf(test_pdf)
    pages = extract_pdf_pages(test_pdf)
    assert len(pages) == 69
    assert pages[0][0] == "Adobe Scan Oct 18, 2026_p001"
    assert pages[0][1].shape[0] > 1000
    assert pages[0][1].shape[1] > 1000
    assert pages[0][1].dtype == np.uint8


def test_pipeline_pdf_batch(tmp_path):
    test_pdf = Path("test-run/Adobe Scan Oct 18, 2026.pdf")
    layout_path = Path("test-run/build_mv9h3xds_quhr-exam-package/layout.json")
    key_path = Path("test-run/build_mv9h3xds_quhr-exam-package/answer_key_template.csv")

    if not (test_pdf.exists() and layout_path.exists() and key_path.exists()):
        pytest.skip("Test run assets not present")

    layout = Layout.load(layout_path)
    key = AnswerKey.load(key_path)
    pipeline = OMRPipeline(layout, key, px_per_mm=10.0)

    # Process first page via process_file
    grade, annotated = pipeline.process_file(test_pdf)
    assert grade is not None
    assert grade.score >= 0
    assert annotated.shape[0] > 0
    assert annotated.shape[1] > 0


def test_exam_package_directory_resolution():
    package_dir = Path("test-run/build_mv9h3xds_quhr-exam-package")
    if not package_dir.exists():
        pytest.skip("Exam package not present")

    # Load layout and key directly from the package directory
    layout = Layout.load(package_dir)
    assert layout.page_width > 200
    assert len(layout.zones) > 0

    key = AnswerKey.load(package_dir)
    assert len(key.items) == 75
    assert key.items["1"].correct_answer == "A"


def test_empty_pdf_error(tmp_path):
    empty_pdf = tmp_path / "empty.pdf"
    # Minimal PDF with 0 pages catalog
    empty_pdf.write_bytes(
        b"%PDF-1.4\n"
        b"1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n"
        b"2 0 obj <</Type /Pages /Kids [] /Count 0>> endobj\n"
        b"xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n"
        b"trailer <</Size 3 /Root 1 0 R>>\nstartxref\n115\n%%EOF\n"
    )
    with pytest.raises(Exception) as exc_info:
        extract_pdf_pages(empty_pdf)
    msg = str(exc_info.value).lower()
    assert "no renderable pages" in msg or "contains no pages" in msg
