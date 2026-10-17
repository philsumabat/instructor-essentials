import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../../builder/js/layout-engine.js';
import { renderStandaloneHTML, buildSheetTree } from '../../builder/js/render-dom.js';
import { renderSVG } from '../../builder/js/render-svg.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

test('Feature: CV Target Overlay alignment with printed bubbles and item numbers across all rows', () => {
  // 60-item exam with 5 columns (12 rows/col), groupEvery: 5, groupGap: 1.6
  // (Identical structure to the user uploaded scan where rows 5, 10, 17, 22, 29, 34, 41, 46, 53, 58 were previously offset)
  const tpl = {
    id: 'cv-alignment-test',
    title: 'CV Target Alignment Test',
    paper: 'Letter',
    bubble: { diameter: 4.0, pitchX: 5.4, pitchY: 5.0, groupEvery: 5, groupGap: 1.4, stroke: 0.25 },
    zones: [
      {
        id: 'test1',
        type: 'mcq',
        label: 'Test 1 - Multiple Choice',
        count: 60,
        start: 1,
        choices: 'ABCD',
        columns: 5,
        pointsPerItem: 1,
      },
    ],
  };

  const layout = buildLayout(tpl);
  const zone = layout.zones[0];
  assert.equal(zone.grids.length, 5, 'Layout creates 5 column grids');

  // Verify mathematical precision across all 60 questions and their options
  const targetRowsToCheck = [5, 10, 17, 22, 29, 34, 41, 46, 53, 58];
  const checkedTargetRows = new Set();

  for (let c = 0; c < zone.grids.length; c++) {
    const grid = zone.grids[c];
    assert.equal(grid.pitchY, 5.0, 'Grid stores nominal pitchY: 5.0mm');

    for (let r = 0; r < 12; r++) {
      const qNum = c * 12 + r + 1;
      const group = zone.groups.find((g) => g.key === String(qNum));
      assert.ok(group, `Group found for question ${qNum}`);

      // Row track height in CSS Grid
      const isGroupBreak = (r + 1) % 5 === 0 && r < 11;
      const expectedRowTrackH = 5.0 + (isGroupBreak ? 1.4 : 0);
      assert.equal(grid.rows[r], expectedRowTrackH, `Row ${r} track height must be ${expectedRowTrackH}mm`);

      // Top of row track
      const y0 = grid.y + grid.rows.slice(0, r).reduce((a, b) => a + b, 0);

      // In DOM renderer:
      // cellBubbleOffset = (nominalRowH - diameter) / 2 = (5.0 - 4.0) / 2 = 0.5mm
      // Bubble top = y0 + 0.5mm. Bubble center = y0 + 0.5 + 2.0 = y0 + 2.5mm
      const domBubbleCenterY = y0 + (grid.pitchY - layout.bubble.diameter) / 2 + layout.bubble.diameter / 2;

      // In SVG renderer:
      // Bubble cy = y0 + nominalRowH / 2 = y0 + 2.5mm
      const svgBubbleCenterY = y0 + grid.pitchY / 2;

      for (const opt of group.options) {
        // CV target overlay circle cy from layout engine
        const cvTargetCy = opt.cy;

        // Verify zero offset between CV target, DOM bubble, and SVG bubble
        assert.ok(
          Math.abs(domBubbleCenterY - cvTargetCy) < 1e-4,
          `Q${qNum} (${opt.value}): DOM bubble center (${domBubbleCenterY}) must match CV target cy (${cvTargetCy})`
        );
        assert.ok(
          Math.abs(svgBubbleCenterY - cvTargetCy) < 1e-4,
          `Q${qNum} (${opt.value}): SVG bubble center (${svgBubbleCenterY}) must match CV target cy (${cvTargetCy})`
        );
      }

      if (targetRowsToCheck.includes(qNum)) {
        checkedTargetRows.add(qNum);
      }
    }
  }

  assert.equal(checkedTargetRows.size, targetRowsToCheck.length, 'All group-break target rows were verified');

  // Verify rendered SVG text and circle elements for group break rows
  const svg = renderSVG(layout);
  // Row 5 is question 5 (first col, r=4). y0 = 53.5 (or layout y) + 4 * 5 = y0 + 20.
  // CV target is exactly at y0 + 22.5.
  const q5 = zone.groups.find((g) => g.key === '5');
  const q5Cy = q5.options[0].cy;
  assert.ok(
    svg.includes(`cy="${q5Cy}"`),
    `SVG output must contain circle cy="${q5Cy}" matching CV target for row 5`
  );
  assert.ok(
    svg.includes(`y="${q5Cy}"`) && svg.includes('>5<'),
    `SVG output must contain number 5 centered at y="${q5Cy}" matching CV target`
  );
});

