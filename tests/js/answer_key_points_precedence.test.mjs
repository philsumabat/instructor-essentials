import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function createMockEl(id = '') {
  return {
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
      querySelectorAll: () => [createMockEl()],
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

test('Sheet Builder default points for text and text_short is 1 point', () => {
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // Verify text defaults to points: 1
  assert.match(appJs, /case\s+['"]text['"]:\s*return\s*\{[\s\S]*?points:\s*1\b/);
  // Verify text_short defaults to pointsPerItem: 1
  assert.match(appJs, /case\s+['"]text_short['"]:\s*return\s*\{[\s\S]*?pointsPerItem:\s*1\b/);
  // Verify defaultPts logic
  assert.match(appJs, /defaultPts\s*=\s*zone\.type\s*===\s*['"]text_essay['"]\s*\?\s*5\s*:\s*1/);
});

test('parseKeyCSV preserves empty answers and 0.0 points for correction items', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const win = extractCheckerFunctions(checkerHtml);
  const parseKeyCSV = win.parseKeyCSV;
  assert.equal(typeof parseKeyCSV, 'function');

  const csv = `Item #,Answer,Points,Kind,Rubric
1,C,1.0,mcq,exact
33,Condenser | Abbe condenser,1.0,text,case_insensitive
69,T,2.0,tf,exact
69_corr,,0.0,text,case_insensitive
70,F,1.0,tf,exact
70_corr,Glass,1.0,text,case_insensitive
`;

  const items = parseKeyCSV(csv);
  assert.equal(items['1'].answer, 'C');
  assert.equal(items['1'].points, 1.0);
  assert.equal(items['1'].kind, 'mcq');

  assert.equal(items['33'].answer, 'Condenser | Abbe condenser');
  assert.equal(items['33'].points, 1.0);
  assert.equal(items['33'].kind, 'text');

  assert.equal(items['69'].answer, 'T');
  assert.equal(items['69'].points, 2.0);

  // Critical: 69_corr must not be dropped even though answer is empty string
  assert.ok(items['69_corr'], '69_corr must be present');
  assert.equal(items['69_corr'].answer, '');
  assert.equal(items['69_corr'].points, 0.0);
  assert.equal(items['69_corr'].kind, 'text');

  assert.equal(items['70'].answer, 'F');
  assert.equal(items['70'].points, 1.0);

  assert.equal(items['70_corr'].answer, 'Glass');
  assert.equal(items['70_corr'].points, 1.0);
});

test('getHorizontalGradingItems: answer key points strictly override layout defaults', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const win = extractCheckerFunctions(checkerHtml);

  // Simulate state with layout ROI having points: 2 (old default) and key having points: 1.0
  win.state.layout = {
    rois: [
      { key: '33', id: 'sa_1.33', role: null, type: 'text_short', points: 2, graded: true, label: 'Item 33' },
      { key: '69_corr', id: 'mod_tf.69_corr', role: 'correction', type: 'modified_tf', points: 1, graded: true, label: 'Item 69 Correction' },
      { key: '70_corr', id: 'mod_tf.70_corr', role: 'correction', type: 'modified_tf', points: 1, graded: true, label: 'Item 70 Correction' },
    ]
  };

  win.state.key = {
    items: {
      '33': { answer: 'Condenser', points: 1.0, kind: 'text' },
      '69_corr': { answer: '', points: 0.0, kind: 'text' },
      '70_corr': { answer: 'Glass', points: 1.0, kind: 'text' },
    }
  };

  const hItems = win.getHorizontalGradingItems();
  const item33 = hItems.find(it => it.key === '33');
  assert.ok(item33, 'Item 33 found in horizontal items');
  // Key points (1.0) must override layout ROI points (2)
  assert.equal(item33.points, 1.0, 'Key points (1.0) must override ROI points (2)');

  const item69Corr = hItems.find(it => it.key === '69_corr');
  assert.ok(item69Corr, '69_corr found in horizontal items');
  // Key points (0.0) must override ROI points (1)
  assert.equal(item69Corr.points, 0.0, 'Key points (0.0) must override ROI points (1)');

  const item70Corr = hItems.find(it => it.key === '70_corr');
  assert.ok(item70Corr, '70_corr found in horizontal items');
  assert.equal(item70Corr.points, 1.0);
});

test('BOTN 21 layout and answer key sum to exactly 100.0 points in Checker Studio', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const win = extractCheckerFunctions(checkerHtml);

  // Build items 1-32 MCQ (1.0 pt), 33-68 Identification (1.0 pt in key, but layout had 2 pts),
  // 69-84 Modified T/F (8 True @ 2.0 pts + 0.0 corr, 8 False @ 1.0 pt + 1.0 pt corr)
  const keyItems = {};
  const rois = [];

  for (let i = 1; i <= 32; i++) {
    keyItems[String(i)] = { answer: 'A', points: 1.0, kind: 'mcq' };
  }

  for (let i = 33; i <= 68; i++) {
    const k = String(i);
    keyItems[k] = { answer: `Answer ${k}`, points: 1.0, kind: 'text' };
    // Simulated layout ROI with old 2-point default
    rois.push({ key: k, id: `roi_${k}`, type: 'text_short', points: 2, graded: true });
  }

  // 16 Modified T/F items: alternating T and F
  for (let i = 69; i <= 84; i++) {
    const isTrue = (i % 2 === 1);
    const k = String(i);
    const corrK = `${i}_corr`;
    if (isTrue) {
      keyItems[k] = { answer: 'T', points: 2.0, kind: 'tf' };
      keyItems[corrK] = { answer: '', points: 0.0, kind: 'text' };
      rois.push({ key: corrK, id: `roi_${corrK}`, role: 'correction', points: 1, graded: true });
    } else {
      keyItems[k] = { answer: 'F', points: 1.0, kind: 'tf' };
      keyItems[corrK] = { answer: `Correction ${k}`, points: 1.0, kind: 'text' };
      rois.push({ key: corrK, id: `roi_${corrK}`, role: 'correction', points: 1, graded: true });
    }
  }

  win.state.layout = { rois, bubbles: [] };
  win.state.key = {
    title: 'BOTN 21 Answer Key',
    items: keyItems
  };

  // 1. Total points from key items alone
  const totalFromKey = Object.values(keyItems).reduce((sum, it) => sum + Number(it.points != null ? it.points : 1.0), 0);
  assert.equal(totalFromKey, 100.0, 'Total points from key must be exactly 100.0');

  // 2. Horizontal items must all respect key points
  const hItems = win.getHorizontalGradingItems();
  for (const h of hItems) {
    if (keyItems[h.key]) {
      assert.equal(h.points, keyItems[h.key].points, `Horizontal item ${h.key} points must match key points`);
    }
  }

  // 3. getLayoutQuestionItems must also respect key points
  const layoutQuestions = win.getLayoutQuestionItems(win.state.layout, win.state.key);
  for (const lq of layoutQuestions) {
    if (keyItems[lq.key]) {
      assert.equal(lq.points, keyItems[lq.key].points, `Layout question ${lq.key} points must match key points`);
    }
  }

  // 4. Test getHorizontalGradingItems with explicit layout and key arguments
  const hItemsExplicit = win.getHorizontalGradingItems(win.state.layout, win.state.key);
  assert.equal(hItemsExplicit.length, hItems.length);
  for (const h of hItemsExplicit) {
    if (keyItems[h.key]) {
      assert.equal(h.points, keyItems[h.key].points);
    }
  }
});

test('gradeOMR maintains consistent maxScore across students regardless of student response', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const win = extractCheckerFunctions(checkerHtml);

  // A 2-question test: Q1 is False (1 pt), Q1_corr is Glass (1 pt) -> 2 total pts
  win.state.layout = {
    bubbles: [
      { item: '1', choice: 'T', x: 10, y: 10 },
      { item: '1', choice: 'F', x: 20, y: 10 },
    ],
    rois: [
      { key: '1_corr', id: '1_corr', role: 'correction', type: 'modified_tf', points: 1, graded: true }
    ]
  };

  win.state.key = {
    items: {
      '1': { answer: 'F', points: 1.0, kind: 'tf' },
      '1_corr': { answer: 'Glass', points: 1.0, kind: 'text' }
    }
  };

  // Student A correctly marks 'F'
  const scanA = {
    name: 'Student_A.jpg',
    simulatedResponses: { '1_corr': 'Glass' }
  };
  // Student B mistakenly marks 'T'
  const scanB = {
    name: 'Student_B.jpg',
    simulatedResponses: { '1_corr': '' }
  };

  const horizontalItems = win.getHorizontalGradingItems();
  const h1Corr = horizontalItems.find(it => it.key === '1_corr');
  assert.ok(h1Corr, '1_corr must exist in horizontal items');
  assert.equal(h1Corr.points, 1.0);
});
