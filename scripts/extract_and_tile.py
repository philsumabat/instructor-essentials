#!/usr/bin/env python3
"""
OMR Exam Sheet Grader & Extraction Engine
Extracts header identifiers (Name, ID, Offer No.), scores objective bubbles,
filters blank handwritten boxes via ink density, and tiles non-blank answers
into ultra-compact contact strips for token-efficient grading.

Features:
- Hyphenated Student ID normalization (e.g. 26-1-0142 -> 26100142)
- Offer Number normalization (e.g. E-326 -> E326)
- Modified T/F audit labeling: (True — No Correction Required) on True items
- Translucent red/green visual correction overlays
- Botanical scientific name validation (capitalization & underline stroke detection)
"""

import argparse
import csv
import json
import os
import sys
from pathlib import Path

# Add grader repo root to sys.path
root_dir = Path(__file__).resolve().parent.parent
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

import cv2
import numpy as np

try:
    from omr.layout import Layout
    from omr.grading import AnswerKey, ExamGrade, ItemGrade, check_scientific_name
    from omr.annotator import (
        ExamAnnotator,
        COLOR_WHITE,
        COLOR_CORRECT,
        COLOR_INCORRECT,
        COLOR_BANNER_BG,
        COLOR_TEXT,
    )
    from omr.roster import Student, RosterMatch, Roster, normalize_student_id, normalize_offer_number
    from omr.vision import SheetWarper, BubbleScanner, detect_underline_stroke
    from omr.pdf import extract_pdf_pages
except ImportError as e:
    print(f"Error importing OMR toolkit modules: {e}", file=sys.stderr)
    print("Ensure '/Users/philsumabat/coding-projects/grader' is in your PYTHONPATH.", file=sys.stderr)
    sys.exit(1)


def parse_args():
    parser = argparse.ArgumentParser(description="OMR Exam Grader & Compact Tiler")
    parser.add_argument("--scans", "-s", type=Path, required=True, 
                        help="Path to scanned PDF file or directory of image scans")
    parser.add_argument("--layout", "-l", type=Path, required=True, 
                        help="Path to layout.json")
    parser.add_argument("--key", "-k", type=Path, required=True, 
                        help="Path to answer_key.csv or answer_key.json")
    parser.add_argument("--output-dir", "-o", type=Path, required=True, 
                        help="Directory to save output files and scans")
    parser.add_argument("--roster", "-r", type=Path, default=None,
                        help="Optional student roster CSV (with Student ID and Full Name)")
    parser.add_argument("--dpi", type=float, default=300.0, 
                        help="PDF rendering DPI (default: 300.0)")
    parser.add_argument("--px-per-mm", type=float, default=10.0, 
                        help="Warped canvas pixels per mm (default: 10.0)")
    parser.add_argument("--ink-threshold", type=float, default=0.015, 
                        help="Ink density threshold for blanks (default: 0.015 = 1.5 percent)")
    parser.add_argument("--pages", nargs="*", type=int, default=None,
                        help="Optional list of 1-based page numbers to process (e.g. 10 28)")
    return parser.parse_args()


def load_key(key_path: Path) -> AnswerKey:
    """Loads answer key from either CSV or JSON."""
    if key_path.suffix.lower() == '.csv':
        return AnswerKey.from_csv(key_path)
    elif key_path.suffix.lower() == '.json':
        return AnswerKey.load(key_path)
    else:
        raise ValueError(f"Unsupported key format: {key_path}. Use .csv or .json.")


def load_input_pages(scans_path: Path, dpi: float = 300.0) -> list[tuple[str, np.ndarray]]:
    """Loads pages from a PDF or a directory of image files."""
    if scans_path.is_file() and scans_path.suffix.lower() == '.pdf':
        return extract_pdf_pages(scans_path, dpi=dpi)
    elif scans_path.is_dir():
        valid_exts = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp'}
        files = sorted([f for f in scans_path.iterdir() if f.suffix.lower() in valid_exts])
        pages = []
        for f in files:
            img = cv2.imread(str(f))
            if img is not None:
                pages.append((f.stem, img))
        return pages
    else:
        raise ValueError(f"Input path {scans_path} is neither a valid PDF nor a directory of images.")


