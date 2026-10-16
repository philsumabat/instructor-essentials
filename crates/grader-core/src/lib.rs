//! Instructor Essentials Core Engine (Rust).
//!
//! Pure-Rust, zero-external-dependency OMR, grading, roster matching,
//! and psychometrics engine.

pub mod grading;
pub mod layout;
pub mod psycho;
pub mod report;
pub mod roster;
pub mod vision;

pub use grading::{AnswerKey, ExamGrade, GradingEngine, ItemGrade};
pub use layout::Layout;
pub use psycho::BatchPsychometrics;
pub use roster::{Roster, RosterMatch, Student};
