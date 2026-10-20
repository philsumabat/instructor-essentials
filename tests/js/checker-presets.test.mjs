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
  assert.equal(p100.layout.bubbles.length, 400); // 100 MCQ items * 4 options
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

test('checker.html implements responsive split master-detail layout with Sheet Inspector preview pane in #tab-roster', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify responsive split layout DOM structure
  assert.ok(checkerHtml.includes('roster-split-layout'), 'Master-detail split layout class present');
  assert.ok(checkerHtml.includes('roster-table-col'), 'Left table column present');
  assert.ok(checkerHtml.includes('roster-preview-pane'), 'Right sheet inspector preview pane present');
  // Verify canvas element supports #roster-preview-canvas
  assert.ok(checkerHtml.includes('id="roster-preview-canvas"'), 'Side preview canvas element (#roster-preview-canvas) present');
  assert.ok(checkerHtml.includes('id="roster-inspector-canvas"'), 'Legacy alias id="roster-inspector-canvas" supported');
});

test('checker.html Tab 1 has metric cards, Pass/Fail distribution bar, and summary table with switchTab navigation', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Metric cards
  assert.ok(checkerHtml.includes('Total Graded'), 'Metric card Total Graded present');
  assert.ok(checkerHtml.includes('Average Score'), 'Metric card Average Score present');
  assert.ok(checkerHtml.includes('Pass Rate'), 'Metric card Pass Rate present');
  assert.ok(checkerHtml.includes('Reliability KR-20'), 'Metric card Reliability KR-20 present');

  // 2. Pass/Fail distribution bar
  assert.ok(checkerHtml.includes('id="distribution-card"'), 'Distribution card container present');
  assert.ok(checkerHtml.includes('id="dist-bar-pass"'), 'Pass distribution bar element present');
  assert.ok(checkerHtml.includes('id="dist-bar-fail"'), 'Fail distribution bar element present');
  assert.ok(checkerHtml.includes('id="dist-label-pass"'), 'Pass label present');
  assert.ok(checkerHtml.includes('id="dist-label-fail"'), 'Fail label present');
  assert.ok(checkerHtml.includes('id="dist-label-threshold"'), 'Threshold label present');

  // 3. Summary table and row click
  assert.ok(checkerHtml.includes('id="table-summary-preview"'), 'Summary preview table present');
  assert.ok(checkerHtml.includes("switchTab('roster')"), 'Summary table row click switches to roster tab');
});

test('checker.html Tab 2 supports table sorting, master-detail selection, side preview canvas (#roster-preview-canvas), student badge, JPEG and ZIP export', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify sortable table headers
  assert.ok(checkerHtml.includes('th class="sortable" data-sort="studentId"'), 'Sortable studentId header present');
  assert.ok(checkerHtml.includes('th class="sortable" data-sort="rawScore"'), 'Sortable rawScore header present');
  assert.ok(checkerHtml.includes('th class="sortable" data-sort="percentage"'), 'Sortable percentage header present');
  assert.ok(checkerHtml.includes('th class="sortable" data-sort="status"'), 'Sortable status header present');

  // Compile script to test sortGrades function
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block present');
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

  const sortGrades = vm.runInContext('sortGrades', sandbox);
  assert.ok(typeof sortGrades === 'function', 'sortGrades helper function defined');

  // Test sorting by score
  const sampleGrades = [
    { studentId: '1002', studentName: 'Bob', rawScore: 40, percentage: 80 },
    { studentId: '1001', studentName: 'Alice', rawScore: 45, percentage: 90 },
    { studentId: '1003', studentName: 'Charlie', rawScore: 35, percentage: 70 }
  ];

  const sortedDesc = sortGrades(sampleGrades, 'rawScore', 'desc');
  assert.equal(sortedDesc[0].studentId, '1001');
  assert.equal(sortedDesc[1].studentId, '1002');
  assert.equal(sortedDesc[2].studentId, '1003');

  const sortedAsc = sortGrades(sampleGrades, 'studentName', 'asc');
  assert.equal(sortedAsc[0].studentName, 'Alice');
  assert.equal(sortedAsc[1].studentName, 'Bob');
  assert.equal(sortedAsc[2].studentName, 'Charlie');

  // Verify export buttons
  assert.ok(checkerHtml.includes('id="btn-export-zip"'), 'Batch ZIP export button present');
  assert.ok(checkerHtml.includes('createZip'), 'createZip uncompressed ZIP generator present');
});

