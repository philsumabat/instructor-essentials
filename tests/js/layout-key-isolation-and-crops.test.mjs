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

  const storage = {};
  const mockElements = {
    'input-threshold': { value: '60' },
    'input-bubble-threshold': { value: '0.20' },
    'dist-label-threshold': { textContent: '' },
    'dist-label-pass': { textContent: '' },
    'dist-label-fail': { textContent: '' },
    'dist-bar-pass': { style: {} },
    'dist-bar-fail': { style: {} },
    'metric-passrate': { textContent: '' },
    'metric-passrate-sub': { textContent: '' },
    'metric-count': { textContent: '' },
    'metric-count-sub': { textContent: '' },
    'metric-mean': { textContent: '' },
    'metric-mean-sub': { textContent: '' },
    'metric-alpha': { textContent: '' },
    'metric-stddev': { textContent: '' },
    'metric-median': { textContent: '' },
    'input-hf-token': { value: '' },
    'modal-trocr-settings': { showModal: () => {}, close: () => {} },
    'modal-new-class-prompt': { showModal: () => {}, close: () => {} },
    'checker-empty-state': { style: {} },
    'results-export-bar': { style: {} },
    'tbody-summary': { innerHTML: '' },
    'tbody-roster': { innerHTML: '' },
    'tbody-items': { innerHTML: '' },
    'tbody-top-students': { innerHTML: '' },
    'btn-thresh-dec': { onclick: null },
    'btn-thresh-inc': { onclick: null },
    'roster-preview-canvas': { getContext: () => ({ clearRect: () => {}, fillRect: () => {}, fillText: () => {} }), width: 840, height: 1188 },
    'viewer-student-select': { innerHTML: '' },
    'key-empty-state': { style: {} },
    'key-status-box': { style: {} },
    'key-title-display': { textContent: '' },
    'key-stats-display': { textContent: '' },
    'btn-google-drive': { style: {}, classList: { add: () => {}, remove: () => {} } },
    'google-drive-status-badge': { style: {}, classList: { add: () => {}, remove: () => {} } },
    'google-drive-sync-indicator': { style: {}, classList: { add: () => {}, remove: () => {} } },
    'label-google-drive': { textContent: '' },
    'google-drive-dot': { style: {} },
    'select-horizontal-item': { value: 'item_33', innerHTML: '' },
    'btn-batch-ai-transcribe': { disabled: false, innerHTML: '' },
    'horizontal-submissions-container': { innerHTML: '', style: {} },
    'horizontal-active-card-container': { innerHTML: '' },
    'card-top-students': { style: {} }
  };

  const sandbox = {
    document: {
      getElementById: (id) => {
        const el = mockElements[id] || {};
        el.style = el.style || {};
        el.dataset = el.dataset || {};
        el.classList = el.classList || { add: () => {}, remove: () => {}, contains: () => false };
        el.addEventListener = el.addEventListener || (() => {});
        el.setAttribute = el.setAttribute || (() => {});
        el.getAttribute = el.getAttribute || (() => null);
        return el;
      },
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { add: () => {}, remove: () => {}, contains: () => false }, style: {}, dataset: {}, setAttribute: () => {}, getAttribute: () => null }),
      createElement: (tag) => {
        if (tag === 'canvas') {
          return {
            width: 840,
            height: 1188,
            style: {},
            getContext: () => ({
              fillRect: () => {},
              drawImage: () => {},
              fillText: () => {},
              strokeText: () => {},
              strokeRect: () => {},
              beginPath: () => {},
              closePath: () => {},
              moveTo: () => {},
              lineTo: () => {},
              stroke: () => {},
              fill: () => {},
              arc: () => {},
              getImageData: () => ({ data: new Uint8ClampedArray(840 * 1188 * 4) }),
              putImageData: () => {}
            }),
            toDataURL: () => 'data:image/jpeg;base64,mockCropData'
          };
        }
        return { style: {}, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {} };
      },
      body: { classList: { add: () => {}, remove: () => {} } }
    },
    window: {},
    navigator: { onLine: true },
    Image: class MockImage {
      constructor() {
        this.width = 840;
        this.height = 1188;
        this.naturalWidth = 840;
        this.naturalHeight = 1188;
        this.complete = true;
      }
      set src(val) {
        this._src = val;
        if (this.onload) setTimeout(() => this.onload(), 0);
      }
      get src() {
        return this._src;
      }
      decode() {
        return Promise.resolve();
      }
    },
    localStorage: {
      getItem: (k) => storage[k] || null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    alert: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    Promise,
    Date,
    FileReader: class MockFileReader {
      readAsArrayBuffer() {
        if (this.onload) this.onload({ target: { result: new ArrayBuffer(0) } });
      }
    }
  };

  sandbox.HTMLImageElement = sandbox.Image;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);

  return { context, sandbox, checkerHtml };
}