def check_ink_density(crop: np.ndarray, threshold: float = 0.015) -> tuple[bool, float]:
    """Calculates ink pixel ratio within box, ignoring outer boundary borders."""
    h, w = crop.shape[:2]
    inset_x = max(1, int(round(w * 0.05)))
    inset_y = max(1, int(round(h * 0.12)))
    inner = crop[inset_y:h-inset_y, inset_x:w-inset_x]
    
    gray = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY) if inner.ndim == 3 else inner
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
    ink_ratio = cv2.countNonZero(thresh) / thresh.size
    return (ink_ratio > threshold, ink_ratio)


def extract_header_fields(warped: np.ndarray, layout: Layout, px_per_mm: float = 10.0) -> dict[str, np.ndarray]:
    """Extracts crops for all header metadata fields (name, sid, offer, sched, date, score)."""
    crops = {}
    y1 = int(round(20.0 * px_per_mm))
    y2 = int(round(42.0 * px_per_mm))
    x1 = int(round(12.0 * px_per_mm))
    x2 = int(round(203.0 * px_per_mm))
    crops['header_card'] = warped[y1:y2, x1:x2]

    for roi in layout.rois:
        if roi.key in ['name', 'sid', 'offer', 'sched', 'date', 'score']:
            rx = int(round(roi.x * px_per_mm))
            ry = int(round(roi.y * px_per_mm))
            rw = int(round(roi.w * px_per_mm))
            rh = int(round(roi.h * px_per_mm))
            crops[roi.key] = warped[ry:ry+rh, rx:rx+rw]
    return crops


def build_three_fields_header(warped: np.ndarray, layout: Layout, px_per_mm: float = 10.0) -> np.ndarray:
    """
    Extracts strictly the three student identifier fields: Name, ID no., and Offer No.,
    and tiles them into a clean single horizontal banner of width 800px.
    """
    name_roi = layout.name_roi or next((r for r in layout.rois if r.key == 'name'), None)
    sid_roi = layout.sid_roi or next((r for r in layout.rois if r.key == 'sid'), None)
    offer_roi = next((r for r in layout.rois if r.key == 'offer'), None)
    
    h_target = 55
    
    # 1. Name crop (with label)
    if name_roi:
        nx1 = max(0, int(round((name_roi.x - 11.7) * px_per_mm)))
        nx2 = min(warped.shape[1], int(round((name_roi.x + name_roi.w + 1.0) * px_per_mm)))
        ny1 = max(0, int(round((name_roi.y - 1.0) * px_per_mm)))
        ny2 = min(warped.shape[0], int(round((name_roi.y + name_roi.h + 1.0) * px_per_mm)))
        name_crop = warped[ny1:ny2, nx1:nx2]
        name_res = cv2.resize(name_crop, (420, h_target))
    else:
        name_res = np.full((h_target, 420, 3), 255, dtype=np.uint8)

    # 2. ID no. crop (with label)
    if sid_roi:
        ix1 = max(0, int(round((sid_roi.x - 17.5) * px_per_mm)))
        ix2 = min(warped.shape[1], int(round((sid_roi.x + sid_roi.w + 1.0) * px_per_mm)))
        iy1 = max(0, int(round((sid_roi.y - 1.0) * px_per_mm)))
        iy2 = min(warped.shape[0], int(round((sid_roi.y + sid_roi.h + 1.0) * px_per_mm)))
        id_crop = warped[iy1:iy2, ix1:ix2]
        id_res = cv2.resize(id_crop, (220, h_target))
    else:
        id_res = np.full((h_target, 220, 3), 255, dtype=np.uint8)

    # 3. Offer No. crop (with label)
    if offer_roi:
        ox1 = max(0, int(round((offer_roi.x - 22.5) * px_per_mm)))
        ox2 = min(warped.shape[1], int(round((offer_roi.x + offer_roi.w + 1.0) * px_per_mm)))
        oy1 = max(0, int(round((offer_roi.y - 1.0) * px_per_mm)))
        oy2 = min(warped.shape[0], int(round((offer_roi.y + offer_roi.h + 1.0) * px_per_mm)))
        offer_crop = warped[oy1:oy2, ox1:ox2]
        offer_res = cv2.resize(offer_crop, (140, h_target))
    else:
        offer_res = np.full((h_target, 140, 3), 255, dtype=np.uint8)

    gap = np.full((h_target, 10, 3), 255, dtype=np.uint8)
    banner = np.hstack([name_res, gap, id_res, gap, offer_res])
    return banner


