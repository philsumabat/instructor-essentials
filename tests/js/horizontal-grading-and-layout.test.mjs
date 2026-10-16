import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildLayout, layoutStats } from '../../builder/js/layout-engine.js';
import { SAMPLE_TEMPLATES } from '../../builder/js/templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function createMockEl(id = '') {
  const el = {
    id,
    addEventListener: () => {},
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c) { if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c); },
      contains(c) { return this._classes.has(c); }
    },
    style: {},
    dataset: {},
    getContext: () => ({
      getImageData: () => ({ data: new Uint8Array(100) }),
      measureText: () => ({ width: 10 }),
      fillRect: () => {},
      fillText: () => {},
      drawImage: () => {}
    }),
    setAttribute: () => {},
    removeAttribute: () => {},
    toDataURL: () => 'data:image/jpeg;base64,mock',
    scrollIntoView: () => {},
    innerHTML: '',
    textContent: '',
    value: ''
  };
  return el;
}

function extractCheckerFunctions(htmlContent) {
  const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) throw new Error('No script tag found in checker.html');
  const scriptContent = scriptMatch[1];

  const elementsMap = new Map();
  function getOrCreate(id) {
    if (!elementsMap.has(id)) {
      elementsMap.set(id, createMockEl(id));
    }
    return elementsMap.get(id);
  }

  const fakeStorage = {};
  const mockLocalStorage = {
    getItem: (k) => fakeStorage[k] || null,
    setItem: (k, v) => { fakeStorage[k] = String(v); },
    removeItem: (k) => { delete fakeStorage[k]; },
    clear: () => { Object.keys(fakeStorage).forEach(k => delete fakeStorage[k]); }
  };

  const context = {
    window: {},
    document: {
      getElementById: (id) => getOrCreate(id),
      querySelector: (sel) => {
        const idMatch = sel.match(/^#([\w-]+)$/);
        return idMatch ? getOrCreate(idMatch[1]) : createMockEl();
      },
      querySelectorAll: (sel) => [createMockEl()],
      createElement: (tag) => createMockEl(tag),
      body: createMockEl('body')
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
  } catch (_) {}

  return context.window;
}

test('Feature 1: Separate Horizontal Grading Button and Summary Banner', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // Prominent button in results export bar
  assert.ok(checkerHtml.includes('id="btn-results-horizontal-grading"'), 'Results export bar contains Horizontal Grading button');
  assert.ok(checkerHtml.includes('id="badge-header-horizontal-count"'), 'Header count badge exists for horizontal grading');

  // Summary callout banner
  assert.ok(checkerHtml.includes('id="banner-horizontal-review"'), 'Summary callout banner for horizontal grading exists');
  assert.ok(checkerHtml.includes('id="btn-banner-horizontal-open"'), 'Button to open horizontal grading from summary banner exists');

  // Tab button in tabs bar
  assert.ok(checkerHtml.includes('id="tab-btn-horizontal"'), 'Tabs bar contains Horizontal Grading tab button');
  assert.ok(checkerHtml.includes('id="badge-horizontal-count"'), 'Tab badge count exists for horizontal items');
});

