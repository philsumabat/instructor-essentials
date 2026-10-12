import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLayout, layoutStats, TemplateError } from '../../builder/js/layout-engine.js';
import { renderSVG } from '../../builder/js/render-svg.js';
import { renderStandaloneHTML, buildSheetTree } from '../../builder/js/render-dom.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('layout engine builds 50-item exam accurately', async () => {
  const raw = JSON.parse(await readFile(resolve(root, 'builder/templates/exam-50.json'), 'utf8'));
  const layout = buildLayout(raw);

  assert.equal(layout.page.paper, 'A4');
  assert.equal(layout.page.width, 210);
  assert.equal(layout.page.height, 297);
  assert.equal(layout.fiducials.length, 4);

  const stats = layoutStats(layout);
  assert.equal(stats.questions, 60); // 50 MCQ + 10 TF
  assert.equal(stats.idDigits, 8);
  assert.equal(stats.textRegions, 2);

  // Check SVG output
  const svg = renderSVG(layout);
  assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /data-aruco-id="0"/);
  assert.match(svg, /BIO 101/);

  // Check HTML output
  const html = renderStandaloneHTML(layout, '/* test css */');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /omr-sheet/);
});

test('layout engine builds 100-item Letter exam', async () => {
  const raw = JSON.parse(await readFile(resolve(root, 'builder/templates/exam-100.json'), 'utf8'));
  const layout = buildLayout(raw);

  assert.equal(layout.page.paper, 'Letter');
  assert.equal(layout.page.width, 215.9);
  assert.equal(layout.page.height, 279.4);

  const stats = layoutStats(layout);
  assert.equal(stats.questions, 100);
  assert.equal(stats.idDigits, 9);
});

test('template validation rejects invalid parameters', () => {
  assert.throws(() => buildLayout({ id: 'bad', zones: [] }), TemplateError);
  assert.throws(() => buildLayout({ id: 'bad', paper: 'A3', zones: [{ type: 'student_id', id: 's' }] }), TemplateError);
});

test('layout engine and renderers support text_short, text_essay, modified_tf, and partitioned digits', () => {
  const tpl = {
    id: 'test-new-features',
    title: 'New Features Test',
    paper: 'Folio',
    zones: [
      {
        type: 'fields',
        id: 'info',
        columns: 3,
        fields: [
          { id: 'name', label: 'Student Name', role: 'name', w: 70 },
          { id: 'sid', label: 'Student ID', role: 'student_id', digits: 8, w: 60 },
          { id: 'score', label: 'Score', role: 'score', w: 25 },
        ],
      },
      {
        type: 'modified_tf',
        id: 'mtf',
        count: 5,
        corrWidth: 42,
        columns: 1,
      },
      {
        type: 'text_short',
        id: 'ts1',
        label: '1. Short Answer Definition',
        boxHeight: 12,
        points: 2,
      },
      {
        type: 'text_essay',
        id: 'te1',
        label: '2. Essay Prompt',
        boxHeight: 45,
        points: 5,
      },
    ],
  };

  const layout = buildLayout(tpl);
  assert.equal(layout.page.paper, 'Folio');
  assert.equal(layout.zones.length, 4);

  const stats = layoutStats(layout);
  assert.equal(stats.idDigits, 8);
  assert.equal(stats.questions, 5); // 5 modified TF questions
  assert.equal(stats.textRegions, 7); // 5 corrections + 1 short + 1 essay

  // Verify DOM tree output
  const tree = buildSheetTree(layout);
  const html = renderStandaloneHTML(layout, '/* test */');
  assert.match(html, /omr-partitioned-digits/);
  assert.match(html, /omr-correction-box/);
  assert.match(html, /omr-write-box--answer/);
  assert.match(html, /1\. Short Answer Definition/);
  assert.match(html, /2\. Essay Prompt/);

  // Verify SVG output
  const svg = renderSVG(layout);
  assert.match(svg, /omr-zone--modified_tf/);
  assert.match(svg, /omr-zone--text_short/);
  assert.match(svg, /omr-zone--text_essay/);
  assert.match(svg, /data-roi="info\.sid"/);
  assert.match(svg, /data-roi="mtf\.1\.correction"/);
});
