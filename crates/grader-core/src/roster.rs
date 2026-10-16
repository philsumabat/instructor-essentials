//! Class roster ingestion and fault-tolerant student ID resolution.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum RosterError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("CSV parse error: {0}")]
    Csv(#[from] csv::Error),
    #[error("Missing student ID column in roster")]
    MissingIdColumn,
    #[error("Missing name column in roster")]
    MissingNameColumn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Student {
    pub student_id: String,
    pub full_name: String,
    #[serde(default)]
    pub class_section: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RosterMatch {
    pub status: String, // "exact" | "normalized" | "inferred" | "probable" | "ambiguous" | "unmatched" | "no_roster"
    pub decoded_id: String,
    pub student: Option<Student>,
    #[serde(default)]
    pub candidates: Vec<Student>,
    #[serde(default)]
    pub note: String,
}

impl RosterMatch {
    pub fn matched(&self) -> bool {
        self.student.is_some()
    }

    pub fn needs_review(&self) -> bool {
        self.status != "exact" && self.status != "normalized"
    }
}

pub struct Roster {
    by_id: HashMap<String, Student>,
    by_stripped: HashMap<String, Vec<Student>>,
    all_students: Vec<Student>,
}

fn norm_header(h: &str) -> String {
    h.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

impl Roster {
    pub fn load_file<P: AsRef<Path>>(path: P) -> Result<Self, RosterError> {
        let content = std::fs::read_to_string(path)?;
        Self::from_csv(&content)
    }

    pub fn from_csv(csv_text: &str) -> Result<Self, RosterError> {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(true)
            .flexible(true)
            .trim(csv::Trim::All)
            .from_reader(csv_text.as_bytes());

        let headers = rdr.headers()?.clone();
        let mut id_idx = None;
        let mut name_idx = None;
        let mut first_idx = None;
        let mut last_idx = None;
        let mut class_idx = None;

        for (idx, h) in headers.iter().enumerate() {
            let nh = norm_header(h);
            if matches!(
                nh.as_str(),
                "studentid" | "id" | "sid" | "studentnumber" | "studentno" | "idnumber" | "idno" | "learnerid"
            ) {
                id_idx = Some(idx);
            } else if matches!(nh.as_str(), "fullname" | "name" | "studentname" | "displayname") {
                name_idx = Some(idx);
            } else if matches!(nh.as_str(), "firstname" | "givenname" | "first") {
                first_idx = Some(idx);
            } else if matches!(nh.as_str(), "lastname" | "surname" | "familyname" | "last") {
                last_idx = Some(idx);
            } else if matches!(nh.as_str(), "class" | "offerno" | "offer" | "section" | "sched") {
                class_idx = Some(idx);
            }
        }

        let id_col = id_idx.ok_or(RosterError::MissingIdColumn)?;
        if name_idx.is_none() && (first_idx.is_none() || last_idx.is_none()) {
            return Err(RosterError::MissingNameColumn);
        }

        let mut students = Vec::new();
        let mut by_id = HashMap::new();
        let mut by_stripped: HashMap<String, Vec<Student>> = HashMap::new();

        for result in rdr.records() {
            let record = result?;
            let mut sid = record.get(id_col).unwrap_or("").trim().to_string();
            if sid.is_empty() {
                continue;
            }
            if sid.contains('.') {
                sid = sid.split('.').next().unwrap_or(&sid).to_string();
            }

            let full_name = if let Some(n_idx) = name_idx {
                record.get(n_idx).unwrap_or("").trim().to_string()
            } else {
                let first = first_idx.and_then(|i| record.get(i)).unwrap_or("").trim();
                let last = last_idx.and_then(|i| record.get(i)).unwrap_or("").trim();
                format!("{} {}", first, last).trim().to_string()
            };

            let class_section = class_idx
                .and_then(|i| record.get(i))
                .unwrap_or("")
                .trim()
                .to_string();

            let student = Student {
                student_id: sid.clone(),
                full_name: if full_name.is_empty() { sid.clone() } else { full_name },
                class_section,
            };

            let stripped = sid.trim_start_matches('0').to_string();
            let key_stripped = if stripped.is_empty() { "0".to_string() } else { stripped };

            by_stripped.entry(key_stripped).or_default().push(student.clone());
            by_id.insert(sid, student.clone());
            students.push(student);
        }

        Ok(Self {
            by_id,
            by_stripped,
            all_students: students,
        })
    }

    pub fn match_id(&self, decoded_id: &str) -> RosterMatch {
        let decoded = decoded_id.trim();
        if decoded.is_empty() || decoded.chars().all(|c| c == '?') {
            return RosterMatch {
                status: "unmatched".to_string(),
                decoded_id: decoded.to_string(),
                student: None,
                candidates: Vec::new(),
                note: "No student ID markings detected".to_string(),
            };
        }

        // 1. Exact match
        if let Some(student) = self.by_id.get(decoded) {
            return RosterMatch {
                status: "exact".to_string(),
                decoded_id: decoded.to_string(),
                student: Some(student.clone()),
                candidates: Vec::new(),
                note: String::new(),
            };
        }

        // 2. Leading zero normalization
        let stripped = decoded.trim_start_matches('0');
        let key_stripped = if stripped.is_empty() { "0" } else { stripped };
        if let Some(hits) = self.by_stripped.get(key_stripped) {
            if hits.len() == 1 {
                return RosterMatch {
                    status: "normalized".to_string(),
                    decoded_id: decoded.to_string(),
                    student: Some(hits[0].clone()),
                    candidates: Vec::new(),
                    note: "Matched after removing leading zeros".to_string(),
                };
            }
        }

        // 3. Unused leading/trailing columns (trimmed '?')
        let trimmed_blank = decoded.trim_matches('?');
        if !trimmed_blank.is_empty() && trimmed_blank != decoded {
            if let Some(student) = self.by_id.get(trimmed_blank) {
                return RosterMatch {
                    status: "exact".to_string(),
                    decoded_id: decoded.to_string(),
                    student: Some(student.clone()),
                    candidates: Vec::new(),
                    note: "Unused ID columns ignored".to_string(),
                };
            }
        }

        // 4. Wildcard inference for '?' or '*' columns
        if decoded.contains('?') || decoded.contains('*') {
            let mut matches = Vec::new();
            for s in &self.all_students {
                if s.student_id.len() == decoded.len() {
                    let mut fits = true;
                    for (a, b) in s.student_id.chars().zip(decoded.chars()) {
                        if b != '?' && b != '*' && a != b {
                            fits = false;
                            break;
                        }
                    }
                    if fits {
                        matches.push(s.clone());
                    }
                }
            }

            if matches.len() == 1 {
                return RosterMatch {
                    status: "inferred".to_string(),
                    decoded_id: decoded.to_string(),
                    student: Some(matches[0].clone()),
                    candidates: matches,
                    note: "Inferred missing digits from roster".to_string(),
                };
            } else if matches.len() > 1 {
                return RosterMatch {
                    status: "ambiguous".to_string(),
                    decoded_id: decoded.to_string(),
                    student: None,
                    candidates: matches,
                    note: "Multiple roster IDs fit the partial markings".to_string(),
                };
            }
        }

        // 5. Single digit error recovery (Hamming distance 1)
        let mut near = Vec::new();
        for s in &self.all_students {
            if s.student_id.len() == decoded.len() {
                let diffs = s
                    .student_id
                    .chars()
                    .zip(decoded.chars())
                    .filter(|(a, b)| a != b)
                    .count();
                if diffs == 1 {
                    near.push(s.clone());
                }
            }
        }

        if near.len() == 1 {
            return RosterMatch {
                status: "probable".to_string(),
                decoded_id: decoded.to_string(),
                student: Some(near[0].clone()),
                candidates: near,
                note: "1-digit difference recovered from roster".to_string(),
            };
        } else if !near.is_empty() {
            return RosterMatch {
                status: "ambiguous".to_string(),
                decoded_id: decoded.to_string(),
                student: None,
                candidates: near,
                note: "Multiple candidates differ by 1 digit".to_string(),
            };
        }

        RosterMatch {
            status: "unmatched".to_string(),
            decoded_id: decoded.to_string(),
            student: None,
            candidates: Vec::new(),
            note: "Student ID not found in roster".to_string(),
        }
    }
}
