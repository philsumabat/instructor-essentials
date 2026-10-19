import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function createMockEl() {
  const el = {
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: {},
    dataset: {},
    getContext: () => new Proxy({
      getImageData: () => ({ data: new Uint8Array(100) }),
      measureText: () => ({ width: 10 })
    }, {
      get: (t, p) => p in t ? t[p] : () => {},
      set: () => true
    }),
    setAttribute: () => {},
    removeAttribute: () => {},
    toDataURL: () => 'data:image/jpeg;base64,mock',
    innerHTML: '',
    textContent: '',
    value: '60'
  };
  return new Proxy(el, {
    get: (t, p) => p in t ? t[p] : () => {},
    set: (t, p, v) => { t[p] = v; return true; }
  });
}

function extractCheckerFunctions(htmlContent) {
  // Extract utility functions from checker.html into isolated VM context
  const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) throw new Error('No script tag found in checker.html');
  const scriptContent = scriptMatch[1];

  const fakeStorage = {};
  const mockLocalStorage = {
    getItem: (k) => fakeStorage[k] || null,
    setItem: (k, v) => { fakeStorage[k] = String(v); },
    removeItem: (k) => { delete fakeStorage[k]; },
    clear: () => { Object.keys(fakeStorage).forEach(k => delete fakeStorage[k]); }
  };

  const elementMap = new Map();
  const getOrCreateEl = (id) => {
    if (!elementMap.has(id)) elementMap.set(id, createMockEl());
    return elementMap.get(id);
  };

  const context = {
    window: {},
    document: {
      getElementById: (id) => getOrCreateEl(id),
      querySelector: () => createMockEl(),
      querySelectorAll: () => [createMockEl()],
      createElement: () => createMockEl(),
      body: createMockEl()
    },
    localStorage: mockLocalStorage,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    alert: () => {},
    confirm: () => true,
    showToast: () => {},
    Image: class { constructor() { this.width = 100; this.height = 100; } }
  };
  context.window = context;

  const vmContext = vm.createContext(context);
  try {
    vm.runInContext(scriptContent, vmContext);
  } catch (err) {
    // ignore initialization errors
  }

  return context.window;
}

test('Feature 1: Class / Offer No. Extraction, Display, and Export', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Verify parseRosterCSV parses diverse column aliases
  const ctx = extractCheckerFunctions(checkerHtml);
  assert.equal(typeof ctx.parseRosterCSV, 'function', 'parseRosterCSV is defined');

  // Standard CSV with "Class / Offer No."
  const csv1 = `Student ID,Student Name,Class / Offer No.\n10482901,Alice Walker,BIO101-SEC1\n10482902,Benjamin Carter,BIO101-SEC2\n`;
  const roster1 = ctx.parseRosterCSV(csv1);
  assert.equal(roster1.length, 2);
  assert.equal(roster1[0].id, '10482901');
  assert.equal(roster1[0].name, 'Alice Walker');
  assert.equal(roster1[0].classOffer, 'BIO101-SEC1');
  assert.equal(roster1[1].classOffer, 'BIO101-SEC2');

  // Diverse header aliases: "offerno", "section", "course"
  const csv2 = `"ID","Full Name","offer_no"\n"9911","John Doe","PHYS201-01"`;
  const roster2 = ctx.parseRosterCSV(csv2);
  assert.equal(roster2[0].classOffer, 'PHYS201-01');

  const csv3 = `id,name,Section\n"7722","Jane Roe","CHEM301-B"`;
  const roster3 = ctx.parseRosterCSV(csv3);
  assert.equal(roster3[0].classOffer, 'CHEM301-B');

  // 2. Verify downloadRosterTemplateCSV contains Class / Offer No.
  assert.ok(checkerHtml.includes('Student ID,Student Name,Class / Offer No.'), 'Roster template CSV has Class / Offer No. header');
  assert.ok(checkerHtml.includes('BIO101-SEC1'), 'Roster template CSV has sample class/offer codes');

  // 3. Verify #tab-roster and Top Performing Students headers & columns
  assert.ok(checkerHtml.includes('data-sort="classOffer">Class / Offer No.'), '#tab-roster has sortable Class / Offer No. header');
  assert.ok(checkerHtml.includes('<th>Class / Offer No.</th>'), 'Top Performing Students table has Class / Offer No. header');
  assert.ok(checkerHtml.includes('${s.classOffer || \'—\'}'), 'Top Performing Students row template renders s.classOffer');

  // 4. Verify CSV Summary export includes Class / Offer No.
  assert.ok(checkerHtml.includes('"Exam ID", "Student ID", "Student Name", "Class / Offer No.", "Raw Score"'), 'btn-export-csv includes Class / Offer No. column header');
  assert.ok(checkerHtml.includes('`"${g.classOffer || \'\'}"`'), 'btn-export-csv writes g.classOffer');

  // 5. Verify HTML export includes Class / Offer No.
  assert.ok(checkerHtml.includes('<th>Class / Offer No.</th>'), 'HTML export has Class / Offer No. header');
});

