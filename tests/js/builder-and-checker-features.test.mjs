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

test('Feature 2b: Modified T/F correction hint print suppression and geometry preservation', () => {
  const sheetCss = fs.readFileSync(path.join(rootDir, 'builder/css/sheet.css'), 'utf8');
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');
  const renderDomJs = fs.readFileSync(path.join(rootDir, 'builder/js/render-dom.js'), 'utf8');
  const renderSvgJs = fs.readFileSync(path.join(rootDir, 'builder/js/render-svg.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // 1. render-dom wraps hint in .omr-correction-hint and .app-chrome inside .omr-correction-box
  assert.match(
    renderDomJs,
    /h\('span',\s*\{\s*class:\s*'omr-correction-hint app-chrome'\s*\},\s*'if false: correction'\)/,
    'render-dom.js must wrap hint in omr-correction-hint app-chrome span'
  );

  // 2. sheet.css suppresses hint and sets correction box color transparent in @media print
  assert.match(sheetCss, /\.omr-correction-box\s*\{[^}]*border:\s*0\.25mm\s+solid\s+#000/, 'sheet.css preserves 0.25mm border on correction box');
  assert.match(sheetCss, /@media\s+print\s*\{[\s\S]*?\.omr-correction-hint\s*\{[\s\S]*?display:\s*none\s*!important/, 'sheet.css hides hint in @media print');
  assert.match(sheetCss, /@media\s+print\s*\{[\s\S]*?\.omr-correction-box\s*\{[\s\S]*?color:\s*transparent\s*!important/, 'sheet.css transparentizes text in @media print');

  // 3. app.css print isolation suppresses .omr-correction-hint and sets .omr-correction-box color transparent
  assert.match(appCss, /@media\s+print\s*\{[\s\S]*?\.omr-correction-hint/, 'app.css @media print includes .omr-correction-hint');
  assert.match(appCss, /@media\s+print\s*\{[\s\S]*?\.omr-correction-box\s*\{[\s\S]*?color:\s*transparent\s*!important/, 'app.css @media print transparentizes .omr-correction-box');

  // 4. app.js DEFAULT_SHEET_CSS fallback mirrors print suppression rules
  assert.match(appJs, /DEFAULT_SHEET_CSS[\s\S]*?\.omr-correction-hint\s*\{\s*display:\s*none\s*!important/, 'DEFAULT_SHEET_CSS includes print suppression for hint');
  assert.match(appJs, /DEFAULT_SHEET_CSS[\s\S]*?\.omr-correction-box\s*\{\s*color:\s*transparent\s*!important/, 'DEFAULT_SHEET_CSS includes color transparent for box');

  // 5. render-svg modified_tf renders purely vector bounding rect with zero hint text
  assert.doesNotMatch(renderSvgJs, /if false:\s*correction/, 'render-svg.js must not output any placeholder text');
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
  assert.ok(!checkerHtml.includes('id="banner-resume-session"'), 'banner-resume-session banner eliminated');
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

test('Feature 5: Flexible box height down to 3mm without stepper clamping or duplicate listeners', () => {
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // Verify inputs in appJs allow min="3"
  assert.match(appJs, /id="insp-box-height"[^>]*min="3"/, 'insp-box-height input should have min="3"');
  assert.match(appJs, /id="insp-corr-height"[^>]*min="3"/, 'insp-corr-height input should have min="3"');

  // Verify bindStepper sets min to 3
  assert.match(appJs, /bindStepper\('insp-box-height'[\s\S]*?3,\s*120\)/, 'bindStepper for insp-box-height must use min 3');
  assert.match(appJs, /bindStepper\(\s*'insp-corr-height'[\s\S]*?3,\s*40\s*\)/, 'bindStepper for insp-corr-height must use min 3');

  // Verify NO duplicate bindStepper calls exist for insp-box-height
  const boxHeightMatches = appJs.match(/bindStepper\('insp-box-height'/g);
  assert.equal(boxHeightMatches ? boxHeightMatches.length : 0, 1, 'insp-box-height must be bound exactly once');

  // Verify layout engine builds with 3mm and 4mm box heights
  const tpl3mm = {
    id: 'test-3mm',
    title: '3mm Height Test',
    paper: 'A4',
    zones: [
      { id: 't1', type: 'text', label: '1.', boxHeight: 3, w: 80 },
      { id: 't2', type: 'text_short', label: 'Short', count: 2, boxHeight: 4, w: 80 },
      { id: 'm1', type: 'modified_tf', label: 'MTF', count: 2, boxHeight: 3, w: 80 },
    ],
  };
  const layout = buildLayout(tpl3mm);
  assert.ok(layout, 'Layout builds successfully with 3mm and 4mm boxes');
  const z1 = layout.zones.find(z => z.id === 't1');
  const z2 = layout.zones.find(z => z.id === 't2');
  const zm = layout.zones.find(z => z.id === 'm1');
  assert.equal(z1.rois[0].h, 3, 'Single text box height should be 3mm');
  assert.equal(z2.rois[0].h, 4, 'Text short box height should be 4mm');
  assert.equal(zm.rois[0].h, 3, 'Modified TF correction box height should be 3mm');
});

test('Feature 6: Uniform item number font size across all block types (MCQ, T/F, Short Answer, Essay)', () => {
  const sheetCss = fs.readFileSync(path.join(rootDir, 'builder/css/sheet.css'), 'utf8');
  const renderDomJs = fs.readFileSync(path.join(rootDir, 'builder/js/render-dom.js'), 'utf8');
  const renderSvgJs = fs.readFileSync(path.join(rootDir, 'builder/js/render-svg.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // sheet.css and DEFAULT_SHEET_CSS define .omr-item-num with var(--omr-font-number) !important
  assert.match(sheetCss, /\.omr-item-num\s*\{[\s\S]*?font-size:\s*var\(--omr-font-number\)\s*!important;/, 'sheet.css enforces uniform item number font size');
  assert.match(appJs, /\.omr-item-num\s*\{[\s\S]*?font-size:\s*var\(--omr-font-number\)\s*!important;/, 'app.js fallback sheet css enforces uniform item number font size');

  // render-dom.js applies omr-item-num to text zone labels and item numbers
  assert.match(renderDomJs, /omr-item-num/, 'render-dom.js attaches omr-item-num class');

  // render-svg.js uses typography.number for inline text item prompt numbers
  assert.match(renderSvgJs, /typography\.number/, 'render-svg.js uses typography.number for item number labels');
});

test('Feature 7: Bloom dropdown styling and Short Answer items in Answer Key Editor', () => {
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // App CSS constraints for Bloom select dropdown
  assert.match(appCss, /\.key-bloom-select\s*\{[\s\S]*?max-width:\s*82px;[\s\S]*?text-overflow:\s*ellipsis;/, 'app.css constrains bloom dropdown width');
  assert.match(checkerHtml, /\.key-bloom-select\s*\{[\s\S]*?max-width:\s*82px;[\s\S]*?text-overflow:\s*ellipsis;/, 'checker.html constrains bloom dropdown width');

  // Full-width short answer styling in Answer Key Editor
  assert.match(appCss, /\.key-item-cell--text\s*\{[\s\S]*?width:\s*100%;[\s\S]*?column-span:\s*all;/, 'app.css has full-width text item cell');
  assert.match(appCss, /\.key-text-items-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/, 'app.css has key-text-items-list container');
  assert.match(checkerHtml, /\.key-item-cell--text\s*\{[\s\S]*?width:\s*100%;[\s\S]*?column-span:\s*all;/, 'checker.html has full-width text item cell');
  assert.match(checkerHtml, /\.key-text-items-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/, 'checker.html has key-text-items-list container');

  // Answer Key modal separation of MCQ/TF matrix and short answer list
  assert.ok(checkerHtml.includes('key-matrix-grid'), 'checker.html separates choice items into key-matrix-grid');
  assert.ok(checkerHtml.includes('key-text-items-list'), 'checker.html renders short answer items into key-text-items-list');
});

test('Feature 8: Text essay and short answer controls (boxWidth, points, rowGap, start, section title)', () => {
  // 1. Single-item text_essay retains section title, generates numbered items, preserves boxWidth, rowGap, start, and points
  const essayTpl = {
    id: 'essay-test',
    title: 'Biology Final Exam',
    paper: 'A4',
    zones: [
      {
        id: 'essay-1',
        type: 'text_essay',
        label: 'Part III. Essay / Discussion',
        count: 1,
        start: 21,
        boxWidth: 165,
        boxHeight: 40,
        pointsPerItem: 10,
        rowGap: 5,
      },
      {
        id: 'sa-1',
        type: 'text_short',
        label: 'Part IV. Short Answer',
        count: 4,
        start: 22,
        columns: 2,
        boxWidth: 70,
        boxHeight: 12,
        pointsPerItem: 3,
        rowGap: 4,
      },
    ],
  };

  const layout = buildLayout(essayTpl);
  assert.ok(layout, 'buildLayout succeeds for essay and short answer blocks');

  // Verify essay zone properties
  const essayZone = layout.zones.find(z => z.id === 'essay-1');
  assert.equal(essayZone.label, 'Part III. Essay / Discussion', 'Single-item essay block preserves section title');
  assert.equal(essayZone.start, 21, 'Essay block preserves start question number');
  assert.equal(essayZone.pointsPerItem, 10, 'Essay block preserves points per item');
  assert.equal(essayZone.boxWidth, 165, 'Essay block preserves boxWidth');
  assert.equal(essayZone.rowGap, 5, 'Essay block preserves rowGap');
  assert.equal(essayZone.items.length, 1, 'Essay block has 1 item');
  assert.equal(essayZone.items[0].label, '21', 'Essay item has question label 21');
  assert.equal(essayZone.items[0].boxW, 165, 'Essay item boxW is 165mm');
  assert.equal(essayZone.items[0].boxH, 40, 'Essay item boxH is 40mm');

  // Verify short answer zone properties
  const saZone = layout.zones.find(z => z.id === 'sa-1');
  assert.equal(saZone.label, 'Part IV. Short Answer', 'Short answer preserves section title');
  assert.equal(saZone.start, 22, 'Short answer preserves start number');
  assert.equal(saZone.pointsPerItem, 3, 'Short answer preserves pointsPerItem');
  assert.equal(saZone.boxWidth, 70, 'Short answer preserves boxWidth');
  assert.equal(saZone.rowGap, 4, 'Short answer preserves rowGap');
  assert.equal(saZone.items.length, 4, 'Short answer has 4 items');
  assert.equal(saZone.items[0].label, '22', 'First short answer item starts at 22');
  assert.equal(saZone.items[3].label, '25', 'Fourth short answer item is 25');

  // 2. DOM Rendering: Section title, points badge, top-alignment for tall boxes
  const domHtml = renderStandaloneHTML(layout);
  assert.ok(domHtml.includes('Part III. Essay / Discussion'), 'DOM contains essay section title');
  assert.ok(domHtml.includes('(10 pts)'), 'DOM renders single-item essay points badge (10 pts)');
  assert.ok(domHtml.includes('(3 pts each)'), 'DOM renders multi-item short answer points badge (3 pts each)');
  assert.match(domHtml, /align-items:\s*flex-start/, 'DOM aligns question number at top for tall boxes (boxH > 15)');

  // 3. SVG Rendering: Section title, points badge, top-alignment
  const svgContent = renderSVG(layout);
  assert.ok(svgContent.includes('Part III. Essay / Discussion (10 pts)'), 'SVG renders full title with points suffix');
  assert.ok(svgContent.includes('Part IV. Short Answer (3 pts each)'), 'SVG renders short answer title with points suffix');

  // 4. app.js code verification: Section Title label, bindStepper live update, contenteditable paper editing
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');
  assert.match(appJs, /<label class="form-label" for="insp-label">Section Title<\/label>/, 'Inspector label standardized to Section Title');
  assert.match(appJs, /function syncZonePointsToAnswerKey\(/, 'syncZonePointsToAnswerKey helper defined in app.js');
  assert.match(appJs, /titleTextEl\.setAttribute\('contenteditable',\s*'true'\)/, 'DOM zone title is contenteditable on canvas');
  assert.match(appJs, /examTitleEl\.setAttribute\('contenteditable',\s*'true'\)/, 'DOM exam title is contenteditable on canvas');
  assert.match(appJs, /setter\(num,\s*skipInspector\)/, 'bindStepper passes skipInspector to prevent focus loss during live updates');
});

test('Feature 8b: Sheet Builder Inspector steppers and canvas title interaction mechanics', () => {
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // 1. Direct on-paper title editing does not destroy DOM on click (uses attachFloatingToolbar)
  assert.match(appJs, /function attachFloatingToolbar\(/, 'attachFloatingToolbar helper is defined');
  assert.match(appJs, /attachFloatingToolbar\(zEl,\s*idx\)/, 'Floating toolbar attached without full preview rerender');

  // 2. Direct on-paper title input preserves untrimmed spaces while typing
  assert.match(appJs, /zone\.label\s*=\s*titleTextEl\.textContent;/, 'Paper title input does not trim prematurely');
  assert.match(appJs, /state\.template\.title\s*=\s*examTitleEl\.textContent;/, 'Exam title input does not trim prematurely');

  // 3. Duplicate item key collision yields diagnostic warning rather than fatal TemplateError
  const collisionTpl = {
    id: 'col-test',
    title: 'Collision Test',
    paper: 'A4',
    zones: [
      { id: 'm1', type: 'mcq', count: 5, start: 1 },
      { id: 'm2', type: 'mcq', count: 5, start: 3 }, // Collides on questions 3, 4, 5
    ],
  };
  assert.doesNotThrow(() => {
    const res = buildLayout(collisionTpl);
    assert.ok(res.warnings.some((w) => w.includes('duplicates key')), 'Duplicate key produces diagnostic warning');
  }, 'buildLayout handles transient duplicate start numbers without throwing fatal exception');

  // 4. Stepper start number reads from computed layout start when zone.start is unset
  assert.match(appJs, /zone\.start\s*\?\?\s*state\.layout\?\.zones\?\.\[idx\]\?\.start/, 'Start stepper uses computed layout start fallback');

  // 5. Stepper box width getter reads from rendered box width instead of jumping
  assert.match(appJs, /state\.layout\?\.zones\?\.\[idx\]\?\.items\?\.\[0\]\?\.boxW/, 'Box width getter reads rendered item boxW');

  // 6. Stepper points per item updates embedded points badge in zone.label
  assert.match(appJs, /ptsPattern\s*=\s*\/\\\(.+?pts\?/, 'Points stepper recognizes embedded points badge pattern');
  assert.match(appJs, /zone\.label\.replace\(ptsPattern,\s*suffix\)/, 'Points stepper synchronizes embedded points badge in label');

  // 7. Stepper clicks preserve inspector DOM without destruction (skipInspector: true)
  assert.match(appJs, /minus\?\.addEventListener\('click',\s*\(\)\s*=>\s*clampAndSet\(getBaseVal\(\)\s*-\s*1,\s*true\)\)/, 'Minus stepper click passes skipInspector: true');
  assert.match(appJs, /plus\?\.addEventListener\('click',\s*\(\)\s*=>\s*clampAndSet\(getBaseVal\(\)\s*\+\s*1,\s*true\)\)/, 'Plus stepper click passes skipInspector: true');

  // 8. Range badge synchronization when start/count changes (e.g. 1-20 -> 21-40)
  assert.match(appJs, /function syncZoneRangeInLabel\(/, 'syncZoneRangeInLabel helper defined');
  assert.match(appJs, /syncZoneRangeInLabel\(zone,\s*idx\)/, 'syncZoneRangeInLabel invoked on start/count stepper changes');

  // 9. Layout engine exposes maxBoxW and inspector constrains stepper max
  const essayTpl = {
    id: 'boxw-tpl',
    paper: 'A4',
    zones: [
      { id: 'e1', type: 'text_essay', count: 1, start: 1 },
      { id: 's2', type: 'text_short', count: 4, columns: 2, start: 2 },
    ],
  };
  const layout = buildLayout(essayTpl);
  assert.ok(layout.zones[0].maxBoxW >= 170, 'Single-col essay exposes ~176mm maxBoxW');
  assert.ok(layout.zones[1].maxBoxW <= 90 && layout.zones[1].maxBoxW >= 80, 'Two-col short answer exposes ~83mm maxBoxW');
  assert.match(appJs, /maxBoxW\s*=\s*state\.layout\?\.zones\?\.\[idx\]\?\.maxBoxW/, 'Inspector reads layout maxBoxW for box width constraint');

  // 10. Canvas zone interaction queries top-level zone containers and delegates clicks for child write-boxes
  assert.match(appJs, /\.omr-zone\[data-zone-index\],\s*\.omr-instructions\[data-zone-index\]/, 'attachCanvasZoneInteractions queries top-level zone containers');
  assert.match(appJs, /e\.target\.closest\('\[data-zone-index\]'\)/, 'Delegated click on sheetEl resolves closest zone index element');
});

