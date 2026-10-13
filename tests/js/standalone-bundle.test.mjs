import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('standalone studio.html is 100% self-contained with valid IIFE closures and zero CORS/external requests', async () => {
  const htmlPath = resolve(root, 'builder/studio.html');
  const html = await readFile(htmlPath, 'utf8');

  // 1. Zero external CSS requests
  const extStyles = [...html.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  assert.equal(extStyles.length, 0, 'No external stylesheet links allowed');

  // 2. Zero external script requests
  const extScripts = [...html.matchAll(/<script\s+[^>]*src=[^>]*>/gi)];
  assert.equal(extScripts.length, 0, 'No external script tags allowed');

  // 3. Embedded sample templates
  assert.ok(html.includes('bio101-midterm-50'), 'exam-50 template must be inlined');
  assert.ok(html.includes('chem201-final-100'), 'exam-100 template must be inlined');
  assert.ok(html.includes('hist110-quiz-tf'), 'quiz-tf template must be inlined');

  // 4. Inlined styles present
  assert.ok(html.includes('.omr-sheet'), 'sheet.css must be inlined');
  assert.ok(html.includes('.app-header'), 'app.css must be inlined');
  assert.ok(!html.includes('OMR Exam Designer & Layout Engine'), 'Legacy OMR Exam Designer badge removed from studio');

  // 5. Inlined script syntax validation
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '<script> block must be present');
  const scriptContent = scriptMatch[1];

  // Must not throw SyntaxError (e.g. duplicate identifier '$')
  assert.doesNotThrow(() => {
    new vm.Script(scriptContent);
  }, 'Bundled script must compile with zero syntax errors');

  // 6. Verify IIFE closures wrap the modules
  assert.match(scriptContent, /const\s+Aruco\s*=\s*\(function\(\)/);
  assert.match(scriptContent, /const\s+LayoutEngine\s*=\s*\(function\(Aruco\)/);
  assert.match(scriptContent, /const\s+RenderDOM\s*=\s*\(function\(Aruco\)/);
  assert.match(scriptContent, /const\s+RenderSVG\s*=\s*\(function\(Aruco,\s*RenderDOM\)/);
  assert.match(scriptContent, /const\s+Templates\s*=\s*\(function\(\)/);
});

test('docs/index.html is synchronized for 1-click GitHub Pages deployment', async () => {
  const studioHtml = await readFile(resolve(root, 'builder/studio.html'), 'utf8');
  const docsHtml = await readFile(resolve(root, 'docs/index.html'), 'utf8');
  assert.equal(docsHtml, studioHtml, 'docs/index.html must match builder/studio.html exactly');
});

test('docs/checker.html is 100% self-contained and synchronized for client-side GitHub Pages OMR', async () => {
  const checkerSrc = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const checkerDocs = await readFile(resolve(root, 'docs/checker.html'), 'utf8');
  assert.equal(checkerDocs, checkerSrc, 'docs/checker.html must match builder/checker.html exactly');

  // Verify zero external requests
  const extStyles = [...checkerDocs.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  assert.equal(extStyles.length, 0, 'No external stylesheet links in checker.html');
  const extScripts = [...checkerDocs.matchAll(/<script\s+[^>]*src=[^>]*>/gi)];
  assert.equal(extScripts.length, 0, 'No external script tags in checker.html');

  // Verify embedded OMR engine and sample key
  assert.ok(checkerDocs.includes('computeHomography'), 'Homography engine present');
  assert.ok(checkerDocs.includes('SAMPLE_KEY'), 'Sample answer key present');
  assert.ok(checkerDocs.includes('SAMPLE_ROSTER'), 'Sample roster present');

  // Verify JPEG and ZIP export features
  assert.ok(checkerDocs.includes('btn-download-sheet-jpeg'), 'Download Graded Sheet (JPEG) button present');
  assert.ok(checkerDocs.includes('btn-export-zip'), 'Download All Graded Sheets (ZIP) button present');
  assert.ok(checkerDocs.includes('createZip'), 'Zero-dependency inlined ZIP generator present');
  assert.ok(!checkerDocs.includes('OMR Exam Designer & Layout Engine'), 'Legacy OMR Exam Designer badge removed from checker');
  assert.ok(!checkerDocs.includes('Client-Side OMR Grading &amp; Psychometrics'), 'Client-Side OMR Grading badge removed from checker header');
});

