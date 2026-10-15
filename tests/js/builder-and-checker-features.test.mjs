import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../../builder/js/layout-engine.js';
import { renderSheetDOM, renderStandaloneHTML } from '../../builder/js/render-dom.js';
import { renderSVG } from '../../builder/js/render-svg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

test('Feature 1: Flexible boxWidth and boxHeight for modified_tf and text_short', () => {
  // 1. modified_tf custom dimensions
  const tplModifiedTf = {
    id: 'test-mod-tf',
    title: 'Modified T/F Custom Size Test',
    paper: 'A4',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones: [
      {
        id: 'mtf-custom',
        type: 'modified_tf',
        label: 'Modified True/False',
        count: 5,
        start: 1,
        boxWidth: 65,
        boxHeight: 12,
        points: 2,
      },
    ],
  };

  const layout = buildLayout(tplModifiedTf);
  assert.ok(layout, 'Layout builds successfully');
  const mtfZone = layout.zones.find((z) => z.id === 'mtf-custom');
  assert.ok(mtfZone, 'Zone mtf-custom found');

  // Verify correction boxes (rois) reflect boxWidth: 65 and boxHeight: 12
  assert.equal(mtfZone.rois.length, 5);
  for (const roi of mtfZone.rois) {
    assert.equal(roi.w, 65, 'Correction box width should match custom boxWidth (65mm)');
    assert.equal(roi.h, 12, 'Correction box height should match custom boxHeight (12mm)');
  }

  // Verify row height expanded to accommodate boxHeight: 12 (12 + 1.2 = 13.2mm)
  const grid = mtfZone.grids[0];
  assert.equal(grid.rows[0], 13.2, 'Grid row height should expand to boxHeight + 1.2mm');

  // 2. text_short custom boxWidth and boxHeight
  const tplTextShort = {
    id: 'test-text-short',
    title: 'Text Short Custom Size Test',
    paper: 'A4',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones: [
      {
        id: 'short-custom',
        type: 'text_short',
        label: 'Short Answer',
        count: 4,
        start: 1,
        columns: 2,
        boxWidth: 35,
        boxHeight: 14,
        points: 3,
      },
    ],
  };

  const layoutText = buildLayout(tplTextShort);
  const textZone = layoutText.zones.find((z) => z.id === 'short-custom');
  assert.ok(textZone, 'Text zone found');
  assert.equal(textZone.rois.length, 4);
  for (const roi of textZone.rois) {
    assert.equal(roi.w, 35, 'Text item box width should respect custom boxWidth (35mm)');
    assert.equal(roi.h, 14, 'Text item box height should respect custom boxHeight (14mm)');
  }
});

test('Feature 2: Clean print isolation suppresses canvas-bottom-bar', () => {
  const indexHtml = fs.readFileSync(path.join(rootDir, 'builder/index.html'), 'utf8');
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');

  // Check HTML has app-chrome class on canvas-bottom-bar
  assert.match(indexHtml, /class="canvas-bottom-bar\s+app-chrome"/, 'canvas-bottom-bar must have app-chrome class in index.html');

  // Check app.css includes .canvas-bottom-bar in @media print display: none
  assert.match(appCss, /@media\s+print\s*\{[^}]*\.canvas-bottom-bar/, 'app.css @media print must suppress .canvas-bottom-bar');
});

test('Feature 3: Export dropdown has all buttons wired with answer key sheet generator', () => {
  const indexHtml = fs.readFileSync(path.join(rootDir, 'builder/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // All export buttons present in HTML
  assert.ok(indexHtml.includes('id="dl-package"'), 'dl-package exists');
  assert.ok(indexHtml.includes('id="dl-svg"'), 'dl-svg exists');
  assert.ok(indexHtml.includes('id="dl-html"'), 'dl-html exists');
  assert.ok(indexHtml.includes('id="dl-key-sheet-html"'), 'dl-key-sheet-html exists');
  assert.ok(indexHtml.includes('id="dl-key-sheet-svg"'), 'dl-key-sheet-svg exists');
  assert.ok(indexHtml.includes('id="dl-layout"'), 'dl-layout exists');
  assert.ok(indexHtml.includes('id="dl-template"'), 'dl-template exists');

  // All buttons wired in app.js
  assert.ok(appJs.includes("keySheetHtml: $('#dl-key-sheet-html')"), 'keySheetHtml mapped in els.buttons');
  assert.ok(appJs.includes("keySheetSvg: $('#dl-key-sheet-svg')"), 'keySheetSvg mapped in els.buttons');
  assert.ok(appJs.includes('generateKeySheetSVG'), 'generateKeySheetSVG helper defined');
  assert.ok(appJs.includes('generateKeySheetHTML'), 'generateKeySheetHTML helper defined');
  assert.ok(appJs.includes('DEFAULT_SHEET_CSS'), 'DEFAULT_SHEET_CSS fallback defined');

  // Auto-close dropdown on click
  assert.match(appJs, /els\.exportMenu\?\.addEventListener\('click'/, 'Dropdown auto-closes when item clicked');
});

test('Feature 4: Checker Studio progress saving, resume banner, and state restoration', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // Verify UI elements exist
  assert.ok(checkerHtml.includes('id="btn-save-progress"'), 'btn-save-progress exists in header');
  assert.ok(checkerHtml.includes('id="btn-resume-progress"'), 'btn-resume-progress exists in header');
  assert.ok(checkerHtml.includes('id="input-progress-file"'), 'input-progress-file exists');
  assert.ok(checkerHtml.includes('id="banner-resume-session"'), 'banner-resume-session banner exists');
  assert.ok(checkerHtml.includes('id="btn-results-save-progress"'), 'btn-results-save-progress exists');

  // Verify functions are implemented and exported to window
  assert.ok(checkerHtml.includes('function serializeProgressSession()'), 'serializeProgressSession defined');
  assert.ok(checkerHtml.includes('function saveCheckerProgress('), 'saveCheckerProgress defined');
  assert.ok(checkerHtml.includes('function restoreCheckerProgress('), 'restoreCheckerProgress defined');
  assert.ok(checkerHtml.includes('function checkAutoSavedProgress()'), 'checkAutoSavedProgress defined');
  assert.ok(checkerHtml.includes('window.saveCheckerProgress = saveCheckerProgress;'), 'saveCheckerProgress exported to window');
  assert.ok(checkerHtml.includes('window.restoreCheckerProgress = restoreCheckerProgress;'), 'restoreCheckerProgress exported to window');

  // Verify auto-save calls on grading and manual review resolutions
  assert.match(checkerHtml, /renderResults\(\);\s*saveCheckerProgress\(/, 'Auto-saves after batch grading finishes');
  assert.match(checkerHtml, /resolveReviewFlag[\s\S]*?saveCheckerProgress\(/, 'Auto-saves when flag is resolved');
  assert.match(checkerHtml, /reopenReviewFlag[\s\S]*?saveCheckerProgress\(/, 'Auto-saves when flag is reopened');
});
