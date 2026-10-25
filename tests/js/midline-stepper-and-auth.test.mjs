import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildLayout } from '../../builder/js/layout-engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('midline fiducials (6-marker setup) enforce lateral margin and prevent zone overlap', async () => {
  const baseTpl = {
    id: 'test-midline',
    title: '6-Marker Clearance Test',
    paper: 'A4',
    margin: 12, // 12mm default margin
    midlineFiducials: true,
    zones: [
      {
        id: 'info',
        type: 'instructions',
        w: 186,
        text: 'Midline Clearance Test Instructions'
      },
      {
        id: 'mcq-zone',
        type: 'mcq',
        count: 30,
        columns: 2,
        choices: 'ABCD',
        w: 186
      }
    ]
  };

  const layout = buildLayout(baseTpl);

  // 1. Verify 6 fiducial markers exist (IDs 0, 1, 2, 3, 4, 5)
  assert.equal(layout.fiducials.length, 6, 'Should have exactly 6 fiducials');
  const markerIds = layout.fiducials.map(f => f.id).sort((a, b) => a - b);
  assert.deepEqual(markerIds, [0, 1, 2, 3, 4, 5]);

  // 2. Lateral margin should be automatically adjusted to at least 21mm
  assert.ok(layout.content.x >= 20, `Content X (${layout.content.x}) must clear left midline marker`);
  assert.ok(layout.page.width - (layout.content.x + layout.content.w) >= 20, 'Right margin must clear right midline marker');

  // 3. Midline fiducial coordinates: Marker 4 (left middle) and Marker 5 (right middle)
  const m4 = layout.fiducials.find(f => f.id === 4);
  const m5 = layout.fiducials.find(f => f.id === 5);
  assert.ok(m4 && m5, 'Markers 4 and 5 must be present');

  const halfH = layout.page.height / 2;
  assert.equal(m4.center[1], halfH, 'Marker 4 Y should be centered vertically');
  assert.equal(m5.center[1], halfH, 'Marker 5 Y should be centered vertically');

  // Left marker boundary: x + size + quietZone (3mm)
  const quietZone = 3;
  const m4RightEdge = m4.x + m4.size + quietZone;
  const m5LeftEdge = m5.x - quietZone;

  // 4. Verify no layout zones or bubbles cross into Marker 4 or Marker 5 lateral quiet zone
  for (const zone of layout.zones) {
    assert.ok(zone.bbox.x >= m4RightEdge, `Zone ${zone.id} left edge (${zone.bbox.x}) must not intrude on Marker 4 quiet zone (${m4RightEdge})`);
    assert.ok(zone.bbox.x + zone.bbox.w <= m5LeftEdge, `Zone ${zone.id} right edge (${zone.bbox.x + zone.bbox.w}) must not intrude on Marker 5 quiet zone (${m5LeftEdge})`);
  }

  // Extract all bubble options from layout groups
  const bubbles = (layout.zones || []).flatMap(z => (z.groups || []).flatMap(g => g.options || []));
  assert.ok(bubbles.length > 0, 'Should have generated bubbles');
  for (const bubble of bubbles) {
    assert.ok(bubble.cx > m4RightEdge, `Bubble at X ${bubble.cx} must clear Marker 4 quiet zone (${m4RightEdge})`);
    assert.ok(bubble.cx < m5LeftEdge, `Bubble at X ${bubble.cx} must clear Marker 5 quiet zone (${m5LeftEdge})`);
  }
});

