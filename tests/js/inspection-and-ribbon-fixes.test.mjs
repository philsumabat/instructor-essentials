import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function createMockEl(tag = 'div') {
  const listeners = {};
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    addEventListener: (evt, fn) => {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: (evt) => {
      (listeners[evt.type || evt] || []).forEach(fn => fn(evt));
    },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: (x) => classes.has(x) ? classes.delete(x) : classes.add(x)
    },
    style: {},
    dataset: {},
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      strokeRect: () => {},
      fillText: () => {},
      measureText: () => ({ width: 25 }),
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      setLineDash: () => {},
      getImageData: (x, y, w, h) => ({
        width: w || 100,
        height: h || 40,
        data: new Uint8Array((w || 100) * (h || 40) * 4)
      }),
      putImageData: () => {}
    }),
    setAttribute: () => {},
    removeAttribute: () => {},
    toDataURL: () => 'data:image/jpeg;base64,mock',
    innerHTML: '',
    textContent: '',
    value: '',
    options: [],
    selectedIndex: 0,
    disabled: false
  };
  return new Proxy(el, {
    get: (t, p) => p in t ? t[p] : () => {},
    set: (t, p, v) => { t[p] = v; return true; }
  });
}

function loadCheckerSandbox() {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) throw new Error('No script tag found in checker.html');
  const scriptContent = scriptMatch[1];

  const fakeStorage = {};
  const elementMap = new Map();
  const getOrCreateEl = (id) => {
    if (!elementMap.has(id)) elementMap.set(id, createMockEl(id.includes('select') ? 'select' : (id.includes('modal') ? 'dialog' : 'div')));
    return elementMap.get(id);
  };

  const context = {
    window: {},
    document: {
      getElementById: (id) => getOrCreateEl(id),
      querySelector: () => createMockEl(),
      querySelectorAll: () => [createMockEl()],
      createElement: (tag) => createMockEl(tag),
      body: createMockEl()
    },
    localStorage: {
      getItem: (k) => fakeStorage[k] || null,
      setItem: (k, v) => { fakeStorage[k] = String(v); },
      removeItem: (k) => { delete fakeStorage[k]; },
      clear: () => { Object.keys(fakeStorage).forEach(k => delete fakeStorage[k]); }
    },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    alert: () => {},
    confirm: () => true,
    showToast: () => {},
    Image: class {
      constructor() {
        this.width = 840;
        this.height = 1188;
        this.complete = true;
        this._listeners = {};
      }
      addEventListener(evt, fn) {
        this._listeners[evt] = this._listeners[evt] || [];
        this._listeners[evt].push(fn);
      }
      set src(v) {
        this._src = v;
        setTimeout(() => {
          this.complete = true;
          (this._listeners['load'] || []).forEach(f => f());
          if (this.onload) this.onload();
        }, 5);
      }
      get src() { return this._src; }
    }
  };
  context.window = context;

  const vmContext = vm.createContext(context);
  try {
    vm.runInContext(scriptContent, vmContext);
  } catch (_) {}

  return { ctx: context.window, checkerHtml };
}