test('Feature 2: Layout Question Counter & getLayoutQuestionItems Recognition', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  assert.equal(typeof ctx.getLayoutQuestionItems, 'function', 'getLayoutQuestionItems is defined on window');

  // 1. Layout with both bubbles and short-answer / essay / modified_tf ROIs
  const mixedLayout = {
    title: 'Mixed Exam',
    paper: 'A4',
    bubbles: [
      { item: '1', choice: 'A', center: [10, 10], radius: 2.1 },
      { item: '1', choice: 'B', center: [15, 10], radius: 2.1 },
      { item: '2', choice: 'T', center: [10, 20], radius: 2.1 },
      { item: '2', choice: 'F', center: [15, 20], radius: 2.1 },
      { item: 'sid[0]', choice: '1', center: [10, 30], radius: 2.1 } // SID bubble should be excluded
    ],
    rois: [
      { key: 'q3', id: 'q3', label: '3.', points: 2.0, graded: true, type: 'text_short', x: 20, y: 50, w: 60, h: 8 },
      { key: 'q4', id: 'q4', label: '4.', points: 5.0, role: 'correction', x: 20, y: 70, w: 80, h: 12 },
      { key: 'sid_crop', id: 'sid_crop', role: 'student_id', x: 10, y: 10, w: 50, h: 10 } // Excluded non-question ROI
    ]
  };

  const items = ctx.getLayoutQuestionItems(mixedLayout);
  assert.equal(items.length, 4, 'Includes 2 bubble items and 2 graded ROIs (excluding SID)');

  const q1 = items.find(it => it.key === '1');
  assert.ok(q1);
  assert.equal(q1.kind, 'mcq');
  assert.equal(Array.from(q1.choices).join(','), 'A,B');

  const q2 = items.find(it => it.key === '2');
  assert.ok(q2);
  assert.equal(q2.kind, 'tf');

  const q3 = items.find(it => it.key === 'q3');
  assert.ok(q3);
  assert.equal(q3.kind, 'text');
  assert.equal(q3.points, 2.0);
  assert.equal(q3.label, '3', 'Trailing dot stripped from label');

  const q4 = items.find(it => it.key === 'q4');
  assert.ok(q4);
  assert.equal(q4.kind, 'text');
  assert.equal(q4.points, 5.0);
  assert.equal(q4.type, 'correction');
  assert.equal(q4.label, '4', 'Trailing dot stripped from label');

  // 2. Pure written exam (0 bubbles, 3 written ROIs)
  const writtenLayout = {
    title: 'Essay Exam',
    bubbles: [],
    rois: [
      { key: 'e1', id: 'e1', label: 'Essay 1', points: 10.0, graded: true, type: 'text_essay' },
      { key: 'e2', id: 'e2', label: 'Essay 2', points: 10.0, graded: true, type: 'text_essay' }
    ]
  };
  const writtenItems = ctx.getLayoutQuestionItems(writtenLayout);
  assert.equal(writtenItems.length, 2, 'Extracts question items from pure written layout');
});

test('Feature 3: Unsure Choice with Flag to Revisit Later', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  ctx.state.layout = {
    title: 'Short Answer Test',
    zones: [{
      id: 'written-zone',
      type: 'text_short',
      rois: [{ key: 'q51', id: 'q51', label: '51', points: 2.0, graded: true }]
    }]
  };
  ctx.state.key = {
    items: {
      'q51': { answer: 'Mitochondria', points: 2.0, kind: 'text' }
    }
  };
  ctx.state.results = {
    passThreshold: 60,
    grades: [{
      examId: 'scan_01.jpg',
      studentId: '10482901',
      studentName: 'Alice Walker',
      rawScore: 0.0,
      maxScore: 2.0,
      percentage: 0.0,
      gradedItems: {
        'q51': { status: 'unreviewed', pointsAwarded: 0, maxPoints: 2.0, reviewed: false }
      }
    }]
  };

  // Grade item with 'unsure'
  ctx.gradeHorizontalItem(0, 'q51', 'unsure');

  const gradedItem = ctx.state.results.grades[0].gradedItems['q51'];
  assert.equal(gradedItem.status, 'unsure', 'Status is marked as unsure');
  assert.equal(gradedItem.pointsAwarded, 0, 'Zero points awarded while unsure');
  assert.equal(gradedItem.reviewed, true, 'Item has been flagged');
  assert.equal(ctx.state.results.grades[0].rawScore, 0, 'Student score is 0');

  // Verify filtered queue: 'needs_review' includes unsure items
  const pendingIndices = ctx.getFilteredFlashcardIndices('q51');
  assert.ok(pendingIndices.includes(0), 'Unsure item remains in needs_review queue for revisitation');

  // Now decide the item as 'accept'
  ctx.gradeHorizontalItem(0, 'q51', 'accept');
  assert.equal(ctx.state.results.grades[0].gradedItems['q51'].status, 'accepted');
  assert.equal(ctx.state.results.grades[0].rawScore, 2.0);
  assert.equal(ctx.state.results.grades[0].percentage, 100.0);
});

