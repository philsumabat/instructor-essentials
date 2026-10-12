# Optical Mark Recognition (OMR) & Document Processing Pipeline

An end-to-end, millimeter-accurate Optical Mark Recognition (OMR) and document processing pipeline operating on standard image files (JPEG, PNG).

---

## Architecture Overview

```
                                      JSON Template
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
                           │   Isomorphic Layout Engine      │
                           │   (builder/js/layout-engine.js) │
                           └───────────────┬─────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
           Browser DOM Builder        Vector SVG Export      Layout Geometry
          (CSS Grid + @page print)    (True-scale mm)        (layout.json)
                    │                                             │
                    ▼                                             ▼
             Printed Paper                                OpenCV Vision Pipeline
             (with ArUco fiducials)                      (Perspective Warping & OMR)
                    │                                             │
                    ▼                                             ▼
              Scanned JPEG  ─────────────────────────────► Bubble Density Scan
                                                                  │
                                                                  ├─► OCR Extraction
                                                                  │
                                   CSV Roster ───────────────────►├─► Student Match
                                                                  │
                                   Answer Key ───────────────────►├─► Grading Engine
                                                                  │
                                           ┌──────────────────────┴──────────────────────┐
                                           ▼                                             ▼
                                  Annotated JPEG Scans                          Item Analysis Report
                                (OpenCV visual feedback)                         (HTML + Psychometrics)
```

---

## Directory Structure

```text
├── builder/                      # Module 1: Browser-Based Exam Sheet Builder
│   ├── css/
│   │   ├── app.css               # Builder UI styles and print rules
│   │   └── sheet.css             # Physical millimeter sheet styling (CSS Grid)
│   ├── index.html                # Client-side sheet generator and interactive preview
│   ├── js/
│   │   ├── app.js                # Browser controller & file download actions
│   │   ├── aruco.js              # OpenCV DICT_4X4_50 marker bit patterns (IDs 0–3)
│   │   ├── layout-engine.js      # Core geometry engine (resolves mm coordinates)
│   │   ├── render-dom.js         # DOM / CSS Grid virtual node renderer
│   │   └── render-svg.js         # Standalone scalable vector graphic generator
│   └── templates/
│       ├── exam-50.json          # 50 MCQ + 10 T/F + 2 handwritten text answers (A4)
│       ├── exam-100.json         # 100 MCQ 4-choice answers (US Letter)
│       └── quiz-tf.json          # 40 T/F + 3 short-answer items (A4)
├── data/
│   ├── bio101_key.json           # Sample exam answer key with points and rubrics
│   ├── bio101_roster.csv         # Sample class roster (Student ID, Full Name, Section)
│   └── scans/                    # Scanned test JPEGs with realistic skew and noise
├── dist/                         # Exported template bundles (layout.json, sheet.svg, sheet.html)
│   ├── exam-50/
│   ├── exam-100/
│   └── quiz-tf/
├── omr/                          # Modules 2–5: Python Computer Vision & Grading Engine
│   ├── __init__.py
│   ├── __main__.py
│   ├── annotator.py              # Visual grading overlay renderer (OpenCV derivative JPEGs)
│   ├── cli.py                    # Command-line interface for batch grading
│   ├── grading.py                # Answer key evaluator (MCQ, TF, fuzzy OCR text)
│   ├── layout.py                 # Typed loader for builder layout.json coordinate contract
│   ├── ocr.py                    # ROI cropping & handwriting OCR extraction (PyTesseract)
│   ├── pipeline.py               # End-to-end batch processing pipeline orchestrator
│   ├── report.py                 # Psychometrics (P, D, r_pbis, Alpha) & Jinja2 HTML report
│   ├── roster.py                 # CSV roster ingestion & fault-tolerant OMR ID matcher
│   ├── simulator.py              # Realistic exam scan generator with physical distortions
│   └── vision.py                 # ArUco detection, perspective warping, bubble density scanner
├── output/                       # Grading deliverables
│   ├── annotated/                # Graded JPEG derivative scans with visual marks
│   ├── grades_summary.json       # Structured scores and roster matches
│   └── item_analysis_report.html # Standalone psychometric report
├── scripts/
│   ├── export-layout.mjs         # Headless template export CLI (Node)
│   └── generate_sample_scans.py  # Synthetic test scan generator
├── tests/                        # Automated unit and integration test suite
│   ├── js/
│   │   └── layout.test.mjs       # Node tests for layout engine & rendering
│   ├── test_grading.py           # Evaluation tests
│   ├── test_psychometrics.py     # Statistical formulas tests
│   ├── test_roster.py            # Roster parsing & ID recovery tests
│   └── test_vision.py            # Perspective warp & bubble density tests
├── package.json                  # Node scripts and dev server
├── pyproject.toml                # Python package metadata
└── requirements.txt              # Python dependencies
```