test('parseRosterCSV handles standard, RFC 4180 quotes with commas, and matches student names accurately', async () => {
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

  const parseRosterCSV = vm.runInContext('parseRosterCSV', sandbox);

  // 1. Standard CSV
  const csv1 = `Student ID,Full Name,Section
10482901,Alice Walker,A1
10482902,Benjamin Carter,A1`;
  const roster1 = parseRosterCSV(csv1);
  assert.equal(roster1.length, 2);
  assert.equal(roster1[0].id, '10482901');
  assert.equal(roster1[0].name, 'Alice Walker');

  // 2. CSV with quotes containing commas ("Last, First")
  const csv2 = `Student ID,Student Name
10482901,"Walker, Alice"
10482902,"Carter, Benjamin"`;
  const roster2 = parseRosterCSV(csv2);
  assert.equal(roster2.length, 2);
  assert.equal(roster2[0].id, '10482901');
  assert.equal(roster2[0].name, 'Walker, Alice');
  assert.equal(roster2[1].id, '10482902');
  assert.equal(roster2[1].name, 'Carter, Benjamin');

  // 3. Alternate headers (ID, Name)
  const csv3 = `id,name
10482905,Elena Foster`;
  const roster3 = parseRosterCSV(csv3);
  assert.equal(roster3.length, 1);
  assert.equal(roster3[0].id, '10482905');
  assert.equal(roster3[0].name, 'Elena Foster');
});

test('Tab 3 Item Analysis properly renders True/False vs MCQ headers and per-item distractor frequencies', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify headers container
  assert.ok(checkerHtml.includes('id="th-d1"'), 'th-d1 header present');
  assert.ok(checkerHtml.includes('id="th-d2"'), 'th-d2 header present');
  assert.ok(checkerHtml.includes('id="th-d3"'), 'th-d3 header present');
  assert.ok(checkerHtml.includes('id="th-d4"'), 'th-d4 header present');
  assert.ok(checkerHtml.includes('id="th-d5"'), 'th-d5 header present');
  assert.ok(checkerHtml.includes('id="tbody-items"'), 'Item analysis table body present');

  // Check script logic distinguishes pure TF vs mixed/MCQ
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  const code = scriptMatch[1];
  assert.ok(code.includes('allTF'), 'distinguishes all-TF pure exams');
  assert.ok(code.includes('isItemTF'), 'distinguishes individual item type for distractors');
});

test('checker.html is 100% offline self-contained with zero external fetch, script, or link tags', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Zero external stylesheet links
  const extStyles = [...checkerHtml.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  assert.equal(extStyles.length, 0, 'No external stylesheets');

  // Zero external scripts
  const extScripts = [...checkerHtml.matchAll(/<script\s+[^>]*src=[^>]*>/gi)];
  assert.equal(extScripts.length, 0, 'No external scripts');

  // Zero fetch() calls
  assert.ok(!checkerHtml.includes('fetch('), 'Must not use fetch() calls');
});

test('checker.html is rebranded to Instructor Essentials in title, meta tags, and header brand', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  assert.ok(checkerHtml.includes('<title>Instructor Essentials — Checker Studio</title>'), 'Document title must be rebranded');
  assert.ok(checkerHtml.includes('<meta name="application-name" content="Instructor Essentials">'), 'Application-name meta tag present');
  assert.ok(checkerHtml.includes('<meta name="description" content="Instructor Essentials — In-Browser OMR Exam Grading & Psychometrics">'), 'Description meta tag present');
  assert.ok(checkerHtml.includes('<h1 class="app-brand__title">Instructor Essentials</h1>'), 'Brand heading must be Instructor Essentials');
});

test('checker.html implements progressive disclosure in sidebar, modular upload cards, and prominent results export bar', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Sidebar initial buttons
  assert.ok(checkerHtml.includes('id="btn-sidebar-grade"'), 'Sidebar Grade Scans button present');
  assert.ok(checkerHtml.includes('id="btn-sidebar-sample"'), 'Sidebar 1-Click Sample Test button present');

  // Modular upload cards in sidebar
  assert.ok(checkerHtml.includes('id="card-layout-quick"'), 'Exam layout card present');
  assert.ok(checkerHtml.includes('id="card-key-quick"'), 'Answer key card present');
  assert.ok(!checkerHtml.includes('id="card-roster-quick"'), 'Student roster card removed');
  assert.ok(checkerHtml.includes('id="card-scans-quick"'), 'Exam scans card present');

  // Class modifiers for progressive disclosure
  assert.ok(checkerHtml.includes('card--grading-settings'), 'Grading settings card has progressive disclosure class');
  assert.ok(checkerHtml.includes('card--export-reports'), 'Export reports card has progressive disclosure class');
  assert.ok(checkerHtml.includes('body:not(.has-data) .card--grading-settings'), 'CSS hides grading settings in initial state');
  assert.ok(checkerHtml.includes('body:not(.has-data) .card--export-reports'), 'CSS hides export reports in initial state');

  // Results view prominent export bar
  assert.ok(checkerHtml.includes('id="results-export-bar"'), 'Results prominent export bar container present');
  assert.ok(checkerHtml.includes('id="btn-results-export-zip"'), 'Prominent ZIP export button present');
  assert.ok(checkerHtml.includes('id="btn-results-export-csv"'), 'Prominent CSV export button present');
  assert.ok(checkerHtml.includes('id="btn-results-export-html"'), 'Prominent HTML export button present');
});

