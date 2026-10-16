//! Typed representations of `layout.json` produced by the sheet builder.
//!
//! All coordinates are in physical millimeters (mm).
//! Origin is at the top-left of the page.

use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

pub const LAYOUT_SCHEMA: &str = "omr-layout/1";

#[derive(Error, Debug)]
pub enum LayoutError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unsupported layout schema '{0}', expected '{LAYOUT_SCHEMA}'")]
    UnsupportedSchema(String),
    #[error("Layout units must be 'mm', got '{0}'")]
    InvalidUnits(String),
    #[error("Layout must define exactly four fiducials, got {0}")]
    InvalidFiducialsCount(usize),
    #[error("Page dimensions out of valid bounds (50-500mm): {width}x{height}")]
    InvalidDimensions { width: f64, height: f64 },
    #[error("Malformed layout: {0}")]
    Malformed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bubble {
    pub value: String,
    pub cx: f64,
    pub cy: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BubbleGroup {
    pub key: String,
    pub kind: String, // "sid" | "mcq" | "tf"
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub index: Option<usize>,
    pub options: Vec<Bubble>,
}

impl BubbleGroup {
    pub fn values(&self) -> Vec<&str> {
        self.options.iter().map(|b| b.value.as_str()).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextROI {
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub zone_id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default = "default_charset")]
    pub charset: String,
    #[serde(default)]
    pub multiline: bool,
    #[serde(default = "default_true")]
    pub ocr: bool,
    #[serde(default)]
    pub graded: bool,
    #[serde(default)]
    pub points: f64,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub digits: usize,
}

fn default_charset() -> String {
    "any".to_string()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fiducial {
    pub id: usize,
    pub corner: String,
    pub size: f64,
    pub corners: Vec<[f64; 2]>, // [x, y] in mm: TL, TR, BR, BL
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Zone {
    pub id: String,
    #[serde(rename = "type")]
    pub zone_type: String,
    #[serde(default)]
    pub label: String,
    pub bbox: BoundingBox,
    #[serde(default)]
    pub groups: Vec<BubbleGroup>,
    #[serde(default)]
    pub rois: Vec<TextROI>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PageInfo {
    pub paper: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BubbleSpec {
    pub diameter: f64,
    #[serde(rename = "pitchX")]
    pub pitch_x: f64,
    #[serde(rename = "pitchY")]
    pub pitch_y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FiducialConfig {
    pub dictionary: String,
    #[serde(default)]
    pub size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawLayoutJson {
    pub schema: String,
    #[serde(default = "default_units")]
    pub units: String,
    #[serde(rename = "templateId")]
    pub template_id: String,
    #[serde(default)]
    pub title: String,
    pub page: PageInfo,
    pub fiducial: FiducialConfig,
    pub fiducials: Vec<Fiducial>,
    pub bubble: BubbleSpec,
    #[serde(default)]
    pub zones: Vec<Zone>,
}

fn default_units() -> String {
    "mm".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layout {
    pub template_id: String,
    pub title: String,
    pub paper: String,
    pub page_width: f64,
    pub page_height: f64,
    pub dictionary: String,
    pub fiducials: Vec<Fiducial>,
    pub bubble_diameter: f64,
    pub pitch_x: f64,
    pub pitch_y: f64,
    pub zones: Vec<Zone>,
}

impl Layout {
    pub fn load_file<P: AsRef<Path>>(path: P) -> Result<Self, LayoutError> {
        let content = std::fs::read_to_string(path)?;
        Self::from_json(&content)
    }

    pub fn from_json(json_str: &str) -> Result<Self, LayoutError> {
        let raw: RawLayoutJson = serde_json::from_str(json_str)?;

        if raw.schema != LAYOUT_SCHEMA {
            return Err(LayoutError::UnsupportedSchema(raw.schema));
        }
        if raw.units != "mm" {
            return Err(LayoutError::InvalidUnits(raw.units));
        }
        if raw.fiducials.len() != 4 {
            return Err(LayoutError::InvalidFiducialsCount(raw.fiducials.len()));
        }
        if !(50.0..=500.0).contains(&raw.page.width) || !(50.0..=500.0).contains(&raw.page.height) {
            return Err(LayoutError::InvalidDimensions {
                width: raw.page.width,
                height: raw.page.height,
            });
        }

        // Propagate zone_id to all groups and rois
        let mut zones = raw.zones;
        for zone in &mut zones {
            for group in &mut zone.groups {
                if group.zone_id.is_empty() {
                    group.zone_id = zone.id.clone();
                }
            }
            for roi in &mut zone.rois {
                if roi.zone_id.is_empty() {
                    roi.zone_id = zone.id.clone();
                }
            }
        }

        Ok(Self {
            template_id: raw.template_id,
            title: raw.title,
            paper: raw.page.paper,
            page_width: raw.page.width,
            page_height: raw.page.height,
            dictionary: raw.fiducial.dictionary,
            fiducials: raw.fiducials,
            bubble_diameter: raw.bubble.diameter,
            pitch_x: raw.bubble.pitch_x,
            pitch_y: raw.bubble.pitch_y,
            zones,
        })
    }

    pub fn question_groups(&self) -> Vec<&BubbleGroup> {
        self.zones
            .iter()
            .flat_map(|z| &z.groups)
            .filter(|g| g.kind != "sid")
            .collect()
    }

    pub fn sid_groups(&self) -> Vec<&BubbleGroup> {
        let mut sid_groups: Vec<&BubbleGroup> = self
            .zones
            .iter()
            .filter(|z| z.zone_type == "student_id")
            .flat_map(|z| &z.groups)
            .collect();
        sid_groups.sort_by_key(|g| g.index.unwrap_or(0));
        sid_groups
    }

    pub fn item_order(&self) -> Vec<String> {
        let mut keys = Vec::new();
        for z in &self.zones {
            for g in &z.groups {
                if g.kind != "sid" {
                    keys.push(g.key.clone());
                }
            }
            for r in &z.rois {
                if r.graded {
                    keys.push(r.key.clone());
                }
            }
        }
        keys
    }

    pub fn sid_roi(&self) -> Option<&TextROI> {
        self.zones
            .iter()
            .flat_map(|z| &z.rois)
            .find(|r| r.role.as_deref() == Some("student_id") || r.key == "sid")
    }

    pub fn score_roi(&self) -> Option<&TextROI> {
        self.zones
            .iter()
            .flat_map(|z| &z.rois)
            .find(|r| r.role.as_deref() == Some("score") || r.key == "score")
    }
}
