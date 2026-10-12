#!/usr/bin/env python3
"""Generate realistic synthetic scanned exam JPEGs for testing the OMR pipeline."""
from __future__ import annotations

import csv
import json
import random
from pathlib import Path

import cv2

from omr.layout import Layout
from omr.simulator import ExamSimulator

ROOT = Path(__file__).resolve().parent.parent


def main():
    layout_path = ROOT / "dist" / "exam-50" / "layout.json"
    key_path = ROOT / "data" / "bio101_key.json"
    roster_path = ROOT / "data" / "bio101_roster.csv"
    scans_dir = ROOT / "data" / "scans"
    scans_dir.mkdir(parents=True, exist_ok=True)

    layout = Layout.load(layout_path)
    with open(key_path, encoding="utf-8") as fh:
        key_data = json.load(fh)

    # Load students from roster
    students = []
    with open(roster_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            students.append((row["Student ID"], row["Full Name"]))

    sim = ExamSimulator(layout, px_per_mm=10.0)
    print(f"[*] Generating {len(students)} synthetic exam scans in {scans_dir}...")

    # Define ability distributions for varied scores (from 60% to 100%)
    abilities = [0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.88, 0.92]

    for idx, ((sid, name), ability) in enumerate(zip(students, abilities), start=1):
        answers = {}
        for q_key, spec in key_data["items"].items():
            if spec["kind"] in {"mcq", "tf"}:
                correct = spec["answer"]
                if random.random() < ability:
                    answers[q_key] = correct
                else:
                    # Choose a distractor
                    choices = ["A", "B", "C", "D", "E"] if spec["kind"] == "mcq" else ["T", "F"]
                    distractors = [c for c in choices if c != correct]
                    answers[q_key] = random.choice(distractors)

        # Handwritten answers
        text_answers = {}
        if random.random() < ability:
            text_answers["q61"] = "MITOCHONDRIA"
        else:
            text_answers["q61"] = "CHLOROPLAST"

        if random.random() < ability:
            text_answers["q62"] = "TRNA"
        else:
            text_answers["q62"] = "MRNA"

        # Apply a realistic rotation skew (-1.8 to +1.8 deg)
        skew = random.uniform(-1.5, 1.5)
        scan_img = sim.generate_exam(
            student_id=sid,
            student_name=name,
            answers=answers,
            text_answers=text_answers,
            skew_deg=skew,
            add_noise=True,
        )

        out_file = scans_dir / f"scan_{idx:02d}_{sid}.jpg"
        cv2.imwrite(str(out_file), scan_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print(f"  [{idx}/{len(students)}] Created {out_file.name} (Skew: {skew:+.2f}°)")

    print(f"[✔] Successfully generated {len(students)} test scans.")


if __name__ == "__main__":
    main()