test('checker.html renders SVG Bell Curve with histogram, Gaussian curve, cutoff, and plain-language summary', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // DOM elements
  assert.ok(checkerHtml.includes('id="dist-bell-curve-container"'), 'Bell curve container present');
  assert.ok(checkerHtml.includes('id="dist-bell-curve-narrative"'), 'Bell curve plain-language narrative present');

  // Script logic verification
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block present');
  const code = scriptMatch[1];

  let renderedSvg = '';
  let renderedNarrative = '';

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'dist-bell-curve-container') {
          return { set innerHTML(val) { renderedSvg = val; }, get innerHTML() { return renderedSvg; } };
        }
        if (id === 'dist-bell-curve-narrative') {
          return { set innerHTML(val) { renderedNarrative = val; }, get innerHTML() { return renderedNarrative; } };
        }
        return { style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {} } };
      },
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { add: () => {}, remove: () => {} } }),
      createElement: () => ({ getContext: () => ({}), style: {} }),
      body: { classList: { add: () => {}, remove: () => {} } }
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

  const renderBellCurve = vm.runInContext('renderBellCurve', sandbox);
  assert.ok(typeof renderBellCurve === 'function', 'renderBellCurve function defined');

  // Simulate cohort scores
  const sampleGrades = [
    { percentage: 65 }, { percentage: 70 }, { percentage: 75 },
    { percentage: 80 }, { percentage: 85 }, { percentage: 90 },
    { percentage: 55 }, { percentage: 78 }, { percentage: 82 }, { percentage: 95 }
  ];

  renderBellCurve(sampleGrades, 70);

  // Verify SVG output contains histogram rects, Gaussian path, mean line, cutoff line, +/-1sigma
  assert.ok(renderedSvg.includes('<svg'), 'SVG element generated');
  assert.ok(renderedSvg.includes('rect'), 'Histogram bar rects generated');
  assert.ok(renderedSvg.includes('path'), 'Fitted normal curve path generated');
  assert.ok(renderedSvg.includes('Cutoff: 70%'), 'Pass threshold cutoff label rendered');
  assert.ok(renderedSvg.includes('Mean:'), 'Mean label rendered');
  assert.ok(renderedSvg.includes('±1σ'), 'Standard deviation ±1σ rendered');
  assert.ok(renderedNarrative.includes('Cohort Bell Curve Distribution:'), 'Plain language explanation rendered');
});

test('validatePreflightKeyLayout detects key-layout mismatches and displays warning banner', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // DOM elements
  assert.ok(checkerHtml.includes('id="preflight-warning-banner"'), 'Preflight warning banner element present');
  assert.ok(checkerHtml.includes('id="preflight-warning-text"'), 'Preflight warning text element present');

  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block present');
  const code = scriptMatch[1];

  let bannerDisplay = 'none';
  let warningHtml = '';

  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'preflight-warning-banner') {
          return { style: { set display(val) { bannerDisplay = val; }, get display() { return bannerDisplay; } } };
        }
        if (id === 'preflight-warning-text') {
          return { set innerHTML(val) { warningHtml = val; }, get innerHTML() { return warningHtml; } };
        }
        return { style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {} } };
      },
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { add: () => {}, remove: () => {} } }),
      createElement: () => ({ getContext: () => ({}), style: {} }),
      body: { classList: { add: () => {}, remove: () => {} } }
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

  const validatePreflightKeyLayout = vm.runInContext('validatePreflightKeyLayout', sandbox);
  const state = vm.runInContext('state', sandbox);

  // Case 1: Layout has 50 items (1..50), Key has only 30 items (1..30)
  state.layout = {
    bubbles: Array.from({ length: 50 }, (_, i) => ({
      item: String(i + 1),
      choice: 'A'
    }))
  };
  state.key = {
    items: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
      String(i + 1), { answer: 'A', points: 1, kind: 'mcq' }
    ]))
  };

  const isValid = validatePreflightKeyLayout();
  assert.equal(isValid, false, 'Validation must fail when items are unkeyed');
  assert.equal(bannerDisplay, 'flex', 'Warning banner must be displayed');
  assert.ok(warningHtml.includes('unkeyed'), 'Warning text must mention unkeyed questions');
  assert.ok(warningHtml.includes('0 pts'), 'Warning text must explain unkeyed items score 0 pts');
  assert.ok(warningHtml.includes('31–50'), 'Warning text must identify question range 31–50');

  // Case 2: Matching layout and key
  state.key = {
    items: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [
      String(i + 1), { answer: 'A', points: 1, kind: 'mcq' }
    ]))
  };

  const isMatched = validatePreflightKeyLayout();
  assert.equal(isMatched, true, 'Validation must succeed when key matches layout');
  assert.equal(bannerDisplay, 'none', 'Warning banner must be hidden when aligned');
});

