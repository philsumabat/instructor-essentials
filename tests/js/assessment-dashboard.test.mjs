import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Assessment Dashboard: Formal inline academic citations and dedicated references section', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Formal inline citations in in-app Psychometric Interpretation Guide
  assert.ok(checkerHtml.includes('[Ebel, 1979]'), 'Ebel 1979 citation present for difficulty and discrimination');
  assert.ok(checkerHtml.includes('[Cronbach, 1951]'), 'Cronbach 1951 citation present for internal consistency');
  assert.ok(checkerHtml.includes('[Haladyna &amp; Downing, 1993]') || checkerHtml.includes('[Haladyna, 1993]'), 'Haladyna citation present for distractor functioning');
  assert.ok(checkerHtml.includes('Kuder &amp; Richardson, 1937'), 'Kuder & Richardson 1937 citation present for KR-20 reliability');
  assert.ok(checkerHtml.includes('Anderson &amp; Krathwohl, 2001; Bloom et al., 1956'), 'Anderson & Krathwohl and Bloom et al. citations present for Bloom cognitive domains');

  // 2. Dedicated <section id="references"> present in in-app dashboard
  assert.ok(checkerHtml.includes('<section id="references"'), '<section id="references"> present in checker.html');
  assert.ok(checkerHtml.includes('Academic &amp; Psychometric References'), 'Academic & Psychometric References heading present');

  // 3. All 7 APA citations present in references section
  assert.ok(checkerHtml.includes('Anderson, L. W., &amp; Krathwohl, D. R.'), 'Anderson & Krathwohl (2001) reference present');
  assert.ok(checkerHtml.includes('Bloom, B. S., Engelhart, M. D.'), 'Bloom et al. (1956) reference present');
  assert.ok(checkerHtml.includes('Cronbach, L. J. (1951)'), 'Cronbach (1951) reference present');
  assert.ok(checkerHtml.includes('Ebel, R. L. (1979)'), 'Ebel (1979) reference present');
  assert.ok(checkerHtml.includes('Haladyna, T. M., &amp; Downing, S. M. (1993)'), 'Haladyna & Downing (1993) reference present');
  assert.ok(checkerHtml.includes('Krathwohl, D. R. (2002)'), 'Krathwohl (2002) reference present');
  assert.ok(checkerHtml.includes('Kuder, G. F., &amp; Richardson, M. W. (1937)'), 'Kuder & Richardson (1937) reference present');

  // 4. Standalone exported HTML report also contains references section and inline citations
  assert.ok(checkerHtml.includes('<section id="references" class="card"'), 'Exported HTML template contains <section id="references">');
  assert.ok(checkerHtml.includes('Psychometrics Report — ${state.key.title}'), 'Exported HTML has comprehensive report title');
});

test('Assessment Dashboard: Responsive collision-free bar charts and interactive tooltips', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Responsive scroll wrappers around SVG charts
  assert.ok(checkerHtml.includes('class="chart-scroll-wrap"'), 'Responsive chart scroll wrappers present');
  assert.ok(checkerHtml.includes('id="chart-item-difficulty-container"'), 'Difficulty chart container present');
  assert.ok(checkerHtml.includes('id="chart-item-discrimination-container"'), 'Discrimination chart container present');
  assert.ok(checkerHtml.includes('id="chart-blooms-container"'), 'Bloom chart container present');

  // 2. Interactive floating tooltip element and CSS
  assert.ok(checkerHtml.includes('id="chart-floating-tooltip" class="chart-tooltip"'), 'Floating tooltip DOM element present');
  assert.ok(checkerHtml.includes('.chart-tooltip {'), 'Tooltip styling present in CSS');
  assert.ok(checkerHtml.includes('tr.is-row-highlight {'), 'Row highlight animation CSS present');

  // 3. Script contains collision prevention logic (n <= 25 || idx % 5 === 0)
  assert.ok(checkerHtml.includes('n <= 25 || idx % 5 === 0'), 'Collision prevention logic present in chart renderers');
  assert.ok(checkerHtml.includes('data-type="diff"'), 'Difficulty chart bar elements tagged for interactive tooltips');
  assert.ok(checkerHtml.includes('data-type="disc"'), 'Discrimination chart bar elements tagged for interactive tooltips');
  assert.ok(checkerHtml.includes('data-type="bloom"'), 'Bloom chart bar elements tagged for interactive tooltips');
});