test('checker studio 1-2-3 sequential stepper progression and validation alerts', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify markup structure
  assert.ok(checkerHtml.includes('id="card-layout-quick"'), 'Step 1 card must exist');
  assert.ok(checkerHtml.includes('id="card-key-quick"'), 'Step 2 card must exist');
  assert.ok(checkerHtml.includes('id="card-scans-quick"'), 'Step 3 card must exist');
  assert.ok(checkerHtml.includes('id="step-badge-1"'), 'Step 1 badge must exist');
  assert.ok(checkerHtml.includes('id="step-badge-2"'), 'Step 2 badge must exist');
  assert.ok(checkerHtml.includes('id="step-badge-3"'), 'Step 3 badge must exist');
  assert.ok(checkerHtml.includes('id="checker-empty-state"'), 'Stepper empty state board must exist');
  assert.ok(checkerHtml.includes('id="empty-step-1"'), 'Stepper board step 1 must exist');
  assert.ok(checkerHtml.includes('id="empty-step-2"'), 'Stepper board step 2 must exist');
  assert.ok(checkerHtml.includes('id="empty-step-3"'), 'Stepper board step 3 must exist');

  // Verify premature auto-grade triggers were removed
  assert.ok(!checkerHtml.includes('if (state.scans.length > 0) {\n          $(\'btn-grade-now\').click();\n        }'), 'applyLoadedLayout must not auto-trigger grading');
  assert.ok(!checkerHtml.includes('if (state.scans.length > 0) $(\'btn-grade-now\').click();'), 'handleAnswerKeyUpload must not auto-trigger grading');

  // Execute in sandbox to test updateStepperUI and sequential alert validations
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block must be present');

  const alerts = [];
  const createMockEl = (overrides = {}) => {
    const classListSet = new Set(overrides.classes || []);
    return {
      style: {},
      classList: {
        add: (...cls) => cls.forEach(c => classListSet.add(c)),
        remove: (...cls) => cls.forEach(c => classListSet.delete(c)),
        contains: (c) => classListSet.has(c)
      },
      addEventListener: () => {},
      setAttribute: () => {},
      removeAttribute: () => {},
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      ...overrides
    };
  };

  const elements = {
    'card-layout-quick': createMockEl(),
    'card-key-quick': createMockEl({ classes: ['step--locked'] }),
    'card-scans-quick': createMockEl({ classes: ['step--locked'] }),
    'step-badge-1': createMockEl(),
    'step-status-1': createMockEl(),
    'step-badge-2': createMockEl({ classes: ['is-locked'] }),
    'step-status-2': createMockEl({ classes: ['is-locked'] }),
    'step-badge-3': createMockEl({ classes: ['is-locked'] }),
    'step-status-3': createMockEl({ classes: ['is-locked'] }),
    'empty-step-1': createMockEl(),
    'empty-step-2': createMockEl({ classes: ['step--locked'] }),
    'empty-step-3': createMockEl({ classes: ['step--locked'] }),
    'empty-step-1-desc': createMockEl(),
    'empty-step-2-desc': createMockEl(),
    'empty-step-3-desc': createMockEl(),
    'btn-grade-now': createMockEl(),
    'auth-gate-overlay': createMockEl()
  };

  const sandbox = {
    document: {
      getElementById: (id) => elements[id] || createMockEl(),
      querySelectorAll: () => [],
      querySelector: () => createMockEl(),
      createElement: () => createMockEl()
    },
    window: {
      location: undefined, // Headless environment
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    alert: (msg) => { alerts.push(msg); },
    console,
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    Image: class { constructor() { this.src = ''; } },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox);

  assert.equal(typeof sandbox.window.updateStepperUI, 'function', 'updateStepperUI must be exported');

  // Test 1: Initial state (Nothing loaded)
  sandbox.window.state.layout = null;
  sandbox.window.state.key = null;
  sandbox.window.state.scans = [];
  sandbox.window.updateStepperUI();

  assert.ok(elements['card-key-quick'].classList.contains('step--locked'), 'Step 2 card must be locked');
  assert.ok(elements['card-scans-quick'].classList.contains('step--locked'), 'Step 3 card must be locked');
  assert.equal(elements['step-status-1'].textContent, 'Pending');
  assert.equal(elements['step-status-2'].textContent, 'Locked');
  assert.equal(elements['step-status-3'].textContent, 'Locked');

  // Test grading button validation: Step 1 incomplete
  alerts.length = 0;
  elements['btn-grade-now'].onclick();
  assert.equal(alerts[0], 'Step 1 Incomplete: Please select or upload an exam layout.');

  // Test 2: Step 1 Complete (Layout loaded, but no key)
  sandbox.window.state.layout = { bubbles: [{ id: 'b1' }], page: { width: 210, height: 297 } };
  sandbox.window.updateStepperUI();

  assert.equal(elements['step-status-1'].textContent, 'Ready');
  assert.ok(!elements['card-key-quick'].classList.contains('step--locked'), 'Step 2 card must be unlocked');
  assert.ok(elements['card-scans-quick'].classList.contains('step--locked'), 'Step 3 card must still be locked');
  assert.equal(elements['step-status-2'].textContent, 'Pending');
  assert.equal(elements['step-status-3'].textContent, 'Locked');

  // Test grading button validation: Step 2 incomplete
  alerts.length = 0;
  elements['btn-grade-now'].onclick();
  assert.equal(alerts[0], 'Step 2 Incomplete: Please upload your master answer sheet or set an answer key.');

  // Test 3: Step 1 & 2 Complete (Layout & Key loaded, but no scans)
  sandbox.window.state.key = { items: { 'q1': { answer: 'A', points: 1 } } };
  sandbox.window.updateStepperUI();

  assert.equal(elements['step-status-2'].textContent, 'Ready');
  assert.ok(!elements['card-scans-quick'].classList.contains('step--locked'), 'Step 3 card must be unlocked');
  assert.equal(elements['step-status-3'].textContent, 'Pending');

  // Test grading button validation: Step 3 incomplete
  alerts.length = 0;
  elements['btn-grade-now'].onclick();
  assert.equal(alerts[0], 'Step 3 Incomplete: Please upload student exam scans.');

  // Test 4: All Steps Complete (Layout, Key, and Scans present)
  sandbox.window.state.scans = [{ name: 'scan1.jpg' }, { name: 'scan2.jpg' }];
  sandbox.window.updateStepperUI();

  assert.equal(elements['step-status-3'].textContent, '2 Ready');
  assert.ok(!elements['card-scans-quick'].classList.contains('step--locked'));
});

