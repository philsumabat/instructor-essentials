import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE39_PATTERNS,
  generateRandomSheetId,
  encodeCode39,
  generateBarcodeSVG,
  decodeCode39Scanline,
  decodeCode39FromImageData,
} from '../../builder/js/barcode.js';

test('Barcode 1: Code 39 Pattern Specifications', () => {
  assert.equal(Object.keys(CODE39_PATTERNS).length, 44);
  for (const [char, pat] of Object.entries(CODE39_PATTERNS)) {
    assert.equal(pat.length, 9, `Pattern for "${char}" must be 9 elements`);
    const ones = pat.split('').filter((b) => b === '1').length;
    const zeros = pat.split('').filter((b) => b === '0').length;
    assert.equal(ones, 3, `Pattern for "${char}" must have exactly 3 wide elements`);
    assert.equal(zeros, 6, `Pattern for "${char}" must have exactly 6 narrow elements`);
  }
});

test('Barcode 2: Random Sheet ID Generator', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = generateRandomSheetId('SHT');
    assert.match(id, /^SHT-[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/, `ID "${id}" matches expected format`);
    ids.add(id);
  }
  assert.equal(ids.size, 500, '500 generated IDs must all be unique');
});

test('Barcode 3: Encode & Decode Round-Trip via Scanline', () => {
  const testCodes = ['SHT-8F42-9B', 'EXAM-101', 'SHEET-01', 'QUIZ-49A', '10482901'];

  for (const code of testCodes) {
    const { runs } = encodeCode39(code, { wideRatio: 2.5 });
    // Convert runs to binary pixels (1 unit = 3 pixels, quiet margins = 20 pixels)
    const pixels = new Array(20).fill(0);
    for (const r of runs) {
      const pxCount = Math.round(r.width * 3);
      for (let p = 0; p < pxCount; p++) {
        pixels.push(r.isBlack ? 1 : 0);
      }
    }
    for (let p = 0; p < 20; p++) pixels.push(0);

    const decoded = decodeCode39Scanline(pixels);
    assert.equal(decoded, code, `Decoded "${decoded}" must match input "${code}"`);
  }
});

test('Barcode 4: generateBarcodeSVG Output', () => {
  const svg = generateBarcodeSVG('SHT-7A2F-9K', { widthMm: 34, heightMm: 6.5 });
  assert.ok(svg.includes('<svg class="omr-barcode"'), 'Contains SVG root');
  assert.ok(svg.includes('data-sheet-id="SHT-7A2F-9K"'), 'Embeds sheet ID attribute');
  assert.ok(svg.includes('<rect'), 'Contains barcode bar rectangles');
  assert.ok(svg.includes('SHT-7A2F-9K</text>'), 'Contains human-readable text label');
  assert.ok(svg.includes('width="34mm"'), 'Sets physical width in mm');
});

test('Barcode 5: decodeCode39FromImageData Simulation', () => {
  const testId = 'SHT-9K3M-2W';
  const { runs, totalUnits } = encodeCode39(testId, { wideRatio: 2.5 });

  const quietMarginUnits = 4;
  const fullUnits = totalUnits + 2 * quietMarginUnits;
  const widthPx = 300;
  const heightPx = 25;

  const data = new Uint8ClampedArray(widthPx * heightPx * 4);
  // Default white background
  data.fill(255);

  let currentUnit = quietMarginUnits;
  for (const r of runs) {
    const xStart = Math.round((currentUnit / fullUnits) * widthPx);
    const xEnd = Math.round(((currentUnit + r.width) / fullUnits) * widthPx);

    if (r.isBlack) {
      for (let y = 0; y < 18; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const idx = (y * widthPx + x) * 4;
          data[idx] = 10;     // R
          data[idx + 1] = 10; // G
          data[idx + 2] = 10; // B
        }
      }
    }
    currentUnit += r.width;
  }

  const imageData = { data, width: widthPx, height: heightPx };
  const decoded = decodeCode39FromImageData(imageData);
  assert.equal(decoded, testId, `Decoded from imageData "${decoded}" must equal "${testId}"`);
});
