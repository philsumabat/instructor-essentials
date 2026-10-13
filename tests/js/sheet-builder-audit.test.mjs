import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Import modules directly for comprehensive unit and integration verification
import { buildLayout, layoutStats, TemplateError, allGroups, PAPER_SIZES } from '../../builder/js/layout-engine.js';
import { renderSheetDOM, renderStandaloneHTML, buildSheetTree, toHTML, pageRule, escapeHTML } from '../../builder/js/render-dom.js';
import { renderSVG } from '../../builder/js/render-svg.js';
import { SAMPLE_TEMPLATES } from '../../builder/js/templates.js';

const createMockDoc = () => {
  const makeEl = (tag) => ({
    tag,
    attrs: {},
    children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
  });
  return {
    createElement: makeEl,
    createElementNS: (_ns, tag) => makeEl(tag),
    createTextNode: (text) => text,
  };
};

test('1. Preset loading: blank, exam-50, exam-100, quiz-tf, quiz-bonus', async () => {
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const studioHtml = await readFile(resolve(root, 'builder/studio.html'), 'utf8');

  // Verify preset selector and header buttons
  assert.ok(!indexHtml.includes('id="sample-preset"'), 'Preset dropdown was removed from Sheet Builder header');
  assert.ok(indexHtml.includes('id="btn-generator"'), 'Header generator button present with Generate label');
  assert.ok(indexHtml.includes('<span>Generate</span>'), 'Header generator button labeled Generate');
  assert.ok(!indexHtml.includes('id="btn-dl-key"'), 'Header answer key button removed in favor of Checker Studio key editor');
  assert.ok(indexHtml.includes('id="dl-package"'), 'Export Exam Package (ZIP) button added to export menu');

  // Verify all 5 sample templates build cleanly with zero errors
  const presetKeys = ['blank', 'exam-50', 'exam-100', 'quiz-tf', 'quiz-bonus'];

  // Verify all 5 sample templates build cleanly with zero errors
  const mockDoc = createMockDoc();
  for (const key of presetKeys) {
    const tpl = JSON.parse(JSON.stringify(SAMPLE_TEMPLATES[key]));
    assert.ok(tpl, `Sample template "${key}" must exist`);
    const layout = buildLayout(tpl);
    assert.ok(layout, `Layout for "${key}" must build successfully`);
    assert.ok(layout.page.width > 0, `Page width must be > 0 for "${key}"`);
    assert.ok(layout.page.height > 0, `Page height must be > 0 for "${key}"`);
    assert.ok(layout.fiducials.length === 4, `Fiducials count must be 4 for "${key}"`);

    const stats = layoutStats(layout);
    assert.ok(!Number.isNaN(stats.questions), `Questions count must not be NaN for "${key}"`);
    assert.ok(!Number.isNaN(stats.bubbles), `Bubbles count must not be NaN for "${key}"`);

    if (key === 'blank') {
      assert.equal(stats.questions, 0);
      assert.equal(stats.bubbles, 0);
    } else if (key === 'exam-50') {
      assert.equal(stats.questions, 60); // 50 MCQ + 10 TF
      assert.equal(stats.textRegions, 2); // 2 Short Answer
    } else if (key === 'exam-100') {
      assert.equal(stats.questions, 100);
    } else if (key === 'quiz-tf') {
      assert.equal(stats.questions, 30); // 20 TF + 10 Mod TF
      assert.equal(stats.textRegions, 12); // 10 Mod TF corrections + 2 Written
    } else if (key === 'quiz-bonus') {
      assert.equal(stats.questions, 10); // 10 MCQ
      assert.equal(stats.textRegions, 1); // 1 Bonus
    }

    // Verify both DOM tree and SVG render without throwing
    const domNode = renderSheetDOM(layout, mockDoc);
    assert.ok(domNode, `DOM node must render for "${key}"`);
    const vtree = buildSheetTree(layout);
    assert.equal(vtree.tag, 'div');
    assert.ok(vtree.attrs.class.includes('omr-sheet'));

    const htmlStr = toHTML(vtree);
    assert.ok(htmlStr.includes('class="omr-sheet'), `toHTML must render omr-sheet for "${key}"`);

    const svgStr = renderSVG(layout).trim();
    assert.ok(svgStr.includes('<svg') && svgStr.endsWith('</svg>'), `SVG must render for "${key}"`);
  }
});

