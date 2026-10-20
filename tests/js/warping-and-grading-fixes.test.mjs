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
    'global-loading-indicator': { style: { display: 'none' } },
    'global-loading-title': { textContent: '' },
    'global-loading-message': { textContent: '' },
    'global-loading-bar-wrap': { style: { display: 'none' } },
    'global-loading-bar': { style: { width: '0%' } },
    'preflight-warning-banner': { style: { display: 'none' } },
    'preflight-warning-text': { innerHTML: '' },
    'modal-new-class-prompt': { showModal: () => {}, close: () => {} },
    'modal-google-drive': { showModal: () => {}, close: () => {} },
    'btn-google-drive': { style: { display: 'none' }, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {} },
    'label-google-drive': { textContent: '', style: { display: 'inline' } },
    'google-drive-dot': { style: { display: 'none' } },
    'gdrive-view-disconnected': { style: { display: 'block' } },
    'gdrive-view-connected': { style: { display: 'none' } },
    'gdrive-user-name': { textContent: '' },
    'gdrive-user-email': { textContent: '' },
    'gdrive-user-avatar': { style: { display: 'none' }, src: '' },
    'gdrive-files-list-wrap': { style: { display: 'none' } },
    'gdrive-files-list': { innerHTML: '', appendChild: () => {}, children: [] },
    'select-horizontal-scope': { value: 'all', innerHTML: '', options: [], addEventListener: () => {} },
    'select-horizontal-item': { value: '1', innerHTML: '', options: [], addEventListener: () => {} },
    'horizontal-submissions-container': { innerHTML: '', style: {} },
    'horizontal-active-card-container': { innerHTML: '' },
    'horizontal-flashcard-deck': { style: {} },
    'horizontal-prompt-card': { style: {} },
    'btn-horizontal-item-prev': { disabled: true },
    'btn-horizontal-item-next': { disabled: true },
    'horizontal-item-title': { textContent: '' },
    'horizontal-item-prompt': { textContent: '' },
    'horizontal-item-points': { textContent: '' },
    'horizontal-item-expected': { textContent: '' },
    'horizontal-item-rubric': { textContent: '' },
    'horizontal-badge-type': { textContent: '' },
    'horizontal-progress-bar': { style: { width: '0%' } },
    'horizontal-progress-text': { textContent: '' },
    'flashcard-stepper-label': { textContent: '' },
    'btn-flashcard-prev': { disabled: true },
    'btn-flashcard-next': { disabled: true },
    'flashcard-filter-count-all': { textContent: '0' },
    'flashcard-filter-count-pending': { textContent: '0' },
    'flashcard-filter-count-reviewed': { textContent: '0' },
    'input-threshold': { value: '60' },
    'input-bubble-threshold': { value: '0.20' },
    'scans-list': { innerHTML: '' }
  };

  const sandbox = {
    document: {
      getElementById: (id) => {
        const el = mockElements[id] || {};
        if (!el.style) el.style = {};
        if (!el.classList) el.classList = { add: () => {}, remove: () => {} };
        if (!el.addEventListener) el.addEventListener = () => {};
        return el;
      },
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { add: () => {}, remove: () => {} } }),
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
              createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
              putImageData: () => {}
            }),
            toDataURL: () => 'data:image/jpeg;base64,mock',
            toBlob: (cb) => cb(new Blob(['mock']))
          };
        }
        return { style: {}, classList: { add: () => {}, remove: () => {} }, addEventListener: () => {}, dataset: {} };
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
    XMLHttpRequest: class {
      constructor() {
        this.headers = {};
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(k, v) {
        this.headers[k] = v;
      }
      send(body) {
        this.body = body;
        if (this.onload) {
          this.status = 204;
          this.onload();
        }
      }
    }
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  new vm.Script(code).runInContext(context);

  return { context, sandbox, storage, mockElements, checkerHtml };
}

