import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function loadCheckerSandbox() {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block must be present in checker.html');
  const code = scriptMatch[1];

  const createMockEl = (overrides = {}) => ({
    style: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    addEventListener: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...overrides
  });

  const storage = {};
  const mockElements = {
    'input-threshold': createMockEl({ value: '60' }),
    'dist-label-threshold': createMockEl({ textContent: 'Threshold: 60%' }),
    'dist-label-pass': createMockEl({ textContent: '' }),
    'dist-label-fail': createMockEl({ textContent: '' }),
    'dist-bar-pass': createMockEl(),
    'dist-bar-fail': createMockEl(),
    'metric-passrate': createMockEl({ textContent: '' }),
    'metric-passrate-sub': createMockEl({ textContent: '' }),
    'input-hf-token': createMockEl({ value: '' }),
    'modal-trocr-settings': createMockEl({ showModal: () => {}, close: () => {} }),
    'modal-new-class-prompt': createMockEl({ showModal: () => {}, close: () => {} }),
    'checker-empty-state': createMockEl(),
    'results-export-bar': createMockEl(),
    'tbody-summary': createMockEl({ innerHTML: '' }),
    'tbody-roster': createMockEl({ innerHTML: '' }),
    'tbody-items': createMockEl({ innerHTML: '' }),
    'tbody-top-students': createMockEl({ innerHTML: '' }),
    'btn-thresh-dec': createMockEl({ onclick: null }),
    'btn-thresh-inc': createMockEl({ onclick: null }),
    'roster-preview-canvas': createMockEl({ getContext: () => ({ clearRect: () => {} }), width: 840, height: 1188 }),
    'viewer-student-select': createMockEl({ innerHTML: '' })
  };

  const sandbox = {
    document: {
      getElementById: (id) => mockElements[id] || createMockEl(),
      querySelectorAll: () => [],
      querySelector: () => createMockEl(),
      createElement: (tag) => {
        if (tag === 'canvas') {
          return {
            width: 840,
            height: 1188,
            getContext: () => ({
              drawImage: () => {},
              fillRect: () => {},
              strokeRect: () => {},
              fillText: () => {},
              beginPath: () => {},
              arc: () => {},
              fill: () => {},
              stroke: () => {},
              moveTo: () => {},
              lineTo: () => {},
              setLineDash: () => {},
              measureText: () => ({ width: 30 }),
              save: () => {},
              restore: () => {},
              translate: () => {},
              rotate: () => {},
              getImageData: (x, y, w, h) => ({
                data: new Uint8ClampedArray(w * h * 4)
              }),
              putImageData: () => {}
            }),
            toDataURL: () => 'data:image/jpeg;base64,mock',
            toBlob: (cb) => cb(new Blob(['mock']))
          };
        }
        return { style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {} } };
      },
      body: { classList: { add: () => {}, remove: () => {} } }
    },
    window: {},
    console,
    localStorage: {
      getItem: (k) => storage[k] ?? null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    navigator: { onLine: false },
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {
      constructor() {
        this.width = 840;
        this.height = 1188;
      }
    },
    FileReader: class {},
    Blob: class { constructor(parts) { this.parts = parts; } },
    URLSearchParams: class {
      constructor(str) { this.params = new URLSearchParams(str); }
      get(k) { return this.params.get(k); }
    }
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(code).runInContext(context);

  return { context, sandbox, storage, mockElements, checkerHtml };
}

test('1. Layout ROI Extraction & Student Name ROI Detection', async () => {
  const { context } = await loadCheckerSandbox();
  const getLayoutROIs = context.getLayoutROIs;
  const findStudentNameROI = context.findStudentNameROI;

  assert.equal(typeof getLayoutROIs, 'function', 'getLayoutROIs must be defined');
  assert.equal(typeof findStudentNameROI, 'function', 'findStudentNameROI must be defined');

  // Edge Case: Null and undefined
  assert.deepEqual([...getLayoutROIs(null)], []);
  assert.deepEqual([...getLayoutROIs(undefined)], []);
  assert.equal(findStudentNameROI(null), null);

  // Modern nested zone layout format
  const nestedLayout = {
    title: 'Modern Exam',
    zones: [
      {
        id: 'header_zone',
        type: 'header',
        rois: [
          { id: 'zone.student_name', role: 'name', x: 20, y: 15, width: 80, height: 12, label: 'Student Name' },
          { id: 'zone.date', role: 'date', x: 110, y: 15, w: 40, h: 10, label: 'Date' }
        ]
      },
      {
        id: 'mcq_zone',
        type: 'mcq',
        rois: []
      },
      {
        id: 'corrupt_zone_without_rois',
        type: 'custom'
      }
    ]
  };

  const extracted = getLayoutROIs(nestedLayout);
  assert.equal(extracted.length, 2, 'Must extract 2 ROIs across all nested zones safely');

  const foundName = findStudentNameROI(nestedLayout);
  assert.ok(foundName, 'Must find student name ROI in nested zone');
  assert.equal(foundName.id, 'zone.student_name');

  // Legacy root rois format
  const legacyLayout = {
    rois: [
      { id: 'score_box', role: 'score', x: 160, y: 15, w: 30, h: 15 },
      { id: 'name', role: 'name', x: 25, y: 15, w: 85, h: 12 }
    ]
  };
  assert.equal(getLayoutROIs(legacyLayout).length, 2);
  assert.equal(findStudentNameROI(legacyLayout).id, 'name');

  // Matching variations of student name identification
  const nameVariants = [
    { id: 'student_name', label: 'Name of Student' },
    { key: 'q_name', role: 'name' },
    { id: 'id.name', label: 'Write Name Here' },
    { id: 'custom_field', label: 'Student Full Name' }
  ];
  for (const roi of nameVariants) {
    const layout = { rois: [roi] };
    const match = findStudentNameROI(layout);
    assert.ok(match, `Must find name ROI for variant: ${JSON.stringify(roi)}`);
  }
});

test('2. cropROIFromScan dimension fallback and safe minimums', async () => {
  const { context, sandbox } = await loadCheckerSandbox();
  const cropROIFromScan = context.cropROIFromScan;
  assert.equal(typeof cropROIFromScan, 'function', 'cropROIFromScan must be exported');

  const destCanvas = sandbox.document.createElement('canvas');
  const grade = {
    scanImg: sandbox.document.createElement('canvas'),
    targetW: 840,
    targetH: 1188,
    rotationDeg: 0
  };

  // Case A: using w and h
  const roiA = { x: 20, y: 30, w: 75, h: 10 };
  cropROIFromScan(grade, roiA, destCanvas);
  assert.ok(destCanvas.width >= 200, 'Canvas width must satisfy safe minimum of 200px');
  assert.ok(destCanvas.height >= 50, 'Canvas height must satisfy safe minimum of 50px');

  // Case B: using width and height
  const roiB = { x: 20, y: 30, width: 90, height: 14 };
  cropROIFromScan(grade, roiB, destCanvas);
  assert.ok(destCanvas.width >= 200);
  assert.ok(destCanvas.height >= 50);

  // Case C: 0 or missing dimensions falls back to safe minimums
  const roiC = { x: 10, y: 10 };
  cropROIFromScan(grade, roiC, destCanvas);
  assert.ok(destCanvas.width >= 200);
  assert.ok(destCanvas.height >= 50);
});

test('3. HandwritingEngine 4-Tier Offline-First Cascade & Token Management', async () => {
  const { context, storage } = await loadCheckerSandbox();
  const HandwritingEngine = context.HandwritingEngine;
  assert.ok(HandwritingEngine, 'HandwritingEngine must exist');

  // Token management in localStorage
  HandwritingEngine.setHFToken('hf_test_token_12345');
  assert.equal(HandwritingEngine.getHFToken(), 'hf_test_token_12345');
  assert.equal(storage['toolkit_hf_token'], 'hf_test_token_12345');

  HandwritingEngine.setHFToken('');
  assert.equal(HandwritingEngine.getHFToken(), '');
  assert.equal(storage['toolkit_hf_token'], undefined);

  // Tier 2: Blank detector on empty/white canvas
  const canvas = context.document.createElement('canvas');
  const t2Result = HandwritingEngine.runTier2LocalOCR(canvas);
  assert.ok(t2Result, 'Tier 2 should classify blank canvas');
  assert.equal(t2Result.tier, 2);
  assert.equal(t2Result.text, '');
  assert.ok(t2Result.confidence > 0.9);

  // Tier 3: Zero-failure visual crop fallback
  const result = await HandwritingEngine.transcribeHandwritingCrop(null);
  assert.equal(result.tier, 3, 'Null canvas must yield Tier 3 visual fallback');
  assert.equal(result.source, 'visual-fallback');

  // Offline robustness: Serverless booster returns null when offline
  const t4Offline = await HandwritingEngine.runTier4HFServerless(canvas);
  assert.equal(t4Offline, null, 'Serverless booster must safely resolve null when offline');
});

test('4. Passing score stepper handles 0% threshold without reverting to 60%', async () => {
  const { context, mockElements } = await loadCheckerSandbox();
  const updatePassThreshold = context.updatePassThreshold;
  const state = context.state;

  state.results = {
    passThreshold: 60,
    grades: [
      { rawScore: 0, maxScore: 100, percentage: 0 },
      { rawScore: 50, maxScore: 100, percentage: 50 },
      { rawScore: 100, maxScore: 100, percentage: 100 }
    ]
  };

  // Set threshold to 0%
  mockElements['input-threshold'].value = '0';
  updatePassThreshold();

  assert.equal(state.results.passThreshold, 0, 'Threshold 0% must remain 0 and not revert to 60');
  assert.equal(mockElements['dist-label-threshold'].textContent, 'Threshold: 0%');
  assert.equal(mockElements['metric-passrate'].textContent, '100.0%', 'All 3 students pass at 0% threshold');

  // Stepper decrement from 5 should hit 0
  mockElements['input-threshold'].value = '5';
  updatePassThreshold();
  assert.equal(state.results.passThreshold, 5);

  const decBtn = mockElements['btn-thresh-dec'];
  assert.equal(typeof decBtn.onclick, 'function', 'btn-thresh-dec click handler must be bound');
  decBtn.onclick();
  assert.equal(Number(mockElements['input-threshold'].value), 0);
  assert.equal(state.results.passThreshold, 0);
});

test('5. Branding, Single Sign-in, and Header Ribbon Cleanliness across pages', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Clean brand title without subtext across all three pages
  for (const [name, html] of [['home', homeHtml], ['builder', indexHtml], ['checker', checkerHtml]]) {
    assert.ok(html.includes('<h1 class="app-brand__title">Instructors\' Toolkit</h1>'), `${name} must display Instructors' Toolkit`);
    assert.ok(!html.includes('app-brand__badge">Sheet Builder'), `${name} must not have Sheet Builder badge in brand`);
    assert.ok(!html.includes('app-brand__badge">Checker Studio'), `${name} must not have Checker Studio badge in brand`);
    assert.ok(!html.includes('app-brand__badge">Portal &amp; Projects'), `${name} must not have Portal & Projects badge`);
  }

  // 2. Single Google Sign-In on Home Portal only
  assert.ok(homeHtml.includes('id="btn-google-login"'), 'Home portal must contain Google login button');
  assert.ok(!indexHtml.includes('id="btn-google-login"'), 'Sheet Builder must not have Google login button');
  assert.ok(!checkerHtml.includes('id="btn-google-login"'), 'Checker Studio must not have Google login button');

  // Sheet Builder and Checker Studio have silent inherited buttons hidden by default
  assert.ok(indexHtml.includes('id="btn-google-drive" class="btn btn--secondary btn-google-drive" style="display: none;"'), 'Sheet Builder hides gdrive button by default');
  assert.ok(checkerHtml.includes('id="btn-google-drive" class="btn btn--secondary btn-google-drive" style="display: none;"'), 'Checker Studio hides gdrive button by default');

  // 3. New Class / Clear button rename and TrOCR settings button
  assert.ok(checkerHtml.includes('<span>New Class / Clear</span>'), 'Checker Studio reset button renamed to New Class / Clear');
  assert.ok(checkerHtml.includes('id="btn-trocr-settings"'), 'Checker Studio has TrOCR settings button in ribbon');
  assert.ok(checkerHtml.includes('id="modal-trocr-settings"'), 'Checker Studio has TrOCR settings modal');
  assert.ok(checkerHtml.includes('id="modal-new-class-prompt"'), 'Checker Studio has non-blocking new class prompt modal');

  // 4. Student Roster table clean: no Exam ID column
  assert.ok(!checkerHtml.includes('<th class="sortable" data-sort="examId">Exam ID'), 'Roster table must not contain Exam ID header');
  assert.ok(!checkerHtml.includes('<th data-sort="examId">Exam ID'), 'Roster table must not contain Exam ID header');
});