test('Feature 4: Flashcard Deck Mode & Auto-Advance', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  ctx.state.layout = {
    title: 'Deck Test',
    zones: [{
      id: 'written-zone',
      type: 'text_short',
      rois: [{ key: 'q10', id: 'q10', label: '10', points: 2.0, graded: true }]
    }]
  };
  ctx.state.key = {
    items: {
      'q10': { answer: 'Cell Wall', points: 2.0, kind: 'text' }
    }
  };
  ctx.state.results = {
    passThreshold: 60,
    grades: [
      { examId: 's1.jpg', studentId: '101', studentName: 'Student 1', rawScore: 0, maxScore: 2, percentage: 0, gradedItems: { q10: { status: 'unreviewed', reviewed: false } } },
      { examId: 's2.jpg', studentId: '102', studentName: 'Student 2', rawScore: 0, maxScore: 2, percentage: 0, gradedItems: { q10: { status: 'unreviewed', reviewed: false } } },
      { examId: 's3.jpg', studentId: '103', studentName: 'Student 3', rawScore: 0, maxScore: 2, percentage: 0, gradedItems: { q10: { status: 'unreviewed', reviewed: false } } }
    ]
  };

  assert.equal(typeof ctx.flashcardGradeAction, 'function');
  assert.equal(typeof ctx.navigateFlashcard, 'function');
  assert.equal(typeof ctx.setFlashcardFilter, 'function');
  assert.equal(typeof ctx.toggleStreamVisibility, 'function');

  ctx.horizontalDeckState.currentIndex = 0;
  ctx.horizontalDeckState.filter = 'all';

  // Grade card 0 as accept with auto-advance
  ctx.flashcardGradeAction(0, 'q10', 'accept');
  assert.equal(ctx.state.results.grades[0].gradedItems['q10'].status, 'accepted');
  assert.equal(ctx.horizontalDeckState.currentIndex, 1, 'Auto-advances to card index 1');

  // Grade card 1 as unsure with auto-advance
  ctx.flashcardGradeAction(1, 'q10', 'unsure');
  assert.equal(ctx.state.results.grades[1].gradedItems['q10'].status, 'unsure');
  assert.equal(ctx.horizontalDeckState.currentIndex, 2, 'Auto-advances to card index 2');

  // Navigate manually
  ctx.navigateFlashcard(-1);
  assert.equal(ctx.horizontalDeckState.currentIndex, 1, 'Navigates back to card index 1');

  // Test Auto-Advance in needs_review filter: clicking 'unsure' MUST advance to next card
  ctx.horizontalDeckState.filter = 'needs_review';
  ctx.horizontalDeckState.currentIndex = 0;
  // Reset grades to unreviewed
  ctx.state.results.grades.forEach(g => {
    g.gradedItems['q10'] = { status: 'unreviewed', reviewed: false, pointsAwarded: 0 };
  });
  const pendingBefore = ctx.getFilteredFlashcardIndices('q10');
  assert.equal(pendingBefore.length, 3);
  // Grade submission 0 with 'unsure'
  ctx.flashcardGradeAction(0, 'q10', 'unsure');
  assert.equal(ctx.state.results.grades[0].gradedItems['q10'].status, 'unsure');
  assert.equal(ctx.horizontalDeckState.currentIndex, 1, 'Auto-advances to card index 1 after marking unsure in needs_review filter');

  // Toggle stream visibility
  ctx.toggleStreamVisibility();
  assert.equal(ctx.horizontalDeckState.streamVisible, false);
  ctx.toggleStreamVisibility();
  assert.equal(ctx.horizontalDeckState.streamVisible, true);
});