test('1. Layout Upload Key Isolation: Uploading layout JSON without key leaves state.key null', async () => {
  const { context } = await loadCheckerSandbox();

  // Reset state
  context.state.key = null;
  context.state.layout = null;

  // A standalone layout JSON without any embedded key
  const standaloneLayoutJson = {
    title: 'Biology 101 Midterm',
    paper: 'A4',
    bubbles: [
      { item: '1', choice: 'A', center: [20, 30], radius: 2.1 },
      { item: '1', choice: 'B', center: [26, 30], radius: 2.1 }
    ]
  };

  context.applyLoadedLayout(standaloneLayoutJson, 'bio101.layout.json');

  // Verify state.layout is loaded
  assert.ok(context.state.layout, 'Layout must be parsed and loaded');
  // CRITICAL: state.key must NOT be auto-synthesized!
  assert.equal(context.state.key, null, 'state.key must remain null when standalone layout JSON has no key');
});

test('2. Layout Upload Key Isolation: Preserves embedded authentic key if present in package/layout JSON', async () => {
  const { context } = await loadCheckerSandbox();

  context.state.key = null;
  const layoutWithAuthenticKey = {
    title: 'Chemistry 201 Final',
    paper: 'A4',
    bubbles: [
      { item: '1', choice: 'A', center: [20, 30], radius: 2.1 },
      { item: '1', choice: 'B', center: [26, 30], radius: 2.1 }
    ],
    key: {
      title: 'Chemistry 201 Authentic Key',
      items: {
        '1': { answer: 'B', points: 2.0 }
      }
    }
  };

  context.applyLoadedLayout(layoutWithAuthenticKey, 'chem201.layout.json');

  assert.ok(context.state.key, 'Authentic embedded key must be loaded');
  assert.equal(context.state.key.title, 'Chemistry 201 Authentic Key');
  assert.equal(context.state.key.items['1'].answer, 'B');
});

test('3. AI Handwriting Transcription: autoTranscribeActiveItem accesses state.results.grades and sets match badge', async () => {
  const { context } = await loadCheckerSandbox();

  let toastMessage = '';
  context.showToast = (msg) => { toastMessage = msg; };

  // Mock active grading results in state.results.grades
  context.state.results = {
    grades: [
      {
        studentId: '2026-0001',
        studentName: 'Alice Santos',
        gradedItems: {
          'item_33': {
            cropDataUrl: 'data:image/jpeg;base64,sampleCropAlice',
            status: 'unreviewed',
            ocrText: '',
            aiOcrMatch: false
          }
        }
      },
      {
        studentId: '2026-0002',
        studentName: 'Bob Reyes',
        gradedItems: {
          'item_33': {
            cropDataUrl: 'data:image/jpeg;base64,sampleCropBob',
            status: 'unreviewed',
            ocrText: '',
            aiOcrMatch: false
          }
        }
      }
    ]
  };

  context.state.key = {
    items: {
      'item_33': { answer: 'Photosynthesis', points: 2.0 }
    }
  };

  // Mock HandwritingEngine transcription
  context.HandwritingEngine.transcribeHandwritingCrop = async (cropUrl) => {
    if (cropUrl.includes('Alice')) {
      return { text: 'Photosynthesis', confidence: 0.95 };
    }
    return { text: 'Cellular Respiration', confidence: 0.91 };
  };

  // Run autoTranscribeActiveItem
  await context.autoTranscribeActiveItem();

  const aliceItem = context.state.results.grades[0].gradedItems['item_33'];
  const bobItem = context.state.results.grades[1].gradedItems['item_33'];

  assert.equal(aliceItem.ocrText, 'Photosynthesis', 'Alice OCR text transcribed');
  assert.equal(aliceItem.aiOcrMatch, true, 'Alice answer matched expected key');

  assert.equal(bobItem.ocrText, 'Cellular Respiration', 'Bob OCR text transcribed');
  assert.equal(bobItem.aiOcrMatch, false, 'Bob answer did not match expected key');

  assert.ok(toastMessage.includes('Auto-transcribed 2 student answers'), 'Toast confirms 2 transcribed answers');
});