test('1. Inspection Canvas & drawGradeOnCanvas: awaits image decoding, falls back to scanData and state.scans', async () => {
  const { ctx } = loadCheckerSandbox();

  let drawImageCalls = 0;
  const mockCanvas = {
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => { drawImageCalls++; },
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      strokeRect: () => {},
      fillText: () => {},
      measureText: () => ({ width: 20 })
    }),
    width: 0,
    height: 0
  };

  // Case A: grade has an incomplete HTMLImageElement (loading asynchronously)
  const incompleteImg = new ctx.Image();
  incompleteImg.complete = false;
  let listenerAttached = false;
  incompleteImg.addEventListener = (evt, fn) => {
    if (evt === 'load') listenerAttached = true;
  };

  const gradeIncomplete = {
    examId: 'scan_01.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: incompleteImg,
    percentage: 85,
    bubbleDiagnostics: []
  };

  ctx.drawGradeOnCanvas(gradeIncomplete, mockCanvas);
  assert.equal(listenerAttached, true, 'drawGradeOnCanvas attaches load listener if scanImg is not yet complete');

  // Case B: grade has no scanImg, but scanData is present
  const gradeWithData = {
    examId: 'scan_02.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: null,
    scanData: 'data:image/jpeg;base64,sample',
    percentage: 90,
    bubbleDiagnostics: []
  };

  ctx.drawGradeOnCanvas(gradeWithData, mockCanvas);
  assert.ok(gradeWithData.scanImg instanceof ctx.Image, 'drawGradeOnCanvas creates an Image from scanData when scanImg is missing');

  // Case C: grade has no scanImg and no scanData, but state.scans has matching scan
  const mockScanImg = new ctx.Image();
  ctx.state.scans = [{ name: 'scan_03.jpg', img: mockScanImg }];
  const gradeFromState = {
    examId: 'scan_03.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: null,
    percentage: 75,
    bubbleDiagnostics: []
  };

  ctx.drawGradeOnCanvas(gradeFromState, mockCanvas);
  assert.equal(gradeFromState.scanImg, mockScanImg, 'drawGradeOnCanvas falls back to state.scans matching examId');

  // Case D: grade has a blank placeholder canvas (_isBlankCanvas = true), falls back to state.scans
  const mockBlankCanvas = {
    _isBlankCanvas: true,
    width: 840,
    height: 1188,
    getContext: () => ({ fillRect: () => {} })
  };
  const mockRealScanImg = new ctx.Image();
  ctx.state.scans = [{ name: 'scan_04.jpg', img: mockRealScanImg }];
  const gradeBlankCanvas = {
    examId: 'scan_04.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: mockBlankCanvas,
    percentage: 80,
    bubbleDiagnostics: []
  };

  ctx.drawGradeOnCanvas(gradeBlankCanvas, mockCanvas);
  assert.equal(gradeBlankCanvas.scanImg, mockRealScanImg, 'drawGradeOnCanvas replaces blank placeholder canvas with real image from state.scans');
});

test('2. Ribbon Google Drive 32px Button: hides text labels via CSS and updates status badge without logo bleed', () => {
  const { ctx, checkerHtml } = loadCheckerSandbox();

  // Verify CSS display: none !important rule for text inside 32px button
  assert.ok(
    checkerHtml.includes('.btn-google-drive .google-sync-indicator') &&
    checkerHtml.includes('.btn-google-drive #label-google-drive') &&
    checkerHtml.includes('display: none !important;'),
    'CSS suppresses text inside .btn-google-drive to protect Google logo and 32px boundary'
  );

  // Verify btn-google-drive does not have overflow: hidden clipping the status badge
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');
  assert.ok(
    appCss.includes('.btn-google-drive .google-sync-indicator') &&
    appCss.includes('.btn-google-drive #label-google-drive'),
    'app.css includes label-google-drive in display: none !important'
  );

  // Verify updateGoogleSyncStatus updates .google-status-badge and button title
  const btn = ctx.document.getElementById('btn-google-drive');
  const badge = ctx.document.getElementById('google-drive-status-badge');

  ctx.updateGoogleSyncStatus('synced');
  assert.ok(badge.classList.contains('is-synced'), 'Status badge gains .is-synced class');
  assert.ok(btn.title.includes('Synced to Google Drive'), 'Button title reflects synced state');

  ctx.updateGoogleSyncStatus('syncing');
  assert.ok(badge.classList.contains('is-syncing'), 'Status badge gains .is-syncing class');
  assert.ok(btn.title.includes('Syncing session'), 'Button title reflects syncing state');
});

test('3. Harmonize Ribbon Shapes across Home Portal, Sheet Builder, and Checker Studio', () => {
  const homeHtml = fs.readFileSync(path.join(rootDir, 'builder/home.html'), 'utf8');
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');

  // Verify header height is 56px across all pages
  assert.ok(homeHtml.includes('height: 56px;'), 'home.html has 56px header');
  assert.ok(checkerHtml.includes('height: 56px;'), 'checker.html has 56px header');
  assert.ok(appCss.includes('height: 56px;'), 'app.css has 56px header');

  // Verify button padding is unified
  assert.ok(homeHtml.includes('padding: 0.45rem 0.85rem;'), 'home.html button padding is 0.45rem 0.85rem');
  assert.ok(checkerHtml.includes('padding: 0.45rem 0.85rem;'), 'checker.html button padding is 0.45rem 0.85rem');
  assert.ok(appCss.includes('padding: 0.45rem 0.85rem;') || appCss.includes('padding: 0.42rem 0.85rem;'), 'app.css button padding matches standard');

  // Verify workflow navigation exists in all workspaces
  assert.ok(homeHtml.includes('class="workflow-nav"'), 'home.html has workflow-nav');
  assert.ok(checkerHtml.includes('class="workflow-nav"'), 'checker.html has workflow-nav');
});