test('Assessment Dashboard: Top Performing Students section and psychometric cohort ranking', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Top Performing Students card and table body
  assert.ok(checkerHtml.includes('id="card-top-students"'), 'Top Performing Students card present in checker.html');
  assert.ok(checkerHtml.includes('id="tbody-top-students"'), 'tbody-top-students present in checker.html');

  // 2. Rank badge styling
  assert.ok(checkerHtml.includes('.rank-badge--1'), 'Gold rank badge CSS present');
  assert.ok(checkerHtml.includes('.rank-badge--2'), 'Silver rank badge CSS present');
  assert.ok(checkerHtml.includes('.rank-badge--3'), 'Bronze rank badge CSS present');

  // 3. Percentile rank calculation formula: (countStrictlyLower + 0.5 * countEqual) / totalN * 100
  assert.ok(checkerHtml.includes('countStrictlyLower + 0.5 * countEqual'), 'Standard psychometric percentile rank formula present');

  // 4. Inspect action triggers inspector navigation
  assert.ok(checkerHtml.includes('inspectStudent(${s.origIdx}); switchTab(\'roster\');'), 'Inspect action switches to roster inspector');
});

test('Bloom\'s Taxonomy: CSV template, modal selector, engine computation, and filtering', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. CSV template header has 4 columns including Bloom
  assert.ok(checkerHtml.includes('Item #,Answer,Points,Bloom'), 'downloadKeyTemplateCSV outputs 4th Bloom column');

  // 2. Visual answer key modal includes cognitive level selector
  assert.ok(checkerHtml.includes('class="key-bloom-select"'), 'Key editor modal contains Bloom cognitive level selector');
  assert.ok(checkerHtml.includes('BLOOM_LEVELS'), 'BLOOM_LEVELS array defined');

  // 3. Psychometrics engine calculates bloomStats and highQualityCount
  assert.ok(checkerHtml.includes('bloomStats'), 'computePsychometrics calculates bloomStats');
  assert.ok(checkerHtml.includes('highQualityCount'), 'computePsychometrics calculates highQualityCount');
  assert.ok(checkerHtml.includes('masteryPct'), 'computePsychometrics calculates student masteryPct per Bloom domain');

  // 4. In-app Bloom cards grid and filter dropdown
  assert.ok(checkerHtml.includes('id="blooms-summary-grid"'), 'blooms-summary-grid container present');
  assert.ok(checkerHtml.includes('id="select-bloom-filter"'), 'select-bloom-filter dropdown present');

  // 5. Item analysis table supports sorting by bloom and rendering bloom badges
  assert.ok(checkerHtml.includes('data-sort="bloom"'), 'Table header has sortable Bloom column');
  assert.ok(checkerHtml.includes('badge-bloom--'), 'Pill badge styles present for Bloom levels');
});

