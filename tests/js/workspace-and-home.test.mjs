import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Checker Studio: Clear Workspace and Clear Roster UI & State Logic', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Verify New Session and Roster controls exist in DOM
  assert.ok(checkerHtml.includes('id="btn-clear-workspace"'), 'New Session (clear workspace) button present');
  assert.ok(checkerHtml.includes('id="nav-btn-home"'), 'Home portal navigation link present');
  assert.ok(checkerHtml.includes('id="btn-clear-roster"'), 'Explicit Remove Roster button present in #tab-roster');
  assert.ok(checkerHtml.includes('id="btn-upload-roster-csv"'), 'Upload Roster CSV button present');
  assert.ok(checkerHtml.includes('id="input-roster-file"'), 'File input for student roster present');
  assert.ok(checkerHtml.includes('id="roster-active-badge"'), 'Active roster count badge present in tab toolbar');

  // 2. Verify Bubble Mark Threshold stepper is removed from DOM
  assert.ok(!checkerHtml.includes('id="input-bubble-threshold"'), 'input-bubble-threshold removed from DOM');
  assert.ok(!checkerHtml.includes('id="btn-bthresh-dec"'), 'btn-bthresh-dec removed from DOM');
  assert.ok(!checkerHtml.includes('id="btn-bthresh-inc"'), 'btn-bthresh-inc removed from DOM');

  // 3. Verify robust built-in default 0.20 bubble threshold is retained
  assert.ok(checkerHtml.includes('const bubbleThreshold = 0.20;'), 'Grading routine uses fixed 0.20 bubble threshold');

  // 4. Verify clearWorkspace function implementation and window export
  assert.ok(checkerHtml.includes('function clearWorkspace('), 'clearWorkspace function defined');
  assert.ok(checkerHtml.includes('window.clearWorkspace = clearWorkspace;'), 'clearWorkspace exported to window');

  // 5. Test clearWorkspace logic in isolated VM sandbox
  const mockStorage = {
    'instructor_checker_progress_v1': JSON.stringify({ grades: [{ studentId: '123' }] })
  };
  const mockElements = {
    'input-scans': { value: 'file.jpg' },
    'input-key-scan': { value: 'key.jpg' },
    'input-layout-direct': { value: 'layout.json' },
    'input-roster-file': { value: 'roster.csv' },
    'input-progress-file': { value: 'prog.json' },
    'scans-list': { innerHTML: 'files' },
    'badge-save-status': { style: {} },
    'checker-empty-state': { style: {} },
    'results-export-bar': { style: {} },
    'tbody-roster': { innerHTML: 'rows' },
    'roster-total-count': { textContent: '5 students' },
    'roster-count-badge': { textContent: '5 students' },
    'count-roster-all': { textContent: '(5)' },
    'count-roster-review': { textContent: '(1)' },
    'count-roster-duplicates': { textContent: '(0)' },
    'count-roster-clean': { textContent: '(4)' },
    'tab-roster-empty': { style: {} },
    'card-roster-status': { style: {} },
    'roster-active-badge': { style: {} },
    'btn-clear-roster': { style: {} },
    'metric-count': { textContent: '5' },
    'metric-mean': { textContent: '45.0' },
    'metric-passrate': { textContent: '80%' },
    'dist-bar-pass': { style: { width: '80%' } },
    'dist-bar-fail': { style: { width: '20%' } },
    'dist-label-pass': { textContent: 'Pass: 4' },
    'dist-label-fail': { textContent: 'Fail: 1' },
    'dist-label-threshold': { textContent: 'Threshold: 60%' },
    'tbody-summary': { innerHTML: 'rows' },
    'tbody-items': { innerHTML: 'rows' },
    'tbody-top-students': { innerHTML: 'rows' },
    'student-badge-current': { textContent: 'Alice (2026-001)' },
    'roster-preview-canvas': { getContext: () => ({ clearRect: () => {} }), width: 840, height: 1188 },
    'btn-export-csv': { disabled: false },
    'btn-export-zip': { disabled: false },
    'btn-results-export-zip': { disabled: false },
    'btn-results-export-csv': { disabled: false },
    'viewer-student-select': { innerHTML: '<option value="0">Alice</option>' }
  };

  let removedClass = null;
  const mockWindow = {
    state: {
      scans: [{ name: 'scan1.png' }],
      roster: [{ studentId: '2026-001', studentName: 'Alice' }],
      key: { answers: { 1: ['A'] } },
      layout: { title: 'Exam' },
      results: { grades: [{ studentId: '2026-001', rawId: '2026-001', studentName: 'Alice', rawScore: 50, percentage: 100 }] },
      reviewQueue: [{ scanIndex: 0 }],
      selectedStudentIdx: 0,
      selectedStudentIndex: 0,
      activePresetId: 'exam-50'
    },
    $: (id) => mockElements[id] || { style: {}, querySelector: () => null },
    localStorage: {
      getItem: (k) => mockStorage[k],
      setItem: (k, v) => { mockStorage[k] = v; },
      removeItem: (k) => { delete mockStorage[k]; }
    },
    PROGRESS_STORAGE_KEY: 'instructor_checker_progress_v1',
    updateLayoutDisplay: () => {},
    updateKeyDisplay: () => {},
    updateRosterDisplay: () => {},
    updateResumeStatusUI: () => {},
    updateSaveStatusUI: () => {},
    renderBellCurve: () => {},
    showToast: () => {},
    switchTab: () => {},
    document: {
      querySelector: (sel) => ({
        classList: {
          remove: (c) => { removedClass = c; }
        }
      }),
      body: { classList: { remove: () => {} } }
    }
  };
  mockWindow.window = mockWindow;

  // Extract clearWorkspace code from checkerHtml
  const clearFnMatch = checkerHtml.match(/function clearWorkspace\(\{ silent = false \}[^}]*?\{[\s\S]*?window\.clearWorkspace = clearWorkspace;/);
  assert.ok(clearFnMatch, 'clearWorkspace function found in checkerHtml');

  const context = vm.createContext(mockWindow);
  vm.runInContext(clearFnMatch[0], context);

  // Invoke clearWorkspace in VM
  context.clearWorkspace({ silent: true });

  assert.equal(context.state.scans.length, 0, 'state.scans purged');
  assert.equal(context.state.roster.length, 0, 'state.roster purged');
  assert.equal(context.state.key, null, 'state.key reset to null');
  assert.equal(context.state.layout, null, 'state.layout reset to null');
  assert.equal(context.state.results, null, 'state.results reset to null');
  assert.equal(context.state.reviewQueue.length, 0, 'state.reviewQueue purged');
  assert.equal(context.state.selectedStudentIdx, null, 'state.selectedStudentIdx reset to null');
  assert.equal(mockStorage['instructor_checker_progress_v1'], undefined, 'localStorage progress purged');

  // Verify DOM metric resets
  assert.equal(mockElements['metric-count'].textContent, '0', 'metric-count reset to 0');
  assert.equal(mockElements['metric-mean'].textContent, '0.0', 'metric-mean reset to 0.0');
  assert.equal(mockElements['metric-passrate'].textContent, '0.0%', 'metric-passrate reset to 0.0%');
  assert.ok(mockElements['tbody-summary'].innerHTML.includes('No student grades available'), 'tbody-summary reset');
  assert.ok(mockElements['tbody-items'].innerHTML.includes('No item analysis available'), 'tbody-items reset');
  assert.equal(mockElements['student-badge-current'].textContent, 'No Student Selected', 'student badge reset');
  assert.equal(mockElements['btn-export-csv'].disabled, true, 'btn-export-csv disabled');
  assert.equal(mockElements['btn-export-zip'].disabled, true, 'btn-export-zip disabled');
  assert.equal(removedClass, 'has-data', 'Removed has-data from DOM on clear');

  // 6. Verify ensureActiveLayout does NOT inject SAMPLE_ROSTER
  const ensureLayoutMatch = checkerHtml.match(/function ensureActiveLayout\(\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(ensureLayoutMatch, 'ensureActiveLayout function found');
  assert.ok(!ensureLayoutMatch[1].includes('SAMPLE_ROSTER'), 'ensureActiveLayout must NOT silently inject SAMPLE_ROSTER');

  // 7. Verify btn-clear-roster resets input-roster-file value
  assert.ok(checkerHtml.includes("if (rosterInput) rosterInput.value = '';"), 'btn-clear-roster clears input-roster-file value');
});

test('Sheet Builder: New Sheet Workspace Clearing and Shared Google Auth', async () => {
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const appJs = await readFile(resolve(root, 'builder/js/app.js'), 'utf8');

  // 1. Verify New Sheet button and Home link exist in header
  assert.ok(indexHtml.includes('id="btn-new-sheet"'), 'New Sheet button present in builder header');
  assert.ok(indexHtml.includes('id="nav-btn-home"'), 'Home portal link present in builder header');

  // 2. Verify clearSheetWorkspace function implementation
  assert.ok(appJs.includes('async function clearSheetWorkspace('), 'clearSheetWorkspace defined');
  assert.ok(appJs.includes('window.clearSheetWorkspace = clearSheetWorkspace;'), 'clearSheetWorkspace exported to window');

  // 3. Verify shared Google auth restore and token persistence in appJs
  assert.ok(appJs.includes('restoreGoogleAuthState()'), 'restoreGoogleAuthState called on init');
  assert.ok(appJs.includes("localStorage.getItem('instructor_google_token')"), 'Reads shared Google token from localStorage');
  assert.ok(appJs.includes("localStorage.setItem('instructor_google_token'"), 'Writes shared Google token to localStorage');
  assert.ok(appJs.includes("localStorage.removeItem('instructor_google_token')"), 'Cleans up shared Google token on logout');

  // 4. Verify cross-tab logout clears in-memory state in appJs
  assert.ok(appJs.includes('googleDriveState.accessToken = null;'), 'Clears accessToken on logout/expiry');
  assert.ok(appJs.includes('googleDriveState.isConnected = false;'), 'Clears isConnected on logout/expiry');
});

test('Unified Home Portal: home.html structure, single Google login, and tool launchers', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');
  const docsHome = await readFile(resolve(root, 'docs/home.html'), 'utf8');
  const desktopHome = await readFile(resolve(root, 'apps/desktop/ui/home.html'), 'utf8');

  // 1. Verify synchronization across builder, docs, and desktop UI
  assert.equal(docsHome, homeHtml, 'docs/home.html must match builder/home.html');
  assert.ok(desktopHome.includes('nav-btn-home'), 'apps/desktop/ui/home.html has nav-btn-home');
  assert.ok(desktopHome.includes('desktop.js'), 'apps/desktop/ui/home.html includes desktop.js');

  // 2. Verify Single Google Sign-In elements
  assert.ok(homeHtml.includes('id="btn-google-login"'), 'Google login button present');
  assert.ok(homeHtml.includes('id="btn-google-logout"'), 'Google logout button present');
  assert.ok(homeHtml.includes('id="google-connected-view"'), 'Google profile connected view present');
  assert.ok(homeHtml.includes('id="user-avatar-img"'), 'Google avatar image present');
  assert.ok(homeHtml.includes('id="user-display-name"'), 'Google user name element present');

  // 3. Verify Tool Launcher cards
  assert.ok(homeHtml.includes('Sheet Builder'), 'Sheet Builder launcher card present');
  assert.ok(homeHtml.includes('Checker Studio'), 'Checker Studio launcher card present');
  assert.ok(homeHtml.includes('New Exam Session'), 'New Exam Session sub-action present');
  assert.ok(homeHtml.includes('Quick Generator'), 'Quick Generator sub-action present');

  // 4. Verify Active Session Card and Saved Builds List
  assert.ok(homeHtml.includes('id="box-active-session"'), 'Active grading session card present');
  assert.ok(homeHtml.includes('id="saved-builds-container"'), 'Saved builds library list container present');
  assert.ok(homeHtml.includes('id="btn-clear-all-workspaces"'), 'Clear all workspaces button present');

  // 5. Verify Script compiles cleanly
  const scriptMatch = homeHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'home.html has embedded script');
  assert.doesNotThrow(() => {
    new vm.Script(scriptMatch[1]);
  }, 'home.html script compiles without syntax errors');
});

test('Button Design System: Danger, Ghost, and Micro-Interaction styles', async () => {
  const appCss = await readFile(resolve(root, 'builder/css/app.css'), 'utf8');
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Danger button tokens and states
  assert.ok(appCss.includes('.btn--danger') || appCss.includes('.btn.is-danger'), 'app.css styles danger button');
  assert.ok(appCss.includes('--danger'), 'Danger token defined in app.css');
  assert.ok(checkerHtml.includes('.btn--danger') || checkerHtml.includes('.btn.is-danger'), 'checker.html styles danger button');

  // Ghost button styles
  assert.ok(appCss.includes('.btn--ghost'), 'Ghost button styled in app.css');
  assert.ok(checkerHtml.includes('.btn--ghost'), 'Ghost button styled in checker.html');

  // Micro-interactions (:active transform translateY)
  assert.ok(appCss.includes('transform: translateY(1px)') || appCss.includes('translateY'), 'Button active micro-interaction present in app.css');
  assert.ok(checkerHtml.includes('transform: translateY(1px)') || checkerHtml.includes('translateY'), 'Button active micro-interaction present in checker.html');
});
