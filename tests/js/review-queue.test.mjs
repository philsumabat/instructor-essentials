import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(process.cwd());

test('Review Queue DOM Structure: toolbar, filter pills, stepper, callouts, and badges', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Summary callout banner for flagged scans
  assert.ok(checkerHtml.includes('id="summary-review-callout"'), 'Summary review callout banner present');
  assert.ok(checkerHtml.includes('id="btn-open-review-queue"'), 'Button to jump directly to review queue present');
  assert.ok(checkerHtml.includes('id="summary-review-callout-title"'), 'Callout title present');

  // 2. Roster toolbar and filter buttons
  assert.ok(checkerHtml.includes('roster-toolbar'), 'Roster toolbar class present');
  assert.ok(checkerHtml.includes('id="roster-review-filters"'), 'Filter container #roster-review-filters present');
  assert.ok(checkerHtml.includes('id="filter-roster-all"'), 'Filter button #filter-roster-all present');
  assert.ok(checkerHtml.includes('id="filter-roster-review"'), 'Filter button #filter-roster-review present');
  assert.ok(checkerHtml.includes('id="filter-roster-clean"'), 'Filter button #filter-roster-clean present');

  // 3. Count indicators
  assert.ok(checkerHtml.includes('id="count-roster-all"'), '#count-roster-all present');
  assert.ok(checkerHtml.includes('id="count-roster-review"'), '#count-roster-review present');
  assert.ok(checkerHtml.includes('id="count-roster-clean"'), '#count-roster-clean present');
  assert.ok(checkerHtml.includes('id="roster-count-badge"'), '#roster-count-badge present');

  // 4. Stepper controls in side preview footer and full view modal
  assert.ok(checkerHtml.includes('id="btn-roster-prev"'), '#btn-roster-prev button present');
  assert.ok(checkerHtml.includes('id="btn-roster-next"'), '#btn-roster-next button present');
  assert.ok(checkerHtml.includes('id="roster-queue-stepper-label"'), '#roster-queue-stepper-label present');
  assert.ok(checkerHtml.includes('id="btn-viewer-prev"'), '#btn-viewer-prev button present');
  assert.ok(checkerHtml.includes('id="btn-viewer-next"'), '#btn-viewer-next button present');
  assert.ok(checkerHtml.includes('id="viewer-queue-stepper-label"'), '#viewer-queue-stepper-label present');
  assert.ok(checkerHtml.includes('.roster-preview-stepper-footer'), '.roster-preview-stepper-footer CSS class present');
  assert.ok(checkerHtml.includes('.viewer-footer-bar'), '.viewer-footer-bar CSS class present');

  // 5. CSS classes for badges and active filter
  assert.ok(checkerHtml.includes('.badge-reviewed'), '.badge-reviewed CSS class present');
  assert.ok(checkerHtml.includes('.badge-review--active'), '.badge-review--active CSS class present');
  assert.ok(checkerHtml.includes('.btn--secondary.is-active'), '.btn--secondary.is-active CSS class present');
});

