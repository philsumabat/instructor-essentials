/**
 * Zero-dependency Code 39 barcode generator and scanline raster decoder.
 * Used for serialized physical sheet identification and robust duplicate scan detection.
 */

export const CODE39_PATTERNS = Object.freeze({
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
  '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
  '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
  'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000',
  'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
  'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
  'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110',
  'S': '001000110', 'T': '000010110', 'U': '110000001', 'V': '011000001',
  'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '*': '010010100',
  '$': '010101000', '/': '010100010', '+': '010001010', '%': '000101010',
});

const REV_CODE39 = Object.freeze(
  Object.fromEntries(Object.entries(CODE39_PATTERNS).map(([k, v]) => [v, k]))
);

/**
 * Generates a unique, cryptographically random sheet serial code.
 * Example format: "SHT-7A2F-9B"
 */
export function generateRandomSheetId(prefix = 'SHT') {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Exclude 0/O and 1/I to prevent visual ambiguity
  const rnd = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(rnd);
  } else {
    for (let i = 0; i < 6; i++) rnd[i] = Math.floor(Math.random() * 256);
  }
  let s1 = '', s2 = '';
  for (let i = 0; i < 3; i++) s1 += chars[rnd[i] % chars.length];
  for (let i = 3; i < 6; i++) s2 += chars[rnd[i] % chars.length];
  return `${prefix}-${s1}-${s2}`;
}

/**
 * Encodes text into Code 39 bar/space run units.
 * Returns array of elements: { isBlack: boolean, width: number }
 */
export function encodeCode39(text, { wideRatio = 2.5 } = {}) {
  const clean = String(text || '').toUpperCase().replace(/[^0-9A-Z\-.$/+% ]/g, '');
  const framed = `*${clean}*`;
  const runs = [];
  let totalUnits = 0;

  for (let i = 0; i < framed.length; i++) {
    const ch = framed[i];
    const pat = CODE39_PATTERNS[ch];
    if (!pat) continue;
    for (let j = 0; j < pat.length; j++) {
      const isBlack = (j % 2 === 0);
      const width = pat[j] === '1' ? wideRatio : 1.0;
      runs.push({ isBlack, width });
      totalUnits += width;
    }
    if (i < framed.length - 1) {
      runs.push({ isBlack: false, width: 1.0 }); // Inter-character gap
      totalUnits += 1.0;
    }
  }

  return { runs, totalUnits, text: clean };
}

/**
 * Generates an SVG string representation of a Code 39 barcode with human-readable text label.
 */
export function generateBarcodeSVG(text, { widthMm = 34, heightMm = 6.5, fontSizeMm = 1.6 } = {}) {
  const { runs, totalUnits, text: clean } = encodeCode39(text);
  if (runs.length === 0 || totalUnits === 0) return '';

  const quietMarginUnits = 4;
  const fullUnits = totalUnits + 2 * quietMarginUnits;
  const barHeightMm = Math.max(2.5, heightMm - fontSizeMm - 0.8);

  const rects = [];
  let currentUnit = quietMarginUnits;

  for (const run of runs) {
    if (run.isBlack) {
      const x = (currentUnit / fullUnits) * widthMm;
      const w = (run.width / fullUnits) * widthMm;
      rects.push(`<rect x="${x.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="${barHeightMm.toFixed(3)}" fill="#000" shape-rendering="crispEdges"/>`);
    }
    currentUnit += run.width;
  }

  const textY = heightMm - 0.2;
  const textSvg = `<text x="${(widthMm / 2).toFixed(3)}" y="${textY.toFixed(3)}" font-family="'Courier New', Courier, monospace" font-size="${fontSizeMm.toFixed(3)}mm" font-weight="700" text-anchor="middle" fill="#000" letter-spacing="0.2mm">${clean}</text>`;

  return `<svg class="omr-barcode" data-sheet-id="${clean}" viewBox="0 0 ${widthMm} ${heightMm}" width="${widthMm}mm" height="${heightMm}mm" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${widthMm}" height="${heightMm}" fill="#fff"/>
  ${rects.join('\n  ')}
  ${textSvg}
</svg>`;
}

/**
 * Decodes a binary scanline array (1 for black, 0 for white).
 * Returns the decoded string or null if not valid Code 39.
 */
