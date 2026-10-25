import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('1. OMR Bubble Vision: Canonical rectCanvas, clear white annulus, and relative contrast disambiguation', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Must sample from canonical rectCanvas so sag correction, midline registration, and homography are baked in
  assert.ok(checkerHtml.includes('rectCanvas.getContext('), 'rectCanvas context retrieved for canonical bubble sampling');
  assert.ok(checkerHtml.includes('rectCtx.getImageData(0, 0, targetW, targetH)'), 'processExamScan pulls pixels from canonical rectified canvas');

  // Clean paper annulus background geometry (strictly outside the printed circle and letter glyph)
  assert.ok(checkerHtml.includes('const sampleR = Math.max(3, Math.round(rad * 0.65));'), 'Inner fill sampling radius avoids outer stroke border');
  assert.ok(checkerHtml.includes('const innerBgR = Math.round(rad + 1.2);'), 'Inner annulus background radius sits cleanly outside printed stroke');
  assert.ok(checkerHtml.includes('const outerBgR = Math.round(rad * 1.45);'), 'Outer annulus background radius samples pure white paper');

  // Relative contrast disambiguation (eliminates false positives on unshaded letters with slight darkness)
  assert.ok(checkerHtml.includes('top.fillDensity - second.fillDensity'), 'Relative fill density difference checked between candidates');
  assert.ok(checkerHtml.includes('margin >= 0.12'), 'Contrast margin 0.12 checked to resolve dominant pencil shade over faint printed strokes');

  // Master key scan decoder also updated with canonical rectCanvas and clean annulus
  assert.ok(checkerHtml.includes('const rectCtx = rectCanvas.getContext ? rectCanvas.getContext(\'2d\') : null;'), 'decodeMasterKeyFromScan uses canonical rectCanvas');
});

test('2. Collapsible Left Sidebar: Toggle button, expand pill, and state persistence', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // DOM Elements
  assert.ok(checkerHtml.includes('id="btn-toggle-sidebar"'), 'btn-toggle-sidebar exists in sidebar header');
  assert.ok(checkerHtml.includes('id="btn-expand-sidebar"'), 'btn-expand-sidebar exists as floating expand pill');
  assert.ok(checkerHtml.includes('class="sidebar-expand-pill"'), 'sidebar-expand-pill CSS class present in DOM');

  // CSS for collapsing
  assert.ok(checkerHtml.includes('.is-sidebar-collapsed'), 'CSS selector for collapsed sidebar state present');
  assert.ok(checkerHtml.includes('grid-template-columns: 0px 1fr'), 'Workspace grid updates to collapse sidebar to 0px');
  assert.ok(checkerHtml.includes('transform: translateX(-100%)'), 'Sidebar slides out smoothly off canvas');

  // JS handler and localStorage persistence
  assert.ok(checkerHtml.includes('function toggleSidebar('), 'toggleSidebar function defined');
  assert.ok(checkerHtml.includes('localStorage.getItem(\'checker_sidebar_collapsed\')'), 'Reads collapsed preference from localStorage');
  assert.ok(checkerHtml.includes('localStorage.setItem(\'checker_sidebar_collapsed\''), 'Persists collapsed preference to localStorage');
  assert.ok(checkerHtml.includes('window.toggleSidebar = toggleSidebar;'), 'toggleSidebar exposed on window');
});

test('3. Relocation of Persistent Export Bar & Header Ribbon Export Dropdown', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Export bar relocated from top of all tabs into Tab 1 (tab-summary)
  const tabSummaryIdx = checkerHtml.indexOf('id="tab-summary"');
  const exportBarIdx = checkerHtml.indexOf('id="results-export-bar"');
  const tabRosterIdx = checkerHtml.indexOf('id="tab-roster"');

  assert.ok(tabSummaryIdx > 0, 'tab-summary exists');
  assert.ok(exportBarIdx > tabSummaryIdx, 'results-export-bar is located inside tab-summary');
  assert.ok(exportBarIdx < tabRosterIdx, 'results-export-bar does not precede or span over other tabs');

  // Export options available inside relocated export bar
  assert.ok(checkerHtml.includes('id="btn-results-export-zip"'), 'btn-results-export-zip in export bar');
  assert.ok(checkerHtml.includes('id="btn-results-export-csv"'), 'btn-results-export-csv in export bar');
  assert.ok(checkerHtml.includes('id="btn-results-export-html"'), 'btn-results-export-html in export bar');
  assert.ok(checkerHtml.includes('id="btn-results-save-progress"'), 'btn-results-save-progress in export bar');

  // Header ribbon export dropdown wired with matching action handlers
  assert.ok(checkerHtml.includes('id="btn-ribbon-export-zip"'), 'btn-ribbon-export-zip in ribbon');
  assert.ok(checkerHtml.includes('id="btn-ribbon-export-csv"'), 'btn-ribbon-export-csv in ribbon');
  assert.ok(checkerHtml.includes('id="btn-ribbon-export-html"'), 'btn-ribbon-export-html in ribbon');
});

