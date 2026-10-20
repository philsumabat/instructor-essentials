# Instructors' Toolkit Product and Engine Roadmap

## Product direction

Instructors' Toolkit should help an instructor move from a printable assessment to trustworthy, reviewable results with as little setup as possible. Keep the full product free: no paid feature gates, accounts, subscriptions, or required paid services.

## Project perspective

This is an instructor-led project. The maintainer understands classroom needs and can describe the desired teaching workflow, but does not claim to be an expert in software engineering, computer vision, OCR, or psychometrics. The roadmap’s technical and assessment ideas are proposals to investigate and validate, not expert-certified conclusions. Contributors and AI agents should explain choices and limitations in plain language. See [`AGENTS.md`](AGENTS.md) for project-wide contributor guidance and [`DECISIONS.md`](DECISIONS.md) for the current architecture and implementation history.

The project already has a browser based Sheet Builder, a browser checker, a Python/OpenCV grading pipeline, a Hugging Face Gradio app, batch exports, and psychometric analysis. The roadmap improves how these pieces work together and strengthens the engines that read and grade scans.

## Principles

- **Free to use:** exam creation, grading, review, and export remain available at no cost.
- **Local-first where practical:** offer browser-only and local-computer paths. Hosted processing is optional.
- **Reviewable results:** show the evidence behind uncertain reads and let instructors correct them.
- **No hidden substitutions:** clearly identify sample inputs and never silently grade them in place of uploaded work.
- **Explain limits:** third-party free hosting can change availability or limits; it is not a product guarantee.
- **Engine improvements need evidence:** compare changes against representative scans and track both accuracy and failure cases before calling them improvements.
- **Avoid unsupported certainty:** report concrete flags and diagnostics before introducing confidence scores that have not been calibrated.

## Priorities at a glance

| Priority | Milestone | Main outcome | Suggested effort |
|---|---|---|---:|
| P0 | Product foundation and input validation | Users understand the workflow; incompatible files are caught early | 1–2 weeks |
| P1 | Engine diagnostics and benchmark set | Improvements can be measured against real failure cases | 1–2 weeks |
| P2 | Review queue and instructor corrections | Uncertain results can be checked and corrected before export | 2–4 weeks |
| P3 | Gradebook and classroom exports | Results transfer cleanly to spreadsheets and students | 1–2 weeks |
| P4 | OMR engine robustness | Better alignment, bubble reads, and predictable handling of scan quality | 3–5 weeks |
| P5 | OCR and student identity improvements | More reliable IDs and clearer handling of ambiguous text | 2–4 weeks |
| P6 | First-run demo and connected workflow | New instructors can complete a sample assessment end to end | 1–2 weeks |
| P7 | Builder/checker usability, privacy, and accessibility | The tool is easier to operate and its data handling is clear | 2–4 weeks |
| P8 | Analysis and feedback improvements | Reports are easier to interpret and act on | 2–4 weeks |

Effort is directional for one developer familiar with the codebase. Engine work may take longer if representative scan data is limited.

---

# Detailed roadmap

## P0 — Product foundation and input validation

**Goal:** Make the current capabilities understandable and prevent avoidable grading mistakes before running the expensive or time-consuming parts of the pipeline.

### Product work

1. Define and document the main instructor journey:
   - Choose or build an answer sheet.
   - Print at actual size and preserve the fiducial markers.
   - Save the matching layout and answer key.
   - Scan completed sheets.
   - Upload scans, layout, key, and optionally roster.
   - Review flagged results.
   - Export confirmed results.
2. Present Sheet Builder and Checker as connected steps, with clear links between them.
3. Explain three operating modes:
   - Browser-only tools where the current checker supports the needed workflow.
   - Local Python grading for processing files on the instructor’s computer.
   - Optional hosted Gradio app, which processes uploads on the host.
4. Clarify that the software is free while free hosting is controlled by third parties and may change.
5. Create a concise “Start here” page and file checklist.

### Input preflight work

