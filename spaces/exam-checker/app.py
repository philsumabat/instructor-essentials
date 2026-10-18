"""Hugging Face Space Application for Checker: OMR Exam Grading & Psychometrics.

Provides an interactive Gradio web application for:
1. Uploading scanned exam sheets (single or batch).
2. Uploading or selecting custom Layout JSON, Answer Key JSON, and optional Roster CSV.
3. Executing the computer-vision grading pipeline (ArUco rectification, bubble detection, OCR).
4. Inspecting cohort statistics, psychometric item analysis (difficulty, discrimination, Cronbach's alpha).
5. Visualizing and downloading annotated exam feedback images.
"""
from __future__ import annotations

import html
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

# Add app directory and parent repository root to sys.path
CURRENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = CURRENT_DIR.parent.parent
for directory in (CURRENT_DIR, REPO_ROOT):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

try:
    import gradio as gr
except ImportError:
    gr = None

try:
    import pandas as pd
except ImportError:
    pd = None

from omr.grading import AnswerKey
from omr.layout import Layout
from omr.pipeline import OMRPipeline
from omr.roster import Roster

# Locate built-in sample files
SAMPLE_DIR = CURRENT_DIR / "sample_data"
SAMPLE_LAYOUT = SAMPLE_DIR / "layout.json"
SAMPLE_KEY = SAMPLE_DIR / "bio101_key.json"
SAMPLE_ROSTER = SAMPLE_DIR / "bio101_roster.csv"
SAMPLE_SCANS_DIR = SAMPLE_DIR / "scans"
SAMPLE_SCANS = sorted(SAMPLE_SCANS_DIR.glob("*.jpg")) if SAMPLE_SCANS_DIR.exists() else []


def _extract_path(file_obj: str | Path | object | None) -> Path | None:
    """Safely extracts a local filesystem Path from Gradio file input objects."""
    if file_obj is None:
        return None
    if isinstance(file_obj, (str, Path)):
        p = Path(file_obj)
        return p if p.exists() else None
    if isinstance(file_obj, dict):
        val = file_obj.get("path") or file_obj.get("name")
        if val:
            p = Path(val)
            return p if p.exists() else None
    if hasattr(file_obj, "path") and file_obj.path:
        p = Path(file_obj.path)
        return p if p.exists() else None
    if hasattr(file_obj, "name") and file_obj.name:
        p = Path(file_obj.name)
        return p if p.exists() else None
    return None


