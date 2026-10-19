import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '../..');

test('Checker Studio uploader accepts PDF files and remains 100% offline self-contained', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Scans uploader accept attribute
  assert.ok(
    checkerHtml.includes('id="input-scans"') &&
    checkerHtml.includes('accept="image/*,.pdf,application/pdf"'),
    'input-scans must accept image/*,.pdf,application/pdf'
  );

  // 2. Key scan uploader accept attribute
  assert.ok(
    checkerHtml.includes('id="input-key-scan"') &&
    checkerHtml.includes('accept="image/*,.pdf,application/pdf,.json,.csv"'),
    'input-key-scan must accept PDF as well as image and data formats'
  );

  // 3. Dropzone hint mentions PDF
  assert.ok(
    checkerHtml.includes('Supports JPG, PNG, PDF (Single or Multi-Page Batch)'),
    'dropzone hint mentions PDF support'
  );

  // 4. Zero external scripts or styles
  const extStyles = [...checkerHtml.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  assert.equal(extStyles.length, 0, 'No external stylesheets in checker.html');

  const extScripts = [...checkerHtml.matchAll(/<script\s+[^>]*src=[^>]*>/gi)];
  assert.equal(extScripts.length, 0, 'No external scripts in checker.html');

  // 5. Zero fetch() calls
  assert.ok(!checkerHtml.includes('fetch('), 'Must maintain zero fetch() calls in checker.html');
});

test('extractPdfScansFromBuffer correctly extracts pages and rotations from Adobe Scan PDF', async (t) => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Extract extractPdfScansFromBuffer from checker.html script
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script tag found in checker.html');

  // Create isolated context with extractPdfScansFromBuffer
  const ctx = {
    Buffer,
    Uint8Array,
    Map,
    parseInt,
    parseFloat,
    Math,
    String,
    TextDecoder,
  };
  vm.createContext(ctx);

  // Extract function definition from checker.html
  const fnMatch = scriptMatch[1].match(/function extractPdfScansFromBuffer\([\s\S]*?\n    \}/);
  assert.ok(fnMatch, 'extractPdfScansFromBuffer found in script');

  vm.runInContext(fnMatch[0] + '; globalThis.extractPdfScansFromBuffer = extractPdfScansFromBuffer;', ctx);

  // Load the real Adobe Scan PDF if present (optional local fixture)
  let pdfBytes;
  try {
    pdfBytes = await readFile(resolve(root, 'test-run/Adobe Scan Oct 18, 2026.pdf'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (typeof t?.skip === 'function') {
        t.skip('Adobe Scan Oct 18, 2026.pdf not present in test-run/');
      }
      return;
    }
    throw err;
  }
  const scans = ctx.extractPdfScansFromBuffer(pdfBytes);

  assert.equal(scans.length, 69, 'Must extract all 69 pages from Adobe Scan PDF');
  assert.equal(scans[0].pageNum, 1);
  assert.equal(scans[0].rotation, 90, 'Page 1 has 90 deg clockwise rotation');
  assert.ok(scans[0].bytes.length > 50000, 'Page 1 has valid image bytes');
  assert.equal(scans[0].bytes[0], 0xFF, 'JPEG SOI byte 1');
  assert.equal(scans[0].bytes[1], 0xD8, 'JPEG SOI byte 2');

  // Verify all 69 pages are strictly ordered sequentially 1..69
  for (let i = 0; i < scans.length; i++) {
    assert.equal(scans[i].pageNum, i + 1, `Page index ${i} must match pageNum ${i + 1}`);
  }

  // Verify handlePdfUpload in checkerHtml uses orderedScans to prevent async race condition
  assert.ok(checkerHtml.includes('const orderedScans = new Array(pages.length)'), 'handlePdfUpload preserves page order via orderedScans');
  assert.ok(checkerHtml.includes('Extracting scan pages from'), 'handlePdfUpload reports extraction progress');
});