1. Validate that scan images can be decoded and are in supported formats.
2. Validate layout JSON, answer key JSON, and roster CSV before grading.
3. Check that answer-key item identifiers correspond to items in the layout.
4. Detect duplicate roster IDs, missing required columns, and malformed rows.
5. Display which files and settings will be used, including whether sample data is selected.
6. Warn if the uploaded scan count or file sizes exceed supported practical limits.
7. Show a concise preflight summary with actionable fixes instead of stack traces.

### Deliverables

- Start page and file checklist.
- Preflight validation screen or panel.
- Input errors phrased for instructors, with a technical detail disclosure where useful.
- Explicit sample-mode labeling.

### Acceptance criteria

- A first-time instructor can identify the inputs needed without reading architecture documentation.
- Invalid or mismatched files are reported before grading begins.
- The app clearly states whether it will use uploaded files or sample data.
- Documentation differentiates local processing from hosted processing and avoids guarantees about third-party free tiers.

---

## P1 — Engine diagnostics and benchmark set

**Goal:** Establish a trustworthy way to decide whether an engine change actually helps.

### Benchmark data

1. Collect a small, versioned set of representative scans with known answers and IDs.
2. Include varied conditions:
   - Clean flatbed scans.
   - Phone photos with rotation and perspective distortion.
   - Light and dark exposure.
   - Uneven lighting and shadows.
   - Slight blur, compression artifacts, and paper skew.
   - Erasures, faint marks, heavy marks, and marks crossing bubble boundaries.
   - Blank, multiple, and ambiguous responses.
   - Handwritten and bubble-grid student IDs if both are supported.
3. Keep a ground-truth annotation for each scan: expected corners/alignment, bubble selections, IDs, item responses, and known review cases.
4. Remove real student personal data or obtain appropriate permission before using any real scans. Prefer synthetic or intentionally de-identified examples for the public repository.
5. Document how to add a benchmark example and how its labels were checked.

### Metrics to track

- Sheet detection/alignment success rate.
- Bubble-level accuracy, precision, recall, and error rate.
- Blank and multiple-mark classification accuracy.
- Student-ID exact match rate and correction/recovery rate.
- Per-scan successful processing rate.
- False acceptance rate: an incorrect read treated as unambiguous.
- Review rate: how often the system correctly asks a human to inspect a result.
- Runtime and memory on a representative batch.

Do not optimize only for the number of scans processed. A system that flags uncertainty accurately can be safer and more useful than one that always returns a confident-looking answer.

### Diagnostics work

1. Preserve useful per-scan signals from the pipeline: marker detections, warp quality, bubble fill measurements, OCR alternatives, roster-match method, and skipped/failed reasons.
2. Add a machine-readable diagnostic record per scan or item, separate from the student-facing report.
3. Use deterministic benchmark runs and compare metrics before/after engine changes.
4. Add a small set of targeted regression examples for every bug found in actual usage.

### Deliverables

- Versioned benchmark dataset and ground-truth format.
- Baseline metric report.
- Per-scan diagnostic schema.
- Short engine evaluation guide.

### Acceptance criteria

- An engine change can be compared against a known baseline.
- Metrics include false acceptance and review behavior, not just aggregate accuracy.
- A detected regression can be traced to a scan and, where applicable, an item.
- Public examples contain no unapproved student personal data.

---

## P2 — Review queue and instructor corrections

**Goal:** Make grading transparent and correctable before instructors use results.

### Flagging rules

Flag concrete conditions, including:

- Fiducials missing, incomplete, or geometrically inconsistent.
- Scan could not be aligned or image could not be decoded.
- Bubble mark is blank, multiple, or near a decision boundary.
- Student ID is unreadable, incomplete, or roster-matched through a recovery rule.
- OCR text is empty or has plausible competing interpretations.
- Scan failed or one or more items were skipped.
- Instructor manually changed an answer or identity.

Keep reason codes stable and human-readable. Avoid presenting an uncalibrated numeric confidence value as if it were a probability.

### Review interface

1. Add a review status to each scan: **Needs review**, **Reviewed**, or **Could not process**.
2. Build a queue filtered to scans/items needing attention.
3. Show the scan preview, detected response, expected response, score impact, and reason for the flag together.
4. Let the instructor navigate between flagged scans without returning to the batch list each time.
5. Add a way to inspect all responses for a student before confirming that scan.
6. Show a completion count, such as “8 of 10 flagged items reviewed.”