def run_grading_pipeline(
    scans_input: list | object | None,
    layout_input: object | None,
    key_input: object | None,
    roster_input: object | None,
    pass_threshold: float,
    resolution: float,
    use_sample_fallback: bool,
):
    """Executes the grading pipeline and prepares all outputs for the Gradio interface."""
    # 1. Resolve scan files
    scan_paths: list[Path] = []
    if scans_input:
        if isinstance(scans_input, list):
            for item in scans_input:
                p = _extract_path(item)
                if p and p.is_file():
                    scan_paths.append(p)
        else:
            p = _extract_path(scans_input)
            if p and p.is_file():
                scan_paths.append(p)

    if not scan_paths:
        if use_sample_fallback and SAMPLE_SCANS:
            scan_paths = list(SAMPLE_SCANS)
        else:
            empty_err = "<div style='color: #dc2626; padding: 16px; border: 1px solid #f87171; border-radius: 8px; background: #fef2f2;'><strong>Error:</strong> No scan images or PDFs uploaded. Please upload exam scan files (JPEG, PNG, PDF) or enable the sample fallback option.</div>"
            return (
                empty_err,
                [],
                [],
                None,
                "<p>No report generated.</p>",
                None,
                None,
            )

    # 2. Resolve Layout
    layout_path = _extract_path(layout_input)
    if not layout_path or not layout_path.exists():
        if use_sample_fallback and SAMPLE_LAYOUT.exists():
            layout_path = SAMPLE_LAYOUT
        else:
            err_html = "<div style='color: #dc2626; padding: 16px; border: 1px solid #f87171; border-radius: 8px; background: #fef2f2;'><strong>Error:</strong> Missing Layout JSON file. Please upload a layout or enable sample fallback.</div>"
            return err_html, [], [], None, "", None, None

    # 3. Resolve Answer Key
    key_path = _extract_path(key_input)
    if not key_path or not key_path.exists():
        if use_sample_fallback and SAMPLE_KEY.exists():
            key_path = SAMPLE_KEY
        else:
            err_html = "<div style='color: #dc2626; padding: 16px; border: 1px solid #f87171; border-radius: 8px; background: #fef2f2;'><strong>Error:</strong> Missing Answer Key file (JSON or CSV). Please upload an answer key or enable sample fallback.</div>"
            return err_html, [], [], None, "", None, None

    # 4. Resolve Roster (Optional)
    roster_path = _extract_path(roster_input)
    if not roster_path and use_sample_fallback and SAMPLE_ROSTER.exists():
        roster_path = SAMPLE_ROSTER

    # 5. Load OMR components
    try:
        layout = Layout.load(str(layout_path))
    except Exception as exc:
        return (
            f"<div style='color:#dc2626; padding:12px; background:#fef2f2; border-radius:8px;'>Failed to parse Layout JSON: {html.escape(str(exc))}</div>",
            [],
            [],
            None,
            "",
            None,
            None,
        )

    try:
        key = AnswerKey.load(str(key_path))
    except Exception as exc:
        return (
            f"<div style='color:#dc2626; padding:12px; background:#fef2f2; border-radius:8px;'>Failed to parse Answer Key file: {html.escape(str(exc))}</div>",
            [],
            [],
            None,
            "",
            None,
            None,
        )

    roster = None
    if roster_path and roster_path.exists():
        try:
            roster = Roster.load(str(roster_path))
        except Exception:
            roster = None

    # Clean up any stale temporary directories older than 1 hour
    tmp_base = Path(tempfile.gettempdir())
    now = time.time()
    for old_dir in tmp_base.glob("grader_hf_*"):
        try:
            if old_dir.is_dir() and (now - old_dir.stat().st_mtime) > 3600:
                shutil.rmtree(old_dir, ignore_errors=True)
        except Exception:
            pass

    # 6. Execute Batch Grading in Temporary Working Directory
    temp_dir = Path(tempfile.mkdtemp(prefix="grader_hf_"))

    try:
        pipeline = OMRPipeline(
            layout=layout,
            answer_key=key,
            roster=roster,
            px_per_mm=float(resolution),
        )
        result = pipeline.process_batch(scan_paths, output_dir=temp_dir)
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return (
            f"<div style='color:#dc2626; padding:16px; background:#fef2f2; border:1px solid #f87171; border-radius:8px;'><strong>Grading Pipeline Error:</strong> {html.escape(str(exc))}</div>",
            [],
            [],
            None,
            "",
            None,
            None,
        )

    # 7. Format Metrics Overview Card
    total_graded = len(result.grades)
    total_failed = len(result.failed_scans)
    mean_pct = result.psychometrics.mean_percentage
    mean_sc = result.psychometrics.mean_score
    tot_sc = result.psychometrics.total_possible_score
    med_sc = result.psychometrics.median_score
    std_sc = result.psychometrics.std_dev
    alpha = result.psychometrics.cronbach_alpha

    passed_count = sum(1 for g in result.grades if (g.percentage >= pass_threshold))
    pass_rate = (passed_count / total_graded * 100.0) if total_graded > 0 else 0.0

    metrics_html = f"""
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px;">
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 14px 18px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; font-weight: 600;">Exams Graded</div>
            <div style="font-size: 24px; font-weight: 700; margin-top: 4px; color: #38bdf8;">{total_graded} <span style="font-size: 14px; font-weight: 400; color: #64748b;">({total_failed} errors)</span></div>
        </div>
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 14px 18px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; font-weight: 600;">Mean Score</div>
            <div style="font-size: 24px; font-weight: 700; margin-top: 4px; color: #4ade80;">{mean_sc:.1f} / {tot_sc:.1f} <span style="font-size: 14px; font-weight: 400; color: #86efac;">({mean_pct:.1f}%)</span></div>
        </div>
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 14px 18px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; font-weight: 600;">Pass Rate (≥{pass_threshold:.0f}%)</div>
            <div style="font-size: 24px; font-weight: 700; margin-top: 4px; color: {'#34d399' if pass_rate >= 70 else '#f87171'};">{pass_rate:.1f}% <span style="font-size: 14px; font-weight: 400; color: #94a3b8;">({passed_count}/{total_graded})</span></div>
        </div>
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 14px 18px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; font-weight: 600;">Cronbach's Alpha (α)</div>
            <div style="font-size: 24px; font-weight: 700; margin-top: 4px; color: #a78bfa;">{alpha:.3f} <span style="font-size: 12px; font-weight: 400; color: #cbd5e1;">(Reliability)</span></div>
        </div>
        <div style="background: linear-gradient(135deg, #1e293b, #0f172a); color: white; padding: 14px 18px; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; font-weight: 600;">Median & Std Dev</div>
            <div style="font-size: 20px; font-weight: 700; margin-top: 4px; color: #f1f5f9;">Med: {med_sc:.1f} <span style="font-size: 14px; font-weight: 400; color: #94a3b8;">| σ: {std_sc:.2f}</span></div>
        </div>
    </div>
    """

    # 8. Student Table
    table_rows = []
    for g in result.grades:
        st_status = "✅ PASS" if g.percentage >= pass_threshold else "❌ FAIL"
        name = g.student_name if g.student_name else "—"
        table_rows.append(
            [
                g.exam_id,
                g.student_id if g.student_id else "N/A",
                name,
                f"{g.score:.1f}",
                f"{g.max_score:.1f}",
                f"{g.percentage:.1f}%",
                st_status,
            ]
        )

    # 9. Gallery of Annotated Images
    gallery_items = []
    for p, g in zip(result.annotated_paths, result.grades):
        st_status = "PASS" if g.percentage >= pass_threshold else "FAIL"
        caption = f"{g.student_name or g.student_id or g.exam_id} | Score: {g.score:.1f}/{g.max_score:.1f} ({g.percentage:.1f}%) — {st_status}"
        gallery_items.append((str(p), caption))

    # 10. Create ZIP Archive of Annotated Scans
    zip_path = temp_dir / "annotated_scans.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zip_out:
        for p in result.annotated_paths:
            zip_out.write(p, arcname=p.name)

    # 11. HTML Item Analysis Report Embed
    raw_html_report = result.report_path.read_text(encoding="utf-8")
    escaped_report = html.escape(raw_html_report, quote=True)
    report_embed_html = f"""
    <div style="border-radius: 8px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
        <iframe sandbox="allow-same-origin" srcdoc="{escaped_report}" style="width: 100%; height: 750px; border: none; background: white;"></iframe>
    </div>
    """

    return (
        metrics_html,
        table_rows,
        gallery_items,
        str(zip_path),
        report_embed_html,
        str(result.report_path),
        str(result.grades_json_path),
    )


