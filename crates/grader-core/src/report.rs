//! Deliverable report generators (CSV Gradebook and Summary JSON).

use crate::grading::ExamGrade;
use crate::psycho::BatchPsychometrics;
use serde_json::json;
use std::fs::File;
use std::io::Write;
use std::path::Path;

pub fn write_grades_csv<P: AsRef<Path>>(
    grades: &[ExamGrade],
    item_order: &[String],
    path: P,
) -> Result<(), std::io::Error> {
    let mut wtr = csv::WriterBuilder::new().from_path(path)?;

    // Build header: Exam ID, Student ID, Student Name, Score, Max Score, Percentage, Status, [Item columns]
    let mut headers = vec![
        "Exam ID".to_string(),
        "Student ID".to_string(),
        "Student Name".to_string(),
        "Score".to_string(),
        "Max Score".to_string(),
        "Percentage".to_string(),
        "Needs Review".to_string(),
    ];
    for item in item_order {
        headers.push(format!("Q{}", item));
    }
    wtr.write_record(&headers)?;

    for g in grades {
        let mut row = vec![
            g.exam_id.clone(),
            g.student_id.clone(),
            g.student_name.clone(),
            format!("{:.2}", g.score),
            format!("{:.2}", g.max_score),
            format!("{:.1}%", g.percentage),
            if g.needs_review { "YES" } else { "NO" }.to_string(),
        ];
        for item in item_order {
            let resp = g
                .items
                .get(item)
                .map(|ig| ig.student_response.as_str())
                .unwrap_or("?");
            row.push(resp.to_string());
        }
        wtr.write_record(&row)?;
    }

    wtr.flush()?;
    Ok(())
}

pub fn write_summary_json<P: AsRef<Path>>(
    grades: &[ExamGrade],
    metrics: Option<&BatchPsychometrics>,
    path: P,
) -> Result<(), std::io::Error> {
    let payload = json!({
        "total_exams": grades.len(),
        "needs_review_count": grades.iter().filter(|g| g.needs_review).count(),
        "psychometrics": metrics,
        "grades": grades,
    });

    let json_bytes = serde_json::to_vec_pretty(&payload)?;
    let mut file = File::create(path)?;
    file.write_all(&json_bytes)?;
    Ok(())
}
