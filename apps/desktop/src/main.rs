// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use grader_core::{
    grading::GradingEngine,
    layout::Layout,
    psycho::analyze_batch,
    roster::Roster,
    vision::BubbleScanner,
    AnswerKey, ExamGrade,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct GradingPayload {
    pub layout_json: String,
    pub key_json: String,
    pub roster_csv: Option<String>,
    pub scan_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GradingResponse {
    pub total_scans: usize,
    pub grades: Vec<ExamGrade>,
    pub psychometrics: Option<grader_core::BatchPsychometrics>,
}

#[tauri::command]
fn grade_scans(payload: GradingPayload) -> Result<GradingResponse, String> {
    let layout = Layout::from_json(&payload.layout_json).map_err(|e| e.to_string())?;
    let key = AnswerKey::from_json(&payload.key_json).map_err(|e| e.to_string())?;
    let roster = payload
        .roster_csv
        .as_deref()
        .map(Roster::from_csv)
        .transpose()
        .map_err(|e| e.to_string())?;

    let engine = GradingEngine::new(key.clone());
    let scanner = BubbleScanner::new(&layout);

    let mut grades = Vec::new();

    for path_str in &payload.scan_paths {
        let p = PathBuf::from(path_str);
        let filename = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("scan")
            .to_string();

        let img = match image::open(&p) {
            Ok(im) => im.to_luma8(),
            Err(e) => return Err(format!("Could not read image {:?}: {}", p, e)),
        };

        let (responses, blank_items, multi_items, decoded_sid) = scanner.scan_all(&img, &layout);

        let mut review_notes = Vec::new();
        let student_name = if let Some(ref r) = roster {
            let m = r.match_id(&decoded_sid);
            if m.needs_review() {
                review_notes.push(format!("Roster status: {}", m.status));
            }
            m.student
                .map(|s| s.full_name)
                .unwrap_or_else(|| "Unknown Student".to_string())
        } else {
            "Student".to_string()
        };

        let exam_grade = engine.grade_exam(
            &filename,
            &decoded_sid,
            &student_name,
            &responses,
            &blank_items,
            &multi_items,
            review_notes,
        );

        grades.push(exam_grade);
    }

    let psycho = analyze_batch(&key, &grades);

    Ok(GradingResponse {
        total_scans: grades.len(),
        grades,
        psychometrics: psycho,
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![grade_scans])
        .run(tauri::generate_context!())
        .expect("error while running Instructor Essentials application");
}