def load_built_in_sample():
    """Returns sample files for 1-click testing."""
    sample_scans_list = [str(p) for p in SAMPLE_SCANS]
    return (
        sample_scans_list,
        str(SAMPLE_LAYOUT) if SAMPLE_LAYOUT.exists() else None,
        str(SAMPLE_KEY) if SAMPLE_KEY.exists() else None,
        str(SAMPLE_ROSTER) if SAMPLE_ROSTER.exists() else None,
        True,
    )


# Custom CSS styling for modern aesthetic
CUSTOM_CSS = """
.gradio-container {
    max-width: 1240px !important;
    margin: 0 auto !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.app-header {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
    color: white;
    padding: 24px 32px;
    border-radius: 12px;
    margin-bottom: 20px;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}
.app-header h1 {
    color: white !important;
    margin: 0 0 8px 0 !important;
    font-size: 28px !important;
    font-weight: 800 !important;
    letter-spacing: -0.025em;
}
.app-header p {
    color: #cbd5e1 !important;
    margin: 0 !important;
    font-size: 14px;
    line-height: 1.5;
}
.action-btn-primary {
    background: linear-gradient(135deg, #2563eb, #1d4ed8) !important;
    color: white !important;
    font-weight: 600 !important;
    border: none !important;
}
"""

