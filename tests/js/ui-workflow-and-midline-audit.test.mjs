import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { buildLayout, PAPER_SIZES, allGroups } from '../../builder/js/layout-engine.js';
import { SAMPLE_TEMPLATES } from '../../builder/js/templates.js';
import { renderSVG } from '../../builder/js/render-svg.js';

const cloneTemplate = (t) => JSON.parse(JSON.stringify(t));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

test('1. Midline fiducials across all 6 paper sizes: zero overlap on wide zones, columns, inline zones, fields, and modified_tf', () => {
  const paperNames = Object.keys(PAPER_SIZES);
  assert.ok(paperNames.length >= 6, 'Should test all 6 supported paper sizes');
  const templateNames = ['exam-50', 'exam-100', 'quiz-tf', 'quiz-bonus'];

  for (const paperName of paperNames) {
    for (const tplName of templateNames) {
      const tpl = cloneTemplate(SAMPLE_TEMPLATES[tplName]);
      tpl.paper = paperName;
      tpl.fiducial = { ...(tpl.fiducial || {}), ids: [0, 1, 4, 5, 2, 3] };

      const layout = buildLayout(tpl);
      assert.equal(layout.fiducials.length, 6, `Midline markers 4 & 5 present on ${paperName} (${tplName})`);

      const safeLeft = layout.content.x;
      const safeRight = layout.content.x + layout.content.w;

      for (const z of layout.zones) {
        assert.ok(z.bbox.x >= safeLeft - 0.05, `Zone ${z.id} on ${paperName} (${tplName}) x=${z.bbox.x} must be >= safeLeft=${safeLeft}`);
        assert.ok(z.bbox.x + z.bbox.w <= safeRight + 0.05, `Zone ${z.id} on ${paperName} (${tplName}) right=${z.bbox.x + z.bbox.w} must be <= safeRight=${safeRight}`);

        for (const r of (z.rois || [])) {
          const rw = r.w != null ? r.w : (r.width || 0);
          assert.ok(
            r.x + rw <= z.bbox.x + z.bbox.w + 0.1,
            `ROI ${r.id || r.key} in ${z.id} on ${paperName} (${tplName}) must not overflow zone right boundary`
          );
          assert.ok(rw >= 8, `ROI ${r.id || r.key} in ${z.id} on ${paperName} (${tplName}) must retain usable width`);
        }
      }

      for (const g of allGroups(layout)) {
        for (const opt of (g.options || [])) {
          const r = (layout.bubble?.diameter || 4.2) / 2;
          assert.ok(opt.cx - r >= safeLeft - 0.5, `Bubble ${g.key}:${opt.label} on ${paperName} (${tplName}) must not overlap left fiducial column`);
          assert.ok(opt.cx + r <= safeRight + 0.5, `Bubble ${g.key}:${opt.label} on ${paperName} (${tplName}) must not overlap right fiducial column`);
        }
      }

      const fidWarnings = layout.warnings.filter(w => w.includes('intrudes on the quiet zone'));
      assert.equal(fidWarnings.length, 0, `Zero fiducial quiet-zone intrusions on ${paperName} (${tplName}): ${fidWarnings.join('; ')}`);

      // Verify SVG renders cleanly without throwing
      const svg = renderSVG(layout);
      assert.ok(svg.includes('<svg') && svg.includes('</svg>'), `SVG renders cleanly for ${paperName} (${tplName})`);
    }
  }
});

test('2. Midline fiducials & paper size reversibility: toggling midline off restores original zone geometry', () => {
  const tplOff = cloneTemplate(SAMPLE_TEMPLATES['exam-50']);
  tplOff.fiducial = { ids: [0, 1, 2, 3] };
  const layoutBefore = buildLayout(tplOff);

  const tplOn = cloneTemplate(SAMPLE_TEMPLATES['exam-50']);
  tplOn.fiducial = { ids: [0, 1, 4, 5, 2, 3] };
  const layoutMidline = buildLayout(tplOn);

  const tplOffAgain = cloneTemplate(SAMPLE_TEMPLATES['exam-50']);
  tplOffAgain.fiducial = { ids: [0, 1, 2, 3] };
  const layoutAfter = buildLayout(tplOffAgain);

  assert.equal(layoutBefore.fiducials.length, 4);
  assert.equal(layoutMidline.fiducials.length, 6);
  assert.equal(layoutAfter.fiducials.length, 4);

  for (let i = 0; i < layoutBefore.zones.length; i++) {
    assert.equal(layoutAfter.zones[i].bbox.x, layoutBefore.zones[i].bbox.x, `Zone ${layoutBefore.zones[i].id} x restored`);
    assert.equal(layoutAfter.zones[i].bbox.w, layoutBefore.zones[i].bbox.w, `Zone ${layoutBefore.zones[i].id} width restored`);
  }
});