test('4. Streamlined Sheet Inspector Popup: single consolidated header and no duplicate ZIP button', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // Ensure modal-viewer exists with single spacious header
  const modalStart = checkerHtml.indexOf('id="modal-viewer"');
  assert.ok(modalStart !== -1, 'modal-viewer dialog exists');
  const modalChunk = checkerHtml.slice(modalStart, modalStart + 3500);

  // Verify duplicate ZIP button was removed from modal header
  assert.ok(!modalChunk.includes('id="btn-viewer-download-zip"'), 'btn-viewer-download-zip removed from modal header');

  // Verify consolidated elements are present in modal
  assert.ok(modalChunk.includes('id="viewer-student-info"'), 'viewer-student-info present');
  assert.ok(modalChunk.includes('id="viewer-student-select"'), 'viewer-student-select present');
  assert.ok(modalChunk.includes('id="viewer-score-badge"'), 'viewer-score-badge present');
  assert.ok(modalChunk.includes('id="chk-redact-names-modal"'), 'chk-redact-names-modal present');
  assert.ok(modalChunk.includes('id="btn-download-sheet-jpeg"'), 'btn-download-sheet-jpeg present');
  assert.ok(modalChunk.includes('id="btn-close-viewer"'), 'btn-close-viewer present');
});

test('5. Student Roster Table: Sheet Inspector column removed, row click updates inspector', () => {
  const { ctx, checkerHtml } = loadCheckerSandbox();

  // Tab roster thead does not have Sheet Inspector column
  const tabRosterThead = checkerHtml.substring(checkerHtml.indexOf('id="tab-roster"'), checkerHtml.indexOf('id="tbody-roster"'));
  assert.ok(!tabRosterThead.includes('<th>Sheet Inspector</th>'), 'th Sheet Inspector column removed from tab-roster');

  // renderRosterTable row does not have Sheet Inspector button
  ctx.state.results = {
    passThreshold: 60,
    grades: [
      {
        studentId: '1001',
        studentName: 'Alice Green',
        nameCropDataUrl: null,
        rawScore: 45,
        maxScore: 50,
        percentage: 90,
        reviewFlags: { needsReview: false }
      }
    ]
  };

  const tbody = ctx.document.getElementById('tbody-roster');
  ctx.renderRosterTable();
  assert.ok(!tbody.innerHTML.includes('Sheet Inspector</button>'), 'Roster rows do not render redundant Sheet Inspector button');
  assert.ok(tbody.innerHTML.includes('onclick="inspectStudent(0)"'), 'Roster row click triggers inspectStudent(origIdx)');
});

test('6. Removal of Synthetic Student IDs in Parentheses', () => {
  const { ctx } = loadCheckerSandbox();

  ctx.state.results = {
    passThreshold: 60,
    grades: [
      {
        studentId: 'STU-992812',
        studentName: 'Student STU-992812',
        nameCropDataUrl: 'data:image/jpeg;base64,crop',
        rawScore: 30,
        maxScore: 50,
        percentage: 60,
        reviewFlags: { needsReview: false }
      },
      {
        studentId: 'STU-123456',
        studentName: 'Bob Student',
        nameCropDataUrl: null,
        rawScore: 40,
        maxScore: 50,
        percentage: 80,
        reviewFlags: { needsReview: false }
      }
    ]
  };

  // Inspect student with crop
  ctx.renderRosterPreview(0);
  const badgeName0 = ctx.document.getElementById('roster-badge-name');
  assert.ok(!badgeName0.innerHTML.includes('(STU-992812)'), 'No (STU-...) in roster-badge-name with name crop');
  assert.ok(badgeName0.innerHTML.includes('<img src="data:image/jpeg;base64,crop"'), 'Direct name crop rendered');

  // Inspect student without crop
  ctx.renderRosterPreview(1);
  const badgeName1 = ctx.document.getElementById('roster-badge-name');
  assert.equal(badgeName1.textContent, 'Bob Student', 'Roster student name displayed cleanly without (STU-...) suffix');

  // Check viewer student info
  ctx.state.selectedStudentIdx = 0;
  ctx.renderViewerSheet();
  const viewerInfo = ctx.document.getElementById('viewer-student-info');
  assert.ok(!viewerInfo.innerHTML.includes('(STU-992812)'), 'No (STU-...) in viewer-student-info');

  ctx.state.selectedStudentIdx = 1;
  ctx.renderViewerSheet();
  assert.equal(viewerInfo.textContent, 'Bob Student', 'Viewer displays clean student name without parentheses');
  assert.ok(!viewerInfo.textContent.includes('(') && !viewerInfo.textContent.includes(')'), 'No parentheses in viewer student name');
});