### Corrections and auditability

1. Let the instructor change a bubble response, student identity, or supported text response.
2. Recalculate item score, total score, and affected summary metrics immediately.
3. Retain the original machine reading, corrected value, correction reason if provided, and timestamp for the current session/export.
4. Make it clear which values were machine-read and which were changed by an instructor.
5. Ensure corrected grades replace the original values in every export.
6. Keep edits in the browser session or a downloadable review-state file; do not require user accounts or a server database.

### Deliverables

- Flag taxonomy and review states.
- Review queue and enlarged scan/item inspection.
- Correction controls and an audit trail.
- Export integration for corrected results and unresolved flags.

### Acceptance criteria

- Instructors can find the results needing attention without opening every scan.
- Every flag explains why it appeared and what the instructor can inspect.
- Corrections change the displayed grade and all exported grades.
- Exports preserve the original read and corrected value distinctly.
- Unreviewed flags remain visible and are not represented as confirmed.

---

## P3 — Gradebook and classroom exports

**Goal:** Make results usable in normal classroom workflows without paid integrations.

### Standard gradebook CSV

Include, at minimum:

- Student ID.
- Student name, when available.
- Exam/scan identifier.
- Score and maximum score.
- Percentage.
- Review status.
- Whether any correction was made.
- One column per item with consistent representations for correct, incorrect, blank, multiple mark, and unresolved.

Use stable headers, deterministic item ordering, correct CSV quoting, UTF-8 encoding, and spreadsheet-friendly values. Document the schema and avoid ambiguous values such as a blank cell meaning several different states.

### Other exports

- Annotated scans as a ZIP archive.
- Item analysis as standalone HTML.
- Machine-readable JSON summary.
- Optional per-student feedback that excludes cohort statistics and answer keys by default.
- Optional anonymized gradebook export for sharing class-level results.

### Traceability and privacy

- Include exam title, template/layout identifier, grading date, and export schema version.
- Identify automated and manually corrected fields.
- List failed scans and unresolved flags in a separate, clear section.
- Offer a way to omit names from reports or use student IDs only.
- Keep local browser exports generated client-side where possible.

### Acceptance criteria

- CSV opens correctly in common spreadsheet software and keeps every student as one row.
- Item columns align with the exam’s item IDs and appear in predictable order.
- Corrections, failures, blanks, multiple marks, and unresolved cases remain distinguishable.
- Instructors do not need to copy results manually from the UI.

---

## P4 — OMR engine robustness

**Goal:** Improve sheet alignment and mark reading across realistic scan variation, with changes validated against P1 benchmarks.

### 4.1 Sheet detection and geometric rectification

Current foundation: ArUco fiducial detection and homography-based perspective correction in `omr/vision.py`.

Investigate and improve:

1. Validate the detected marker IDs, corner ordering, marker size, and expected relative geometry before warping.
2. Reject or flag implausible homographies rather than returning a distorted sheet that proceeds to grading.
3. Record diagnostics such as found markers, corner coordinates, reprojection/geometric error, and output crop bounds.
4. Improve handling of partially obscured markers when enough geometric evidence remains; otherwise ask for a rescan.
5. Support common rotations and camera perspective without assuming a fixed image orientation.
6. Add scan-quality guidance: include the full page, avoid shadows, keep the page flat, and preserve all four markers.
7. Explore fallback detection only after measuring marker failure cases. Any fallback should identify its method and be tested against false alignments.

### 4.2 Bubble mark detection

Current foundation: adaptive preprocessing and inner-core density sampling.

Investigate and improve:

1. Retain per-bubble measurements such as fill density and relevant local threshold values.
2. Evaluate adaptive thresholds by page or region to handle shadows and exposure gradients.
3. Compare each candidate mark with nearby unmarked bubbles and the printed bubble baseline.
4. Distinguish blank, single mark, multiple marks, and ambiguous fill using benchmarked thresholds.
5. Handle light pencil, heavy shading, check marks, erasures, and stray marks with explicit benchmark cases.
6. Inspect whether contour/shape or ink distribution provides useful additional evidence beyond fill density.
7. Calibrate any review threshold against false accept and false reject rates.
8. Preserve a debug visualization option that overlays sampled regions and measured values for troubleshooting.

