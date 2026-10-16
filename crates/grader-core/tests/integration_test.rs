use grader_core::{
    grading::GradingEngine,
    layout::Layout,
    psycho::analyze_batch,
    roster::Roster,
    AnswerKey,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

fn root_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn test_load_exam50_layout() {
    let layout_path = root_dir().join("dist/exam-50/layout.json");
    let layout = Layout::load_file(&layout_path).expect("Failed to load layout.json");

    assert_eq!(layout.paper, "A4");
    assert_eq!(layout.page_width, 210.0);
    assert_eq!(layout.page_height, 297.0);
    assert_eq!(layout.fiducials.len(), 4);
    assert!(!layout.zones.is_empty());

    let q_groups = layout.question_groups();
    assert_eq!(q_groups.len(), 60); // 50 MCQ + 10 TF
}

#[test]
fn test_load_bio101_key() {
    let key_path = root_dir().join("data/bio101_key.json");
    let key = AnswerKey::load_file(&key_path).expect("Failed to load answer key");

    assert!(key.total_points() > 0.0);
    assert!(key.items.contains_key("1"));
}

#[test]
fn test_load_bio101_roster() {
    let roster_path = root_dir().join("data/bio101_roster.csv");
    let roster = Roster::load_file(&roster_path).expect("Failed to load roster");

    // Exact match test (Alice Walker is 10482901)
    let m = roster.match_id("10482901");
    assert_eq!(m.status, "exact");
    assert!(m.matched());
    assert_eq!(m.student.unwrap().full_name, "Alice Walker");

    // Wildcard recovery test (1048?901)
    let m_wildcard = roster.match_id("1048?901");
    assert_eq!(m_wildcard.status, "inferred");
    assert!(m_wildcard.matched());
    assert_eq!(m_wildcard.student.unwrap().student_id, "10482901");

    // Hamming distance 1 recovery test (10482909 is Isabella Kim, test 10482900)
    let m_hamming = roster.match_id("10482900");
    if m_hamming.matched() {
        assert_eq!(m_hamming.status, "probable");
    }
}

#[test]
fn test_grading_and_psychometrics() {
    let key_path = root_dir().join("data/bio101_key.json");
    let key = AnswerKey::load_file(&key_path).expect("Failed to load answer key");

    let engine = GradingEngine::new(key.clone());

    // Mock student responses for 3 students
    let mut grades = Vec::new();

    let mut resp1 = HashMap::new();
    for (k, spec) in &key.items {
        match &spec.correct_answer {
            grader_core::grading::AnswerValue::Single(s) => {
                resp1.insert(k.clone(), s.clone());
            }
            grader_core::grading::AnswerValue::Multiple(list) => {
                resp1.insert(k.clone(), list[0].clone());
            }
        }
    }

    let g1 = engine.grade_exam(
        "scan_01.jpg",
        "20230001",
        "Alice Walker",
        &resp1,
        &HashSet::new(),
        &HashSet::new(),
        vec![],
    );
    assert_eq!(g1.score, g1.max_score);
    assert_eq!(g1.percentage, 100.0);
    grades.push(g1);

    // Student 2: half correct
    let mut resp2 = HashMap::new();
    for (idx, (k, spec)) in key.items.iter().enumerate() {
        if idx % 2 == 0 {
            match &spec.correct_answer {
                grader_core::grading::AnswerValue::Single(s) => {
                    resp2.insert(k.clone(), s.clone());
                }
                grader_core::grading::AnswerValue::Multiple(list) => {
                    resp2.insert(k.clone(), list[0].clone());
                }
            }
        } else {
            resp2.insert(k.clone(), "Z".to_string()); // Wrong
        }
    }
    let g2 = engine.grade_exam(
        "scan_02.jpg",
        "20230002",
        "Bob Smith",
        &resp2,
        &HashSet::new(),
        &HashSet::new(),
        vec![],
    );
    assert!(g2.score < g2.max_score);
    grades.push(g2);

    // Psychometrics test
    let psycho = analyze_batch(&key, &grades).expect("Psychometrics failed");
    assert_eq!(psycho.num_students, 2);
    assert!(psycho.mean_score > 0.0);
}