test('6. drawGradeOnCanvas score box stamp without prepending "Score:"', async () => {
  const { context, sandbox } = await loadCheckerSandbox();
  const drawGradeOnCanvas = context.drawGradeOnCanvas;
  assert.equal(typeof drawGradeOnCanvas, 'function', 'drawGradeOnCanvas must be exported');

  let textDrawn = '';
  const mockCanvas = {
    getContext: () => ({
      drawImage: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      fillText: (txt) => { textDrawn = txt; },
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      measureText: () => ({ width: 40 }),
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {}
    }),
    width: 840,
    height: 1188
  };

  const grade = {
    rawScore: 42,
    maxScore: 50,
    percentage: 84,
    gradedItems: {},
    bubbleDiagnostics: [],
    scanImg: mockCanvas,
    rotationDeg: 0
  };

  const layoutWithScore = {
    rois: [
      { id: 'score', role: 'score', x: 150, y: 20, w: 35, h: 18 }
    ]
  };

  drawGradeOnCanvas(grade, mockCanvas, { layout: layoutWithScore });
  assert.equal(textDrawn, '42/50', 'Score box must print clean "42/50" without "Score:" prefix');
});

test('7. Session restore scan isolation, _isBlankCanvas guard, and placeholder DOM', async () => {
  const { context, sandbox } = await loadCheckerSandbox();
  const restoreCheckerProgress = context.restoreCheckerProgress;
  const cropROIFromScan = context.cropROIFromScan;
  const drawGradeOnCanvas = context.drawGradeOnCanvas;
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify DOM placeholders exist
  assert.ok(checkerHtml.includes('id="roster-scans-placeholder"'), 'roster-scans-placeholder present in DOM');
  assert.ok(checkerHtml.includes('id="input-attach-scans-folder"'), 'input-attach-scans-folder present in DOM');

  // Pre-populate old scans in state to test isolation
  context.state.scans = [{ name: 'stale_scan.jpg', img: { width: 840, height: 1188 } }];
  context.state.selectedStudentIdx = 5;

  const mockProgress = {
    results: {
      grades: [
        {
          examId: 'new_exam_01.jpg',
          studentId: '2026-999',
          rawScore: 40,
          maxScore: 50,
          percentage: 80,
          gradedItems: { q1: { expected: 'A' } },
          bubbleDiagnostics: [{ item: 'q1', choice: 'A', canX: 100, canY: 200, rad: 5, isMarked: true }]
        }
      ]
    }
  };

  restoreCheckerProgress(mockProgress);

  // 1. Verify old scans were purged
  assert.equal(context.state.scans.length, 1);
  assert.equal(context.state.scans[0].name, 'new_exam_01.jpg');
  assert.equal(context.state.results.grades[0].scanImg._isBlankCanvas, true, 'Restored grade without scanData has _isBlankCanvas = true');

  // 2. Verify cropROIFromScan returns null on _isBlankCanvas
  const destCanvas = sandbox.document.createElement('canvas');
  const cropResult = cropROIFromScan(context.state.results.grades[0], { x: 10, y: 10, w: 50, h: 20 }, destCanvas);
  assert.equal(cropResult, null, 'cropROIFromScan returns null for placeholder canvas');

  // 3. Verify drawGradeOnCanvas paints white and does not draw bubble diagnostics
  let circlesDrawn = 0;
  const testCanvas = {
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => { circlesDrawn++; },
      fill: () => {},
      stroke: () => {}
    }),
    width: 840,
    height: 1188
  };
  drawGradeOnCanvas(context.state.results.grades[0], testCanvas);
  assert.equal(circlesDrawn, 0, 'drawGradeOnCanvas does not draw floating marks when scan is blank canvas');
});