### 4.3 Print and scan tolerance

1. Test the physical print-to-scan pipeline at the supported paper sizes and printer scaling settings.
2. Verify that print margins and browser print scaling do not shift the layout outside tolerated geometry.
3. Detect severe crop, blur, low resolution, or glare and provide a rescan recommendation.
4. Ensure unsupported layouts or resolution assumptions are identified in preflight.

### Deliverables

- Improved alignment and bubble diagnostics.
- Benchmark results for every threshold or algorithm change.
- Debug mode for representative scans.
- Instructor-facing scan quality guidance.

### Acceptance criteria

- Changes improve or preserve benchmark metrics across scan conditions, not just the clean sample.
- The system flags geometry it cannot validate instead of silently grading a bad warp.
- Blank, multiple, and ambiguous marks are separable in the result model.
- The UI can show the reason an item was flagged without exposing raw image-processing jargon by default.

---

## P5 — OCR and student identity improvements

**Goal:** Make student identification more dependable while keeping ambiguous OCR visible to instructors.

### Student ID reading

1. Separate OCR recognition from roster resolution in diagnostics and UI.
2. Preserve raw OCR text and any normalized candidate values.
3. Explain whether a match was exact, normalized, recovered from a missing digit, or corrected by an instructor.
4. Add protections against unsafe auto-correction: if more than one roster entry is plausible, require review.
5. Handle leading zeros consistently and document normalization rules.
6. Detect duplicate student IDs and duplicate matches across scans in a batch.
7. Allow instructors to resolve a scan to the correct roster entry from a searchable list.

### Handwritten response OCR

1. Identify which text fields are supported for automated reading and which require human grading.
2. Keep OCR suggestions separate from official grades unless the rubric and recognition behavior are validated.
3. Show the cropped response region beside the recognized text.
4. Allow correction for supported short-answer items and retain the original OCR output.
5. Make OCR failure or ambiguity a review reason, not a silent blank answer.

### Engine evaluation

- Track exact ID match, ambiguous ID, false match, and no-match rates separately.
- Benchmark OCR by handwriting style and image quality where suitable data is available.
- Avoid claiming general handwriting recognition accuracy based only on synthetic or very small samples.

### Deliverables

- Transparent roster-match explanation.
- Duplicate and ambiguous match detection.
- OCR crop review and correction for supported fields.
- Separate metrics for OCR and roster resolution.

### Acceptance criteria

- Ambiguous identity is never silently assigned to an arbitrary student.
- The instructor can tell what the OCR read and how the roster match was selected.
- Duplicate scans or duplicate student assignments are visible before export.
- Handwritten answers are not auto-graded beyond the behavior that has been validated and documented.

---

## P6 — First-run demo and connected workflow

**Goal:** Give new users a safe, quick demonstration using sample materials.

### Work

1. Provide a clearly labeled sample assessment with matching sheet, layout, answer key, roster, and scans.
2. Offer a sample run from the browser checker where the host/runtime supports it.
3. Provide a downloadable sample package for local Python use.
4. Show the sample result, annotated scan, item analysis, and exports.
5. Explain the file roles in a short walkthrough.
6. Make sample mode visually persistent and confirm the inputs before running.
7. Link from the sample experience to creating a custom assessment.
8. Add troubleshooting for wrong layout/key, cropped page, marker detection, unreadable ID, unsupported image, and corrupted file.

### Acceptance criteria

- A user can see a complete sample result without preparing files.
- The UI distinguishes fictional sample data from real grading data.
- Sample mode cannot be entered accidentally through silent fallback.
- The sample outputs can be compared to expected known results.

---

## P7 — Builder/checker usability, privacy, and accessibility

**Goal:** Reduce setup friction and state data handling accurately.

### Builder usability

