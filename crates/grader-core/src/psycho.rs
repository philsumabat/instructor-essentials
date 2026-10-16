//! Psychometrics calculation suite.
//!
//! Implements Classical Test Theory:
//! - Facility Index (Item Difficulty, P = mean points ratio)
//! - Discrimination Index (Kelly's 27% Upper vs Lower cohort difference)
//! - Point-Biserial correlation (r_pbis between item points and total score)
//! - Test Reliability (Cronbach's Alpha) and cohort distribution metrics.

use crate::grading::{AnswerKey, ExamGrade};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistractorStat {
    pub option: String,
    pub count: usize,
    pub percentage: f64,
    pub is_correct: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemStats {
    pub key: String,
    pub kind: String,
    pub correct_answer: String,
    pub points: f64,
    pub facility_index: f64,
    pub discrimination_index: f64,
    pub point_biserial: f64,
    pub distractors: Vec<DistractorStat>,
    pub blank_count: usize,
    pub multi_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPsychometrics {
    pub exam_title: String,
    pub num_students: usize,
    pub total_possible_score: f64,
    pub mean_score: f64,
    pub median_score: f64,
    pub std_dev: f64,
    pub min_score: f64,
    pub max_score: f64,
    pub mean_percentage: f64,
    pub cronbach_alpha: f64,
    pub items: Vec<ItemStats>,
}

fn compute_pearson_r(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len();
    if n < 3 {
        return 0.0;
    }

    let mean_x = x.iter().sum::<f64>() / (n as f64);
    let mean_y = y.iter().sum::<f64>() / (n as f64);

    let cov: f64 = x
        .iter()
        .zip(y.iter())
        .map(|(&xi, &yi)| (xi - mean_x) * (yi - mean_y))
        .sum();
    let var_x: f64 = x.iter().map(|&xi| (xi - mean_x).powi(2)).sum();
    let var_y: f64 = y.iter().map(|&yi| (yi - mean_y).powi(2)).sum();

    let denom = (var_x * var_y).sqrt();
    if denom == 0.0 {
        0.0
    } else {
        cov / denom
    }
}

pub fn analyze_batch(key: &AnswerKey, grades: &[ExamGrade]) -> Option<BatchPsychometrics> {
    let n = grades.len();
    if n == 0 {
        return None;
    }

    let scores: Vec<f64> = grades.iter().map(|g| g.score).collect();
    let total_possible = key.total_points();
    let mean_score = scores.iter().sum::<f64>() / (n as f64);

    let mut sorted_scores = scores.clone();
    sorted_scores.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let median_score = if n % 2 == 1 {
        sorted_scores[n / 2]
    } else {
        (sorted_scores[n / 2 - 1] + sorted_scores[n / 2]) / 2.0
    };

    let variance = scores
        .iter()
        .map(|s| (s - mean_score).powi(2))
        .sum::<f64>()
        / ((n.max(2) - 1) as f64);
    let std_dev = variance.sqrt();
    let min_score = sorted_scores[0];
    let max_score = sorted_scores[n - 1];
    let mean_pct = if total_possible > 0.0 {
        (mean_score / total_possible) * 100.0
    } else {
        0.0
    };

    // Kelly's 27% rule for upper and lower cohorts
    let cohort_size = ((n as f64 * 0.27).round() as usize).max(1);
    let mut sorted_grades: Vec<&ExamGrade> = grades.iter().collect();
    sorted_grades.sort_by(|a, b| a.score.partial_cmp(&b.score).unwrap());

    let lower_cohort = &sorted_grades[..cohort_size];
    let upper_cohort = &sorted_grades[(n - cohort_size)..];

    let mut item_stats_list = Vec::new();
    let mut item_variances = Vec::new();

    let mut sorted_item_keys: Vec<&String> = key.items.keys().collect();
    sorted_item_keys.sort();

    for &item_key in &sorted_item_keys {
        let key_spec = &key.items[item_key];
        let mut item_scores = Vec::with_capacity(n);
        let mut responses = Vec::with_capacity(n);

        for g in grades {
            if let Some(ig) = g.items.get(item_key) {
                item_scores.push(ig.points_awarded);
                responses.push(ig.student_response.as_str());
            } else {
                item_scores.push(0.0);
                responses.push("?");
            }
        }

        let mean_item_score = item_scores.iter().sum::<f64>() / (n as f64);
        let facility_index = if key_spec.points > 0.0 {
            mean_item_score / key_spec.points
        } else {
            0.0
        };

        // Discrimination Index (Upper cohort mean - Lower cohort mean) / max points
        let upper_mean = if !upper_cohort.is_empty() {
            upper_cohort
                .iter()
                .filter_map(|g| g.items.get(item_key).map(|i| i.points_awarded))
                .sum::<f64>()
                / (upper_cohort.len() as f64)
        } else {
            0.0
        };

        let lower_mean = if !lower_cohort.is_empty() {
            lower_cohort
                .iter()
                .filter_map(|g| g.items.get(item_key).map(|i| i.points_awarded))
                .sum::<f64>()
                / (lower_cohort.len() as f64)
        } else {
            0.0
        };

        let discrim_index = if key_spec.points > 0.0 {
            (upper_mean - lower_mean) / key_spec.points
        } else {
            0.0
        };

        let r_pbis = compute_pearson_r(&item_scores, &scores);

        let item_var = item_scores
            .iter()
            .map(|s| (s - mean_item_score).powi(2))
            .sum::<f64>()
            / ((n.max(2) - 1) as f64);
        item_variances.push(item_var);

        let blank_cnt = responses.iter().filter(|&&r| r == "?" || r.is_empty()).count();
        let multi_cnt = responses.iter().filter(|&&r| r == "*").count();

        // Distractor analysis
        let options = if key_spec.kind == "tf" {
            vec!["T", "F"]
        } else {
            vec!["A", "B", "C", "D", "E"]
        };

        let mut distractors = Vec::new();
        for opt in options {
            let count = responses.iter().filter(|&&r| r == opt).count();
            let pct = (count as f64 / n as f64) * 100.0;
            let is_correct = key_spec.correct_answer.matches(opt);

            distractors.push(DistractorStat {
                option: opt.to_string(),
                count,
                percentage: (pct * 10.0).round() / 10.0,
                is_correct,
            });
        }

        item_stats_list.push(ItemStats {
            key: item_key.clone(),
            kind: key_spec.kind.clone(),
            correct_answer: key_spec.correct_answer.display_string(),
            points: key_spec.points,
            facility_index: (facility_index * 1000.0).round() / 1000.0,
            discrimination_index: (discrim_index * 1000.0).round() / 1000.0,
            point_biserial: (r_pbis * 1000.0).round() / 1000.0,
            distractors,
            blank_count: blank_cnt,
            multi_count: multi_cnt,
        });
    }

    // Cronbach's Alpha
    let k = key.items.len();
    let cronbach_alpha = if k > 1 && variance > 0.0 {
        let sum_item_vars: f64 = item_variances.iter().sum();
        let alpha = (k as f64 / (k as f64 - 1.0)) * (1.0 - (sum_item_vars / variance));
        alpha.clamp(0.0, 1.0)
    } else {
        1.0
    };

    Some(BatchPsychometrics {
        exam_title: key.title.clone(),
        num_students: n,
        total_possible_score: (total_possible * 100.0).round() / 100.0,
        mean_score: (mean_score * 100.0).round() / 100.0,
        median_score: (median_score * 100.0).round() / 100.0,
        std_dev: (std_dev * 100.0).round() / 100.0,
        min_score: (min_score * 100.0).round() / 100.0,
        max_score: (max_score * 100.0).round() / 100.0,
        mean_percentage: (mean_pct * 100.0).round() / 100.0,
        cronbach_alpha: (cronbach_alpha * 1000.0).round() / 1000.0,
        items: item_stats_list,
    })
}
