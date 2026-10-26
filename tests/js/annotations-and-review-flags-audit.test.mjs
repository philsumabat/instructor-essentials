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
      createImageData: (w, h) => ({
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

test('1. Sheet Inspector DOM & CSS: flex-start alignment and harmonized review copy', () => {
  const { checkerHtml } = loadCheckerSandbox();

  // Verify .roster-canvas-wrap uses align-items: flex-start to prevent top-clipping
  const wrapCssMatch = checkerHtml.match(/\.roster-canvas-wrap\s*\{([^}]+)\}/);
  assert.ok(wrapCssMatch, '.roster-canvas-wrap CSS rule must exist');
  assert.ok(
    wrapCssMatch[1].includes('align-items: flex-start;'),
    '.roster-canvas-wrap must have align-items: flex-start to avoid top-clipping on large sheets'
  );
  assert.ok(
    !wrapCssMatch[1].includes('align-items: center;'),
    '.roster-canvas-wrap must not have align-items: center'
  );

  // Verify UI copy no longer mentions unverified IDs
  assert.ok(
    !checkerHtml.includes('unverified IDs'),
    'All occurrences of "unverified IDs" must be removed from checker.html'
  );
  assert.ok(
    checkerHtml.includes('blank responses or multiple marks'),
    'summary-review-callout must reference blank responses or multiple marks'
  );
  assert.ok(
    checkerHtml.includes('blank responses, multiple marks, or unreviewed responses'),
    'summary-review-callout-sub and filter button title must reference unreviewed responses'
  );
});

test('2. Sheet Inspector Canvas: asynchronous image loading race protection', () => {
  const { ctx } = loadCheckerSandbox();

  let fillStyleSet = '';
  let fillRectCalled = false;
  let strokeCalls = 0;

  const mockCanvas = {
    getContext: () => ({
      set fillStyle(val) { fillStyleSet = val; },
      fillRect: () => { fillRectCalled = true; },
      strokeRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => { strokeCalls++; },
      fillText: () => {},
      measureText: () => ({ width: 20 })
    }),
    width: 840,
    height: 1188
  };

  const loadingImg = new ctx.Image();
  loadingImg.complete = false; // still fetching / decoding

  let loadListenerRegistered = false;
  loadingImg.addEventListener = (evt, fn) => {
    if (evt === 'load') loadListenerRegistered = true;
  };

  const grade = {
    examId: 'scan_pending.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: loadingImg,
    percentage: 90,
    bubbleDiagnostics: [
      { item: 'q1', choice: 'A', isMarked: true, canX: 100, canY: 100, rad: 10 }
    ],
    gradedItems: {
      q1: { expected: 'A' }
    }
  };

  // Calling drawGradeOnCanvas while loadingImg is not complete should return early
  ctx.drawGradeOnCanvas(grade, mockCanvas);

  assert.equal(loadListenerRegistered, true, 'Load listener must be registered on incomplete scanImg');
  assert.equal(fillRectCalled, true, 'Clean white backing must be painted');
  assert.equal(fillStyleSet, '#ffffff', 'Canvas fillStyle must be set to #ffffff');
  assert.equal(strokeCalls, 0, 'No floating bubble overlay rings must be stroked before image is ready');
});

test('3. Sheet Inspector Canvas: multi-answer and case-insensitive key target matching', () => {
  const { ctx } = loadCheckerSandbox();

  const colorsDrawn = [];
  const mockCanvas = {
    getContext: () => ({
      set fillStyle(val) { colorsDrawn.push(val); },
      set strokeStyle(val) { colorsDrawn.push(val); },
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
      measureText: () => ({ width: 20 }),
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      setLineDash: () => {}
    }),
    width: 840,
    height: 1188
  };

  const completeImg = new ctx.Image();
  completeImg.complete = true;

  // Question 1 accepts array ["A", "C"]
  // Question 2 accepts comma string "T, F"
  // Bubble for Q1 has lowercase 'a'
  const grade = {
    examId: 'scan_multikey.jpg',
    targetW: 840,
    targetH: 1188,
    scanImg: completeImg,
    percentage: 100,
    bubbleDiagnostics: [
      { item: 'q1', choice: 'a', isMarked: true, canX: 100, canY: 100, rad: 10 },
      { item: 'q1', choice: 'C', isMarked: true, canX: 150, canY: 100, rad: 10 },
      { item: 'q2', choice: 't', isMarked: true, canX: 100, canY: 200, rad: 10 }
    ],
    gradedItems: {
      q1: { expected: ['A', 'C'] },
      q2: { expected: 'T, F' }
    }
  };

  ctx.drawGradeOnCanvas(grade, mockCanvas, {
    layout: {
      rois: [{ role: 'score', x: 20, y: 20, w: 40, h: 20 }]
    }
  });

  // Green correct color (#10b981) should be present for both multi-answer targets
  assert.ok(
    colorsDrawn.includes('#10b981'),
    'Multi-answer choices and case-insensitive choices must be recognized as correct targets'
  );
  // Red incorrect (#ef4444) should NOT be drawn because all marked bubbles match key
  assert.ok(
    !colorsDrawn.includes('#ef4444'),
    'No wrong-mark red annotations should be stroked when choices match multi-key'
  );
});

test('4. Sheet Inspector Canvas: fallback header banner honors name redaction', () => {
  const { ctx } = loadCheckerSandbox();

  let textsDrawn = [];
  const mockCanvas = {
    getContext: () => ({
      fillText: (txt) => { textsDrawn.push(txt); },
      fillRect: () => {},
      strokeRect: () => {},
      drawImage: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      measureText: () => ({ width: 40 }),
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      setLineDash: () => {}
    }),
    width: 840,
    height: 1188
  };

  const completeImg = new ctx.Image();
  completeImg.complete = true;

  const grade = {
    examId: 'scan_redacted.jpg',
    studentId: '2026-9999',
    studentName: 'Johnathan Doe',
    targetW: 840,
    targetH: 1188,
    scanImg: completeImg,
    rawScore: 40,
    maxScore: 50,
    percentage: 80,
    gradedItems: {},
    bubbleDiagnostics: []
  };

  // Calling with redactName: true and NO score ROI (so it hits fallback header banner)
  ctx.drawGradeOnCanvas(grade, mockCanvas, { redactName: true, layout: { rois: [] } });

  assert.ok(
    textsDrawn.includes('[NAME REDACTED]'),
    'Fallback header banner must display [NAME REDACTED] when redactName is true'
  );
  assert.ok(
    !textsDrawn.includes('Johnathan Doe'),
    'Real student name must not appear in fallback banner when redacted'
  );
});

test('5. Removal of "No Student ID detected on sheet" in processExamScan', () => {
  const { ctx } = loadCheckerSandbox();

  // Ensure state.roster is empty/null
  ctx.state.roster = null;

  const mockScanImg = createMockEl('canvas');
  mockScanImg.width = 840;
  mockScanImg.height = 1188;

  const mockLayout = {
    page: { width: 210, height: 297 },
    markers: {
      '0': { center: [10, 10] },
      '1': { center: [200, 10] },
      '2': { center: [200, 287] },
      '3': { center: [10, 287] }
    },
    bubbles: [
      { item: '1', choice: 'A', center: [25, 35], radius: 2.5 }
    ],
    rois: []
  };

  const mockKey = {
    items: {
      '1': { answer: 'A', points: 1.0 }
    },
    total_points: 1.0
  };

  // Mock corner marker detection to return valid corners
  ctx.detectCornerMarkers = () => [
    { x: 10, y: 10 },
    { x: 830, y: 10 },
    { x: 830, y: 1178 },
    { x: 10, y: 1178 }
  ];

  const result = ctx.processExamScan({ name: 'sheet_01.jpg', img: mockScanImg }, mockLayout, mockKey);

  assert.ok(result, 'processExamScan must return a grade result');
  const reasons = (result.reviewFlags && result.reviewFlags.reasons) || [];
  assert.ok(
    !reasons.some(r => r.includes('No Student ID')),
    'processExamScan must NEVER add "No Student ID detected on sheet" when no roster is loaded'
  );
});

test('6. Session Restore: sanitizes legacy "No Student ID" review reasons', async () => {
  const { ctx } = loadCheckerSandbox();

  const legacySessionData = {
    layout: { page: { width: 210, height: 297 }, rois: [] },
    key: { items: {}, total_points: 0 },
    results: {
      passThreshold: 60,
      grades: [
        {
          examId: 'scan_legacy.jpg',
          studentId: 'STU-001',
          studentName: 'Student STU-001',
          rawScore: 40,
          maxScore: 50,
          percentage: 80,
          reviewFlags: {
            needsReview: true,
            reasons: ['No Student ID detected on sheet']
          }
        },
        {
          examId: 'scan_legacy_with_blanks.jpg',
          studentId: 'STU-002',
          studentName: 'Student STU-002',
          rawScore: 20,
          maxScore: 50,
          percentage: 40,
          reviewFlags: {
            needsReview: true,
            reasons: ['No Student ID detected on sheet', '2 blank responses']
          }
        }
      ]
    }
  };

  await ctx.restoreCheckerProgress(legacySessionData);

  const restored = ctx.state.results.grades;
  assert.equal(restored.length, 2, 'Two grades restored');

  // Grade 1 only had "No Student ID detected on sheet", should now be clean
  assert.equal(restored[0].reviewFlags.needsReview, false, 'Grade 1 needsReview must be false after sanitizing');
  assert.deepEqual(restored[0].reviewFlags.reasons, [], 'Grade 1 reasons must be empty');

  // Grade 2 had blanks as well, should keep blank reason but drop No Student ID
  assert.equal(restored[1].reviewFlags.needsReview, true, 'Grade 2 needsReview remains true for blanks');
  assert.deepEqual(restored[1].reviewFlags.reasons, ['2 blank responses'], 'Grade 2 reasons must only contain blanks');
});