test('Feature 2: Fuzzy Written Detail Estimation & Roster Mismatch Handling', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  // 1. Levenshtein Distance & String Similarity
  assert.equal(typeof ctx.levenshteinDistance, 'function');
  assert.equal(typeof ctx.stringSimilarity, 'function');
  assert.equal(typeof ctx.findBestRosterMatch, 'function');

  assert.equal(ctx.levenshteinDistance('kitten', 'sitting'), 3);
  assert.equal(ctx.levenshteinDistance('10482901', '10482901'), 0);
  assert.equal(ctx.levenshteinDistance('10482901', '10482907'), 1);

  assert.equal(ctx.stringSimilarity('Alice Walker', 'Alice Walker'), 1.0);
  assert.ok(ctx.stringSimilarity('Alice Walker', 'Alicia Walker') > 0.8);
  assert.ok(ctx.stringSimilarity('10482901', '10482907') > 0.8);

  // 2. findBestRosterMatch with roster candidates
  const sampleRoster = [
    { id: '10482901', name: 'Alice Walker', classOffer: 'BIO101-SEC1' },
    { id: '10482902', name: 'Benjamin Carter', classOffer: 'BIO101-SEC1' },
    { id: '10482903', name: 'Chloe Davis', classOffer: 'BIO101-SEC2' },
  ];

  // Match by 1-character typo in ID
  const match1 = ctx.findBestRosterMatch('10482907', sampleRoster);
  assert.ok(match1, 'Finds match for near ID');
  assert.ok(match1.score >= 0.7);

  // Match by name partial/typo
  const match2 = ctx.findBestRosterMatch('Alice Walkr', sampleRoster);
  assert.ok(match2);
  assert.equal(match2.student.name, 'Alice Walker');
  assert.ok(match2.score >= 0.85);

  // 3. UI Elements in checker.html
  assert.ok(checkerHtml.includes('id="filter-roster-mismatches"'), 'Mismatches filter pill exists');
  assert.ok(checkerHtml.includes('id="count-roster-mismatches"'), 'Mismatches count badge exists');
  assert.ok(checkerHtml.includes('id="roster-mismatch-panel"'), 'Interactive mismatch resolution panel exists');
  assert.ok(checkerHtml.includes('id="btn-mismatch-confirm"'), 'Confirm Match button exists');
  assert.ok(checkerHtml.includes('id="btn-mismatch-assign"'), 'Assign Selected button exists');
  assert.ok(checkerHtml.includes('id="btn-mismatch-accept-new"'), 'Accept New Student button exists');

  // 4. Mismatch actions exported to window
  assert.equal(typeof ctx.confirmRosterMatch, 'function');
  assert.equal(typeof ctx.assignSelectedRosterMatch, 'function');
  assert.equal(typeof ctx.acceptNewStudent, 'function');
});