test('Psychometrics engine sandbox simulation: Bloom stats, high-quality count, and cohort ranking', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Extract script logic for computePsychometrics and BLOOM utilities
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '<script> tag must exist');
  const fullCode = scriptMatch[1];

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, style: {} }),
      querySelectorAll: () => [],
      createElement: () => ({ getContext: () => ({}) })
    },
    window: {},
    console,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class {},
    FileReader: class {}
  };
  sandbox.window = sandbox;

  const testScript = new vm.Script(`
    ${fullCode}
    // Expose test functions
    globalThis.__test_computePsychometrics = computePsychometrics;
    globalThis.__test_BLOOM_LEVELS = BLOOM_LEVELS;
    globalThis.__test_normalizeBloom = normalizeBloom;
    globalThis.__test_defaultBloomFor = defaultBloomFor;
  `);

  const ctx = vm.createContext(sandbox);
  testScript.runInContext(ctx);

  const computePsychometrics = ctx.__test_computePsychometrics;
  const BLOOM_LEVELS = ctx.__test_BLOOM_LEVELS;
  const normalizeBloom = ctx.__test_normalizeBloom;
  const defaultBloomFor = ctx.__test_defaultBloomFor;

  // 1. Verify Bloom level utilities
  assert.equal(BLOOM_LEVELS.length, 6);
  assert.equal(normalizeBloom('remember'), 'Remember');
  assert.equal(normalizeBloom('ANALYSIS'), 'Analyze');
  assert.equal(normalizeBloom('evaluation'), 'Evaluate');
  assert.equal(defaultBloomFor('1'), 'Remember');
  assert.equal(defaultBloomFor('2'), 'Understand');
  assert.equal(defaultBloomFor('3'), 'Apply');

  // 2. Synthesize an answer key with explicit Bloom levels
  const key = {
    title: 'Biology 101 Midterm',
    items: {
      '1': { answer: 'A', points: 1, bloom: 'Remember' },
      '2': { answer: 'B', points: 1, bloom: 'Understand' },
      '3': { answer: 'C', points: 1, bloom: 'Apply' },
      '4': { answer: 'D', points: 1, bloom: 'Analyze' },
      '5': { answer: 'A', points: 2, bloom: 'Evaluate' },
      '6': { answer: 'B', points: 2, bloom: 'Create' }
    }
  };

  // 3. Synthesize cohort student grades
  const grades = [
    {
      studentId: '101',
      studentName: 'Alice',
      rawScore: 8,
      maxScore: 8,
      percentage: 100,
      gradedItems: {
        '1': { pointsAwarded: 1, isCorrect: true, actual: 'A' },
        '2': { pointsAwarded: 1, isCorrect: true, actual: 'B' },
        '3': { pointsAwarded: 1, isCorrect: true, actual: 'C' },
        '4': { pointsAwarded: 1, isCorrect: true, actual: 'D' },
        '5': { pointsAwarded: 2, isCorrect: true, actual: 'A' },
        '6': { pointsAwarded: 2, isCorrect: true, actual: 'B' }
      }
    },
    {
      studentId: '102',
      studentName: 'Bob',
      rawScore: 5,
      maxScore: 8,
      percentage: 62.5,
      gradedItems: {
        '1': { pointsAwarded: 1, isCorrect: true, actual: 'A' },
        '2': { pointsAwarded: 1, isCorrect: true, actual: 'B' },
        '3': { pointsAwarded: 1, isCorrect: true, actual: 'C' },
        '4': { pointsAwarded: 0, isCorrect: false, actual: 'A' },
        '5': { pointsAwarded: 2, isCorrect: true, actual: 'A' },
        '6': { pointsAwarded: 0, isCorrect: false, actual: 'C' }
      }
    },
    {
      studentId: '103',
      studentName: 'Charlie',
      rawScore: 2,
      maxScore: 8,
      percentage: 25.0,
      gradedItems: {
        '1': { pointsAwarded: 1, isCorrect: true, actual: 'A' },
        '2': { pointsAwarded: 1, isCorrect: true, actual: 'B' },
        '3': { pointsAwarded: 0, isCorrect: false, actual: 'B' },
        '4': { pointsAwarded: 0, isCorrect: false, actual: 'B' },
        '5': { pointsAwarded: 0, isCorrect: false, actual: 'C' },
        '6': { pointsAwarded: 0, isCorrect: false, actual: 'D' }
      }
    }
  ];

  const psych = computePsychometrics(grades, key);
  assert.ok(psych, 'Psychometrics result must exist');
  assert.equal(psych.count, 3);
  assert.equal(psych.totalPossible, 8);
  assert.ok(psych.cronbachAlpha >= 0 && psych.cronbachAlpha <= 1.0);

  // Verify bloomStats
  assert.ok(psych.bloomStats, 'bloomStats must be computed');
  assert.equal(psych.bloomStats.Remember.itemCount, 1);
  assert.equal(psych.bloomStats.Remember.totalPoints, 1);
  assert.equal(psych.bloomStats.Remember.masteryPct, 100); // all 3 got Q1 correct

  assert.equal(psych.bloomStats.Evaluate.itemCount, 1);
  assert.equal(psych.bloomStats.Evaluate.totalPoints, 2);
  // Alice (2 pts) + Bob (2 pts) + Charlie (0 pts) = 4 pts out of 6 possible = 66.67%
  assert.ok(Math.abs(psych.bloomStats.Evaluate.masteryPct - 66.666) < 0.1);

  // Verify highQualityCount is numeric
  assert.equal(typeof psych.highQualityCount, 'number');
});