test('processExamScan calculates reviewFlags for blanks, multi-marks, and unmatched IDs', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Badge class present in CSS and DOM
  assert.ok(checkerHtml.includes('.badge-review'), 'badge-review CSS class present');
  assert.ok(checkerHtml.includes('id="roster-badge-review"'), 'roster-badge-review element present in sheet inspector');

  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block present');
  const code = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {} } }),
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { add: () => {}, remove: () => {} } }),
      createElement: () => ({
        width: 100, height: 100,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(400) })
        }),
        style: {}
      }),
      body: { classList: { add: () => {}, remove: () => {} } }
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

  const processExamScan = vm.runInContext('processExamScan', sandbox);
  const state = vm.runInContext('state', sandbox);

  // Setup simple layout and key
  const mockLayout = {
    page: { width: 210, height: 297 },
    markers: {
      "0": { center: [10, 10] },
      "1": { center: [200, 10] },
      "2": { center: [200, 280] },
      "3": { center: [10, 280] }
    },
    bubbles: [
      { item: "1", choice: "A", center: [30, 40], radius: 2 },
      { item: "1", choice: "B", center: [35, 40], radius: 2 },
      { item: "2", choice: "A", center: [30, 50], radius: 2 },
      { item: "2", choice: "B", center: [35, 50], radius: 2 }
    ]
  };

  const mockKey = {
    items: {
      "1": { answer: "A", points: 1, kind: "mcq" },
      "2": { answer: "B", points: 1, kind: "mcq" }
    }
  };

  state.roster = [{ id: "10482901", name: "Alice Walker" }];

  const mockScan = {
    name: "scan_01_99999999.jpg", // ID not in roster -> unmatched
    img: { width: 400, height: 600 }
  };

  const grade = processExamScan(mockScan, mockLayout, mockKey, 0.20);
  assert.ok(grade.reviewFlags, 'grade must include reviewFlags');
  assert.equal(grade.reviewFlags.needsReview, true, 'Student with unmatched ID or blanks must need review');
  assert.ok(grade.reviewFlags.reasons.length > 0, 'reviewFlags must provide clear reasons');
});

test('processExamScan succeeds seamlessly when state.roster is null or empty', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  const code = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({
        width: 100,
        height: 100,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(400) })
        }),
        style: {}
      })
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

  const script = new vm.Script(code);
  const context = vm.createContext(sandbox);
  script.runInContext(context);

  const state = vm.runInContext('state', context);
  const processExamScan = vm.runInContext('processExamScan', context);

  const mockLayout = {
    page: { width: 210, height: 297 },
    markers: {
      "0": { center: [10, 10] },
      "1": { center: [200, 10] },
      "2": { center: [200, 280] },
      "3": { center: [10, 280] }
    },
    bubbles: [
      { item: "1", choice: "A", center: [30, 40], radius: 2 }
    ]
  };

  const mockKey = {
    items: {
      "1": { answer: "A", points: 1, kind: "mcq" }
    }
  };

  const mockScan = {
    name: "scan_01_10482901.jpg",
    img: { width: 400, height: 600 }
  };

  // 1. When state.roster is null (default state when user never uploads a roster)
  state.roster = null;
  const gradeNoRoster = processExamScan(mockScan, mockLayout, mockKey, 0.20);
  assert.ok(gradeNoRoster, 'Must return grade object when state.roster is null');
  assert.equal(gradeNoRoster.studentId, '10482901');
  assert.equal(gradeNoRoster.studentName, 'Student 10482901');

  // 2. When state.roster is empty array []
  state.roster = [];
  const gradeEmptyRoster = processExamScan(mockScan, mockLayout, mockKey, 0.20);
  assert.ok(gradeEmptyRoster, 'Must return grade object when state.roster is []');
  assert.equal(gradeEmptyRoster.studentId, '10482901');
  assert.equal(gradeEmptyRoster.studentName, 'Student 10482901');
});



