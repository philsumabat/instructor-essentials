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
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    XMLHttpRequest: class MockXHR {
      constructor() {
        this.status = 200;
        this.responseText = '[]';
      }
      open() {}
      setRequestHeader() {}
      send() {}
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

test('3. +1.0mm Crop Extraction with No Wall Stripping', async () => {
  const { context, sandbox, checkerHtml } = await loadCheckerSandbox();
  const cropROIFromScan = context.cropROIFromScan;
  assert.equal(typeof cropROIFromScan, 'function', 'cropROIFromScan must be exported');

  // Verify stripBoxWallsFromImageData is removed
  assert.ok(!checkerHtml.includes('function stripBoxWallsFromImageData'), 'stripBoxWallsFromImageData completely removed');

  const destCanvas = sandbox.document.createElement('canvas');
  const grade = {
    scanImg: sandbox.document.createElement('canvas'),
    targetW: 840,
    targetH: 1188,
    rotationDeg: 0
  };

  const roi = { x: 50, y: 100, w: 100, h: 30 };
  const res = cropROIFromScan(grade, roi, destCanvas, 'item1');
  assert.equal(res, destCanvas);
  assert.ok(destCanvas.width > 400, 'Crop canvas width incorporates outward +1mm padding');
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

  // 3. New Class / Clear button rename and TrOCR settings button removal
  assert.ok(checkerHtml.includes('<span>New Class / Clear</span>'), 'Checker Studio reset button renamed to New Class / Clear');
  assert.ok(!checkerHtml.includes('id="btn-trocr-settings"'), 'Checker Studio does not have TrOCR settings button');
  assert.ok(!checkerHtml.includes('id="modal-trocr-settings"'), 'Checker Studio does not have TrOCR settings modal');
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

test('8. Unreviewed items render with neutral pending styling and IN REVIEW status pill', async () => {
  const { context, checkerHtml } = await loadCheckerSandbox();
  assert.ok(checkerHtml.includes('.badge-in-review'), '.badge-in-review style class present');
  assert.ok(checkerHtml.includes('Pending Review (—/'), 'Pending Review label used in canvas rendering');

  const grade = {
    studentId: 'STU-100',
    studentName: 'Alice',
    rawScore: 0,
    maxScore: 5,
    percentage: 0,
    gradedItems: {
      'text_item': {
        kind: 'text',
        roi: { x: 10, y: 10, w: 50, h: 20 },
        maxPoints: 5,
        pointsAwarded: 0,
        status: 'unreviewed',
        reviewed: false
      }
    }
  };

  assert.equal(context.hasUnreviewedItems(grade), true, 'hasUnreviewedItems returns true for unreviewed write-ins');
});

test('9. MessageChannel unthrottled background yielding and Screen Wake Lock', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify MessageChannel yielding when tab is hidden
  assert.ok(checkerHtml.includes('MessageChannel'), 'MessageChannel used for background yielding');
  assert.ok(checkerHtml.includes('document.hidden'), 'document.hidden checked for background mode');

  // Verify Screen Wake Lock and title progress
  assert.ok(checkerHtml.includes('wakeLock'), 'Screen Wake Lock requested during grading');
  assert.ok(checkerHtml.includes('Grading... - Checker Studio'), 'Dynamic title updates during grading');
});

test('10. cropROIFromScan returns cached crop even when scan is _isBlankCanvas', async () => {
  const { context, sandbox } = await loadCheckerSandbox();
  const cropROIFromScan = context.cropROIFromScan;
  
  const destCanvas = sandbox.document.createElement('canvas');
  const dummyCanvas = sandbox.document.createElement('canvas');
  dummyCanvas._isBlankCanvas = true;
  
  const grade = {
    scanImg: dummyCanvas,
    targetW: 840,
    targetH: 1188,
    rotationDeg: 0,
    gradedItems: {
      q1: {
        cropDataUrl: 'data:image/jpeg;base64,existing_cached_crop'
      }
    }
  };
  
  // When roi id matches cached crop, it returns destCanvas with cached crop
  const roi = { id: 'q1', x: 20, y: 30, w: 75, h: 10 };
  const res = cropROIFromScan(grade, roi, destCanvas);
  assert.equal(res, destCanvas, 'Must return destCanvas with cached crop even when scanImg is blank canvas');
  
  // When roi id does NOT have a cached crop and scanImg is blank canvas, it returns null
  const roiUncached = { id: 'q2', x: 20, y: 30, w: 75, h: 10 };
  const resNull = cropROIFromScan(grade, roiUncached, destCanvas);
  assert.equal(resNull, null, 'Must return null when uncached and scanImg is blank canvas');
});

test('11. Home portal contrast and button styling', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');
  assert.ok(!homeHtml.includes('.tool-card__title {\n      font-size: 1.1rem;\n      font-weight: 700;\n      color: #fff;'), 'tool-card__title must not have hardcoded white text');
  assert.ok(!homeHtml.includes('color: #fff; margin-bottom: 0.2rem;">${examTitle}'), 'examTitle must not have hardcoded white text');
  assert.ok(!homeHtml.includes('.btn--secondary:hover {\n      border-color: var(--border-focus);\n      background: #27354a;\n      color: #fff;\n    }'), 'btn--secondary:hover must not have hardcoded dark background and white text');
});

test('12. Partial Score Calculation, Floating-Point Precision, and Canvas Visuals', async () => {
  const { context, checkerHtml } = await loadCheckerSandbox();

  // Verify dead code removal
  assert.ok(!checkerHtml.includes('function makeConfBadge'), 'makeConfBadge function must be removed');
  assert.ok(!checkerHtml.includes('ocrConfidence: 0.88'), 'Dummy ocrConfidence must be removed');
  assert.ok(!checkerHtml.includes('btn-trocr-settings'), 'btn-trocr-settings listeners must be removed');

  // Verify custom points stepper and enter key handler
  assert.ok(checkerHtml.includes('id="flashcard-custom-pts" min="0" max="${itemMaxPts}" step="0.5"'), 'Custom points stepper with 0.5 step');
  assert.ok(checkerHtml.includes("if (event.key === 'Enter')"), 'Custom points input has Enter key shortcut');

  // Setup student for horizontal grading
  const student = {
    studentId: 'STU-001',
    studentName: 'Bob',
    rawScore: 0,
    maxScore: 10,
    percentage: 0,
    gradedItems: {
      'q_essay': {
        kind: 'text',
        pointsAwarded: 0,
        maxPoints: 5.0,
        status: 'unreviewed',
        reviewed: false
      },
      'q_short': {
        kind: 'text',
        pointsAwarded: 0,
        maxPoints: 2.0,
        status: 'unreviewed',
        reviewed: false
      },
      'q_one': {
        kind: 'text',
        pointsAwarded: 0,
        maxPoints: 1.0,
        status: 'unreviewed',
        reviewed: false
      }
    }
  };

  context.state.results = {
    grades: [student],
    passThreshold: 60
  };
  context.state.layout = {
    rois: [
      { id: 'q_essay', key: 'q_essay', type: 'text_essay', points: 5.0, graded: true },
      { id: 'q_short', key: 'q_short', type: 'text_short', points: 2.0, graded: true },
      { id: 'q_one', key: 'q_one', type: 'text_short', points: 1.0, graded: true }
    ]
  };
  context.state.key = {
    total_points: 10,
    items: {
      'q_essay': { answer: 'Mitosis', points: 5.0, kind: 'text' },
      'q_short': { answer: 'Nucleus', points: 2.0, kind: 'text' },
      'q_one': { answer: 'Cell', points: 1.0, kind: 'text' }
    }
  };

  // Case 1: Default 50% partial quick action
  // On a 5-pt item -> 2.5 pts
  context.gradeHorizontalItem(0, 'q_essay', 'partial');
  assert.equal(student.gradedItems['q_essay'].pointsAwarded, 2.5, '5-pt item awards 2.5 pts default partial');
  assert.equal(student.gradedItems['q_essay'].status, 'partial');

  // On a 2-pt item -> 1.0 pt
  context.gradeHorizontalItem(0, 'q_short', 'partial');
  assert.equal(student.gradedItems['q_short'].pointsAwarded, 1.0, '2-pt item awards 1.0 pt default partial');

  // On a 1-pt item -> 0.5 pt
  context.gradeHorizontalItem(0, 'q_one', 'partial');
  assert.equal(student.gradedItems['q_one'].pointsAwarded, 0.5, '1-pt item awards 0.5 pt default partial');

  // Raw score is 2.5 + 1.0 + 0.5 = 4.0; maxScore strictly preserves key.total_points (10); percentage = 40%
  assert.equal(student.rawScore, 4.0);
  assert.equal(student.maxScore, 10, 'maxScore strictly preserves key.total_points');
  assert.equal(student.percentage, 40);

  // Case 2: Custom partial points adjustment
  context.gradeHorizontalItem(0, 'q_essay', 'partial', 3.5);
  assert.equal(student.gradedItems['q_essay'].pointsAwarded, 3.5, 'Custom points 3.5 awarded');

  context.gradeHorizontalItem(0, 'q_short', 'partial', 1.25);
  assert.equal(student.gradedItems['q_short'].pointsAwarded, 1.25, 'Custom points 1.25 awarded');

  // Clamping test: custom points cannot exceed maxPoints or be negative
  context.gradeHorizontalItem(0, 'q_one', 'partial', 99);
  assert.equal(student.gradedItems['q_one'].pointsAwarded, 1.0, 'Clamped to maxPoints');

  context.gradeHorizontalItem(0, 'q_one', 'partial', -5);
  assert.equal(student.gradedItems['q_one'].pointsAwarded, 0, 'Clamped to 0 minimum');

  // Case 3: Floating point precision check: 3.5 + 1.25 + 0.1 = 4.85
  context.gradeHorizontalItem(0, 'q_one', 'partial', 0.1);
  assert.equal(student.rawScore, 4.85, 'Sum of fractional points has no floating point rounding artifacts');
  assert.equal(student.percentage, 48.5);

  // Canvas visual verification
  assert.ok(checkerHtml.includes("color = '#f59e0b';\n          isDashed = false;\n          ptsText = `Partial"), 'Partial status draws with amber #f59e0b on canvas');
});

test('13. Interactive Bubble Correction: Mark Type Resolution, Roster Array Matching, and Strict MaxScore Preservation', async () => {
  const { context } = await loadCheckerSandbox();

  // Setup active roster as standard Array of { id, name, classOffer }
  context.state.roster = [
    { id: '2026-9999', name: 'Maria Makiling', classOffer: 'BIO-101' },
    { id: '2026-8888', name: 'Juan Luna', classOffer: 'BIO-101' }
  ];

  const student = {
    studentId: '2026-0000',
    studentName: 'Unknown Student',
    rawScore: 0,
    maxScore: 25,
    percentage: 0,
    bubbleDiagnostics: [
      // Ambiguous faint mark on Question 1, Choice A
      { item: '1', choice: 'A', canX: 50, canY: 50, rad: 6, isMarked: false, markType: 'faint' },
      { item: '1', choice: 'B', canX: 70, canY: 50, rad: 6, isMarked: false, markType: null },
      // SID bubbles: 2 columns
      { item: 'sid[1]', choice: '9', digit: 9, canX: 100, canY: 100, rad: 6, isMarked: false, role: 'sid' },
      { item: 'sid[0]', choice: '2', digit: 2, canX: 80, canY: 100, rad: 6, isMarked: false, role: 'sid' }
    ],
    gradedItems: {
      '1': { expected: 'A', actual: 'BLANK', pointsAwarded: 0, maxPoints: 1.0, isCorrect: false },
      '2': { expected: 'B', actual: 'BLANK', pointsAwarded: 0, maxPoints: 1.0, isCorrect: false }
    },
    reviewFlags: {
      blankCount: 2,
      multiMarkCount: 0,
      needsReview: true,
      reasons: ['2 blank responses', 'Unmatched Student ID']
    }
  };

  context.state.results = {
    grades: [student],
    passThreshold: 60
  };
  context.state.key = {
    total_points: 25,
    items: {
      '1': { answer: 'A', points: 1.0 },
      '2': { answer: 'B', points: 1.0 }
    }
  };

  // 1. Correct ambiguous mark on Question 1
  const hitFaint = student.bubbleDiagnostics[0];
  context.correctBubbleMark(student, hitFaint);
  assert.equal(hitFaint.isMarked, true, 'Bubble toggled to marked');
  assert.equal(hitFaint.markType, 'solid', 'Ambiguous faint mark resolved to solid');
  assert.equal(student.gradedItems['1'].actual, 'A');
  assert.equal(student.gradedItems['1'].isCorrect, true);
  assert.equal(student.rawScore, 1.0);
  assert.equal(student.maxScore, 25, 'maxScore strictly preserves key.total_points');
  assert.equal(student.percentage, 4.0); // 1 / 25 * 100

  // Verify blank item count correctly preserved remaining BLANK item
  assert.equal(student.reviewFlags.blankCount, 1, 'Blank count decremented to 1 (item 2 still BLANK)');

  // 2. Correct SID bubbles and match against roster
  const sidCol0 = student.bubbleDiagnostics[3]; // sid[0]
  const sidCol1 = student.bubbleDiagnostics[2]; // sid[1]
  sidCol0.isMarked = true;
  sidCol1.isMarked = true;

  // Let's set studentId to full match '2026-9999'
  student.studentId = '2026-9999';
  context.correctBubbleMark(student, sidCol0); // trigger SID reconstruction & roster match

  assert.equal(student.studentName, 'Maria Makiling', 'Matched student name from state.roster');
  assert.equal(student.classOffer, 'BIO-101', 'Matched classOffer from state.roster');
  assert.ok(!student.reviewFlags.reasons.some(r => r.includes('Unmatched Student ID')), 'Unmatched Student ID flag cleared');
});