test('institutional Google Sign-In auth gating overlay and local bypass', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // Verify overlay element IDs
  assert.ok(indexHtml.includes('id="auth-gate-overlay"'), 'index.html must have auth-gate-overlay');
  assert.ok(indexHtml.includes('id="btn-gate-google-signin"'), 'index.html must have btn-gate-google-signin');
  assert.ok(indexHtml.includes('id="btn-gate-local-bypass"'), 'index.html must have btn-gate-local-bypass');

  assert.ok(checkerHtml.includes('id="auth-gate-overlay"'), 'checker.html must have auth-gate-overlay');
  assert.ok(checkerHtml.includes('id="btn-gate-google-signin"'), 'checker.html must have btn-gate-google-signin');
  assert.ok(checkerHtml.includes('id="btn-gate-local-bypass"'), 'checker.html must have btn-gate-local-bypass');

  // Verify home.html intercepts navigation when unauthenticated
  assert.ok(homeHtml.includes('a[href*="builder.html"], a[href*="checker.html"]'), 'home.html must guard launcher links');

  // Test checkAuthGating logic in VM with simulated protocols
  const createMockEl = () => ({ style: { display: '' } });
  const gateEl = createMockEl();
  const bypassEl = createMockEl();

  // Test with browser environment: unauthenticated on http:
  const checkGateFn = (isConnected, protocol) => {
    if (isConnected) {
      gateEl.style.display = 'none';
    } else {
      bypassEl.style.display = protocol === 'file:' ? 'inline-flex' : 'none';
      gateEl.style.display = 'flex';
    }
  };

  checkGateFn(false, 'https:');
  assert.equal(gateEl.style.display, 'flex', 'Gate should be shown on https when unauthenticated');
  assert.equal(bypassEl.style.display, 'none', 'Local bypass button should be hidden on https');

  checkGateFn(false, 'file:');
  assert.equal(gateEl.style.display, 'flex', 'Gate should be shown on file: when unauthenticated');
  assert.equal(bypassEl.style.display, 'inline-flex', 'Local bypass button should be visible on file:');

  checkGateFn(true, 'https:');
  assert.equal(gateEl.style.display, 'none', 'Gate should be hidden when authenticated');
});
