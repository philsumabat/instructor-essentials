//! Instructor Essentials Headless Batch Grading CLI.

use anyhow::{Context, Result};
use clap::Parser;
use grader_core::{
    grading::GradingEngine,
    layout::Layout,
    psycho::analyze_batch,
    report::{write_grades_csv, write_summary_json},
    roster::Roster,
    vision::BubbleScanner,
    AnswerKey, ExamGrade,
};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(
    name = "instructor-essentials",
    about = "Millimeter-accurate OMR grading & psychometrics pipeline",
    version
)]
struct Args {
    /// Path to layout.json geometry definition
    #[arg(short, long)]
    layout: PathBuf,

    /// Path to answer key JSON
    #[arg(short, long)]
    key: PathBuf,

    /// Path to optional class roster CSV
    #[arg(short, long)]
    roster: Option<PathBuf>,

    /// Glob pattern or path to student scan images (JPEG/PNG)
    #[arg(short, long)]
    scans: String,

    /// Destination directory for grading deliverables
    #[arg(short, long, default_value = "output")]
    out: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();

    println!("📄 Loading layout from {:?}...", args.layout);
    let layout = Layout::load_file(&args.layout)
        .with_context(|| format!("Failed to load layout from {:?}", args.layout))?;

    println!("🔑 Loading answer key from {:?}...", args.key);
    let key = AnswerKey::load_file(&args.key)
        .with_context(|| format!("Failed to load answer key from {:?}", args.key))?;

    let roster = if let Some(ref r_path) = args.roster {
        println!("📋 Loading class roster from {:?}...", r_path);
        Some(Roster::load_file(r_path).with_context(|| format!("Failed to load roster from {:?}", r_path))?)
    } else {
        None
    };

    // Collect scan files
    let mut scan_files = Vec::new();
    if Path::new(&args.scans).exists() {
        scan_files.push(PathBuf::from(&args.scans));
    } else {
        for entry in glob::glob(&args.scans)? {
            scan_files.push(entry?);
        }
    }

    if scan_files.is_empty() {
        anyhow::bail!("No scan files found matching pattern '{}'", args.scans);
    }

    println!("⚡ Found {} scan file(s) to process.", scan_files.len());

    let engine = GradingEngine::new(key.clone());
    let scanner = BubbleScanner::new(&layout);

    std::fs::create_dir_all(&args.out)?;

    let mut grades: Vec<ExamGrade> = Vec::new();

    for (idx, scan_path) in scan_files.iter().enumerate() {
        let filename = scan_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("scan");
        println!("  [{}/{}] Reading {}...", idx + 1, scan_files.len(), filename);

        let img = match image::open(scan_path) {
            Ok(im) => im.to_luma8(),
            Err(e) => {
                eprintln!("    ⚠️ Could not open image {}: {}", filename, e);
                continue;
            }
        };

        // Scan bubbles and decode student ID
        let (responses, blank_items, multi_items, mut decoded_sid) = scanner.scan_all(&img, &layout);

        // If sheet uses partitioned OCR box without bubble grid, extract from filename if present
        if decoded_sid.is_empty() || decoded_sid.chars().all(|c| c == '?') {
            for part in filename.split(|c: char| !c.is_numeric()) {
                if part.len() == 8 {
                    decoded_sid = part.to_string();
                    break;
                }
            }
        }

        let mut review_notes = Vec::new();
        let student_name = if let Some(ref r) = roster {
            let m = r.match_id(&decoded_sid);
            if m.needs_review() {
                review_notes.push(format!("Roster match: {} ({})", m.status, m.note));
            }
            m.student
                .map(|s| s.full_name)
                .unwrap_or_else(|| "Unknown Student".to_string())
        } else {
            "Student".to_string()
        };

        let exam_grade = engine.grade_exam(
            filename,
            &decoded_sid,
            &student_name,
            &responses,
            &blank_items,
            &multi_items,
            review_notes,
        );

        println!(
            "    ✓ Score: {:.1}/{} ({:.1}%) - ID: {} ({})",
            exam_grade.score,
            exam_grade.max_score,
            exam_grade.percentage,
            exam_grade.student_id,
            exam_grade.student_name
        );

        grades.push(exam_grade);
    }

    if grades.is_empty() {
        anyhow::bail!("No valid exam scans could be graded.");
    }

    // Psychometrics
    println!("📊 Computing cohort psychometrics...");
    let psychometrics = analyze_batch(&key, &grades);

    if let Some(ref psycho) = psychometrics {
        println!("  • Mean Score: {:.2} (Std Dev: {:.2})", psycho.mean_score, psycho.std_dev);
        println!("  • Cronbach's Alpha Reliability: {:.3}", psycho.cronbach_alpha);
    }

    // Deliverables
    let csv_path = args.out.join("grades.csv");
    let json_path = args.out.join("grades_summary.json");
    let item_order = layout.item_order();

    println!("💾 Writing gradebook CSV to {:?}...", csv_path);
    write_grades_csv(&grades, &item_order, &csv_path)?;

    println!("💾 Writing summary JSON to {:?}...", json_path);
    write_summary_json(&grades, psychometrics.as_ref(), &json_path)?;

    println!("🎉 Batch grading complete! Deliverables saved in {:?}", args.out);
    Ok(())
}