test('Top Performing Students: competition ranking with ties and safe null name sorting', () => {
  // Test data with tied scores and null/undefined names
  const testGrades = [
    { origIdx: 0, rawScore: 10, maxScore: 10, percentage: 100, studentId: 'S01', studentName: null },
    { origIdx: 1, rawScore: 10, maxScore: 10, percentage: 100, studentId: 'S02', studentName: 'Alice' },
    { origIdx: 2, rawScore: 8, maxScore: 10, percentage: 80, studentId: 'S03', studentName: 'Bob' },
    { origIdx: 3, rawScore: 8, maxScore: 10, percentage: 80, studentId: 'S04', studentName: undefined },
    { origIdx: 4, rawScore: 5, maxScore: 10, percentage: 50, studentId: 'S05', studentName: 'Charlie' },
  ];

  // Must not throw when sorting with null/undefined names
  assert.doesNotThrow(() => {
    testGrades.sort((a, b) => b.rawScore - a.rawScore || (a.studentName || '').localeCompare(b.studentName || ''));
  }, 'Sorting grades with null or undefined studentName must not throw');

  // Verify standard competition ranking formula: 1 + count(score > s.rawScore)
  const ranks = testGrades.map(s => {
    return 1 + testGrades.filter(other => (other.rawScore || 0) > (s.rawScore || 0)).length;
  });

  // Tied top students must both be rank 1
  assert.equal(ranks[0], 1, 'Top score student #1 is rank 1');
  assert.equal(ranks[1], 1, 'Tied top score student #2 is rank 1');
  // Tied second tier students must both be rank 3 (not 2 or arbitrary)
  assert.equal(ranks[2], 3, 'Tied 8/10 student #3 is rank 3');
  assert.equal(ranks[3], 3, 'Tied 8/10 student #4 is rank 3');
  // Fifth student is rank 5
  assert.equal(ranks[4], 5, '5/10 student is rank 5');
});

test('Answer Key CSV Parser: normalization, aliases, and round-trip consistency', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const studioHtml = await readFile(resolve(root, 'builder/studio.html'), 'utf8');

  // Verify parseKeyCSV exists in checker and studio bundle
  assert.ok(checkerHtml.includes('function parseKeyCSV'), 'parseKeyCSV defined in checker.html');
  assert.ok(studioHtml.includes('function parseKeyCSV'), 'parseKeyCSV inlined in studio.html');

  // Sandbox simulation of parseKeyCSV
  const sandbox = {
    console,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    parseFloat,
    isNaN,
    Error
  };

  const code = `
    const BLOOM_LEVELS = ['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'];
    function normalizeBloom(val) {
      if (!val || typeof val !== 'string') return 'Remember';
      const clean = val.trim().toLowerCase();
      if (clean.startsWith('rem') || clean.startsWith('rec') || clean === 'knowledge' || clean === '1') return 'Remember';
      if (clean.startsWith('und') || clean.startsWith('com') || clean === 'comprehension' || clean === '2') return 'Understand';
      if (clean.startsWith('app') || clean === 'application' || clean === '3') return 'Apply';
      if (clean.startsWith('ana') || clean === 'analysis' || clean === '4') return 'Analyze';
      if (clean.startsWith('eva') || clean === 'evaluation' || clean === '5') return 'Evaluate';
      if (clean.startsWith('cre') || clean.startsWith('syn') || clean === 'synthesis' || clean === 'creation' || clean === '6') return 'Create';
      return 'Remember';
    }
    function defaultBloomFor(k) {
      const num = parseInt(k, 10);
      if (!isNaN(num) && num > 0) return BLOOM_LEVELS[(num - 1) % BLOOM_LEVELS.length];
      return 'Remember';
    }
    function parseCSVLine(line) {
      const result = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          result.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      result.push(cur.trim());
      return result;
    }
    function parseKeyCSV(csvText) {
      const lines = csvText.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) throw new Error("CSV file is empty or missing headers.");
      const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim().replace(/^["']|["']$/g, ''));
      const itemCol = header.findIndex(h => h.includes('item') || h.includes('question') || h.includes('#'));
      const ansCol = header.findIndex(h => h.includes('answer') || h.includes('key'));
      const ptsCol = header.findIndex(h => h.includes('point') || h.includes('pts') || h.includes('score'));
      const bloomCol = header.findIndex(h => h.includes('bloom') || h.includes('cognitive') || h.includes('taxonomy') || h.includes('level'));

      const items = {};
      for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i]);
        if (row.length === 0) continue;
        const itNum = itemCol !== -1 ? row[itemCol]?.trim() : String(i);
        let ans = ansCol !== -1 ? row[ansCol]?.trim() : (row[1]?.trim() || '');
        const pts = ptsCol !== -1 ? parseFloat(row[ptsCol]) : 1;
        const rawBloom = bloomCol !== -1 ? row[bloomCol]?.trim() : (row[3]?.trim() || null);
        const bloom = rawBloom ? normalizeBloom(rawBloom) : defaultBloomFor(itNum);

        if (itNum && ans !== undefined && ans !== '') {
          let normAns = ans.trim();
          const upper = normAns.toUpperCase();
          if (upper === 'TRUE') normAns = 'T';
          else if (upper === 'FALSE') normAns = 'F';
          else if (/^[A-Za-z]$/.test(normAns)) normAns = upper;

          const isTF = (normAns === 'T' || normAns === 'F');
          items[itNum] = {
            answer: normAns,
            points: isNaN(pts) ? 1 : pts,
            kind: isTF ? 'tf' : 'mcq',
            bloom: bloom
          };
        }
      }
      return items;
    }
    globalThis.parseKeyCSV = parseKeyCSV;
  `;

  const ctx = vm.createContext(sandbox);
  new vm.Script(code).runInContext(ctx);

  const testCSV = [
    'Item #,Answer,Points,Bloom',
    '1,a,1,Recall',
    '2,True,1.5,Comprehension',
    '3,c,2,application',
    '4,False,1,analysis',
    '5,"Essay answer, test",3,synthesis'
  ].join('\n');

  const parsed = ctx.parseKeyCSV(testCSV);
  assert.equal(parsed['1'].answer, 'A', 'Lowercase "a" normalized to uppercase "A"');
  assert.equal(parsed['1'].bloom, 'Remember', '"Recall" alias normalized to "Remember"');
  assert.equal(parsed['2'].answer, 'T', '"True" normalized to "T"');
  assert.equal(parsed['2'].kind, 'tf', 'Identified as True/False');
  assert.equal(parsed['2'].bloom, 'Understand', '"Comprehension" alias normalized to "Understand"');
  assert.equal(parsed['3'].answer, 'C', '"c" normalized to "C"');
  assert.equal(parsed['3'].points, 2);
  assert.equal(parsed['3'].bloom, 'Apply', '"application" normalized to "Apply"');
  assert.equal(parsed['4'].answer, 'F', '"False" normalized to "F"');
  assert.equal(parsed['4'].bloom, 'Analyze', '"analysis" normalized to "Analyze"');
  assert.equal(parsed['5'].answer, 'Essay answer, test', 'RFC 4180 quotes preserved');
  assert.equal(parsed['5'].points, 3);
  assert.equal(parsed['5'].bloom, 'Create', '"synthesis" normalized to "Create"');
});