test('4. Table Viewport Clamping: Max-height constraints, sticky headers, and pinned Sheet Inspector', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Clamped table container height so long roster and psychometric tables do not extend infinitely
  assert.ok(checkerHtml.includes('max-height: min(65vh, 620px)'), 'Table container clamped with max-height: min(65vh, 620px)');
  assert.ok(checkerHtml.includes('max-height: calc(100vh - 210px)'), 'Roster table column clamped with max-height: calc(100vh - 210px)');

  // Sticky table header
  assert.ok(checkerHtml.includes('position: sticky') && checkerHtml.includes('top: 0'), 'Sticky table headers configured');

  // Pinned Sheet Inspector canvas
  assert.ok(checkerHtml.includes('position: sticky') && checkerHtml.includes('top: 1rem'), 'Sheet inspector pinned with sticky top: 1rem');
});

test('5. Session Persistence: Automatic progress restore across page switches', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Writes to checker_progress_session
  assert.ok(checkerHtml.includes('localStorage.setItem(\'checker_progress_session\','), 'saveCheckerProgress writes to checker_progress_session');

  // Clears checker_progress_session on clearWorkspace
  assert.ok(checkerHtml.includes('localStorage.removeItem(\'checker_progress_session\');'), 'clearWorkspace purges checker_progress_session');

  // checkAutoSavedProgress reads checker_progress_session and auto-restores
  assert.ok(checkerHtml.includes('localStorage.getItem(\'checker_progress_session\')'), 'checkAutoSavedProgress checks checker_progress_session');
  assert.ok(checkerHtml.includes('await restoreCheckerProgress(saved, { silent: true });'), 'auto-restores saved progress silently on return');

  // initCheckerStudio boots and is exposed
  assert.ok(checkerHtml.includes('window.initCheckerStudio = initCheckerStudio;'), 'initCheckerStudio exposed');
  assert.ok(checkerHtml.includes('initCheckerStudio();'), 'initCheckerStudio runs on page load');
});

test('6. Harmonized Ribbons & Design System: Button sizing, active micro-interactions, and header actions', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');
  const appCss = await readFile(resolve(root, 'builder/css/app.css'), 'utf8');
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Uniform .btn--sm sizing & typography across all 3 portals
  assert.ok(homeHtml.includes('padding: 0.32rem 0.6rem;'), 'home.html has standardized btn--sm padding');
  assert.ok(homeHtml.includes('letter-spacing: -0.02em;'), 'home.html has standardized btn--sm letter-spacing');

  assert.ok(appCss.includes('padding: 0.32rem 0.6rem;'), 'app.css has standardized btn--sm padding');
  assert.ok(appCss.includes('letter-spacing: -0.02em;'), 'app.css has standardized btn--sm letter-spacing');

  assert.ok(checkerHtml.includes('padding: 0.32rem 0.6rem;'), 'checker.html has standardized btn--sm padding');
  assert.ok(checkerHtml.includes('letter-spacing: -0.02em;'), 'checker.html has standardized btn--sm letter-spacing');

  // Tactile micro-interaction: translateY(1px) on .btn:active
  assert.ok(homeHtml.includes('transform: translateY(1px);'), 'home.html btn:active transform');
  assert.ok(appCss.includes('transform: translateY(1px);'), 'app.css btn:active transform');
  assert.ok(checkerHtml.includes('transform: translateY(1px);'), 'checker.html btn:active transform');

  // app-header__actions class in home.html, index.html, checker.html
  assert.ok(homeHtml.includes('app-header__actions'), 'home.html has app-header__actions');
  assert.ok(checkerHtml.includes('app-header__actions'), 'checker.html has app-header__actions');
});