test('4. Zero-Loss Restore: cropROIFromScan returns early without blanking canvas when cachedCrop exists', async () => {
  const { context } = await loadCheckerSandbox();

  let fillRectCalls = 0;
  let drawImageCalls = 0;

  const mockCanvas = {
    width: 200,
    height: 50,
    getContext: () => ({
      fillRect: () => { fillRectCalls++; },
      drawImage: () => { drawImageCalls++; }
    }),
    toDataURL: () => 'data:image/jpeg;base64,mock'
  };

  const gradeWithCachedCrop = {
    scanImg: null, // scanImg is null/unavailable
    gradedItems: {
      'q33': {
        cropDataUrl: 'data:image/jpeg;base64,alreadyCachedCrop'
      }
    }
  };

  context.cropROIFromScan(gradeWithCachedCrop, { key: 'q33', x: 20, y: 30, w: 50, h: 15 }, mockCanvas);

  assert.ok(drawImageCalls > 0, 'drawImage must be called with cached image');
  // It must NOT overwrite with error/fallback message
  assert.equal(fillRectCalls, 1, 'Only initial white clear rect must be called, no fallback fillRect');
});

test('5. Zero-Loss Restore: restoreCheckerProgress restores cropDataUrl on gradedItems and awaits decoding', async () => {
  const { context } = await loadCheckerSandbox();

  const sessionData = {
    layout: {
      title: 'Botany Exam',
      rois: [
        { key: 'q33', graded: true, type: 'text_short', x: 10, y: 20, w: 40, h: 10, prompt: 'Define xylem' }
      ]
    },
    key: {
      items: {
        'q33': { answer: 'Vascular tissue', points: 1.0 }
      }
    },
    results: {
      passThreshold: 60,
      grades: [
        {
          studentId: '2026-1001',
          studentName: 'Charlie Brown',
          rawScore: 1.0,
          maxScore: 1.0,
          percentage: 100,
          scanData: 'data:image/jpeg;base64,scanDataFake',
          gradedItems: {
            'q33': {
              cropDataUrl: 'data:image/jpeg;base64,restoredCrop33',
              ocrText: 'Vascular tissue',
              pointsAwarded: 1.0,
              status: 'accepted',
              reviewed: true
            }
          }
        }
      ]
    }
  };

  await context.restoreCheckerProgress(sessionData);

  assert.ok(context.state.results, 'Session results restored');
  assert.equal(context.state.results.grades.length, 1);
  const item = context.state.results.grades[0].gradedItems['q33'];
  assert.equal(item.cropDataUrl, 'data:image/jpeg;base64,restoredCrop33', 'cropDataUrl preserved on restore');
  assert.equal(item.ocrText, 'Vascular tissue');
});