test('Feature 3: Save & Resume Progress Serialization & Restoration', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  assert.equal(typeof ctx.serializeProgressSession, 'function');
  assert.equal(typeof ctx.restoreCheckerProgress, 'function');

  // Setup mock session state
  ctx.state.layout = { id: 'exam-50', title: 'Biology Midterm Exam' };
  ctx.state.key = {
    title: 'Biology Key',
    items: {
      '1': { answer: 'A', points: 1.0 },
      '2': { answer: 'B', points: 1.0 },
    }
  };
  ctx.state.roster = [
    { id: '10482901', name: 'Alice Walker', classOffer: 'BIO101-SEC1' }
  ];
  ctx.state.rosterFilter = 'mismatches';
  ctx.state.activeTab = 'horizontal';
  ctx.state.results = {
    passThreshold: 65,
    psychometrics: { meanScore: 1.5, totalPossible: 2.0, cronbachAlpha: 0.85, stdDev: 0.5, median: 2.0 },
    grades: [
      {
        examId: 'scan_01.jpg',
        studentId: '10482901',
        studentName: 'Alice Walker',
        classOffer: 'BIO101-SEC1',
        rawScore: 2.0,
        maxScore: 2.0,
        percentage: 100.0,
        gradedItems: {
          '1': { pointsAwarded: 1.0, maxPoints: 1.0, isCorrect: true, reviewed: true },
          '2': { pointsAwarded: 1.0, maxPoints: 1.0, isCorrect: true, reviewed: true }
        },
        bubbleDiagnostics: [],
        reviewFlags: { needsReview: false, reasons: [], isMismatch: false }
      }
    ]
  };

  // 1. Serialize session
  const serialized = ctx.serializeProgressSession();
  assert.ok(serialized, 'Serialization succeeds');
  assert.equal(serialized.version, 1);
  assert.equal(serialized.layout.id, 'exam-50');
  assert.equal(serialized.rosterFilter, 'mismatches');
  assert.equal(serialized.activeTab, 'horizontal');
  assert.equal(serialized.results.grades[0].classOffer, 'BIO101-SEC1');
  assert.equal(serialized.results.grades[0].percentage, 100.0);

  // 2. Restore session into fresh context
  const ctx2 = extractCheckerFunctions(checkerHtml);
  ctx2.restoreCheckerProgress(serialized);
  assert.equal(ctx2.state.layout.id, 'exam-50');
  assert.equal(ctx2.state.roster[0].classOffer, 'BIO101-SEC1');
  assert.equal(ctx2.state.results.grades.length, 1);
  assert.equal(ctx2.state.results.grades[0].classOffer, 'BIO101-SEC1');
  assert.equal(ctx2.state.results.grades[0].rawScore, 2.0);

  // 3. Verify .grader.progress.json filename convention
  assert.ok(checkerHtml.includes('.grader.progress.json'), 'Saves with .grader.progress.json convention');
});

test('Feature 4: Horizontal Grading (Item-by-Item) Controller, Rubrics & Actions', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  // 1. DOM elements exist in checker.html
  assert.ok(checkerHtml.includes('id="tab-btn-horizontal"'), 'Horizontal tab navigation button exists');
  assert.ok(checkerHtml.includes('id="tab-horizontal"'), 'Tab pane #tab-horizontal exists');
  assert.ok(checkerHtml.includes('id="select-horizontal-item"'), 'Item selector dropdown exists');
  assert.ok(checkerHtml.includes('id="btn-horizontal-item-prev"'), 'Item previous button exists');
  assert.ok(checkerHtml.includes('id="btn-horizontal-item-next"'), 'Item next button exists');
  assert.ok(checkerHtml.includes('id="btn-horizontal-accept-all"'), 'Accept all unreviewed button exists');
  assert.ok(checkerHtml.includes('id="horizontal-prompt-card"'), 'Item prompt & rubric card exists');
  assert.ok(checkerHtml.includes('id="horizontal-submissions-container"'), 'Submissions stream container exists');

  // 2. Functions exported to window
  assert.equal(typeof ctx.getHorizontalGradingItems, 'function');
  assert.equal(typeof ctx.gradeHorizontalItem, 'function');
  assert.equal(typeof ctx.acceptAllUnreviewedHorizontal, 'function');
  assert.equal(typeof ctx.renderHorizontalGradingView, 'function');

  // 3. Test horizontal item extraction from layout ROIs
  ctx.state.layout = {
    title: 'Short Answer Test',
    zones: [
      {
        id: 'written-1',
        type: 'text_short',
        rois: [
          { key: 'q51', id: 'q51', label: 'Item 51', points: 3.0, graded: true, charset: 'text' }
        ]
      }
    ]
  };
  ctx.state.key = {
    items: {
      'q51': { answer: 'Photosynthesis', points: 3.0, kind: 'text' }
    }
  };

  const hItems = ctx.getHorizontalGradingItems();
  assert.ok(hItems.length >= 1);
  const q51 = hItems.find(it => it.key === 'q51');
  assert.ok(q51);
  assert.equal(q51.points, 3.0);
  assert.equal(q51.expected, 'Photosynthesis');

  // 4. Test grading action updates student score, maxScore, and status
  ctx.state.results = {
    passThreshold: 60,
    grades: [
      {
        examId: 'scan_01.jpg',
        studentId: '10482901',
        studentName: 'Alice Walker',
        rawScore: 0.0,
        maxScore: 3.0,
        percentage: 0.0,
        gradedItems: {
          'q51': {
            status: 'unreviewed',
            pointsAwarded: 0,
            maxPoints: 3.0,
            reviewed: false,
            ocrText: 'photosynthesis'
          }
        }
      }
    ]
  };

  // Grade as accept (+3.0 pts)
  ctx.gradeHorizontalItem(0, 'q51', 'accept');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].status, 'accepted');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].pointsAwarded, 3.0);
  assert.equal(ctx.state.results.grades[0].rawScore, 3.0);
  assert.equal(ctx.state.results.grades[0].maxScore, 3.0);
  assert.equal(ctx.state.results.grades[0].percentage, 100.0);

  // Grade as partial (+1.5 pts)
  ctx.gradeHorizontalItem(0, 'q51', 'partial');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].status, 'partial');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].pointsAwarded, 1.5);
  assert.equal(ctx.state.results.grades[0].rawScore, 1.5);
  assert.equal(ctx.state.results.grades[0].percentage, 50.0);

  // Grade as reject (0 pts)
  ctx.gradeHorizontalItem(0, 'q51', 'reject');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].status, 'rejected');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].pointsAwarded, 0);
  assert.equal(ctx.state.results.grades[0].rawScore, 0);
  assert.equal(ctx.state.results.grades[0].percentage, 0.0);

  // 5. Test acceptAllUnreviewedHorizontal
  ctx.state.results.grades[0].gradedItems['q51'].status = 'unreviewed';
  ctx.state.results.grades[0].gradedItems['q51'].reviewed = false;
  ctx.acceptAllUnreviewedHorizontal('q51');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].status, 'accepted');
  assert.equal(ctx.state.results.grades[0].rawScore, 3.0);
});