test('Feature 5: Anonymous / Blind Grading in Review Cards', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  ctx.state.layout = {
    title: 'Anonymous Test',
    zones: [{
      id: 'written-zone',
      type: 'text_short',
      rois: [{ key: 'q61', id: 'q61', label: '61', points: 3.0, graded: true }]
    }]
  };
  ctx.state.key = {
    items: {
      'q61': { answer: 'Chloroplast', points: 3.0, kind: 'text' }
    }
  };
  ctx.state.results = {
    passThreshold: 60,
    grades: [{
      examId: 'scan_sensitive_01.jpg',
      studentId: 'STU-SECRET-9988',
      studentName: 'Eleanor Vance Private',
      classOffer: 'OFFER-RESTRICTED',
      rawScore: 88.5,
      maxScore: 100.0,
      percentage: 88.5,
      gradedItems: {
        'q61': { status: 'unreviewed', pointsAwarded: 0, maxPoints: 3.0, reviewed: false, ocrText: 'chloroplast', ocrConfidence: 0.94 }
      }
    }]
  };

  ctx.renderHorizontalGradingView();

  const streamContainer = ctx.document.getElementById('horizontal-submissions-container');
  const activeCardContainer = ctx.document.getElementById('horizontal-active-card-container');

  // Verify Stream Card HTML is 100% blind anonymous
  const streamHtml = streamContainer.innerHTML;
  assert.ok(streamHtml.includes('Submission #1'), 'Shows anonymous submission index in stream card');
  assert.ok(streamHtml.includes('Anonymous Blind Review'), 'Shows anonymous review indicator in stream card');
  assert.ok(!streamHtml.includes('Eleanor Vance Private'), 'DOES NOT contain student name in stream card');
  assert.ok(!streamHtml.includes('STU-SECRET-9988'), 'DOES NOT contain student ID in stream card');
  assert.ok(!streamHtml.includes('OFFER-RESTRICTED'), 'DOES NOT contain classOffer in stream card');
  assert.ok(!streamHtml.includes('88.5 / 100'), 'DOES NOT contain overall student score in stream card');

  // Verify Flashcard Card HTML is 100% blind anonymous
  const flashcardHtml = activeCardContainer.innerHTML;
  assert.ok(flashcardHtml.includes('Submission #1'), 'Shows anonymous submission index in flashcard');
  assert.ok(flashcardHtml.includes('Anonymous Blind Review'), 'Shows anonymous review indicator in flashcard');
  assert.ok(!flashcardHtml.includes('Eleanor Vance Private'), 'DOES NOT contain student name in flashcard');
  assert.ok(!flashcardHtml.includes('STU-SECRET-9988'), 'DOES NOT contain student ID in flashcard');
  assert.ok(!flashcardHtml.includes('OFFER-RESTRICTED'), 'DOES NOT contain classOffer in flashcard');
  assert.ok(flashcardHtml.includes('chloroplast'), 'Shows OCR reading in flashcard');
  assert.ok(flashcardHtml.includes('OCR Conf: 94%'), 'Shows OCR confidence in flashcard');
});

test('Feature 6: Item Numbers Do Not Have Trailing Dot to Save Horizontal Space', () => {
  const template = {
    id: 'no-dot-test',
    title: 'No-Dot Item Layout',
    paper: 'A4',
    zones: [
      {
        type: 'text_short',
        id: 'short-ans-block',
        count: 2,
        start: 1,
        boxWidth: 70,
        boxHeight: 8
      }
    ]
  };

  const layout = buildLayout(template);
  assert.ok(layout.zones && layout.zones.length > 0);

  const zone = layout.zones[0];
  assert.ok(zone.items && zone.items.length >= 2);

  // Verify label does not end with dot
  assert.equal(zone.items[0].label, '1', 'Item 1 label has no trailing dot');
  assert.equal(zone.items[1].label, '2', 'Item 2 label has no trailing dot');

  // Verify labelW is compact (e.g. 5mm for single digit) leaving maximum room for boxW
  assert.ok(zone.items[0].labelW <= 6, `Label width is compact (${zone.items[0].labelW}mm <= 6mm)`);

  // Verify SAMPLE_TEMPLATES have no trailing dots in text item numbers
  assert.equal(SAMPLE_TEMPLATES['exam-50'].zones.find(z => z.id === 'q61').label, '61');
  assert.equal(SAMPLE_TEMPLATES['exam-50'].zones.find(z => z.id === 'q62').label, '62');
  assert.equal(SAMPLE_TEMPLATES['quiz-tf'].zones.find(z => z.id === 's1').label, '31');
  assert.equal(SAMPLE_TEMPLATES['quiz-tf'].zones.find(z => z.id === 's2').label, '32');

  // Verify single-item text layout strips trailing dot from numeric label
  const singleItemTemplate = {
    id: 'single-dot-test',
    title: 'Single Dot Item Layout',
    paper: 'A4',
    zones: [{ type: 'text', id: 'q99', label: '99.', boxHeight: 10, w: 90 }]
  };
  const singleLayout = buildLayout(singleItemTemplate);
  assert.equal(singleLayout.zones[0].prompt, '99');
  assert.equal(singleLayout.zones[0].rois[0].label, '99');
});