test('Feature: Show / Hide points per item option on each block (MCQ, True/False, Modified T/F, Short Answer, Essay)', () => {
  // 1. MCQ with showPoints: true
  const tplMcqWithPts = {
    id: 'mcq-pts-true',
    title: 'MCQ With Points',
    paper: 'A4',
    zones: [
      {
        id: 'm1',
        type: 'mcq',
        label: 'Part I — Multiple Choice',
        count: 20,
        choices: 'ABCD',
        pointsPerItem: 1,
        showPoints: true,
      },
    ],
  };
  const layoutMcqWithPts = buildLayout(tplMcqWithPts);
  const domMcqWithPts = renderStandaloneHTML(layoutMcqWithPts);
  const svgMcqWithPts = renderSVG(layoutMcqWithPts);
  assert.ok(domMcqWithPts.includes('(1 pt each)'), 'DOM renders (1 pt each) badge when showPoints is true on MCQ');
  assert.ok(svgMcqWithPts.includes('Part I — Multiple Choice (1 pt each)'), 'SVG renders points suffix when showPoints is true on MCQ');

  // 2. MCQ with showPoints: false (points hidden)
  const tplMcqNoPts = {
    id: 'mcq-pts-false',
    title: 'MCQ Without Points',
    paper: 'A4',
    zones: [
      {
        id: 'm2',
        type: 'mcq',
        label: 'Part I — Multiple Choice',
        count: 20,
        choices: 'ABCD',
        pointsPerItem: 1,
        showPoints: false,
      },
    ],
  };
  const layoutMcqNoPts = buildLayout(tplMcqNoPts);
  const domMcqNoPts = renderStandaloneHTML(layoutMcqNoPts);
  const svgMcqNoPts = renderSVG(layoutMcqNoPts);
  assert.ok(!domMcqNoPts.includes('(1 pt each)'), 'DOM hides points badge when showPoints is false on MCQ');
  assert.ok(!svgMcqNoPts.includes('(1 pt each)'), 'SVG hides points badge when showPoints is false on MCQ');

  // 3. True/False with showPoints: true vs false
  const tplTfWithPts = {
    id: 'tf-pts-test',
    title: 'TF Points Test',
    paper: 'A4',
    zones: [
      {
        id: 'tf1',
        type: 'truefalse',
        label: 'Part II — True / False',
        count: 10,
        pointsPerItem: 2,
        showPoints: true,
      },
    ],
  };
  const layoutTfWithPts = buildLayout(tplTfWithPts);
  const domTfWithPts = renderStandaloneHTML(layoutTfWithPts);
  const svgTfWithPts = renderSVG(layoutTfWithPts);
  assert.ok(domTfWithPts.includes('(2 pts each)'), 'DOM renders (2 pts each) when showPoints is true on True/False');
  assert.ok(svgTfWithPts.includes('Part II — True / False (2 pts each)'), 'SVG renders points suffix when showPoints is true on True/False');

  // 4. Modified True/False with showPoints: true vs false
  const tplModTf = {
    id: 'modtf-pts-test',
    title: 'ModTF Points Test',
    paper: 'A4',
    zones: [
      {
        id: 'mtf1',
        type: 'modified_tf',
        label: 'Part III — Modified True / False',
        count: 5,
        pointsPerItem: 3,
        showPoints: true,
      },
      {
        id: 'mtf2',
        type: 'modified_tf',
        label: 'Part IV — Modified True / False',
        count: 5,
        pointsPerItem: 3,
        showPoints: false,
      },
    ],
  };
  const layoutModTf = buildLayout(tplModTf);
  const domModTf = renderStandaloneHTML(layoutModTf);
  const svgModTf = renderSVG(layoutModTf);
  assert.ok(domModTf.includes('(3 pts each)'), 'DOM renders (3 pts each) for showPoints: true on modified_tf');
  assert.ok(svgModTf.includes('Part III — Modified True / False (3 pts each)'), 'SVG renders points suffix for showPoints: true on modified_tf');
  assert.ok(svgModTf.includes('Part IV — Modified True / False') && !svgModTf.includes('Part IV — Modified True / False (3 pts each)'), 'SVG hides points suffix for showPoints: false on modified_tf');

  // 5. Short Answer and Essay: showPoints: false hides points
  const tplTextNoPts = {
    id: 'text-no-pts',
    title: 'Text No Points',
    paper: 'A4',
    zones: [
      {
        id: 'sa1',
        type: 'text_short',
        label: 'Part V — Identification',
        count: 5,
        pointsPerItem: 2,
        showPoints: false,
      },
      {
        id: 'es1',
        type: 'text_essay',
        label: 'Part VI — Essay',
        count: 1,
        points: 10,
        showPoints: false,
      },
    ],
  };
  const layoutTextNoPts = buildLayout(tplTextNoPts);
  const domTextNoPts = renderStandaloneHTML(layoutTextNoPts);
  const svgTextNoPts = renderSVG(layoutTextNoPts);
  assert.ok(!domTextNoPts.includes('(2 pts each)'), 'DOM hides points badge on Short Answer when showPoints is false');
  assert.ok(!domTextNoPts.includes('(10 pts)'), 'DOM hides points badge on Essay when showPoints is false');
  assert.ok(!svgTextNoPts.includes('(2 pts each)'), 'SVG hides points badge on Short Answer when showPoints is false');
  assert.ok(!svgTextNoPts.includes('(10 pts)'), 'SVG hides points badge on Essay when showPoints is false');

  // 6. Label cleanup: if label had embedded points and showPoints is false, points are stripped for display
  const tplEmbeddedPts = {
    id: 'embedded-pts-test',
    title: 'Embedded Points Test',
    paper: 'A4',
    zones: [
      {
        id: 'm-embed',
        type: 'mcq',
        label: 'Part I — Multiple Choice (1 pt each)',
        count: 10,
        pointsPerItem: 1,
        showPoints: false,
      },
      {
        id: 'm-embed-spelled',
        type: 'mcq',
        label: 'Part II — Multiple Choice (2 points each)',
        count: 10,
        pointsPerItem: 2,
        showPoints: false,
      },
    ],
  };
  const layoutEmbeddedPts = buildLayout(tplEmbeddedPts);
  const domEmbedded = renderStandaloneHTML(layoutEmbeddedPts);
  const svgEmbedded = renderSVG(layoutEmbeddedPts);
  assert.ok(!domEmbedded.includes('(1 pt each)'), 'DOM strips embedded points from title when showPoints is false');
  assert.ok(!svgEmbedded.includes('(1 pt each)'), 'SVG strips embedded points from title when showPoints is false');
  assert.ok(!domEmbedded.includes('(2 points each)'), 'DOM strips spelled-out embedded points from title when showPoints is false');
  assert.ok(!svgEmbedded.includes('(2 points each)'), 'SVG strips spelled-out embedded points from title when showPoints is false');

  // 7. Empty section title with showPoints: true renders points suffix
  const tplEmptyLabel = {
    id: 'empty-label-test',
    title: 'Empty Label Test',
    paper: 'A4',
    zones: [
      {
        id: 'm-empty-label',
        type: 'mcq',
        label: '',
        count: 10,
        pointsPerItem: 1,
        showPoints: true,
      },
    ],
  };
  const layoutEmptyLabel = buildLayout(tplEmptyLabel);
  const domEmptyLabel = renderStandaloneHTML(layoutEmptyLabel);
  const svgEmptyLabel = renderSVG(layoutEmptyLabel);
  assert.ok(domEmptyLabel.includes('(1 pt each)'), 'DOM renders points suffix when label is empty but showPoints is true');
  assert.ok(svgEmptyLabel.includes('(1 pt each)'), 'SVG renders points suffix when label is empty but showPoints is true');

  // 8. Student ID and Modified True/False CV target alignment verification
  const tplSidMod = {
    id: 'sid-mod-alignment',
    title: 'SID and ModTF Alignment',
    paper: 'A4',
    zones: [
      {
        id: 'sid-zone',
        type: 'student_id',
        label: 'ID no.',
        digits: 8,
        shading: true,
      },
      {
        id: 'modtf-zone',
        type: 'modified_tf',
        label: 'Modified T/F',
        count: 5,
        pointsPerItem: 2,
        showPoints: true,
      },
    ],
  };
  const layoutSidMod = buildLayout(tplSidMod);
  // Verify student ID bubble centers match layout options
  const sidZone = layoutSidMod.zones.find((z) => z.id === 'sid-zone');
  const sidGrid = sidZone.grids[0];
  for (const group of sidZone.groups) {
    for (const opt of group.options) {
      const row = parseInt(opt.value, 10) + 2;
      const col = group.index;
      const y0 = sidGrid.y + sidGrid.rows.slice(0, row).reduce((a, b) => a + b, 0);
      const expectedCy = y0 + sidGrid.pitchY / 2;
      assert.ok(Math.abs(opt.cy - expectedCy) < 1e-4, `SID digit ${col} opt ${opt.value} cy must match nominal pitch`);
    }
  }

  // Verify Modified T/F bubble centers match layout options
  const modZone = layoutSidMod.zones.find((z) => z.id === 'modtf-zone');
  const modGrid = modZone.grids[0];
  for (const group of modZone.groups) {
    for (const opt of group.options) {
      const qIndex = parseInt(group.key, 10) - (modZone.start ?? 1);
      const y0 = modGrid.y + modGrid.rows.slice(0, qIndex).reduce((a, b) => a + b, 0);
      const expectedCy = y0 + modGrid.pitchY / 2;
      assert.ok(Math.abs(opt.cy - expectedCy) < 1e-4, `ModTF Q${group.key} opt ${opt.value} cy must match nominal pitch`);
    }
  }

  // 8. Sheet Builder Inspector UI verification in app.js
  const appJs = fs.readFileSync(path.join(rootDir, 'builder/js/app.js'), 'utf8');
  assert.match(appJs, /id="insp-show-points"/, 'Inspector includes insp-show-points checkbox');
  assert.match(appJs, /<span>Show points on sheet<\/span>/, 'Inspector displays "Show points on sheet" label');
  assert.match(appJs, /zone\.showPoints\s*=\s*e\.target\.checked/, 'Inspector wires change listener to update zone.showPoints');
});
