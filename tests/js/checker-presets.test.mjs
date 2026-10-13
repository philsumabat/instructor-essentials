import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('checker.html has inlined PRESETS and zero fetch() calls for presets', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify zero fetch("dist/...") calls
  assert.ok(!checkerHtml.includes('fetch("dist/'), 'Must not call fetch for dist layouts');
  assert.ok(!checkerHtml.includes('fetchLayout'), 'Must not have fetchLayout fallback function');

  // Verify preset selector options
  assert.ok(checkerHtml.includes('<option value="exam-50">50 MCQ + T/F + Short Answer (A4)</option>'));
  assert.ok(checkerHtml.includes('<option value="exam-100">100-Item MCQ (Letter)</option>'));
  assert.ok(checkerHtml.includes('<option value="quiz-tf">20 T/F &amp; Mod T/F (Folio)</option>'));
  assert.ok(checkerHtml.includes('<option value="quiz-bonus">10 MCQ + Bonus Identification (A4)</option>'));
  assert.ok(checkerHtml.includes('<option value="custom">Upload Custom Layout (.json)</option>'));

  // Extract <script> block and verify PRESETS dictionary
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block must be present');
  const code = scriptMatch[1];

  // Compile in sandbox to extract PRESETS and parser functions
  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => ({}) })
    },
    window: {},
    console: console,
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {},
    FileReader: class {}
  };
  sandbox.window = sandbox;

  // Run script in sandbox
  const script = new vm.Script(code);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  const PRESETS = vm.runInContext('PRESETS', context);
  assert.ok(PRESETS, 'PRESETS must be defined');
  assert.ok(PRESETS['exam-50'], 'exam-50 preset must exist');
  assert.ok(PRESETS['exam-100'], 'exam-100 preset must exist');
  assert.ok(PRESETS['quiz-tf'], 'quiz-tf preset must exist');
  assert.ok(PRESETS['quiz-bonus'], 'quiz-bonus preset must exist');

  // Verify exam-50: 50 MCQ questions
  const p50 = PRESETS['exam-50'];
  assert.equal(p50.layout.page.paper, 'A4');
  assert.equal(Object.keys(p50.layout.markers).length, 4);
  assert.equal(p50.layout.bubbles.length, 250); // 50 items * 5 options
  assert.equal(Object.keys(p50.key.items).length, 50);

  // Verify exam-100: 100 MCQ questions
  const p100 = PRESETS['exam-100'];
  assert.equal(p100.layout.page.paper, 'Letter');
  assert.equal(Object.keys(p100.layout.markers).length, 4);
  assert.equal(p100.layout.bubbles.length, 490); // 90 SID + 400 MCQ
  assert.equal(Object.keys(p100.key.items).length, 100);

  // Verify quiz-tf: 20 items (10 T/F + 10 Modified T/F)
  const pTf = PRESETS['quiz-tf'];
  assert.equal(Object.keys(pTf.layout.markers).length, 4);
  assert.equal(pTf.layout.bubbles.length, 40); // 20 items * 2 options
  assert.equal(Object.keys(pTf.key.items).length, 20);

  // Verify quiz-bonus: 10 items (10 MCQ + 1 identification bonus)
  const pBonus = PRESETS['quiz-bonus'];
  assert.equal(pBonus.layout.page.paper, 'A4');
  assert.equal(Object.keys(pBonus.layout.markers).length, 4);
  assert.equal(pBonus.layout.bubbles.length, 40); // 10 items * 4 options
  assert.equal(Object.keys(pBonus.key.items).length, 10);
});

test('parseLayout handles both modern Sheet Builder layout.json and legacy formats', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  const code = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => ({}) })
    },
    window: {},
    console,
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {},
    FileReader: class {}
  };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);

  const parseLayout = vm.runInContext('parseLayout', sandbox);
  const parseAnswerKey = vm.runInContext('parseAnswerKey', sandbox);

  // 1. Modern Sheet Builder format: dist/exam-50/layout.json
  const exam50Raw = JSON.parse(await readFile(resolve(root, 'dist/exam-50/layout.json'), 'utf8'));
  const parsed50 = parseLayout(exam50Raw);
  assert.equal(parsed50.page.paper, 'A4');
  assert.equal(Object.keys(parsed50.markers).length, 4);
  assert.deepEqual(parsed50.markers['0'].center, [12, 12]);
  assert.deepEqual(parsed50.markers['1'].center, [198, 12]);
  assert.equal(parsed50.bubbles.length, 270); // 250 MCQ + 20 TF

  // 2. Legacy format with markers and bubbles
  const legacyRaw = {
    page: { width: 210, height: 297 },
    markers: {
      "0": { center: [10, 10], size: 10 },
      "1": { center: [200, 10], size: 10 },
      "2": { center: [200, 280], size: 10 },
      "3": { center: [10, 280], size: 10 }
    },
    bubbles: [
      { item: "1", choice: "A", center: [30, 50], radius: 2.1 },
      { item: "1", choice: "B", center: [35, 50], radius: 2.1 }
    ]
  };
  const parsedLegacy = parseLayout(legacyRaw);
  assert.equal(Object.keys(parsedLegacy.markers).length, 4);
  assert.equal(parsedLegacy.bubbles.length, 2);

  // 3. Answer Key parser: data/bio101_key.json
  const bioKeyRaw = JSON.parse(await readFile(resolve(root, 'data/bio101_key.json'), 'utf8'));
  const parsedKey = parseAnswerKey(bioKeyRaw);
  assert.equal(parsedKey.items['1'].answer, 'A');
  assert.equal(parsedKey.items['51'].answer, 'T');
  assert.equal(parsedKey.items['q61'].kind, 'text');
});