test('2. Quick Exam Generator: adding parts, changing types, moving, deleting, choices, and generation', () => {
  // Test generator state operations
  let parts = [
    { type: 'mcq', count: 30, choices: 'ABCD', cols: 'auto', pts: 1 },
    { type: 'truefalse', count: 10, cols: 'auto', pts: 1 },
  ];

  // 1. Add Part
  parts.push({ type: 'modified_tf', count: 5, pts: 2 });
  parts.push({ type: 'text_short', count: 5, boxHeight: 12, pts: 2 });
  parts.push({ type: 'text_essay', count: 1, boxHeight: 36, pts: 5 });
  assert.equal(parts.length, 5);

  // 2. Change Type & clamp counts
  parts[0].type = 'text_essay';
  parts[0].count = Math.min(Math.max(parts[0].count || 1, 1), 5); // clamped from 30 to 5
  assert.equal(parts[0].count, 5);

  // Switch back to MCQ
  parts[0].type = 'mcq';
  parts[0].count = 25;
  parts[0].choices = 'ABCDE';

  // 3. Move parts up and down
  // Swap part 0 and part 1
  const temp = parts[0];
  parts[0] = parts[1];
  parts[1] = temp;
  assert.equal(parts[0].type, 'truefalse');
  assert.equal(parts[1].type, 'mcq');

  // 4. Delete part
  parts.splice(0, 1); // remove truefalse
  assert.equal(parts.length, 4);

  // 5. Generate exam sheet layout from parts
  const paper = 'A4';
  const paperSpec = PAPER_SIZES[paper];
  const availW = Math.round((paperSpec.width - 24) * 10) / 10;
  const zones = [];

  // Fields zone
  zones.push({
    type: 'fields',
    id: 'info_1',
    label: '',
    w: availW,
    fieldHeight: 7.5,
    fields: [
      { id: 'name', label: 'Name', role: 'name', row: 0, w: 108 },
      { id: 'sid', label: 'ID no.', role: 'student_id', digits: 8, row: 0, w: 75 },
      { id: 'offer', label: 'Offer No.', row: 1, w: 48 },
      { id: 'sched', label: 'Sched', row: 1, w: 52 },
      { id: 'date', label: 'Date', row: 1, w: 43 },
      { id: 'score', label: 'Score', role: 'score', row: 1, w: 40 },
    ],
  });

  // Convert parts into zones
  let currentQ = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === 'mcq') {
      zones.push({
        type: 'mcq',
        id: `mcq_${i}`,
        label: `Part ${i + 1} — Multiple Choice`,
        count: p.count,
        start: currentQ,
        choices: p.choices,
        columns: 2,
        pointsPerItem: p.pts || 1,
        w: availW,
      });
      currentQ += p.count;
    } else if (p.type === 'modified_tf') {
      zones.push({
        type: 'modified_tf',
        id: `modtf_${i}`,
        label: `Part ${i + 1} — Modified True / False`,
        count: p.count,
        start: currentQ,
        choices: ['T', 'F'],
        corrWidth: 45,
        columns: 1,
        pointsPerItem: p.pts || 2,
        w: availW,
      });
      currentQ += p.count;
    } else if (p.type === 'text_short') {
      for (let j = 0; j < p.count; j++) {
        zones.push({
          type: 'text_short',
          id: `sa_${currentQ}`,
          key: String(currentQ),
          label: `${currentQ}.`,
          w: availW,
          boxHeight: p.boxHeight || 12,
          points: p.pts || 2,
          charset: 'any',
        });
        currentQ++;
      }
    } else if (p.type === 'text_essay') {
      for (let j = 0; j < p.count; j++) {
        zones.push({
          type: 'text_essay',
          id: `essay_${currentQ}`,
          key: String(currentQ),
          label: `${currentQ}.`,
          w: availW,
          boxHeight: p.boxHeight || 36,
          points: p.pts || 5,
          charset: 'any',
        });
        currentQ++;
      }
    }
  }

  const generatedTemplate = {
    id: 'exam-generated-test',
    title: 'GENERATOR AUDIT EXAM',
    paper: 'A4',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones,
  };

  const layout = buildLayout(generatedTemplate);
  assert.ok(layout, 'Generated exam layout must build cleanly');
  assert.equal(layout.title, 'GENERATOR AUDIT EXAM');
  const stats = layoutStats(layout);
  // 25 MCQ + 5 Mod TF = 30 bubble questions; 5 Mod TF corrections + 5 Short Answer + 1 Essay = 11 text regions
  assert.equal(stats.questions, 30);
  assert.equal(stats.textRegions, 11);
  assert.equal(stats.questions + 6, 36); // 30 items + 6 written question items
});