---

## Quickstart

### 1. Installation

```bash
# Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Node environment (optional, for local HTTP server & tests)
npm install
```

### 2. Browser-Based Exam Sheet Builder

To run the interactive sheet builder locally:
```bash
npm run dev
# Open http://localhost:5173 in Google Chrome
```

Or export templates directly from the CLI:
```bash
npm run export:all
```
This generates `dist/<template>/` containing:
- `layout.json`: Canonical millimeter geometry consumed by the CV pipeline.
- `sheet.svg`: Scalable vector graphic for publishing.
- `sheet.html`: Standalone printable DOM sheet using CSS Grid and `@media print`.

### 3. Running Batch Grading

Grade a batch of scanned exams against a roster and answer key:
```bash
python -m omr \
  --layout dist/exam-50/layout.json \
  --key data/bio101_key.json \
  --roster data/bio101_roster.csv \
  --scans "data/scans/*.jpg" \
  --out output/
```

### 4. Running the Test Suite

```bash
# Python test suite
pytest -v

# Node layout engine test suite
npm test
```

---

## Features & Implementation Details

1. **Shared Coordinate Contract**:
   The sheet builder's `layout-engine.js` computes exact bubble center coordinates `(cx, cy)` in millimeters. When exported to `layout.json`, the Python CV pipeline samples those exact coordinates multiplied by `px_per_mm`. Print layout and sampling coordinates can never drift out of sync.

2. **ArUco Perspective Transformation**:
   Four ArUco markers (`DICT_4X4_50`, IDs 0, 1, 2, 3) placed at the sheet corners provide orientation-invariant anchor points. The homography matrix $H$ is computed using RANSAC subpixel refinement, correcting scans rotated at arbitrary angles, upside-down feeds, and perspective keystoning.

3. **Bubble Density Measurement**:
   Adaptive thresholding isolates pencil graphite fills. Pixel density is computed within an inner circular core (72% of bubble radius) to eliminate printed ring stroke interference, combined with contour alignment and differential margin detection.

4. **Fault-Tolerant Student ID Roster Matcher**:
   Decodes multi-column student ID matrices and matches against CSV rosters using a multi-tier fallback: Exact match $\rightarrow$ Leading-zero normalization $\rightarrow$ Wildcard inference (recovering blank/smudged columns) $\rightarrow$ Single-digit Hamming distance recovery.

5. **Handwriting OCR Extraction**:
   Preprocesses cropped regions of interest (ROI inset border suppression, bilateral filtering, and Otsu thresholding) before feeding to Tesseract OCR with character whitelist constraints.

6. **Derivative Feedback Images & Psychometric Analysis**:
   Annotates scans with green halos for correct answers, red crosses with missed-key indicators for errors, and executive score cards. Computes Facility Index ($P$), Discrimination Index ($D$), Point-Biserial Correlation ($r_{pbis}$), distractor frequencies, and Cronbach's Alpha ($\alpha$) in a Jinja2 HTML report.