test('6. Top Performing Students Table: Header and rows do not include Student ID or Class Offer columns', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify section title is renamed from "Top Performing Students (Cohort Leaders)" to "Top Performing Students"
  assert.ok(checkerHtml.includes('<span>Top Performing Students</span>'), 'Section header is Top Performing Students');
  assert.ok(!checkerHtml.includes('<span>Top Performing Students (Cohort Leaders)</span>'), 'Old title removed from Tab 3');

  // Verify HTML table headers in Tab 3 do not contain Student ID or Class / Offer No.
  const topTableMatch = checkerHtml.match(/<div class="section-card" id="card-top-students"[\s\S]*?<\/table>/);
  assert.ok(topTableMatch, 'Top students table card must be present');
  const tableContent = topTableMatch[0];

  assert.ok(!tableContent.includes('<th>Student ID</th>'), 'Student ID column header removed from Tab 3 table');
  assert.ok(!tableContent.includes('<th>Class / Offer No.</th>'), 'Class / Offer No. column header removed from Tab 3 table');
  assert.ok(tableContent.includes('colspan="6"'), 'Empty row spans 6 columns');

  // Verify Exported HTML Report structure
  assert.ok(checkerHtml.includes('<h2 style="margin: 0; font-size: 1.05rem;">Top Performing Students</h2>'), 'HTML report titled Top Performing Students');
  assert.ok(!checkerHtml.includes('<h2 style="margin: 0; font-size: 1.05rem;">Top Performing Students (Cohort Leaders)</h2>'), 'HTML report does not have old title');
});

test('7. Emoji Audit: Decorative emojis removed from signal badges, legend, and buttons', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Check signal badges
  assert.ok(!checkerHtml.includes('>🚨 Miskey</span>'), 'Miskey emoji removed from badge');
  assert.ok(checkerHtml.includes('>Miskey Alert</span>'), 'Miskey Alert label used');

  assert.ok(!checkerHtml.includes('>🎯 Strong</span>'), 'Target emoji removed from strong badge');
  assert.ok(!checkerHtml.includes('>📉 Hard</span>'), 'Down-trend emoji removed from hard badge');
  assert.ok(!checkerHtml.includes('>📈 Easy</span>'), 'Up-trend emoji removed from easy badge');
  assert.ok(!checkerHtml.includes('>💡 Misconception</span>'), 'Lightbulb emoji removed from misconception badge');
  assert.ok(!checkerHtml.includes('>✨ Optimal</span>'), 'Sparkles emoji removed from optimal badge');

  // Check buttons & toasts
  assert.ok(!checkerHtml.includes('<span>✨ Auto-Transcribe Item</span>'), 'Sparkles emoji removed from auto-transcribe button');
  assert.ok(checkerHtml.includes('<span>Auto-Transcribe Item</span>'), 'Clean Auto-Transcribe Item button text');
  assert.ok(!checkerHtml.includes('💾 Progress saved'), 'Floppy disk emoji removed from save progress toast');
});

test('8. Compact 32px Google Account Button & Brand Protection', async () => {
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const appCss = await readFile(resolve(root, 'builder/css/app.css'), 'utf8');

  // Both have compact #btn-google-drive with Google SVG and micro status badge
  assert.ok(indexHtml.includes('id="btn-google-drive" class="btn btn--secondary btn-google-drive" style="display: none;"'), 'Sheet Builder has btn-google-drive');
  assert.ok(indexHtml.includes('id="google-drive-status-badge" class="google-status-badge is-synced"'), 'Sheet Builder has micro status badge');

  assert.ok(checkerHtml.includes('id="btn-google-drive" class="btn btn--secondary btn-google-drive" style="display: none;"'), 'Checker Studio has btn-google-drive');
  assert.ok(checkerHtml.includes('id="google-drive-status-badge" class="google-status-badge is-synced"'), 'Checker Studio has micro status badge');

  // CSS definitions
  assert.ok(appCss.includes('.btn-google-drive {'), 'btn-google-drive CSS present in app.css');
  assert.ok(appCss.includes('width: 32px;'), 'btn-google-drive width is 32px in app.css');
  assert.ok(appCss.includes('height: 32px;'), 'btn-google-drive height is 32px in app.css');
  assert.ok(appCss.includes('.google-status-badge {'), 'google-status-badge CSS present in app.css');
  assert.ok(appCss.includes('.app-brand {\n  display: flex;\n  align-items: center;\n  gap: 0.65rem;\n  flex-shrink: 0;\n}'), 'app-brand has flex-shrink: 0 in app.css');
});

