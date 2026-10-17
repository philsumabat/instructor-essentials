import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Desktop App: Sheet Builder index.html preserves 100% of rich capabilities and macOS styling', async () => {
  const htmlPath = resolve(root, 'apps/desktop/ui/index.html');
  const html = await readFile(htmlPath, 'utf8');

  // 1. macOS titlebar & segmented navigation
  assert.ok(html.includes('data-tauri-drag-region'), 'index.html titlebar must have data-tauri-drag-region');
  assert.ok(html.includes('id="nav-btn-builder"'), 'index.html has builder nav button');
  assert.ok(html.includes('id="nav-btn-checker"'), 'index.html has checker nav button');
  assert.ok(html.includes('id="nav-btn-speed"'), 'index.html has speed grader nav button');
  assert.ok(html.includes('desktop.css'), 'index.html links to desktop.css');
  assert.ok(html.includes('desktop.js'), 'index.html loads desktop.js');

  // 2. All canonical templates inlined
  assert.ok(html.includes('bio101-midterm-50'), 'exam-50 template inlined');
  assert.ok(html.includes('chem201-final-100'), 'exam-100 template inlined');
  assert.ok(html.includes('hist110-quiz-tf'), 'quiz-tf template inlined');
  assert.ok(html.includes('quiz-bonus'), 'quiz-bonus template inlined');

  // 3. Millimeter Layout Engine & Renderers
  assert.ok(html.includes('function buildLayout(') || html.includes('const LayoutEngine'), 'Layout engine present');
  assert.ok(html.includes('function renderSheetDOM(') || html.includes('const RenderDOM'), 'DOM renderer present');
  assert.ok(html.includes('function renderSVG(') || html.includes('const RenderSVG'), 'SVG renderer present');
  assert.ok(html.includes('function generateArucoMarker(') || html.includes('const Aruco'), 'ArUco generator present');

  // 4. Modals and Inspector Controls
  assert.ok(html.includes('id="modal-generator"'), 'Exam Generator modal present');
  assert.ok(html.includes('id="modal-library"'), 'Saved Builds modal present');
  assert.ok(html.includes('id="modal-answer-key"'), 'Answer Key Editor modal present');
  assert.ok(html.includes('id="btn-print"'), 'Print Sheet button present');
  assert.ok(html.includes('id="dl-package"'), 'Exam Package export present');

  // 5. Decision 35 Canvas Interactivity & Stepper Robustness Parity
  assert.ok(html.includes('syncZoneRangeInLabel'), 'index.html has syncZoneRangeInLabel');
  assert.ok(html.includes('selectZoneNonDestructive'), 'index.html has non-destructive title selection');
  assert.ok(html.includes('maxBoxW'), 'index.html calculates maxBoxW');

  // 6. Script compilation check (no syntax errors)
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Inlined script must be present');
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1]);
  }, 'Sheet Builder inlined script must compile cleanly');
});