def create_compact_tiled_strip(page_name: str, warped: np.ndarray, layout: Layout, 
                               ink_threshold: float = 0.015, px_per_mm: float = 10.0) -> tuple[np.ndarray, dict]:
    """
    Creates a single 2-column contact strip containing:
    1. Header card with only the 3 essential fields: Name, ID no., and Offer No.
    2. Only non-blank answer boxes, labeled with question pills.
    """
    hdr_card = build_three_fields_header(warped, layout, px_per_mm)
    
    # Top title bar
    title_bar = np.full((32, 800, 3), (30, 41, 59), dtype=np.uint8)
    cv2.putText(title_bar, f'{page_name} -- STUDENT INFO & NON-BLANK HANDWRITING STRIP', 
                (15, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    
    target_w = 340
    target_h = 55
    cells = []
    blank_rois = []
    filled_rois = []
    
    for roi in layout.graded_rois:
        rx = int(round(roi.x * px_per_mm))
        ry = int(round(roi.y * px_per_mm))
        rw = int(round(roi.w * px_per_mm))
        rh = int(round(roi.h * px_per_mm))
        crop = warped[ry:ry+rh, rx:rx+rw]
        
        is_filled, ratio = check_ink_density(crop, ink_threshold)
        clean_label = roi.key.replace('_corr', '')
        
        if is_filled:
            filled_rois.append(roi.key)
            resized = cv2.resize(crop, (target_w, target_h))
            badge_w = 46
            cell = np.full((target_h, target_w + badge_w + 4, 3), (255, 255, 255), dtype=np.uint8)
            
            if roi.key.endswith('_corr'):
                cv2.rectangle(cell, (0, 0), (badge_w, target_h), (254, 243, 199), -1)
                cv2.rectangle(cell, (0, 0), (badge_w, target_h), (245, 158, 11), 1)
                cv2.putText(cell, f'Q{clean_label}', (5, int(target_h*0.65)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 83, 9), 1, cv2.LINE_AA)
                sort_idx = int(clean_label) + 1000 if clean_label.isdigit() else 2000
            else:
                cv2.rectangle(cell, (0, 0), (badge_w, target_h), (241, 245, 249), -1)
                cv2.rectangle(cell, (0, 0), (badge_w, target_h), (203, 213, 225), 1)
                cv2.putText(cell, f'Q{clean_label}', (5, int(target_h*0.65)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (15, 23, 42), 1, cv2.LINE_AA)
                sort_idx = int(clean_label) if clean_label.isdigit() else 500
                
            cell[:, badge_w+4:] = resized
            cv2.rectangle(cell, (badge_w+4, 0), (badge_w+4+target_w, target_h), (203, 213, 225), 1)
            cells.append((sort_idx, cell))
        else:
            blank_rois.append(roi.key)

    cells.sort(key=lambda x: x[0])
    cell_imgs = [c[1] for c in cells]
    
    if cell_imgs:
        half = (len(cell_imgs) + 1) // 2
        col1 = cell_imgs[:half]
        col2 = cell_imgs[half:]
        
        cell_h, cell_w = cell_imgs[0].shape[:2]
        while len(col2) < len(col1):
            col2.append(np.full((cell_h, cell_w, 3), 255, dtype=np.uint8))
            
        grid_col1 = np.vstack(col1)
        grid_col2 = np.vstack(col2)
        grid = np.hstack([grid_col1, np.full((grid_col1.shape[0], 12, 3), 240, dtype=np.uint8), grid_col2])
        grid_scaled = cv2.resize(grid, (800, int(grid.shape[0] * (800 / grid.shape[1]))))
    else:
        grid_scaled = np.full((120, 800, 3), 255, dtype=np.uint8)
        cv2.putText(grid_scaled, "No handwritten answers detected (All Blank)", (180, 65),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (120, 120, 120), 1, cv2.LINE_AA)

    divider1 = np.full((8, 800, 3), 245, dtype=np.uint8)
    divider2 = np.full((12, 800, 3), 245, dtype=np.uint8)
    strip = np.vstack([title_bar, divider1, hdr_card, divider2, grid_scaled])
    
    stats = {
        'filled_count': len(filled_rois),
        'blank_count': len(blank_rois),
        'filled_keys': filled_rois,
        'blank_keys': blank_rois
    }
    return strip, stats


def export_clean_anonymous_scan(canvas: np.ndarray, layout: Layout, px_per_mm: float = 10.0) -> np.ndarray:
    """
    Creates clean anonymous scan:
    - Redacts Name box with [NAME REDACTED].
    - Preserves ID no. and Offer No. for student self-audit.
    """
    anon = canvas.copy()
    if layout.name_roi:
        rx = int(round(layout.name_roi.x * px_per_mm))
        ry = int(round(layout.name_roi.y * px_per_mm))
        rw = int(round(layout.name_roi.w * px_per_mm))
        rh = int(round(layout.name_roi.h * px_per_mm))
        cv2.rectangle(anon, (rx, ry), (rx + rw, ry + rh), (15, 23, 42), -1)
        lbl = '[NAME REDACTED]'
        font = cv2.FONT_HERSHEY_SIMPLEX
        (lw, lh), _ = cv2.getTextSize(lbl, font, 0.45, 1)
        cv2.putText(anon, lbl, (rx + max(2, (rw - lw) // 2), ry + int((rh + lh) / 2)), 
                    font, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    return anon


def main():
    args = parse_args()
    
    print(f"Loading Layout: {args.layout}")
    layout = Layout.load(args.layout)
    
    print(f"Loading Answer Key: {args.key}")
    answer_key = load_key(args.key)
    
    roster = Roster.load(args.roster) if args.roster and args.roster.exists() else None
    if roster:
        print(f"Loaded Student Roster with {len(roster.students)} entries.")
        
    print(f"Loading Scans from: {args.scans}")
    all_pages = load_input_pages(args.scans, dpi=args.dpi)
    print(f"Found {len(all_pages)} scan pages.")
    
    if args.pages:
        selected_pages = []
        for pnum in args.pages:
            idx = pnum - 1
            if 0 <= idx < len(all_pages):
                selected_pages.append((idx, all_pages[idx]))
            else:
                print(f"Warning: Page {pnum} is out of bounds (1..{len(all_pages)}). Skipping.")
    else:
        selected_pages = list(enumerate(all_pages))
        
    warper = SheetWarper(layout, px_per_mm=args.px_per_mm)
    scanner = BubbleScanner(layout, px_per_mm=args.px_per_mm)
    annotator = ExamAnnotator(layout, px_per_mm=args.px_per_mm)
    
    out_dir = args.output_dir
    strips_dir = out_dir / 'compact_strips'
    annotated_dir = out_dir / 'annotated'
    anon_dir = out_dir / 'annotated_anonymous'
    crops_dir = out_dir / 'header_crops'
    
    for d in [strips_dir, annotated_dir, anon_dir, crops_dir]:
        d.mkdir(parents=True, exist_ok=True)
        
    roster_rows = []
    
    all_keys = list(answer_key.items.keys())
    def key_sort_key(k: str):
        parts = k.split('_')
        base = int(parts[0]) if parts[0].isdigit() else 9999
        suffix = parts[1] if len(parts) > 1 else ''
        return (base, suffix)
    sorted_keys = sorted(all_keys, key=key_sort_key)
    
    fieldnames = ['Exam Page', 'Offer No.', 'Student ID', 'Full Name', 'Raw Score', 'Percentage', 'Status']
    for k in sorted_keys:
        fieldnames.append(f'Q{k}')

    print(f"\nProcessing {len(selected_pages)} pages...")
    for idx, (pname, pimg) in selected_pages:
        print(f"\n[{idx+1}/{len(all_pages)}] Processing: {pname}")
        warp_res = warper.warp(pimg)
        warped_bgr = warp_res.warped_bgr
        warped_gray = warp_res.warped_gray
        binary = scanner.preprocess(warped_gray)
        
        # 1. Bubble scanning
        bubble_results, raw_sid = scanner.scan_all(warped_gray, binary)
        decoded_sid = normalize_student_id(raw_sid)
        
        # 2. Extract header crops
        header_crops = extract_header_fields(warped_bgr, layout, args.px_per_mm)
        for hkey, hcrop in header_crops.items():
            if hkey != 'header_card':
                cv2.imwrite(str(crops_dir / f"{pname}_{hkey}.png"), hcrop)
                
        # 3. Create Compact Tiled Strip
        strip, strip_stats = create_compact_tiled_strip(
            pname, warped_bgr, layout, ink_threshold=args.ink_threshold, px_per_mm=args.px_per_mm
        )
        strip_path = strips_dir / f"{pname}_compact_strip.png"
        cv2.imwrite(str(strip_path), strip)
        print(f"  -> Generated Compact Strip: {strip_stats['filled_count']} non-blank items ({strip_stats['blank_count']} blanks skipped)")
        
        # 4. Evaluate items and assemble grade
        items = {}
        total_score = 0.0
        max_possible = 0.0
        
        # Roster resolution
        matched_student = None
        if roster and decoded_sid:
            rm = roster.match(decoded_sid)
            if rm.matched:
                matched_student = rm.student
        
        row_sid = decoded_sid if decoded_sid else 'PENDING'
        row_name = matched_student.full_name if matched_student else 'PENDING'
        row_offer = normalize_offer_number(matched_student.class_offer) if (matched_student and matched_student.class_offer) else 'PENDING'

        row = {
            'Exam Page': pname,
            'Offer No.': row_offer,
            'Student ID': row_sid,
            'Full Name': row_name,
        }
        
        for k in sorted_keys:
            kspec = answer_key.items[k]
            max_possible += kspec.points
            
            if kspec.kind in ['mcq', 'tf']:
                bres = bubble_results.get(k)
                resp = bres.resolved_value if bres else ''
                is_corr = (resp.upper() == kspec.correct_answer.upper())
                pts = kspec.points if is_corr else 0.0
                total_score += pts
                items[k] = ItemGrade(
                    key=k, kind=kspec.kind, student_response=resp,
                    correct_answer=kspec.correct_answer, is_correct=is_corr,
                    points_awarded=pts, max_points=kspec.points,
                    is_blank=(resp in {'', '?'}), is_multi=(resp == '*')
                )
                mark = '+' if is_corr else '-'
                row[f'Q{k}'] = f"{resp} ({mark}{pts:.0f})"
            else:
                # Text/handwriting item
                is_blank = (k in strip_stats['blank_keys'])
                
                # Check for Modified True/False correction write-in item
                if k.endswith('_corr'):
                    base_k = k.replace('_corr', '')
                    base_kspec = answer_key.items.get(base_k)
                    base_bres = bubble_results.get(base_k)
                    base_resp = base_bres.resolved_value.upper() if base_bres else ''
                    is_true_statement = (
                        (base_kspec and base_kspec.kind == 'tf' and str(base_kspec.correct_answer).upper() == 'T')
                        or (kspec.points == 0.0 and not kspec.correct_answer)
                    )
                    
                    if is_true_statement and base_resp == 'T':
                        # Student correctly marked T on a True statement: No correction required!
                        items[k] = ItemGrade(
                            key=k, kind='text', student_response='',
                            correct_answer='', is_correct=True,
                            points_awarded=0.0, max_points=0.0,
                            is_blank=True, is_multi=False,
                            details="True — No Correction Required",
                        )
                        row[f'Q{k}'] = "(True — No Correction Required)"
                        continue
                    elif is_true_statement and is_blank:
                        items[k] = ItemGrade(
                            key=k, kind='text', student_response='',
                            correct_answer='', is_correct=True,
                            points_awarded=0.0, max_points=0.0,
                            is_blank=True, is_multi=False,
                            details="True — No Correction Required",
                        )
                        row[f'Q{k}'] = "(True — No Correction Required)"
                        continue

                if is_blank:
                    # Automatically zero points for blanks
                    canonical = str(kspec.correct_answer).split('|')[0].strip() if kspec.correct_answer else ""
                    items[k] = ItemGrade(
                        key=k, kind='text', student_response='',
                        correct_answer=kspec.correct_answer, is_correct=False,
                        points_awarded=0.0, max_points=kspec.points,
                        is_blank=True, is_multi=False,
                        feedback_badge="incorrect",
                        feedback_text=f"Key: {canonical}" if canonical else "",
                    )
                    row[f'Q{k}'] = "(Blank 0)"
                else:
                    # Non-blank item marked for vision inspection
                    items[k] = ItemGrade(
                        key=k, kind='text', student_response='[PENDING_INSPECTION]',
                        correct_answer=kspec.correct_answer, is_correct=False,
                        points_awarded=0.0, max_points=kspec.points,
                        is_blank=False, is_multi=False
                    )
                    row[f'Q{k}'] = "[INSPECT]"

        row['Raw Score'] = total_score
        row['Percentage'] = round((total_score / max_possible * 100.0), 1) if max_possible > 0 else 0.0
        row['Status'] = 'PASS' if row['Percentage'] >= 60.0 else 'NEEDS REVIEW'
        roster_rows.append(row)
        
        # 5. Generate Annotated Scans
        stud = matched_student or Student(student_id=decoded_sid, full_name='Student')
        roster_match = RosterMatch(status='exact' if (matched_student or decoded_sid) else 'unmatched', 
                                   decoded_id=decoded_sid, student=stud)
        exam_grade = ExamGrade(
            exam_id=pname, decoded_sid=decoded_sid, roster_match=roster_match,
            items=items, score=total_score, max_score=max_possible,
            percentage=row['Percentage'], bubble_results=bubble_results
        )
        
        # Standard annotated scan
        annotated_std = annotator.annotate(warped_bgr, exam_grade)
        annotator.save(annotated_std, annotated_dir / f"{pname}_annotated.jpg")
        
        # Clean anonymous scan
        clean_anon = export_clean_anonymous_scan(annotated_std, layout, args.px_per_mm)
        annotator.save(clean_anon, anon_dir / f"{pname}_annotated_anonymous.jpg")

    # Write summary CSV
    summary_csv = out_dir / 'Graded_Roster.csv'
    with open(summary_csv, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(roster_rows)
        
    print(f"\n{'='*60}")
    print(f"Batch Processing Complete!")
    print(f"  Total Processed: {len(selected_pages)} pages")
    print(f"  Compact Strips:  {strips_dir}")
    print(f"  Standard Scans:  {annotated_dir}")
    print(f"  Anonymous Scans: {anon_dir}")
    print(f"  Header Crops:    {crops_dir}")
    print(f"  Gradebook CSV:   {summary_csv}")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
