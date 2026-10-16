//! Pure-Rust computer vision and OMR mark detection.
//!
//! Handles:
//! - Projective perspective transformation (Homography)
//! - Adaptive bubble density sampling (72% inner core)
//! - Choice resolution and student ID extraction

use crate::layout::{BubbleGroup, Layout};
use image::{GrayImage, Luma};
use nalgebra::{Matrix3, Point2, Vector3};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

pub const DEFAULT_PX_PER_MM: f64 = 10.0;

#[derive(Error, Debug)]
pub enum VisionError {
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("Could not calculate homography matrix: {0}")]
    HomographyError(String),
    #[error("Fiducial detection failed: {0}")]
    FiducialError(String),
}

#[derive(Debug, Clone)]
pub struct BubbleMeasurement {
    pub value: String,
    pub target_cx_px: u32,
    pub target_cy_px: u32,
    pub fill_ratio: f64,
    pub is_filled: bool,
}

#[derive(Debug, Clone)]
pub struct GroupResult {
    pub key: String,
    pub kind: String,
    pub resolved_value: String, // e.g. "A", "?", or "*"
    pub is_blank: bool,
    pub is_multi: bool,
    pub fill_margin: f64,
    pub measurements: Vec<BubbleMeasurement>,
}

/// Projective perspective transformation matrix.
#[derive(Debug, Clone)]
pub struct Homography {
    pub h: Matrix3<f64>,
    pub inv_h: Matrix3<f64>,
}

impl Homography {
    /// Estimates a 3x3 homography matrix from at least 4 source-to-destination point pairs.
    pub fn from_points(src: &[[f64; 2]], dst: &[[f64; 2]]) -> Result<Self, VisionError> {
        let n = src.len();
        if n < 4 || dst.len() != n {
            return Err(VisionError::HomographyError(
                "At least 4 corresponding point pairs required".to_string(),
            ));
        }

        // Build 2N x 9 matrix A for Ah = 0
        let mut a_rows = Vec::with_capacity(2 * n * 9);
        for i in 0..n {
            let (x, y) = (src[i][0], src[i][1]);
            let (u, v) = (dst[i][0], dst[i][1]);

            // Row 1: [-x, -y, -1, 0, 0, 0, u*x, u*y, u]
            a_rows.extend_from_slice(&[-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u]);
            // Row 2: [0, 0, 0, -x, -y, -1, v*x, v*y, v]
            a_rows.extend_from_slice(&[0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v]);
        }

        let a = nalgebra::DMatrix::from_row_slice(2 * n, 9, &a_rows);
        let svd = a.svd(true, true);
        let v_t = svd.v_t.ok_or_else(|| {
            VisionError::HomographyError("SVD failed on point correspondences".to_string())
        })?;

        // The solution is the last row of V^T (corresponding to the smallest singular value)
        let last_row = v_t.row(8);
        let h_raw = Matrix3::new(
            last_row[0], last_row[1], last_row[2],
            last_row[3], last_row[4], last_row[5],
            last_row[6], last_row[7], last_row[8],
        );

        let inv_h = h_raw.try_inverse().ok_or_else(|| {
            VisionError::HomographyError("Singular homography matrix cannot be inverted".to_string())
        })?;

        Ok(Self { h: h_raw, inv_h })
    }

    /// Transforms a point (x, y) via projective transformation.
    pub fn transform_point(&self, p: Point2<f64>) -> Point2<f64> {
        let v = self.h * Vector3::new(p.x, p.y, 1.0);
        Point2::new(v.x / v.z, v.y / v.z)
    }

    /// Inversely transforms a destination point back to source coordinates.
    pub fn inverse_transform_point(&self, p: Point2<f64>) -> Point2<f64> {
        let v = self.inv_h * Vector3::new(p.x, p.y, 1.0);
        Point2::new(v.x / v.z, v.y / v.z)
    }

    /// Warps source grayscale image onto target dimensions using bilinear interpolation.
    pub fn warp_perspective(
        &self,
        src: &GrayImage,
        target_w: u32,
        target_h: u32,
    ) -> GrayImage {
        let mut dst = GrayImage::new(target_w, target_h);
        let (src_w, src_h) = (src.width() as f64, src.height() as f64);

        for y_dst in 0..target_h {
            for x_dst in 0..target_w {
                let p_src = self.inverse_transform_point(Point2::new(x_dst as f64, y_dst as f64));
                let (sx, sy) = (p_src.x, p_src.y);

                if sx >= 0.0 && sx < (src_w - 1.0) && sy >= 0.0 && sy < (src_h - 1.0) {
                    let x0 = sx.floor() as u32;
                    let y0 = sy.floor() as u32;
                    let x1 = x0 + 1;
                    let y1 = y0 + 1;

                    let dx = sx - (x0 as f64);
                    let dy = sy - (y0 as f64);

                    let p00 = src.get_pixel(x0, y0).0[0] as f64;
                    let p10 = src.get_pixel(x1, y0).0[0] as f64;
                    let p01 = src.get_pixel(x0, y1).0[0] as f64;
                    let p11 = src.get_pixel(x1, y1).0[0] as f64;

                    let val = (1.0 - dx) * (1.0 - dy) * p00
                        + dx * (1.0 - dy) * p10
                        + (1.0 - dx) * dy * p01
                        + dx * dy * p11;

                    dst.put_pixel(x_dst, y_dst, Luma([val.round().clamp(0.0, 255.0) as u8]));
                } else {
                    dst.put_pixel(x_dst, y_dst, Luma([255])); // White background
                }
            }
        }
        dst
    }
}