test('1. Global Loading Visualizer: showLoading and hideLoading control overlay state', async () => {
  const { context, mockElements } = await loadCheckerSandbox();
  const showLoading = context.showLoading;
  const hideLoading = context.hideLoading;

  assert.equal(typeof showLoading, 'function', 'showLoading must be defined');
  assert.equal(typeof hideLoading, 'function', 'hideLoading must be defined');

  // Test showLoading with progress
  showLoading('Processing Scan', 'Analyzing bubble annular contrast...', 45);
  assert.equal(mockElements['global-loading-indicator'].style.display, 'flex');
  assert.equal(mockElements['global-loading-title'].textContent, 'Processing Scan');
  assert.equal(mockElements['global-loading-message'].textContent, 'Analyzing bubble annular contrast...');
  assert.equal(mockElements['global-loading-bar-wrap'].style.display, 'block');
  assert.equal(mockElements['global-loading-bar'].style.width, '45%');

  // Test hideLoading
  hideLoading();
  assert.equal(mockElements['global-loading-indicator'].style.display, 'none');
});

test('2. Scan Deduplication: addOrUpdateScan replaces duplicates by name and appends new ones', async () => {
  const { context } = await loadCheckerSandbox();
  const addOrUpdateScan = context.addOrUpdateScan;
  assert.equal(typeof addOrUpdateScan, 'function', 'addOrUpdateScan must be defined');

  context.state.scans = [];
  addOrUpdateScan({ name: 'scan_001.jpg', img: { id: 1 } });
  addOrUpdateScan({ name: 'scan_002.jpg', img: { id: 2 } });
  assert.equal(context.state.scans.length, 2);

  // Re-uploading scan_001.jpg should replace the entry, not append a 3rd item
  addOrUpdateScan({ name: 'scan_001.jpg', img: { id: 999 } });
  assert.equal(context.state.scans.length, 2);
  assert.equal(context.state.scans[0].img.id, 999);
});

test('3. Modified True/False: correction ROIs (_corr) are NOT flagged as unkeyed when parent is T', async () => {
  const { context, mockElements } = await loadCheckerSandbox();
  const validatePreflightKeyLayout = context.validatePreflightKeyLayout;

  context.state.layout = {
    paper: 'A4',
    bubbles: [
      { item: '1', choice: 'T' },
      { item: '1', choice: 'F' },
      { item: '2', choice: 'T' },
      { item: '2', choice: 'F' }
    ],
    zones: [
      {
        id: 'mod_tf_zone',
        type: 'modified_tf',
        start: 1,
        count: 2,
        rois: [
          { id: 'mod_tf_zone.1.corr', key: '1_corr', role: 'correction', graded: true, points: 1.0 },
          { id: 'mod_tf_zone.2.corr', key: '2_corr', role: 'correction', graded: true, points: 1.0 }
        ]
      }
    ],
    rois: [
      { id: 'mod_tf_zone.1.corr', key: '1_corr', role: 'correction', graded: true, points: 1.0 },
      { id: 'mod_tf_zone.2.corr', key: '2_corr', role: 'correction', graded: true, points: 1.0 }
    ]
  };

  // Key has item 1 as 'T' (correction not required) and item 2 as 'F' (correction keyed)
  context.state.key = {
    items: {
      '1': { answer: 'T', points: 1.0, kind: 'tf' },
      '2': { answer: 'F', points: 1.0, kind: 'tf' },
      '2_corr': { answer: 'mitochondria', points: 1.0, kind: 'text' }
    }
  };

  const isValid = validatePreflightKeyLayout();
  assert.equal(isValid, true, 'Preflight validation must pass without warning 1_corr as unkeyed');
  assert.equal(mockElements['preflight-warning-banner'].style.display, 'none');
});