test('Desktop App: Checker Studio checker.html preserves 100% of CV and psychometrics capabilities', async () => {
  const htmlPath = resolve(root, 'apps/desktop/ui/checker.html');
  const html = await readFile(htmlPath, 'utf8');

  // 1. macOS titlebar & segmented navigation
  assert.ok(html.includes('data-tauri-drag-region'), 'checker.html titlebar must have data-tauri-drag-region');
  assert.ok(html.includes('id="nav-btn-builder"'), 'checker.html has builder nav button');
  assert.ok(html.includes('id="nav-btn-checker"'), 'checker.html has checker nav button');
  assert.ok(html.includes('id="nav-btn-speed"'), 'checker.html has speed grader nav button');
  assert.ok(html.includes('desktop.css'), 'checker.html links to desktop.css');
  assert.ok(html.includes('desktop.js'), 'checker.html loads desktop.js');

  // 2. Computer Vision Pipeline (ArUco, Homography, Bubble density)
  assert.ok(html.includes('detectCornerMarkers'), 'ArUco corner detector present');
  assert.ok(html.includes('computeHomography'), 'Homography rectification present');
  assert.ok(html.includes('evalDensity') || html.includes('processExamScan'), 'Bubble density sampler present');

  // 3. Master-Detail Roster Table & Sheet Inspector Side Preview Pane
  assert.ok(html.includes('id="roster-preview-canvas"'), 'Live sheet preview canvas present');
  assert.ok(html.includes('id="tbody-roster"'), 'Grades table body present');

  // 4. Filterable Review Queue & Audit Resolution
  assert.ok(html.includes('resolveReviewFlag'), 'Resolve review flag logic present');
  assert.ok(html.includes('summary-review-callout'), 'Summary review callout present');

  // 5. SVG Bell Curve & Distribution Histogram
  assert.ok(html.includes('generateBellCurveSVG') || html.includes('dist-bell-curve-container'), 'Bell curve distribution present');

  // 6. Horizontal Blind Grading (Flashcard Deck Mode)
  assert.ok(html.includes('id="horizontal-flashcard-deck"'), 'Flashcard deck workspace present');
  assert.ok(html.includes('navigateFlashcard'), 'Flashcard navigation present');
  assert.ok(html.includes('flashcardGradeAction'), 'Flashcard grade actions present');

  // 7. Cross-tool active Sheet Builder draft detection
  assert.ok(html.includes('active-working-build'), 'checker.html detects active Sheet Builder draft');

  // 8. Script compilation check
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Inlined script must be present');
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1]);
  }, 'Checker Studio inlined script must compile cleanly');
});

test('Desktop App: desktop.css provides clean macOS titlebar and progressive disclosure', async () => {
  const cssPath = resolve(root, 'apps/desktop/ui/desktop.css');
  const css = await readFile(cssPath, 'utf8');

  // Traffic lights clearance (84px left padding)
  assert.ok(css.includes('84px'), 'desktop.css must include 84px traffic light clearance');
  assert.ok(css.includes('app-region: drag') || css.includes('-webkit-app-region: drag'), 'desktop.css has drag region');
  assert.ok(css.includes('app-region: no-drag') || css.includes('-webkit-app-region: no-drag'), 'desktop.css has no-drag on interactive elements');
  assert.ok(css.includes('.window-titlebar') || css.includes('header.app-header'), 'desktop.css titlebar rule covers window-titlebar selector');

  // Segmented control pill styles
  assert.ok(css.includes('.segmented-control'), 'desktop.css styles segmented control');
  assert.ok(css.includes('.seg-btn'), 'desktop.css styles segmented buttons');

  // Dark mode support
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'), 'desktop.css provides dark mode support');
});

test('Desktop App: desktop.js provides view switching, speed grader deep linking, and Tauri Rust bridge', async () => {
  const jsPath = resolve(root, 'apps/desktop/ui/desktop.js');
  const js = await readFile(jsPath, 'utf8');

  // View switcher function
  assert.ok(js.includes('switchView'), 'desktop.js defines switchView');
  assert.ok(js.includes("switchTab('horizontal')"), 'desktop.js handles speed view via switchTab');
  assert.ok(js.includes('invokeRustGrader') || js.includes('grade_scans'), 'desktop.js bridges to Tauri Rust engine');
  assert.ok(js.includes('dragover') && js.includes('drop'), 'desktop.js handles drag and drop');
  assert.ok(js.includes('template-file-input'), 'desktop.js forwards dropped json on builder page');
  assert.ok(js.includes('keydown'), 'desktop.js handles keyboard shortcuts');

  // Script compiles with zero syntax errors
  assert.doesNotThrow(() => {
    new vm.Script(js);
  }, 'desktop.js must compile cleanly');
});

test('Desktop App: apps/desktop/ui/js/ assets match builder/js/ modular source files', async () => {
  const jsFiles = ['app.js', 'layout-engine.js', 'render-dom.js', 'render-svg.js', 'templates.js', 'aruco.js'];
  for (const f of jsFiles) {
    const src = await readFile(resolve(root, 'builder/js', f), 'utf8');
    const dest = await readFile(resolve(root, 'apps/desktop/ui/js', f), 'utf8');
    assert.equal(dest, src, `apps/desktop/ui/js/${f} must match builder/js/${f}`);
  }
});