pub struct BubbleScanner {
    pub px_per_mm: f64,
    pub fill_threshold: f64,
    pub min_contrast_delta: f64,
    pub bubble_diameter_mm: f64,
}

impl BubbleScanner {
    pub fn new(layout: &Layout) -> Self {
        Self {
            px_per_mm: DEFAULT_PX_PER_MM,
            fill_threshold: 0.35,
            min_contrast_delta: 0.12,
            bubble_diameter_mm: layout.bubble_diameter,
        }
    }

    /// Measures the graphite density within the inner 72% circular core of a bubble.
    pub fn measure_bubble(
        &self,
        gray: &GrayImage,
        cx_mm: f64,
        cy_mm: f64,
        value: &str,
    ) -> BubbleMeasurement {
        let cx = (cx_mm * self.px_per_mm).round() as i32;
        let cy = (cy_mm * self.px_per_mm).round() as i32;
        let radius = ((self.bubble_diameter_mm / 2.0) * self.px_per_mm * 0.72).round() as i32;
        let r_sq = radius * radius;

        let (w, h) = (gray.width() as i32, gray.height() as i32);

        let mut dark_pixels = 0;
        let mut total_pixels = 0;

        // Local thresholding: compute mean brightness around the bubble to adapt to shadows
        let mut local_sum = 0u64;
        let mut local_count = 0u64;
        let local_pad = radius * 2;

        for dy in -local_pad..=local_pad {
            for dx in -local_pad..=local_pad {
                let px = cx + dx;
                let py = cy + dy;
                if px >= 0 && px < w && py >= 0 && py < h {
                    local_sum += gray.get_pixel(px as u32, py as u32).0[0] as u64;
                    local_count += 1;
                }
            }
        }

        let local_mean = if local_count > 0 {
            (local_sum / local_count) as f64
        } else {
            200.0
        };

        // Dark threshold is 85% of surrounding local mean brightness
        let dark_cutoff = (local_mean * 0.82).clamp(40.0, 215.0) as u8;

        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx * dx + dy * dy <= r_sq {
                    let px = cx + dx;
                    let py = cy + dy;
                    if px >= 0 && px < w && py >= 0 && py < h {
                        let intensity = gray.get_pixel(px as u32, py as u32).0[0];
                        if intensity < dark_cutoff {
                            dark_pixels += 1;
                        }
                        total_pixels += 1;
                    }
                }
            }
        }

        let fill_ratio = if total_pixels > 0 {
            (dark_pixels as f64) / (total_pixels as f64)
        } else {
            0.0
        };

        BubbleMeasurement {
            value: value.to_string(),
            target_cx_px: cx as u32,
            target_cy_px: cy as u32,
            fill_ratio,
            is_filled: fill_ratio >= self.fill_threshold,
        }
    }

    /// Evaluates a single question group (e.g. choices A, B, C, D).
    pub fn scan_group(&self, gray: &GrayImage, group: &BubbleGroup) -> GroupResult {
        let mut measurements: Vec<BubbleMeasurement> = group
            .options
            .iter()
            .map(|opt| self.measure_bubble(gray, opt.cx, opt.cy, &opt.value))
            .collect();

        measurements.sort_by(|a, b| b.fill_ratio.partial_cmp(&a.fill_ratio).unwrap());

        let top = &measurements[0];
        let second = measurements.get(1);

        let filled_options: Vec<&str> = measurements
            .iter()
            .filter(|m| m.is_filled)
            .map(|m| m.value.as_str())
            .collect();

        let margin = if let Some(s) = second {
            top.fill_ratio - s.fill_ratio
        } else {
            top.fill_ratio
        };

        let is_distinct = if second.is_some() {
            top.fill_ratio > 0.22 && margin >= self.min_contrast_delta
        } else {
            top.fill_ratio >= self.fill_threshold
        };

        let (resolved, is_blank, is_multi) = if filled_options.len() == 1 {
            (filled_options[0].to_string(), false, false)
        } else if filled_options.len() > 1 {
            // Check if one option is overwhelmingly darker than the rest (e.g. erased smudge)
            if is_distinct && margin >= 0.20 {
                (top.value.clone(), false, false)
            } else {
                ("*".to_string(), false, true)
            }
        } else if is_distinct {
            (top.value.clone(), false, false)
        } else {
            ("?".to_string(), true, false)
        };

        GroupResult {
            key: group.key.clone(),
            kind: group.kind.clone(),
            resolved_value: resolved,
            is_blank,
            is_multi,
            fill_margin: margin,
            measurements,
        }
    }

    /// Scans all groups across the layout, returning responses and decoded Student ID.
    pub fn scan_all(
        &self,
        gray: &GrayImage,
        layout: &Layout,
    ) -> (HashMap<String, String>, HashSet<String>, HashSet<String>, String) {
        let mut responses = HashMap::new();
        let mut blank_items = HashSet::new();
        let mut multi_items = HashSet::new();

        for z in &layout.zones {
            for group in &z.groups {
                let res = self.scan_group(gray, group);
                responses.insert(group.key.clone(), res.resolved_value.clone());
                if res.is_blank {
                    blank_items.insert(group.key.clone());
                }
                if res.is_multi {
                    multi_items.insert(group.key.clone());
                }
            }
        }

        // Decode student ID from dedicated student_id zone
        let mut sid_chars = Vec::new();
        for sid_group in layout.sid_groups() {
            if let Some(val) = responses.get(&sid_group.key) {
                sid_chars.push(val.as_str());
            } else {
                sid_chars.push("?");
            }
        }

        let decoded_sid = sid_chars.join("");
        (responses, blank_items, multi_items, decoded_sid)
    }
}