test('Review Queue State & Engine: filtering, count badges, flag resolution, and queue navigation', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block present');
  const code = scriptMatch[1];

  const elements = {};
  const mockGetElementById = (id) => {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        textContent: '',
        innerHTML: '',
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          toggle(c, force) {
            if (force === undefined) {
              if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c);
            } else if (force) {
              this.classes.add(c);
            } else {
              this.classes.delete(c);
            }
          },
          contains(c) { return this.classes.has(c); }
        },
        disabled: false,
        dataset: {},
        addEventListener() {}
      };
    }
    return elements[id];
  };

  const sandbox = {
    document: {
      getElementById: mockGetElementById,
      querySelectorAll: (sel) => {
        if (sel === '#roster-review-filters button') {
          return [
            mockGetElementById('filter-roster-all'),
            mockGetElementById('filter-roster-review'),
            mockGetElementById('filter-roster-clean')
          ];
        }
        return [];
      },
      querySelector: () => ({ classList: { add() {}, remove() {} } }),
      createElement: () => ({
        getContext: () => ({}),
        style: {}
      }),
      body: { classList: { add() {}, remove() {} } }
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

  const state = vm.runInContext('state', sandbox);
  const getFilteredRosterGrades = vm.runInContext('getFilteredRosterGrades', sandbox);
  const updateRosterFilterCounts = vm.runInContext('updateRosterFilterCounts', sandbox);
  const updateSummaryReviewCallout = vm.runInContext('updateSummaryReviewCallout', sandbox);
  const resolveReviewFlag = vm.runInContext('resolveReviewFlag', sandbox);
  const reopenReviewFlag = vm.runInContext('reopenReviewFlag', sandbox);
  const openReviewQueue = vm.runInContext('openReviewQueue', sandbox);

  // Setup mock grades:
  // Student 1: Clean (no review flags)
  // Student 2: Blank mark (needs review)
  // Student 3: Unmatched ID (needs review)
  state.results = {
    passThreshold: 60,
    grades: [
      {
        examId: 'scan_01.jpg',
        studentId: '10482901',
        studentName: 'Alice Smith',
        rawScore: 48,
        maxScore: 50,
        percentage: 96,
        reviewFlags: { needsReview: false, reasons: [] }
      },
      {
        examId: 'scan_02.jpg',
        studentId: '10482902',
        studentName: 'Bob Jones',
        rawScore: 35,
        maxScore: 50,
        percentage: 70,
        reviewFlags: { needsReview: true, reasons: ['1 blank response'] }
      },
      {
        examId: 'scan_03.jpg',
        studentId: 'STU-9999',
        studentName: 'STU-9999',
        rawScore: 28,
        maxScore: 50,
        percentage: 56,
        reviewFlags: { needsReview: true, reasons: ['Unmatched Student ID'] }
      }
    ]
  };

  // 1. Test Filter Counts
  updateRosterFilterCounts();
  assert.equal(elements['count-roster-all'].textContent, '(3)', 'All count should be 3');
  assert.equal(elements['count-roster-review'].textContent, '(2)', 'Needs Review count should be 2');
  assert.equal(elements['count-roster-clean'].textContent, '(1)', 'Clean count should be 1');
  assert.ok(elements['filter-roster-review'].classList.contains('badge-review--active'), 'Needs review button should have active warning highlight when count > 0');

  // 2. Test getFilteredRosterGrades for all, needs-review, and clean
  state.rosterFilter = 'all';
  assert.equal(getFilteredRosterGrades().length, 3, 'All filter must return all 3 grades');

  state.rosterFilter = 'needs-review';
  const flagged = getFilteredRosterGrades();
  assert.equal(flagged.length, 2, 'Needs-review filter must return 2 flagged grades');
  assert.equal(flagged[0].studentId, '10482902');
  assert.equal(flagged[1].studentId, 'STU-9999');

  state.rosterFilter = 'clean';
  const clean = getFilteredRosterGrades();
  assert.equal(clean.length, 1, 'Clean filter must return 1 clean grade');
  assert.equal(clean[0].studentId, '10482901');

  // 3. Test Summary Review Callout
  updateSummaryReviewCallout();
  assert.equal(elements['summary-review-callout'].style.display, 'flex', 'Callout banner must be shown when items need review');
  assert.ok(elements['summary-review-callout-title'].textContent.includes('2 Exam Sheets Need Review'));

  // 4. Test resolveReviewFlag
  // Resolve Bob Jones (index 1)
  resolveReviewFlag(1);
  assert.equal(state.results.grades[1].reviewFlags.needsReview, false, 'Needs review should be set to false');
  assert.equal(state.results.grades[1].reviewFlags.manuallyReviewed, true, 'Manually reviewed should be true');

  updateRosterFilterCounts();
  assert.equal(elements['count-roster-review'].textContent, '(1)', 'Needs Review count must decrement to 1');
  assert.equal(elements['count-roster-clean'].textContent, '(2)', 'Clean count must increment to 2');

  // 5. Test reopenReviewFlag
  reopenReviewFlag(1);
  assert.equal(state.results.grades[1].reviewFlags.needsReview, true, 'Needs review should be restored to true');
  assert.equal(state.results.grades[1].reviewFlags.manuallyReviewed, false, 'Manually reviewed should be cleared');

  // 6. Test openReviewQueue helper
  openReviewQueue();
  assert.equal(state.rosterFilter, 'needs-review', 'openReviewQueue must set rosterFilter to needs-review');

  // 7. Test renderRosterTable rendering and data-orig-idx
  const renderRosterTable = vm.runInContext('renderRosterTable', sandbox);
  state.rosterFilter = 'all';
  state.selectedStudentIdx = 1;
  renderRosterTable();
  const tableHtml = elements['tbody-roster'].innerHTML;
  assert.ok(tableHtml.includes('data-orig-idx="1"'), 'Row must contain data-orig-idx attribute');
  assert.ok(tableHtml.includes('Needs Review'), 'Flagged row must display Needs Review badge');

  // 8. Test Empty States in renderRosterTable
  state.results.grades = [];
  state.rosterFilter = 'needs-review';
  renderRosterTable();
  assert.ok(elements['tbody-roster'].innerHTML.includes('✓ All exam sheets are clean and verified! No scans require manual review.'), 'Needs-review empty state must reassure instructor');

  state.rosterFilter = 'clean';
  renderRosterTable();
  assert.ok(elements['tbody-roster'].innerHTML.includes('No unflagged sheets.'), 'Clean filter empty state message');

  state.rosterFilter = 'all';
  renderRosterTable();
  assert.ok(elements['tbody-roster'].innerHTML.includes('No student grades available.'), 'All filter empty state message');

  // 9. Test Synchronized Stepper Navigation (Side Pane & Full View Modal)
  const stepFilteredRoster = vm.runInContext('stepFilteredRoster', sandbox);
  const setRosterFilter = vm.runInContext('setRosterFilter', sandbox);
  const inspectStudent = vm.runInContext('inspectStudent', sandbox);

  // Restore grades
  state.results.grades = [
    { studentId: 'S1', studentName: 'Student 1', rawScore: 40, maxScore: 50, percentage: 80, reviewFlags: { needsReview: false } },
    { studentId: 'S2', studentName: 'Student 2', rawScore: 30, maxScore: 50, percentage: 60, reviewFlags: { needsReview: true, reasons: ['Blank'] } },
    { studentId: 'S3', studentName: 'Student 3', rawScore: 20, maxScore: 50, percentage: 40, reviewFlags: { needsReview: true, reasons: ['ID'] } }
  ];

  state.rosterFilter = 'all';
  inspectStudent(0);
  assert.equal(elements['roster-queue-stepper-label'].textContent, 'Student 1 of 3');
  assert.equal(elements['viewer-queue-stepper-label'].textContent, 'Student 1 of 3');
  assert.equal(elements['btn-roster-prev'].disabled, true);
  assert.equal(elements['btn-viewer-prev'].disabled, true);
  assert.equal(elements['btn-roster-next'].disabled, false);
  assert.equal(elements['btn-viewer-next'].disabled, false);

  // Advance to student 2
  stepFilteredRoster(1);
  assert.equal(state.selectedStudentIdx, 1);
  assert.equal(elements['roster-queue-stepper-label'].textContent, 'Student 2 of 3');
  assert.equal(elements['viewer-queue-stepper-label'].textContent, 'Student 2 of 3');
  assert.equal(elements['btn-roster-prev'].disabled, false);
  assert.equal(elements['btn-viewer-prev'].disabled, false);
  assert.equal(elements['btn-roster-next'].disabled, false);
  assert.equal(elements['btn-viewer-next'].disabled, false);

  // Advance to student 3 (last student in cohort)
  stepFilteredRoster(1);
  assert.equal(state.selectedStudentIdx, 2);
  assert.equal(elements['roster-queue-stepper-label'].textContent, 'Student 3 of 3');
  assert.equal(elements['viewer-queue-stepper-label'].textContent, 'Student 3 of 3');
  assert.equal(elements['btn-roster-prev'].disabled, false);
  assert.equal(elements['btn-viewer-prev'].disabled, false);
  assert.equal(elements['btn-roster-next'].disabled, true);
  assert.equal(elements['btn-viewer-next'].disabled, true);

  // Select unflagged student 0, then filter by 'needs-review' (2 flagged students: S2 and S3)
  inspectStudent(0);
  setRosterFilter('needs-review');
  assert.equal(state.selectedStudentIdx, 1);
  assert.equal(elements['roster-queue-stepper-label'].textContent, 'Student 1 of 2');
  assert.equal(elements['viewer-queue-stepper-label'].textContent, 'Student 1 of 2');
  assert.equal(elements['btn-roster-prev'].disabled, true);
  assert.equal(elements['btn-viewer-prev'].disabled, true);
  assert.equal(elements['btn-roster-next'].disabled, false);
  assert.equal(elements['btn-viewer-next'].disabled, false);

  // Step next in review queue -> S3 (origIdx 2)
  stepFilteredRoster(1);
  assert.equal(state.selectedStudentIdx, 2);
  assert.equal(elements['roster-queue-stepper-label'].textContent, 'Student 2 of 2');
  assert.equal(elements['viewer-queue-stepper-label'].textContent, 'Student 2 of 2');
  assert.equal(elements['btn-roster-prev'].disabled, false);
  assert.equal(elements['btn-viewer-prev'].disabled, false);
  assert.equal(elements['btn-roster-next'].disabled, true);
  assert.equal(elements['btn-viewer-next'].disabled, true);
});