- Explain preset suitability, paper size, and approximate capacity.
- Make title, date, question count, response type, and student ID setup discoverable.
- Provide print instructions: actual size, no fit-to-page scaling, complete markers visible.
- Clarify which generated file is for printing and which files are required for grading.
- Offer a downloadable setup package with matching layout/key/instructions where technically feasible.

### Checker usability

- Make primary actions, upload status, progress, and errors easy to locate.
- Support tablet-sized review and enlarged scan previews.
- Use plain labels and avoid conveying status by color or emoji alone.
- Provide keyboard navigation, visible focus, screen-reader labels, and accessible table structure.

### Privacy and reliability

1. Document what runs in the browser, locally, and on the hosted service.
2. Verify temporary upload cleanup on success and failure in the hosted app.
3. Avoid retaining scans between sessions unless explicitly requested and supported.
4. Set practical upload count and size limits for free hosting and explain them in the interface.
5. Report partial batch success and preserve successful outputs when some scans fail.
6. Provide local setup as a fallback if hosted service availability changes.

### Acceptance criteria

- Users can distinguish browser-local, computer-local, and hosted processing.
- Hosted temporary files are cleaned up on both success and failure.
- The core journey is keyboard operable and status is not color-only.
- Partial batch failures are explicit and do not hide successfully processed scans.

---

## P8 — Instructor-focused analysis and feedback

**Goal:** Explain existing psychometric outputs and help instructors identify questions worth inspecting.

### Work

1. Explain difficulty/facility, discrimination, point-biserial, and reliability in plain language.
2. State limits for small cohorts and unusual test conditions.
3. Add sorting/filtering by item number, difficulty, discrimination, blank rate, and multiple-mark rate.
4. Highlight patterns as prompts for instructor review, not automatic judgments.
5. Add per-student feedback exports without answer keys or cohort statistics by default.
6. Allow instructor notes such as “check key,” “review wording,” or “retain,” stored locally or in the export.
7. Separate instructor-facing item analysis from student-facing feedback.

### Acceptance criteria

- A reader can understand each metric without having to infer its meaning.
- The report describes small-sample limitations and avoids declaring items good or bad automatically.
- Student-facing exports do not reveal cohort results or answer keys by default.
- Instructor review notes can be carried with the exported report.

---

# Suggested release sequence

## Release 1 — Clear and safe to start

Ship P0 and the benchmark foundation from P1.

**Exit condition:** Users know what to provide; mismatched inputs are caught; engine changes have a measurable baseline.

## Release 2 — Trustworthy results

Ship P2 review workflow, correction state, and the core P3 CSV schema.

**Exit condition:** Instructors can find uncertain cases, correct them, and export an accurate gradebook with unresolved flags visible.

## Release 3 — Stronger engines

Improve alignment and bubble interpretation from P4, then identity/OCR from P5, using the benchmark suite throughout.

**Exit condition:** Engine changes demonstrate measurable performance and do not hide ambiguous cases.

## Release 4 — Easy onboarding and durable use

Ship the sample demo from P6 plus the privacy, accessibility, and reliability work from P7.

**Exit condition:** New users can try the full path, and real-data handling is described accurately.

## Release 5 — Useful reports

Ship P8 and the remaining export enhancements.

**Exit condition:** Instructors can interpret results and share appropriate student-facing outputs safely.

# Recommended first implementation slice

Start with **preflight validation + engine diagnostics + a reviewable results list**:

1. Validate layout/key/roster compatibility before grading.
2. For every scan, report processing status, matched student, score, and concrete review reasons.
3. Preserve bubble measurements and ID match method in an internal diagnostic record.
4. Add a small benchmark set before changing detection thresholds.
5. Export the same review status in the CSV.

This slice connects usability and engine quality while keeping the work incremental. It also establishes a foundation for later corrections and more advanced engine improvements.

# Free-access guardrails

- Keep all core features free, including review and exports.
- Do not require accounts for core use.
- Prefer browser and local processing when practical.
- Avoid paid OCR, AI, analytics, cloud storage, and proprietary API dependencies.
- Treat free third-party hosting as optional infrastructure with changeable limits.
- Maintain a local workflow so the product remains usable if a hosted option changes.
- If donations or sponsorship are added in the future, keep them optional and separate from access to functionality.