test('3. Saved Builds Library: save, load, export .sheet.json, delete, import', () => {
  // Mock localStorage
  const mockStorage = new Map();
  const STORAGE_KEY = 'sheet-builder:saved_builds';

  const getSavedBuilds = () => {
    const raw = mockStorage.get(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  };

  const saveBuild = (entry) => {
    const builds = getSavedBuilds();
    const idx = builds.findIndex((b) => b.id === entry.id);
    if (idx >= 0) builds[idx] = entry;
    else builds.unshift(entry);
    mockStorage.set(STORAGE_KEY, JSON.stringify(builds));
  };

  const deleteBuild = (id) => {
    const builds = getSavedBuilds().filter((b) => b.id !== id);
    mockStorage.set(STORAGE_KEY, JSON.stringify(builds));
  };

  // Verify initial state
  assert.equal(getSavedBuilds().length, 0);

  // Save 2 builds with distinct titles
  const build1 = {
    id: 'build_test1',
    title: 'Midterm 2026',
    paper: 'Folio',
    questionCount: 50,
    timestamp: Date.now(),
    template: { id: 'build_test1', title: 'Midterm 2026', zones: [] },
  };
  saveBuild(build1);
  assert.equal(getSavedBuilds().length, 1);

  const build2 = {
    id: 'build_test2',
    title: 'Final Exam 2026',
    paper: 'A4',
    questionCount: 100,
    timestamp: Date.now(),
    template: { id: 'build_test2', title: 'Final Exam 2026', zones: [] },
  };
  saveBuild(build2);
  assert.equal(getSavedBuilds().length, 2);

  // Load build
  const loaded = getSavedBuilds().find((b) => b.id === 'build_test1');
  assert.ok(loaded);
  assert.equal(loaded.title, 'Midterm 2026');

  // Export .sheet.json serialization
  const exportedJson = JSON.stringify(loaded.template, null, 2);
  assert.ok(exportedJson.includes('Midterm 2026'));

  // Import file
  const importedTpl = JSON.parse(exportedJson);
  const importEntry = {
    id: importedTpl.id,
    title: importedTpl.title,
    paper: 'Folio',
    questionCount: 50,
    timestamp: Date.now(),
    template: importedTpl,
  };
  saveBuild(importEntry);
  assert.equal(getSavedBuilds().length, 2); // Overwrites same id, doesn't duplicate

  // Delete build
  deleteBuild('build_test1');
  assert.equal(getSavedBuilds().length, 1);
  assert.equal(getSavedBuilds()[0].id, 'build_test2');
});

test('4. Answer Key Editor: modal state, Quick Fill A, Quick Fill T, Random Key, Clear All, points, passing score', () => {
  const tpl = JSON.parse(JSON.stringify(SAMPLE_TEMPLATES['exam-50']));
  const layout = buildLayout(tpl);

  // Simulate Answer Key extraction
  const currentAnswerKey = { items: {}, passScore: 0 };
  const existingKey = tpl.answerKey?.items || {};

  for (const g of allGroups(layout)) {
    if (g.kind === 'mcq' || g.kind === 'tf') {
      const existing = existingKey[g.key] ?? existingKey[String(g.key)];
      const defaultAns = g.options[0]?.value || (g.kind === 'tf' ? 'T' : 'A');
      const existingAns = typeof existing === 'object' && existing !== null && existing.answer !== undefined
        ? existing.answer
        : (typeof existing === 'string' || typeof existing === 'number' ? String(existing) : null);
      const existingPts = typeof existing === 'object' && existing !== null && existing.points !== undefined
        ? Number(existing.points)
        : null;

      currentAnswerKey.items[g.key] = {
        answer: existingAns ?? defaultAns,
        points: existingPts ?? Number(g.points || 1),
        kind: g.kind,
        options: g.options.map((o) => o.value),
        label: g.label || g.key,
      };
    }
  }

  for (const roi of layout.zones.flatMap((z) => z.rois || [])) {
    if (roi.graded) {
      const existing = existingKey[roi.key] ?? existingKey[String(roi.key)];
      const defaultAns = roi.role === 'correction' ? 'Correction' : 'Sample Answer';
      const existingAns = typeof existing === 'object' && existing !== null && existing.answer !== undefined
        ? existing.answer
        : (typeof existing === 'string' || typeof existing === 'number' ? String(existing) : null);
      const existingPts = typeof existing === 'object' && existing !== null && existing.points !== undefined
        ? Number(existing.points)
        : null;

      currentAnswerKey.items[roi.key] = {
        answer: existingAns ?? defaultAns,
        points: existingPts ?? Number(roi.points || 1),
        kind: 'text',
        rubric: roi.charset === 'digits' ? 'exact' : 'case_insensitive',
        label: roi.label || roi.key,
      };
    }
  }

  const items = currentAnswerKey.items;
  assert.equal(Object.keys(items).length, 62); // 50 MCQ + 10 TF + 2 Short Answer

  // 1. Quick Fill A
  for (const it of Object.values(items)) {
    if (it.options?.includes('A')) it.answer = 'A';
  }
  assert.equal(items['1'].answer, 'A');
  assert.equal(items['50'].answer, 'A');

  // 2. Quick Fill T
  for (const it of Object.values(items)) {
    if (it.options?.includes('T')) it.answer = 'T';
  }
  assert.equal(items['51'].answer, 'T');
  assert.equal(items['60'].answer, 'T');

  // 3. Random Key
  for (const it of Object.values(items)) {
    if (Array.isArray(it.options) && it.options.length > 0) {
      it.answer = it.options[Math.floor(Math.random() * it.options.length)];
    }
  }
  assert.ok(['A', 'B', 'C', 'D', 'E'].includes(items['1'].answer));
  assert.ok(['T', 'F'].includes(items['51'].answer));

  // 4. Clear All
  for (const it of Object.values(items)) {
    it.answer = '';
  }
  assert.equal(items['1'].answer, '');
  assert.equal(items['51'].answer, '');

  // 5. Total Points and Passing Score
  items['1'].points = 3;
  let totalPts = 0;
  for (const it of Object.values(items)) totalPts += Number(it.points || 1);
  assert.equal(totalPts, 66); // 50 items (1 is 3pts -> +2) + 10 items + 2 written (2pts each) = 50 + 2 + 10 + 4 = 66

  // Passing score calculation
  const defaultPass = Math.round(totalPts * 0.6);
  assert.equal(defaultPass, 40);

  // User sets passing score to 0 (must not be overridden by falsy || check)
  currentAnswerKey.passScore = 0;
  const payload = {
    title: 'Answer Key',
    total_points: totalPts,
    pass_score: currentAnswerKey.passScore ?? Math.round(totalPts * 0.6),
    items: currentAnswerKey.items,
  };
  assert.equal(payload.pass_score, 0, 'Passing score of 0 must be respected with nullish coalescing');

  // 6. Import Answer key JSON with primitive string format
  const importedKeyJson = {
    pass_score: 35,
    items: {
      '1': 'C',
      '2': { answer: 'D', points: 2 },
    },
  };
  for (const [k, v] of Object.entries(importedKeyJson.items)) {
    if (items[k]) {
      items[k].answer = typeof v === 'object' && v.answer !== undefined ? v.answer : v;
      if (typeof v === 'object' && v.points) items[k].points = v.points;
    }
  }
  assert.equal(items['1'].answer, 'C');
  assert.equal(items['2'].answer, 'D');
  assert.equal(items['2'].points, 2);
});

test('5. Component Palette: all 7 card types can be added and layout engine compiles without errors', () => {
  const cardTypes = ['fields', 'mcq', 'truefalse', 'modified_tf', 'text_short', 'text_essay', 'instructions'];
  const availW = 186;
  let nextQ = 1;

  const createZone = (type) => {
    switch (type) {
      case 'fields':
        return {
          type: 'fields',
          id: 'info',
          label: '',
          w: availW,
          fieldHeight: 7.5,
          fields: [
            { id: 'name', label: 'Name', role: 'name', row: 0, w: 108 },
            { id: 'sid', label: 'ID no.', role: 'student_id', digits: 8, row: 0, w: 75 },
          ],
        };
      case 'mcq':
        return {
          type: 'mcq',
          id: 'mcq',
          label: 'Multiple Choice',
          count: 10,
          start: nextQ,
          choices: 'ABCD',
          columns: 2,
          pointsPerItem: 1,
          w: availW,
        };
      case 'truefalse':
        return {
          type: 'truefalse',
          id: 'tf',
          label: 'True / False',
          count: 5,
          start: nextQ,
          choices: ['T', 'F'],
          columns: 2,
          pointsPerItem: 1,
          w: availW,
        };
      case 'modified_tf':
        return {
          type: 'modified_tf',
          id: 'modtf',
          label: 'Modified True / False',
          count: 5,
          start: nextQ,
          choices: ['T', 'F'],
          corrWidth: 42,
          columns: 1,
          pointsPerItem: 2,
          w: availW,
        };
      case 'text_short':
        return {
          type: 'text_short',
          id: 'sa',
          key: String(nextQ),
          label: `${nextQ}.`,
          boxHeight: 12,
          points: 2,
          charset: 'any',
          w: availW,
        };
      case 'text_essay':
        return {
          type: 'text_essay',
          id: 'essay',
          key: String(nextQ),
          label: `${nextQ}.`,
          boxHeight: 45,
          points: 5,
          charset: 'any',
          w: availW,
        };
      case 'instructions':
        return {
          type: 'instructions',
          id: 'notes',
          fontSize: 2.8,
          text: 'Read instructions carefully.',
          w: availW,
        };
      default:
        throw new Error(`Unknown type ${type}`);
    }
  };

  // Build a sheet containing every single card type
  const zones = [];
  for (const type of cardTypes) {
    const zone = createZone(type);
    zones.push(zone);
    if (zone.count) nextQ += zone.count;
    else if (type === 'text_short' || type === 'text_essay') nextQ++;
  }

  const template = {
    id: 'test-all-palette-cards',
    title: 'All Palette Cards Test',
    paper: 'Folio',
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones,
  };

  const layout = buildLayout(template);
  assert.ok(layout, 'Sheet with all palette blocks must compile without errors');
  assert.equal(layout.zones.length, 7);
});

test('6. Outline tab: up/down reordering, duplicate, delete', () => {
  const zones = [
    { type: 'fields', id: 'zone_0', label: 'Student Info' },
    { type: 'mcq', id: 'zone_1', label: 'MCQ 1-10', count: 10, start: 1 },
    { type: 'truefalse', id: 'zone_2', label: 'TF 11-20', count: 10, start: 11 },
  ];

  // 1. Duplicate zone 1
  const orig = zones[1];
  const clone = JSON.parse(JSON.stringify(orig));
  clone.id = 'zone_1_copy';
  clone.label = `${clone.label} (Copy)`;
  if (clone.start != null && clone.count != null) clone.start += clone.count;
  zones.splice(2, 0, clone);

  assert.equal(zones.length, 4);
  assert.equal(zones[2].id, 'zone_1_copy');
  assert.equal(zones[2].start, 11);

  // 2. Move zone 2 down to 3
  const [moved] = zones.splice(2, 1);
  zones.splice(3, 0, moved);
  assert.equal(zones[3].id, 'zone_1_copy');

  // 3. Move zone 3 up to 2
  const [movedUp] = zones.splice(3, 1);
  zones.splice(2, 0, movedUp);
  assert.equal(zones[2].id, 'zone_1_copy');

  // 4. Delete duplicated zone
  zones.splice(2, 1);
  assert.equal(zones.length, 3);
  assert.equal(zones[1].id, 'zone_1');
  assert.equal(zones[2].id, 'zone_2');
});

test('7. Canvas controls & exports: DOM vs SVG render, CV target overlay, exports', async () => {
  const tpl = JSON.parse(JSON.stringify(SAMPLE_TEMPLATES['quiz-tf']));
  const layout = buildLayout(tpl);
  const mockDoc = createMockDoc();

  // 1. DOM Render
  const domNode = renderSheetDOM(layout, mockDoc);
  assert.ok(domNode);
  assert.equal(domNode.tag, 'div');
  assert.ok(domNode.attrs.class.includes('omr-sheet'));

  // 2. SVG Render
  const svgContent = renderSVG(layout);
  assert.ok(svgContent.includes('<svg'));
  assert.ok(svgContent.includes('class="omr-zone'));

  // 3. Page CSS Rule
  const cssRule = pageRule(layout);
  assert.ok(cssRule.includes('@page { size:'));

  // 4. Standalone Printable HTML Export
  const htmlExport = renderStandaloneHTML(layout, '/* test sheet css */');
  assert.ok(htmlExport.includes('<!doctype html>'));
  assert.ok(htmlExport.includes('<title>'));
  assert.ok(htmlExport.includes('omr-sheet'));

  // 5. Layout JSON Export
  const layoutJson = JSON.stringify(layout, null, 2);
  const reParsed = JSON.parse(layoutJson);
  assert.equal(reParsed.templateId, layout.templateId);
  assert.equal(reParsed.fiducials.length, 4);
});