def create_demo():
    if gr is None:
        raise ImportError(
            "Gradio is not installed. Please install dependencies: pip install gradio"
        )

    with gr.Blocks(css=CUSTOM_CSS, title="Instructor Essentials — OMR Exam Grading & Item Analysis") as demo:
        gr.HTML(
            """
            <div class="app-header">
                <h1>📝 Instructor Essentials — OMR Exam Grading & Item Analysis</h1>
                <p>
                    Turnkey cloud Optical Mark Recognition (OMR) grading pipeline with OpenCV ArUco registration,
                    automated roster mapping, and classical psychometric item analysis (difficulty index, point-biserial discrimination, Cronbach's α).
                </p>
            </div>
            """
        )

        with gr.Tabs():
            with gr.TabItem("🚀 Grading Workspace"):
                with gr.Row():
                    # Configuration Column
                    with gr.Column(scale=4):
                        gr.Markdown("### ⚙️ 1. Exam Configuration & Scans")

                        use_sample_chk = gr.Checkbox(
                            label="Use Built-in BIO 101 Midterm Sample if empty",
                            value=True,
                            info="Pre-loads BIO 101 Midterm (50 questions, 10 sample scans with roster)",
                        )

                        btn_load_sample = gr.Button(
                            "⚡ Pre-fill Inputs with Sample Files",
                            variant="secondary",
                            size="sm",
                        )

                        scans_file_input = gr.File(
                            label="Upload Scanned Exam Images / PDFs (JPEG, PNG, PDF)",
                            file_count="multiple",
                            file_types=["image", ".pdf"],
                        )

                        with gr.Accordion("📋 Custom Layout, Answer Key & Roster", open=False):
                            layout_file_input = gr.File(
                                label="Layout JSON (from Sheet Builder)",
                                file_types=[".json"],
                            )
                            key_file_input = gr.File(
                                label="Answer Key JSON or CSV",
                                file_types=[".json", ".csv"],
                            )
                            roster_file_input = gr.File(
                                label="Student Roster CSV (Optional)",
                                file_types=[".csv"],
                            )

                        with gr.Accordion("🔧 Pipeline Settings", open=False):
                            pass_threshold_slider = gr.Slider(
                                minimum=0.0,
                                maximum=100.0,
                                value=60.0,
                                step=5.0,
                                label="Passing Grade Threshold (%)",
                            )
                            resolution_slider = gr.Slider(
                                minimum=5.0,
                                maximum=20.0,
                                value=10.0,
                                step=1.0,
                                label="Processing Resolution (px/mm)",
                                info="10 px/mm = 254 DPI standard scan resolution",
                            )

                        btn_grade = gr.Button(
                            "🔍 Grade Scanned Exams with Checker",
                            variant="primary",
                            size="lg",
                            elem_classes=["action-btn-primary"],
                        )

                    # Results Column
                    with gr.Column(scale=6):
                        gr.Markdown("### 📊 2. Graded Results & Diagnostics")

                        metrics_display = gr.HTML(
                            """
                            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 24px; text-align: center; color: #64748b;">
                                Upload scans and click <strong>Grade Scanned Exams</strong> or test with the built-in sample.
                            </div>
                            """
                        )

                        with gr.Tabs():
                            with gr.TabItem("📋 Student Roster & Scores"):
                                scores_table = gr.Dataframe(
                                    headers=[
                                        "Exam ID",
                                        "Student ID",
                                        "Student Name",
                                        "Score",
                                        "Max Possible",
                                        "Percentage",
                                        "Status",
                                    ],
                                    datatype=["str", "str", "str", "str", "str", "str", "str"],
                                    interactive=False,
                                )

                            with gr.TabItem("🖼️ Annotated Scans Feedback"):
                                annotated_gallery = gr.Gallery(
                                    label="Graded Scans with Visual Feedback",
                                    columns=2,
                                    height="auto",
                                    object_fit="contain",
                                )
                                zip_download = gr.File(
                                    label="📦 Download All Annotated Scans (ZIP Archive)",
                                    interactive=False,
                                )

                            with gr.TabItem("📈 Item Analysis Report"):
                                report_html = gr.HTML("<p style='color:#64748b; padding:12px;'>Run the grading pipeline to view the item analysis report.</p>")
                                with gr.Row():
                                    report_download = gr.File(
                                        label="📄 Download HTML Report",
                                        interactive=False,
                                    )
                                    json_download = gr.File(
                                        label="📊 Download Grades Summary (JSON)",
                                        interactive=False,
                                    )

            with gr.TabItem("📖 About & Sample Downloads"):
                gr.Markdown(
                    """
                    ### About Checker
                    **Checker** is a high-accuracy, privacy-preserving Optical Mark Recognition (OMR) system designed for academic assessments.

                    #### Pipeline Features:
                    - **Fiducial ArUco Alignment:** 4 corner markers provide sub-millimeter 4-point homography perspective registration regardless of scanner rotation, translation, or skew.
                    - **Adaptive Bubble Fill Detection:** Otsu and Otsu-adaptive dynamic thresholding robust against dark pencils, blue/black ink, and incomplete bubble erasures.
                    - **Handwritten Text Extraction:** Tesseract OCR integration for digit student IDs and short-answer prompts.
                    - **Psychometrics Suite:** Automated calculation of Item Difficulty ($P$-value), Item Discrimination ($r_{\text{pbis}}$ point-biserial), Distractor Frequency Distribution, and Test Reliability (Cronbach's $\\alpha$).

                    #### Designing Sheets in Sheet Builder:
                    You can design custom exam bubble sheets in **Sheet Builder** running on GitHub Pages:
                    1. Design your layout with columns, student ID grids, and questions.
                    2. Export printable PDF/SVG and `layout.json`.
                    3. Create an answer key JSON and grade exams right here in Checker!
                    """
                )

        # Wire event handlers
        btn_load_sample.click(
            fn=load_built_in_sample,
            inputs=[],
            outputs=[
                scans_file_input,
                layout_file_input,
                key_file_input,
                roster_file_input,
                use_sample_chk,
            ],
        )

        btn_grade.click(
            fn=run_grading_pipeline,
            inputs=[
                scans_file_input,
                layout_file_input,
                key_file_input,
                roster_file_input,
                pass_threshold_slider,
                resolution_slider,
                use_sample_chk,
            ],
            outputs=[
                metrics_display,
                scores_table,
                annotated_gallery,
                zip_download,
                report_html,
                report_download,
                json_download,
            ],
        )

    return demo


demo = create_demo() if gr is not None else None

if __name__ == "__main__":
    if gr is None:
        print("Error: Gradio is required to run the web UI.", file=sys.stderr)
        print("Please install requirements: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)
    if demo is not None:
        demo.launch()