test('Feature 5: Anti-Slop & UI Quality Standards', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Zero raw floppy emoji in banner-resume-session (crisp SVG used)
  assert.ok(!checkerHtml.includes('>💾<'), 'No raw floppy emoji in resume banner');
  assert.ok(checkerHtml.includes('id="banner-resume-session"'), 'Resume banner present');
  assert.match(checkerHtml, /id="banner-resume-session"[\s\S]*?<svg[\s\S]*?<\/svg>/, 'Resume banner contains SVG icon');

  // 2. Horizontal buttons have :focus-visible states
  assert.ok(checkerHtml.includes('.btn-horizontal-accept:focus-visible'), 'btn-horizontal-accept has :focus-visible');
  assert.ok(checkerHtml.includes('.btn-horizontal-partial:focus-visible'), 'btn-horizontal-partial has :focus-visible');
  assert.ok(checkerHtml.includes('.btn-horizontal-reject:focus-visible'), 'btn-horizontal-reject has :focus-visible');

  // 3. Horizontal grading cards use SVG icons in action buttons
  assert.match(checkerHtml, /btn-horizontal-accept[\s\S]*?<svg/, 'Accept button contains SVG icon');
  assert.match(checkerHtml, /btn-horizontal-partial[\s\S]*?<svg/, 'Partial button contains SVG icon');
  assert.match(checkerHtml, /btn-horizontal-reject[\s\S]*?<svg/, 'Reject button contains SVG icon');

  // 4. Low OCR Conf badge uses inline SVG icon
  assert.match(checkerHtml, /Low OCR Conf[\s\S]*?<svg/, 'Low OCR confidence badge contains SVG icon');
});