test('3. Sheet Builder UI: grouped palette, zoom left-edge clipping fix, overflow hint, and Bloom Answer Key controls', () => {
  const indexHtml = fs.readFileSync(path.join(rootDir, 'builder/index.html'), 'utf8');
  const appCss = fs.readFileSync(path.join(rootDir, 'builder/css/app.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');

  // Palette grouping & inspector distinction
  assert.ok(indexHtml.includes('class="palette-group-label"'), 'Palette groups blocks by purpose');
  assert.ok(indexHtml.includes('Exam-Wide Setup'), 'Inspector clearly labels Exam-Wide Setup');
  assert.ok(indexHtml.includes('Block Settings'), 'Inspector clearly labels Selected Block Settings');
  assert.ok(indexHtml.includes('Preview Zoom:'), 'Preview toolbar clarifies Preview Zoom vs 100% print scale');
  assert.ok(indexHtml.includes('id="overflow-action-hint"'), 'Overflow banner includes actionable hint');

  // Zoom left-edge clipping protection
  assert.ok(appCss.includes('.preview__viewport') && appCss.includes('display: block;'), 'Viewport uses block layout to prevent flex center left-edge clipping');
  assert.ok(appCss.includes('margin: 0 auto;'), 'Preview frame centers via margin: 0 auto');

  // Bloom controls in Sheet Builder Answer Key Modal
  assert.ok(indexHtml.includes('id="key-bloom-status-badge"'), 'Sheet Builder Answer Key modal shows Bloom mapping count badge');
  assert.ok(indexHtml.includes('id="key-bulk-bloom-scope"'), 'Sheet Builder Answer Key modal has bulk Bloom scope selector');
  assert.ok(indexHtml.includes('id="btn-key-apply-bulk-bloom"'), 'Sheet Builder Answer Key modal has bulk Bloom apply button');
  assert.ok(appJs.includes('const keyKeys = Object.keys(activeKeyItems);'), 'Fixed keyKeys ReferenceError in Sheet Builder CSV export');
});

test('4. Home Portal: recent work prioritization, connected work-state badges, direct actions, and separated maintenance', () => {
  const homeHtml = fs.readFileSync(path.join(rootDir, 'builder/home.html'), 'utf8');

  const recentIdx = homeHtml.indexOf('id="recent-work-section"');
  const launchersIdx = homeHtml.indexOf('class="launchers-grid"');
  assert.ok(recentIdx !== -1 && launchersIdx !== -1 && recentIdx < launchersIdx, 'Recent Projects & Sessions appears before Workflow Launchers');
  assert.ok(homeHtml.includes('id="getting-started-strip"'), 'Concise Getting Started strip exists');

  // Work state badges
  for (const stateLabel of ['Draft', 'Ready to grade', 'In progress', 'Needs review', 'Completed']) {
    assert.ok(homeHtml.includes(stateLabel), `Home portal includes "${stateLabel}" work state badge`);
  }

  // Direct action labels
  for (const actionLabel of ['Resume grading', 'Edit sheet', 'Start grading from this sheet']) {
    assert.ok(homeHtml.includes(actionLabel), `Home portal includes "${actionLabel}" direct action`);
  }

  // Destructive maintenance separated
  assert.ok(homeHtml.includes('id="btn-clear-all-workspaces"'), 'Clear all workspaces button exists in maintenance footer');
});

test('5. Checker Studio: Restored vs Ready scan counts, collapsible review reasons, Bell Curve label staggering, and Bloom null-safety', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch, 'Checker script present');

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      const attrs = new Map();
      elements.set(id, {
        id,
        style: {},
        dataset: {},
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        removeAttribute: (k) => attrs.delete(k),
        classList: {
          add: (...c) => c.forEach(x => classes.add(x)),
          remove: (...c) => c.forEach(x => classes.delete(x)),
          contains: (x) => classes.has(x),
          toggle: (x, f) => {
            if (f === undefined) { if (classes.has(x)) classes.delete(x); else classes.add(x); }
            else if (f) classes.add(x); else classes.delete(x);
          }
        },
        addEventListener: () => {},
        querySelector: () => ({ textContent: '' }),
        querySelectorAll: () => [],
        getContext: () => ({
          fillRect: () => {},
          clearRect: () => {},
          drawImage: () => {},
          strokeRect: () => {},
          fillText: () => {},
          measureText: () => ({ width: 30 }),
          setLineDash: () => {},
          beginPath: () => {},
          arc: () => {},
          fill: () => {},
          stroke: () => {}
        })
      });
    }
    return elements.get(id);
  };

  const sandbox = {
    window: {},
    document: {
      getElementById: getEl,
      querySelector: () => getEl('__qs__'),
      querySelectorAll: () => [],
      createElement: () => getEl('__ce__'),
      body: getEl('__body__')
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    navigator: { onLine: false },
    console,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    Uint8Array,
    Uint8ClampedArray,
    Uint32Array,
    DataView,
    TextEncoder,
    Image: class { constructor() { this.width = 840; this.height = 1188; this.complete = true; } },
    FileReader: class {},
    Blob: class { constructor(p) { this.parts = p; } },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox);

  // A. Verify restored session shows "N Restored" and updates #scans-list
  sandbox.state.layout = { title: 'Bio Exam', bubbles: [{ item: '1', choice: 'A', x: 20, y: 20 }] };
  sandbox.state.key = { title: 'Bio Key', total_points: 1, items: { '1': { answer: 'A', points: 1, bloom: null } } };
  sandbox.restoreCheckerProgress({
    layout: sandbox.state.layout,
    key: sandbox.state.key,
    results: {
      passThreshold: 60,
      grades: [
        {
          examId: 'scan_01.jpg',
          studentId: '1001',
          studentName: 'Maria Clara',
          nameCropDataUrl: 'data:image/jpeg;base64,crop',
          rawScore: 1,
          maxScore: 1,
          percentage: 100,
          gradedItems: { '1': { expected: 'A', actual: 'A', pointsAwarded: 1, maxPoints: 1, isCorrect: true } },
          reviewFlags: { needsReview: true, reasons: ['1 blank response', 'Unverified Student ID'] }
        }
      ]
    }
  }, { silent: true });

  sandbox.updateStepperUI();
  assert.equal(getEl('step-status-3').textContent, '1 Restored', 'Restored session without raw images shows "1 Restored"');
  assert.ok(getEl('scans-list').innerHTML.includes('Restored 1 graded record'), 'Scans list explains restored records instead of saying No scans uploaded yet');

  // B. Verify collapsible review reasons and matched student name caption in Roster Table
  sandbox.renderRosterTable();
  const rosterHtml = getEl('tbody-roster').innerHTML;
  assert.ok(rosterHtml.includes('class="roster-reasons-disclosure"'), 'Roster row includes collapsible <details> disclosure for review reasons');
  assert.ok(rosterHtml.includes('2 reasons'), 'Roster row shows compact reason count pill');
  assert.ok(rosterHtml.includes('Maria Clara'), 'Roster row shows matched student name caption alongside name crop');

  // C. Verify Bell Curve SVG label staggering when Mean and Cutoff collide
  const bellSvg = sandbox.generateBellCurveSVG([
    { rawScore: 30, maxScore: 50, percentage: 60 },
    { rawScore: 30, maxScore: 50, percentage: 60 }
  ], 60);
  assert.ok(bellSvg.includes('Mean:') && bellSvg.includes('Cutoff:'), 'Bell Curve includes Mean and Cutoff labels');

  // D. Verify HTML export does not crash when item.bloom is null
  let downloadedHtml = '';
  sandbox.downloadFile = (fname, content) => { downloadedHtml = content; };
  getEl('btn-export-html').onclick();
  assert.ok(downloadedHtml.includes('<!doctype html>'), 'HTML report exported cleanly even when item.bloom is null');
  assert.ok(!downloadedHtml.includes('badge-bloom--null'), 'HTML report never renders badge-bloom--null');
});