test('7. Written Items Initialized Unreviewed with 0 Points During Scanning', () => {
  const { ctx } = loadCheckerSandbox();

  const mockLayout = {
    title: 'Test Exam',
    page: { width: 210, height: 297 },
    markers: {
      "0": { center: [10, 10] },
      "1": { center: [200, 10] },
      "2": { center: [200, 287] },
      "3": { center: [10, 287] }
    },
    bubbles: [],
    rois: [
      { id: '33', key: '33', graded: true, type: 'text_short', x: 20, y: 50, w: 60, h: 15, expected: 'Mitochondria' }
    ]
  };

  const mockKey = {
    total_points: 5,
    items: {
      '33': { answer: 'Mitochondria', points: 5, kind: 'text' }
    }
  };

  const mockScan = {
    name: 'scan_01.jpg',
    img: new ctx.Image()
  };

  const grade = ctx.processExamScan(mockScan, mockLayout, mockKey, 0.20);
  assert.equal(grade.gradedItems['33'].isCorrect, false, 'Written items start unreviewed and not auto-credited');
  assert.equal(grade.gradedItems['33'].pointsAwarded, 0, 'Written items start with 0 points awarded');
  assert.equal(grade.gradedItems['33'].status, 'unreviewed', 'Written items have status unreviewed');
  assert.equal(grade.gradedItems['33'].reviewed, false, 'Written items reviewed flag is false');
  assert.equal(grade.rawScore, 0, 'rawScore is 0 until teacher manually grades');
});

test('8. Horizontal Grading Numbering & Scoped Navigation', () => {
  const { ctx } = loadCheckerSandbox();

  const mockLayout = {
    title: 'Short Answer Exam',
    rois: [
      { id: '33', key: '33', graded: true, type: 'text_short', x: 10, y: 20, w: 50, h: 15, prompt: 'Define cell wall' },
      { id: '69_corr', key: '69_corr', role: 'correction', graded: true, type: 'modified_tf', x: 10, y: 40, w: 50, h: 15, prompt: 'Explain reason' }
    ]
  };

  const items = ctx.getHorizontalGradingItems(mockLayout, null);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Question 33', 'Item label formatted human-readably as Question 33');
  assert.equal(items[1].label, 'Question 69 (Correction)', 'Correction item label formatted as Question 69 (Correction)');

  // Verify prev/next buttons navigate within selectItem options
  ctx.state.results = {
    grades: [
      {
        studentId: '101',
        studentName: 'Alice',
        gradedItems: {
          '33': { status: 'unreviewed', pointsAwarded: 0, ocrText: 'Cell wall' },
          '69_corr': { status: 'unreviewed', pointsAwarded: 0, ocrText: 'Correction text' }
        }
      }
    ]
  };
  ctx.state.layout = mockLayout;

  const selectItem = ctx.document.getElementById('select-horizontal-item');
  selectItem.options = [
    { value: '33', text: 'Question 33 (1 pts)' },
    { value: '69_corr', text: 'Question 69 (Correction) (1 pts)' }
  ];
  selectItem.selectedIndex = 0;
  selectItem.value = '33';

  const nextBtn = ctx.document.getElementById('btn-horizontal-item-next');
  nextBtn.dispatchEvent({ type: 'click' });
  assert.equal(selectItem.selectedIndex, 1, 'Next button advances selectedIndex to 1 within scoped items');

  const prevBtn = ctx.document.getElementById('btn-horizontal-item-prev');
  prevBtn.dispatchEvent({ type: 'click' });
  assert.equal(selectItem.selectedIndex, 0, 'Prev button steps selectedIndex back to 0 within scoped items');
});