test('Feature 7: layoutStats Safety and Uncompiled Template Recognition in Checker Studio', () => {
  // 1. Verify layoutStats handles zones without rois (e.g. instructions zone) and top-level rois safely
  const mockLayoutWithoutRois = {
    zones: [
      { id: 'inst', type: 'instructions', groups: [] },
      { id: 'custom', type: 'custom', groups: [] }
    ],
    rois: [
      { id: 'extra_q', key: '51', graded: true }
    ]
  };
  const stats = layoutStats(mockLayoutWithoutRois);
  assert.equal(stats.questions, 0);
  assert.equal(stats.textQuestions, 1);
  assert.equal(stats.totalQuestions, 1);

  // 2. Verify parseLayout and getLayoutQuestionItems recognize uncompiled template zones (.sheet.json)
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  const rawTemplate = {
    id: 'bio-midterm-template',
    title: 'Biology Midterm Sheet',
    paper: 'A4',
    zones: [
      { type: 'fields', id: 'info' },
      { type: 'instructions', id: 'notes' },
      { type: 'mcq', id: 'part1', count: 50, choices: 'ABCDE', start: 1 },
      { type: 'truefalse', id: 'part2', count: 10, start: 51 },
      { type: 'text_short', id: 'part3', count: 5, start: 61 },
      { type: 'modified_tf', id: 'part4', count: 5, start: 66 }
    ]
  };

  const parsed = ctx.parseLayout(rawTemplate);
  assert.ok(parsed, 'parseLayout returns parsed layout for uncompiled template');
  assert.equal(parsed.bubbles.length, 50 * 5 + 10 * 2 + 5 * 2, 'Synthesizes bubbles for MCQ, TF, and modified TF');
  assert.equal(parsed.rois.length, 5 + 5, 'Synthesizes rois for text_short and modified_tf corrections');

  const questionItems = ctx.getLayoutQuestionItems(parsed);
  assert.equal(questionItems.length, 50 + 10 + 5 + 5 + 5, 'Recognizes all 75 questions and correction items from uncompiled template');

  const mcq1 = questionItems.find(it => it.key === '1');
  assert.ok(mcq1 && mcq1.kind === 'mcq');
  const tf51 = questionItems.find(it => it.key === '51');
  assert.ok(tf51 && tf51.kind === 'tf');
  const short61 = questionItems.find(it => it.key === '61');
  assert.ok(short61 && short61.kind === 'text');
  const modCorr66 = questionItems.find(it => it.key === '66_corr');
  assert.ok(modCorr66 && modCorr66.type === 'correction');

  // 3. Verify downloadKeyTemplateCSV includes all items without throwing
  ctx.state.layout = parsed;
  let downloadedCsv = null;
  ctx.downloadFile = (name, content) => { downloadedCsv = content; };
  ctx.downloadKeyTemplateCSV();
  assert.ok(downloadedCsv, 'downloadKeyTemplateCSV generates CSV for all questions');
  assert.ok(downloadedCsv.includes('1,'), 'Contains item 1');
  assert.ok(downloadedCsv.includes('51,'), 'Contains item 51');
  assert.ok(downloadedCsv.includes('61,'), 'Contains item 61');
  assert.ok(downloadedCsv.includes('66_corr,'), 'Contains item 66_corr');
});

test('Feature 8: OCR Transcription Honesty (No Expected Answer Leakage)', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  ctx.state.layout = {
    title: 'Honest OCR Test',
    zones: [{
      id: 'written-zone',
      type: 'text_short',
      rois: [{ key: 'q99', id: 'q99', label: '99', points: 2.0, graded: true }]
    }]
  };
  ctx.state.key = {
    items: {
      'q99': { answer: 'VERY_SECRET_CORRECT_ANSWER', points: 2.0, kind: 'text' }
    }
  };
  // Submission has NO OCR text (empty / not read yet)
  ctx.state.results = {
    passThreshold: 60,
    grades: [{
      examId: 'scan_no_ocr.jpg',
      studentId: '1001',
      studentName: 'Anonymous Student',
      rawScore: 0,
      maxScore: 2,
      percentage: 0,
      gradedItems: {
        'q99': { status: 'unreviewed', reviewed: false, ocrText: '' }
      }
    }]
  };

  ctx.renderHorizontalGradingView();

  const activeCardContainer = ctx.document.getElementById('horizontal-active-card-container');
  const streamContainer = ctx.document.getElementById('horizontal-submissions-container');

  // Must NOT display the secret correct answer as OCR Read
  assert.ok(!activeCardContainer.innerHTML.includes('VERY_SECRET_CORRECT_ANSWER'), 'Flashcard must NOT leak expected answer as OCR text');
  assert.ok(!streamContainer.innerHTML.includes('VERY_SECRET_CORRECT_ANSWER'), 'Stream card must NOT leak expected answer as OCR text');
  assert.ok(activeCardContainer.innerHTML.includes('(Handwritten response)'), 'Flashcard displays honest fallback');
  assert.ok(streamContainer.innerHTML.includes('(Handwritten response)'), 'Stream card displays honest fallback');
});