test('Grading and psychometrics simulation for exam-50, exam-100, quiz-tf, and quiz-bonus presets', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  const code = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => ({}) })
    },
    window: {},
    console,
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {},
    FileReader: class {}
  };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);

  const PRESETS = vm.runInContext('PRESETS', sandbox);
  const computePsychometrics = vm.runInContext('computePsychometrics', sandbox);

  for (const presetId of ['exam-50', 'exam-100', 'quiz-tf', 'quiz-bonus']) {
    const preset = PRESETS[presetId];
    const key = preset.key;
    const layout = preset.layout;

    // Simulate 10 student grades
    const grades = [];
    for (let i = 0; i < 10; i++) {
      const ability = 0.70 + (9 - i) * 0.03;
      let rawScore = 0;
      let maxScore = 0;
      const gradedItems = {};

      for (const [k, keyItem] of Object.entries(key.items)) {
        if (keyItem.kind === 'text') continue;
        const pts = keyItem.points || 1.0;
        maxScore += pts;
        const isCorrect = ((i * 17 + Number(k) * 11) % 100) < (ability * 100);
        if (isCorrect) rawScore += pts;

        gradedItems[k] = {
          expected: keyItem.answer,
          actual: isCorrect ? keyItem.answer : 'WRONG',
          isCorrect,
          pointsAwarded: isCorrect ? pts : 0,
          maxPoints: pts
        };
      }

      grades.push({
        rawScore,
        maxScore,
        percentage: (rawScore / maxScore) * 100,
        gradedItems
      });
    }

    const psych = computePsychometrics(grades, key);
    assert.ok(psych, `Psychometrics must compute for ${presetId}`);
    assert.ok(!isNaN(psych.meanScore), `Mean score must not be NaN for ${presetId}`);
    assert.ok(!isNaN(psych.median), `Median must not be NaN for ${presetId}`);
    assert.ok(!isNaN(psych.stdDev), `StdDev must not be NaN for ${presetId}`);
    assert.ok(!isNaN(psych.cronbachAlpha), `Cronbach alpha must not be NaN for ${presetId}`);
    assert.equal(psych.count, 10);
    assert.equal(Object.keys(psych.itemStats).length, Object.keys(key.items).length);
  }
});

test('detectCornerMarkers isolates 4 corner fiducials and avoids student ID bubbles in exam-100', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  const code = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => ({}) })
    },
    window: {},
    console,
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {},
    FileReader: class {}
  };
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);

  const detectCornerMarkers = vm.runInContext('detectCornerMarkers', sandbox);

  // Canvas dimensions for Letter (864 x 1118)
  const w = 864;
  const h = 1118;
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255); // White background

  // Draw 4 corner fiducials: 40x40 px squares at centers (48, 48), (816, 48), (816, 1070), (48, 1070)
  const markerCenters = [
    { x: 48, y: 48 },
    { x: 816, y: 48 },
    { x: 816, y: 1070 },
    { x: 48, y: 1070 }
  ];

  for (const mc of markerCenters) {
    for (let dy = -20; dy <= 20; dy++) {
      for (let dx = -20; dx <= 20; dx++) {
        const x = mc.x + dx;
        const y = mc.y + dy;
        if (x >= 0 && x < w && y >= 0 && y < h) {
          const idx = (y * w + x) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
        }
      }
    }
  }

  // Draw dark Student ID filled bubbles around x=50, y=160 (y = 38mm = 152px)
  for (let dy = 0; dy < 30; dy++) {
    for (let dx = 0; dx < 30; dx++) {
      const x = 50 + dx;
      const y = 160 + dy;
      const idx = (y * w + x) * 4;
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
    }
  }

  const mockCtx = {
    getImageData: () => ({ data, width: w, height: h })
  };

  const corners = detectCornerMarkers(mockCtx, w, h);
  assert.equal(corners.length, 4);

  // TL corner must be detected at (48, 48), completely unaffected by the dark bubble at y=160
  assert.ok(Math.abs(corners[0].x - 48) <= 1, `TL corner x should be ~48, got ${corners[0].x}`);
  assert.ok(Math.abs(corners[0].y - 48) <= 1, `TL corner y should be ~48, got ${corners[0].y}`);

  // TR, BR, BL
  assert.ok(Math.abs(corners[1].x - 816) <= 1, `TR corner x should be ~816, got ${corners[1].x}`);
  assert.ok(Math.abs(corners[1].y - 48) <= 1, `TR corner y should be ~48, got ${corners[1].y}`);
  assert.ok(Math.abs(corners[2].x - 816) <= 1, `BR corner x should be ~816, got ${corners[2].x}`);
  assert.ok(Math.abs(corners[2].y - 1070) <= 1, `BR corner y should be ~1070, got ${corners[2].y}`);
  assert.ok(Math.abs(corners[3].x - 48) <= 1, `BL corner x should be ~48, got ${corners[3].x}`);
  assert.ok(Math.abs(corners[3].y - 1070) <= 1, `BL corner y should be ~1070, got ${corners[3].y}`);
});

