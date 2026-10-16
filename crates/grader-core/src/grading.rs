//! Answer key parsing and exam evaluation engine.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum GradingError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid answer key format: {0}")]
    InvalidFormat(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum AnswerValue {
    Single(String),
    Multiple(Vec<String>),
}

impl AnswerValue {
    pub fn matches(&self, response: &str) -> bool {
        let resp_upper = response.trim().to_uppercase();
        match self {
            AnswerValue::Single(s) => s.trim().to_uppercase() == resp_upper,
            AnswerValue::Multiple(list) => list.iter().any(|s| s.trim().to_uppercase() == resp_upper),
        }
    }

    pub fn display_string(&self) -> String {
        match self {
            AnswerValue::Single(s) => s.clone(),
            AnswerValue::Multiple(list) => list.join(", "),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ItemKey {
    pub key: String,
    #[serde(default = "default_mcq")]
    pub kind: String,
    pub correct_answer: AnswerValue,
    #[serde(default = "default_one_point")]
    pub points: f64,
    #[serde(default = "default_exact")]
    pub rubric: String,
}

fn default_mcq() -> String {
    "mcq".to_string()
}
fn default_one_point() -> f64 {
    1.0
}
fn default_exact() -> String {
    "exact".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerKey {
    #[serde(default)]
    pub title: String,
    pub items: HashMap<String, ItemKey>,
}

impl AnswerKey {
    pub fn load_file<P: AsRef<Path>>(path: P) -> Result<Self, GradingError> {
        let content = std::fs::read_to_string(path)?;
        Self::from_json(&content)
    }

    pub fn from_json(json_str: &str) -> Result<Self, GradingError> {
        let value: serde_json::Value = serde_json::from_str(json_str)?;

        let title = value
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let raw_items = value
            .get("items")
            .and_then(|v| v.as_object())
            .ok_or_else(|| GradingError::InvalidFormat("'items' object missing".to_string()))?;

        let mut items = HashMap::new();
        for (k, v) in raw_items {
            let item_key = if let Some(obj) = v.as_object() {
                let ans = if let Some(a_str) = obj.get("answer").and_then(|a| a.as_str()) {
                    AnswerValue::Single(a_str.to_string())
                } else if let Some(a_arr) = obj.get("answer").and_then(|a| a.as_array()) {
                    let list: Vec<String> = a_arr
                        .iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect();
                    AnswerValue::Multiple(list)
                } else {
                    return Err(GradingError::InvalidFormat(format!(
                        "Item '{}' missing or invalid 'answer'",
                        k
                    )));
                };

                ItemKey {
                    key: k.clone(),
                    kind: obj
                        .get("kind")
                        .and_then(|x| x.as_str())
                        .unwrap_or("mcq")
                        .to_string(),
                    correct_answer: ans,
                    points: obj
                        .get("points")
                        .and_then(|x| x.as_f64())
                        .unwrap_or(1.0),
                    rubric: obj
                        .get("rubric")
                        .and_then(|x| x.as_str())
                        .unwrap_or("exact")
                        .to_string(),
                }
            } else if let Some(s) = v.as_str() {
                ItemKey {
                    key: k.clone(),
                    kind: "mcq".to_string(),
                    correct_answer: AnswerValue::Single(s.to_string()),
                    points: 1.0,
                    rubric: "exact".to_string(),
                }
            } else if let Some(arr) = v.as_array() {
                let list: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect();
                ItemKey {
                    key: k.clone(),
                    kind: "mcq".to_string(),
                    correct_answer: AnswerValue::Multiple(list),
                    points: 1.0,
                    rubric: "exact".to_string(),
                }
            } else {
                return Err(GradingError::InvalidFormat(format!(
                    "Unrecognized format for item '{}'",
                    k
                )));
            };

            items.insert(k.clone(), item_key);
        }

        Ok(Self { title, items })
    }

    pub fn total_points(&self) -> f64 {
        self.items.values().map(|it| it.points).sum()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemGrade {
    pub key: String,
    pub kind: String,
    pub student_response: String,
    pub correct_answer: String,
    pub is_correct: bool,
    pub points_awarded: f64,
    pub max_points: f64,
    pub is_blank: bool,
    pub is_multi: bool,
    #[serde(default)]
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamGrade {
    pub exam_id: String,
    pub student_id: String,
    pub student_name: String,
    pub score: f64,
    pub max_score: f64,
    pub percentage: f64,
    pub items: HashMap<String, ItemGrade>,
    pub needs_review: bool,
    pub review_notes: Vec<String>,
}

pub struct GradingEngine {
    pub key: AnswerKey,
}

impl GradingEngine {
    pub fn new(key: AnswerKey) -> Self {
        Self { key }
    }

    pub fn evaluate_item(
        &self,
        key_spec: &ItemKey,
        response: &str,
        is_blank: bool,
        is_multi: bool,
    ) -> ItemGrade {
        if is_blank || response == "?" || response.trim().is_empty() {
            return ItemGrade {
                key: key_spec.key.clone(),
                kind: key_spec.kind.clone(),
                student_response: "".to_string(),
                correct_answer: key_spec.correct_answer.display_string(),
                is_correct: false,
                points_awarded: 0.0,
                max_points: key_spec.points,
                is_blank: true,
                is_multi: false,
                details: "Unanswered".to_string(),
            };
        }

        if is_multi || response == "*" {
            return ItemGrade {
                key: key_spec.key.clone(),
                kind: key_spec.kind.clone(),
                student_response: "*".to_string(),
                correct_answer: key_spec.correct_answer.display_string(),
                is_correct: false,
                points_awarded: 0.0,
                max_points: key_spec.points,
                is_blank: false,
                is_multi: true,
                details: "Multiple marks filled".to_string(),
            };
        }

        let is_match = key_spec.correct_answer.matches(response);
        let points = if is_match { key_spec.points } else { 0.0 };

        ItemGrade {
            key: key_spec.key.clone(),
            kind: key_spec.kind.clone(),
            student_response: response.to_string(),
            correct_answer: key_spec.correct_answer.display_string(),
            is_correct: is_match,
            points_awarded: points,
            max_points: key_spec.points,
            is_blank: false,
            is_multi: false,
            details: if is_match { "Correct" } else { "Incorrect" }.to_string(),
        }
    }

    pub fn grade_exam(
        &self,
        exam_id: &str,
        decoded_sid: &str,
        student_name: &str,
        responses: &HashMap<String, String>,
        blank_items: &std::collections::HashSet<String>,
        multi_items: &std::collections::HashSet<String>,
        mut review_notes: Vec<String>,
    ) -> ExamGrade {
        let mut items = HashMap::new();
        let mut total_points = 0.0;
        let mut max_points = 0.0;

        for (key, key_spec) in &self.key.items {
            let resp = responses.get(key).map(|s| s.as_str()).unwrap_or("?");
            let is_blank = blank_items.contains(key) || resp == "?";
            let is_multi = multi_items.contains(key) || resp == "*";

            let item_grade = self.evaluate_item(key_spec, resp, is_blank, is_multi);

            total_points += item_grade.points_awarded;
            max_points += item_grade.max_points;
            items.insert(key.clone(), item_grade);
        }

        let pct = if max_points > 0.0 {
            (total_points / max_points) * 100.0
        } else {
            0.0
        };

        if !multi_items.is_empty() {
            review_notes.push(format!("{} multiple-marked item(s)", multi_items.len()));
        }

        let needs_review = !review_notes.is_empty();

        ExamGrade {
            exam_id: exam_id.to_string(),
            student_id: decoded_sid.to_string(),
            student_name: student_name.to_string(),
            score: (total_points * 100.0).round() / 100.0,
            max_score: (max_points * 100.0).round() / 100.0,
            percentage: (pct * 100.0).round() / 100.0,
            items,
            needs_review,
            review_notes,
        }
    }
}
