/**
 * ArUco fiducial bit patterns (OpenCV DICT_4X4_50).
 *
 * The 4x4 data payloads below were extracted from OpenCV's predefined
 * dictionary (cv2.aruco.generateImageMarker), so the printed markers are
 * decoded natively by cv2.aruco.ArucoDetector. 1 = white cell, 0 = black.
 * Each marker is rendered as a 6x6 cell grid: a 1-cell black border wrapping
 * the 4x4 payload. A white quiet zone of >= 1 cell must surround the marker.
 */
export const ARUCO_DICTIONARY = 'DICT_4X4_50';

const PAYLOADS = Object.freeze({
  0: [[1, 0, 1, 1], [0, 1, 0, 1], [0, 0, 1, 1], [0, 0, 1, 0]],
  1: [[0, 0, 0, 0], [1, 1, 1, 1], [1, 0, 0, 1], [1, 0, 1, 0]],
  2: [[0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 0], [1, 1, 0, 1]],
  3: [[1, 0, 0, 1], [1, 0, 0, 1], [0, 1, 0, 0], [0, 1, 1, 0]],
});

export const SUPPORTED_MARKER_IDS = Object.freeze(Object.keys(PAYLOADS).map(Number));

/** Returns the full 6x6 cell matrix (border included) for a marker id. */
export function markerCells(id) {
  const payload = PAYLOADS[id];
  if (!payload) {
    throw new Error(`ArUco id ${id} is not bundled (supported: ${SUPPORTED_MARKER_IDS.join(', ')})`);
  }
  const cells = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) cells[r + 1][c + 1] = payload[r][c];
  }
  return cells;
}

/**
 * Builds a single SVG path ("d" attribute) covering every black cell of the
 * marker, in a unit square of `size` user units. One path avoids the hairline
 * seams that adjacent rectangles produce in some PDF rasterizers.
 */
export function markerPath(id, size) {
  const cells = markerCells(id);
  const cell = size / 6;
  const parts = [];
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c < 6; c += 1) {
      if (cells[r][c] === 0) {
        const x = +(c * cell).toFixed(4);
        const y = +(r * cell).toFixed(4);
        const s = +cell.toFixed(4);
        parts.push(`M${x} ${y}h${s}v${s}h${-s}z`);
      }
    }
  }
  return parts.join('');
}