test('Feature 6: Asynchronous batch grading execution, UI progress updating, and main-thread non-blocking guarantee', async () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Progress DOM element structure present
  assert.ok(checkerHtml.includes('id="grading-progress"'), 'grading-progress bar container present');
  assert.ok(checkerHtml.includes('id="grading-progress-inner"'), 'grading-progress-inner fill element present');
  assert.ok(checkerHtml.includes('id="grading-progress-text"'), 'grading-progress-text status label present');

  // 2. Verified across standalone files
  const docsCheckerHtml = fs.readFileSync(path.join(rootDir, 'docs/checker.html'), 'utf8');
  assert.ok(docsCheckerHtml.includes('id="grading-progress-text"'), 'docs/checker.html contains grading-progress-text');
  const desktopCheckerHtml = fs.readFileSync(path.join(rootDir, 'apps/desktop/ui/checker.html'), 'utf8');
  assert.ok(desktopCheckerHtml.includes('id="grading-progress-text"'), 'apps/desktop/ui/checker.html contains grading-progress-text');

  // 3. Execution of async grading in VM sandbox
  const ctx = extractCheckerFunctions(checkerHtml);
  assert.equal(typeof ctx.window.yieldToMain, 'function', 'yieldToMain function must be exported and callable');

  let yieldCount = 0;
  const origYield = ctx.window.yieldToMain;
  ctx.window.yieldToMain = async () => {
    yieldCount++;
    return origYield();
  };

  // Mock layout, key, and scans
  ctx.state.layout = {
    page: { width: 210, height: 297 },
    markers: {
      "0": { center: [10, 10] },
      "1": { center: [200, 10] },
      "2": { center: [200, 280] },
      "3": { center: [10, 280] }
    },
    bubbles: [
      { item: "1", choice: "A", center: [30, 40], radius: 2 },
      { item: "1", choice: "B", center: [35, 40], radius: 2 }
    ]
  };
  ctx.state.key = {
    items: {
      "1": { answer: "A", points: 1, kind: "mcq" }
    }
  };
  ctx.state.scans = [
    { name: "scan_01.jpg", img: { width: 400, height: 600 } },
    { name: "scan_02.jpg", img: { width: 400, height: 600 } }
  ];

  const btnGrade = ctx.document.getElementById('btn-grade-now');
  assert.equal(typeof btnGrade.onclick, 'function', 'btn-grade-now onclick handler must be attached');

  // Trigger grading
  const promise = btnGrade.onclick();
  assert.ok(promise && typeof promise.then === 'function', 'btn-grade-now.onclick must return a Promise (async function)');

  // Verify concurrency locks while grading is active
  assert.equal(ctx.state.isGrading, true, 'isGrading flag must be true during active grading');
  const initialScanCount = ctx.state.scans.length;
  if (typeof ctx.window.removeScan === 'function') {
    ctx.window.removeScan(0);
    assert.equal(ctx.state.scans.length, initialScanCount, 'removeScan must be ignored while grading is active');
  }

  await promise;

  // Verify non-blocking yields happened (initial yield + 2 per scan + finalization yield)
  assert.ok(yieldCount >= 5, `Expected at least 5 cooperative yields to main thread, got ${yieldCount}`);
  assert.equal(ctx.state.isGrading, false, 'isGrading flag must be reset to false after completion');
  assert.ok(ctx.state.results, 'Grading results must be populated');
  assert.equal(ctx.state.results.grades.length, 2, 'Two scans must be graded');

  // 4. Test error resilience: a scan failure does not crash the entire batch
  const badCtx = extractCheckerFunctions(checkerHtml);
  badCtx.state.layout = ctx.state.layout;
  badCtx.state.key = ctx.state.key;
  badCtx.state.scans = [
    { name: "corrupt_scan.jpg", img: null }, // Corrupt scan: null img
    { name: "valid_scan.jpg", img: { width: 400, height: 600 } }
  ];
  const badBtnGrade = badCtx.document.getElementById('btn-grade-now');
  await badBtnGrade.onclick();
  assert.equal(badCtx.state.isGrading, false, 'isGrading reset even when a scan fails');
  assert.equal(badCtx.state.results.grades.length, 2, 'Both scans processed without throwing exception');
  assert.equal(badCtx.state.results.grades[0].reviewFlags.needsReview, true, 'Corrupt scan marked for review');
  assert.ok(badCtx.state.results.grades[0].reviewFlags.reasons.some(r => r.includes('Scan processing error')), 'Review reasons include error description');

  // 5. Test fast auto-save in serializeProgressSession
  const autoSaved = badCtx.serializeProgressSession();
  assert.equal(autoSaved.results.grades[0].scanData, null, 'Auto-save avoids expensive base64 encoding by default');
  const exportSaved = badCtx.serializeProgressSession({ includeImages: true });
  assert.ok(exportSaved, 'Explicit image export option supported');
});