test('4. Strict maxScore: processExamScan uses key.total_points without double-counting', async () => {
  const { context } = await loadCheckerSandbox();
  const processExamScan = context.processExamScan;
  assert.equal(typeof processExamScan, 'function', 'processExamScan must be defined');

  const mockScan = {
    name: 'test_scan.jpg',
    img: { width: 840, height: 1188 }
  };

  const mockLayout = {
    paper: 'A4',
    page: { width: 210, height: 297 },
    markers: {
      '0': { center: [12, 12] },
      '1': { center: [198, 12] },
      '2': { center: [198, 285] },
      '3': { center: [12, 285] }
    },
    bubbles: [
      { item: '1', choice: 'A', center: [30, 40], radius: 2.2 },
      { item: '1', choice: 'B', center: [40, 40], radius: 2.2 }
    ],
    rois: [
      { id: 'written_1', key: 'written_1', label: 'Item written_1', graded: true, points: 5.0, roi: { x: 20, y: 50, w: 100, h: 20 } }
    ]
  };

  // Key has pre-defined total_points: 50
  const mockKey = {
    total_points: 50,
    items: {
      '1': { answer: 'A', points: 1.0, kind: 'mcq' },
      'written_1': { answer: 'Sample Answer', points: 5.0, kind: 'text' }
    }
  };

  const grade = processExamScan(mockScan, mockLayout, mockKey, 0.20);
  assert.equal(grade.maxScore, 50, 'maxScore must strictly match key.total_points (50)');
});

test('5. Warping & Piecewise Homography: warpScanToCanonical supports H_bottom and sag correction', async () => {
  const { context } = await loadCheckerSandbox();
  const warpScanToCanonical = context.warpScanToCanonical;
  assert.equal(typeof warpScanToCanonical, 'function', 'warpScanToCanonical must be defined');

  const H_top = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const H_bottom = [1, 0, 0, 0, 1.05, 0, 0, 0, 1];
  const scanData = new Uint8ClampedArray(840 * 1188 * 4);
  scanData.fill(200);

  // Call with 6-point piecewise homography
  const canvas = warpScanToCanonical(scanData, 840, 1188, H_top, 840, 1188, scanData, H_bottom, 594, 0);
  assert.ok(canvas, 'Rectified canvas should be returned');
  assert.equal(canvas.width, 840);
  assert.equal(canvas.height, 1188);
});

test('6. Google Drive Session Deletion: deleteSessionFromGoogleDrive issues DELETE request', async () => {
  const { context } = await loadCheckerSandbox();
  const deleteSessionFromGoogleDrive = context.deleteSessionFromGoogleDrive;
  assert.equal(typeof deleteSessionFromGoogleDrive, 'function', 'deleteSessionFromGoogleDrive must be defined');

  let deleteCalled = false;
  let deletedId = null;
  deleteSessionFromGoogleDrive('test_token_123', 'file_xyz_987', (err, success) => {
    assert.equal(err, null);
    assert.equal(success, true);
    deleteCalled = true;
  });
  assert.equal(deleteCalled, true);
});

test('7. Settings Modal: openSettingsModal opens modal-google-drive without reference errors', async () => {
  const { context, mockElements } = await loadCheckerSandbox();
  const openSettingsModal = context.openSettingsModal;
  assert.equal(typeof openSettingsModal, 'function', 'openSettingsModal must be defined');

  let modalOpened = false;
  mockElements['modal-google-drive'].showModal = () => {
    modalOpened = true;
  };

  openSettingsModal();
  assert.equal(modalOpened, true, 'openSettingsModal must open modal-google-drive dialog');
});

test('8. Google Drive UI State: label-google-drive has display set to none to prevent logo bleeding', async () => {
  const { context, mockElements } = await loadCheckerSandbox();
  const updateGoogleUiState = context.updateGoogleUiState;
  assert.equal(typeof updateGoogleUiState, 'function', 'updateGoogleUiState must be defined');

  context.googleDriveState.isConnected = true;
  context.googleDriveState.user = { name: 'Dr. Phil Sumabat', email: 'phil.sumabat@vsu.edu.ph' };

  updateGoogleUiState();
  assert.equal(mockElements['label-google-drive'].style.display, 'none', 'label text must be hidden to prevent bleeding beyond 32px');

  context.googleDriveState.isConnected = false;
  context.googleDriveState.user = null;
  updateGoogleUiState();
  assert.equal(mockElements['label-google-drive'].style.display, 'none', 'label text must remain hidden when disconnected');
});