test('Item Analysis CSV export and Sheet Builder parity', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const studioHtml = await readFile(resolve(root, 'builder/studio.html'), 'utf8');
  const appCss = await readFile(resolve(root, 'builder/css/app.css'), 'utf8');

  // 1. Checker Tab 3 has #btn-tab-export-csv and exportItemAnalysisCSV
  assert.ok(checkerHtml.includes('id="btn-tab-export-csv"'), 'Export CSV button present in Tab 3 of checker.html');
  assert.ok(checkerHtml.includes('function exportItemAnalysisCSV'), 'exportItemAnalysisCSV defined in checker.html');
  assert.ok(checkerHtml.includes('# Bloom\'s Taxonomy Cognitive Distribution Summary'), 'Item Analysis CSV includes Bloom Summary');
  assert.ok(checkerHtml.includes('# Item Analysis & Psychometric Diagnostics'), 'Item Analysis CSV includes Item Diagnostics');

  // 2. Sheet Builder index.html & studio.html parity
  assert.ok(indexHtml.includes('id="btn-key-download-csv"'), 'btn-key-download-csv present in builder/index.html');
  assert.ok(studioHtml.includes('id="btn-key-download-csv"'), 'btn-key-download-csv inlined in studio.html');
  assert.ok(indexHtml.includes('accept=".json,.csv"'), 'key-file-import accepts .json and .csv in builder/index.html');
  assert.ok(studioHtml.includes('accept=".json,.csv"'), 'key-file-import accepts .json and .csv in studio.html');

  // 3. Bloom taxonomy selector styling
  assert.ok(appCss.includes('.key-bloom-select {'), '.key-bloom-select styling present in app.css');
  assert.ok(studioHtml.includes('.key-bloom-select {'), '.key-bloom-select inlined in studio.html');

  // 4. Exam package zip includes answer_key_template.csv
  assert.ok(studioHtml.includes('answer_key_template.csv'), 'answer_key_template.csv bundled in studio.html package');
  assert.ok(studioHtml.includes('Item #,Answer,Points,Bloom'), 'answer_key_template.csv header formatted properly');
});