test('8. HandwritingEngine Tier 2 morphology honesty & dual HF token sync', async () => {
  const { context, storage } = await loadCheckerSandbox();
  const HandwritingEngine = context.HandwritingEngine;
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify inputs in modals
  assert.ok(checkerHtml.includes('id="input-hf-token"'), 'input-hf-token present');
  assert.ok(checkerHtml.includes('input-hf-token-field'), 'input-hf-token-field class present');

  // Verify dual persistence
  HandwritingEngine.setHFToken('hf_unified_key_999');
  assert.equal(storage['toolkit_hf_token'], 'hf_unified_key_999');
  assert.equal(storage['instructor_hf_token'], 'hf_unified_key_999');
  assert.equal(HandwritingEngine.getHFToken(), 'hf_unified_key_999');

  HandwritingEngine.setHFToken('');
  assert.equal(storage['toolkit_hf_token'], undefined);
  assert.equal(storage['instructor_hf_token'], undefined);
  assert.equal(HandwritingEngine.getHFToken(), '');

  // Verify Tier 2 morphology honesty
  const strokeCanvas = {
    width: 100,
    height: 30,
    getContext: () => ({
      getImageData: () => {
        // Create synthetic data with dark pixels
        const data = new Uint8ClampedArray(100 * 30 * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 10; data[i + 1] = 10; data[i + 2] = 10; data[i + 3] = 255;
        }
        return { data };
      }
    })
  };
  const t2Result = HandwritingEngine.runTier2LocalOCR(strokeCanvas, { expected: 'SECRET_EXPECTED' });
  assert.ok(t2Result, 'Tier 2 result exists');
  assert.equal(t2Result.text, '[Handwritten Text]', 'Must return honest [Handwritten Text] instead of stroke counts or expected answers');
});