export function decodeCode39Scanline(binaryLine) {
  if (!Array.isArray(binaryLine) && !ArrayBuffer.isView(binaryLine)) return null;
  const len = binaryLine.length;
  if (len < 30) return null;

  // Run-length encode the binary scanline
  const runs = [];
  let curr = binaryLine[0] ? 1 : 0;
  let count = 1;
  for (let i = 1; i < len; i++) {
    const val = binaryLine[i] ? 1 : 0;
    if (val === curr) {
      count++;
    } else {
      runs.push([curr, count]);
      curr = val;
      count = 1;
    }
  }
  runs.push([curr, count]);

  // Strip leading and trailing white space (quiet zones)
  while (runs.length > 0 && runs[0][0] === 0) runs.shift();
  while (runs.length > 0 && runs[runs.length - 1][0] === 0) runs.pop();

  if (runs.length < 9) return null;

  // Search for the start delimiter '*' (9 elements: b, w, b, w, b, w, b, w, b)
  for (let startIdx = 0; startIdx <= runs.length - 9; startIdx++) {
    if (runs[startIdx][0] !== 1) continue; // Must begin with a black bar
    const window = runs.slice(startIdx, startIdx + 9);
    let alternating = true;
    for (let k = 0; k < 9; k++) {
      if (window[k][0] !== (k % 2 === 0 ? 1 : 0)) {
        alternating = false;
        break;
      }
    }
    if (!alternating) continue;

    const lengths = window.map((r) => r[1]);
    const sortedLens = [...lengths].sort((a, b) => a - b);
    const nEst = sortedLens.slice(0, 6).reduce((a, b) => a + b, 0) / 6.0;
    const wEst = sortedLens.slice(6).reduce((a, b) => a + b, 0) / 3.0;

    if (wEst < 1.35 * nEst || nEst < 0.5) continue;
    const thresh = (nEst + wEst) / 2.0;

    const startPat = lengths.map((l) => (l >= thresh ? '1' : '0')).join('');
    if (startPat !== CODE39_PATTERNS['*']) continue;

    // Start pattern matched! Proceed to decode following characters
    const decoded = [];
    let idx = startIdx + 9;
    let matchedStop = false;

    while (idx < runs.length) {
      // Skip 1 inter-character gap (white space)
      if (idx < runs.length && runs[idx][0] === 0) idx++;
      if (idx + 9 > runs.length) break;

      const charWindow = runs.slice(idx, idx + 9);
      let charAlt = true;
      for (let k = 0; k < 9; k++) {
        if (charWindow[k][0] !== (k % 2 === 0 ? 1 : 0)) {
          charAlt = false;
          break;
        }
      }
      if (!charAlt) break;

      const charLengths = charWindow.map((r) => r[1]);
      const charPat = charLengths.map((l) => (l >= thresh ? '1' : '0')).join('');
      const charVal = REV_CODE39[charPat];
      if (!charVal) break;

      if (charVal === '*') {
        matchedStop = true;
        break;
      }

      decoded.push(charVal);
      idx += 9;
    }

    if (matchedStop && decoded.length > 0) {
      return decoded.join('');
    }
  }

  return null;
}

/**
 * Decodes Code 39 barcode from a 2D pixel image / canvas.
 * Samples multiple horizontal scanlines to tolerate minor ink flecks or paper texture.
 */
export function decodeCode39FromImageData(imageData, { startYFraction = 0.25, endYFraction = 0.75, numScanlines = 5 } = {}) {
  if (!imageData || !imageData.data || imageData.width < 20 || imageData.height < 5) return null;
  const { data, width, height } = imageData;

  const yStep = (endYFraction - startYFraction) / Math.max(1, numScanlines - 1);
  const candidates = {};

  for (let s = 0; s < numScanlines; s++) {
    const yFrac = numScanlines === 1 ? 0.5 : (startYFraction + s * yStep);
    const y = Math.min(height - 1, Math.max(0, Math.floor(height * yFrac)));
    const rowOffset = y * width * 4;

    // Compute row luminance
    const lum = new Float32Array(width);
    let minL = 255, maxL = 0;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      lum[x] = l;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }

    // Require sufficient contrast
    if (maxL - minL < 30) continue;
    const threshold = (minL + maxL) * 0.5;

    // Binarize
    const binary = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      binary[x] = lum[x] < threshold ? 1 : 0; // 1 = black, 0 = white
    }

    const decoded = decodeCode39Scanline(binary);
    if (decoded) {
      candidates[decoded] = (candidates[decoded] || 0) + 1;
    }
  }

  let best = null, bestCount = 0;
  for (const [code, count] of Object.entries(candidates)) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }

  return best;
}