test('9. Warping Mitigation: Multi-fiducial 6-point registration documented in design and decision log', async () => {
  const smartDesign = await readFile(resolve(root, 'docs/SMART_DETECTION_DESIGN.md'), 'utf8');
  const decisions = await readFile(resolve(root, 'DECISIONS.md'), 'utf8');

  assert.ok(smartDesign.includes('Midline Lateral Fiducials (6-Point Registration'), 'Midline lateral fiducials documented in SMART_DETECTION_DESIGN.md');
  assert.ok(smartDesign.includes('Piecewise Homography'), 'Piecewise Homography documented in SMART_DETECTION_DESIGN.md');

  assert.ok(decisions.includes('Decision 41:'), 'Decision 41 documented in DECISIONS.md');
  assert.ok(decisions.includes('6-Point Midline Lateral Fiducials Recommendation for Sheet Warping'), 'Fiducial recommendation in Decision 41');
});

test('10. Layout Key Isolation: ZIP package with answer_key_template.csv does not load fake answer key', async () => {
  const { context } = await loadCheckerSandbox();

  context.state.key = null;
  context.state.layout = null;

  // Mock readZipFiles to return layout.json and answer_key_template.csv (the default dummy template)
  context.readZipFiles = () => [
    {
      name: 'layout.json',
      text: () => JSON.stringify({
        title: 'Quiz 101',
        paper: 'A4',
        bubbles: [{ item: '1', choice: 'A', center: [20, 30], radius: 2.1 }]
      })
    },
    {
      name: 'answer_key_template.csv',
      text: () => 'item,answer,points\n1,A,1.0\n'
    }
  ];

  context.handleLayoutUpload({ name: 'Quiz_101.package.zip' });

  assert.ok(context.state.layout, 'Layout must be parsed from ZIP');
  assert.equal(context.state.key, null, 'state.key must NOT be populated with answer_key_template.csv');
});

test('11. Horizontal Grading ROIs & Crop Caching: getHorizontalGradingItems preserves key/id/role and populates cropDataUrl', async () => {
  const { context } = await loadCheckerSandbox();

  const mockLayout = {
    title: 'Short Answer Exam',
    rois: [
      { id: 'q1', key: 'q1', graded: true, type: 'text_short', x: 10, y: 20, w: 50, h: 15, prompt: 'Define mitosis' }
    ]
  };

  const items = context.getHorizontalGradingItems(mockLayout, null);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'q1');
  assert.ok(items[0].roi, 'ROI must exist');
  assert.equal(items[0].roi.key, 'q1', 'ROI must preserve key');
  assert.equal(items[0].roi.id, 'q1', 'ROI must preserve id');

  // Test cropROIFromScan populating grade.gradedItems['q1'].cropDataUrl
  const mockGrade = {
    scanImg: {
      width: 840,
      height: 1188,
      complete: true
    },
    gradedItems: {
      'q1': {
        status: 'unreviewed',
        expected: 'Cell division'
      }
    }
  };

  let toDataURLCalled = false;
  const mockCanvas = {
    width: 200,
    height: 50,
    getContext: () => ({
      fillRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(200 * 50 * 4) }),
      putImageData: () => {}
    }),
    toDataURL: () => {
      toDataURLCalled = true;
      return 'data:image/jpeg;base64,extractedCropQ1';
    }
  };

  context.cropROIFromScan(mockGrade, items[0].roi, mockCanvas);

  assert.ok(toDataURLCalled, 'toDataURL must be called to cache crop');
  assert.equal(mockGrade.gradedItems['q1'].cropDataUrl, 'data:image/jpeg;base64,extractedCropQ1', 'cropDataUrl must be cached on gradedItem');
});

