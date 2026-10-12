import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('standalone studio.html is 100% self-contained with valid IIFE closures and zero CORS/external requests', async () => {
  const htmlPath = resolve(root, 'builder/studio.html');
  const html = await readFile(htmlPath, 'utf8');

  // 1. Zero external CSS requests
  const extStyles = [...html.matchAll(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi)];
  assert.equal(extStyles.length, 0, 'No external stylesheet links allowed');

  // 2. Zero external script requests
  const extScripts = [...html.matchAll(/<script\s+[^>]*src=[^>]*>/gi)];
  assert.equal(extScripts.length, 0, 'No external script tags allowed');

  // 3. Embedded sample templates
  assert.ok(html.includes('bio101-midterm-50'), 'exam-50 template must be inlined');
  assert.ok(html.includes('chem201-final-100'), 'exam-100 template must be inlined');
  assert.ok(html.includes('hist110-quiz-tf'), 'quiz-tf template must be inlined');

  // 4. Inlined styles present
  assert.ok(html.includes('.omr-sheet'), 'sheet.css must be inlined');
  assert.ok(html.includes('.app-header'), 'app.css must be inlined');

  // 5. Inlined script syntax validation
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, '<script> block must be present');
  const scriptContent = scriptMatch[1];

  // Must not throw SyntaxError (e.g. duplicate identifier '$')
  assert.doesNotThrow(() => {
    new vm.Script(scriptContent);
  }, 'Bundled script must compile with zero syntax errors');

  // 6. Verify IIFE closures wrap the modules
  assert.match(scriptContent, /const\s+Aruco\s*=\s*\(function\(\)/);
  assert.match(scriptContent, /const\s+LayoutEngine\s*=\s*\(function\(Aruco\)/);
  assert.match(scriptContent, /const\s+RenderDOM\s*=\s*\(function\(Aruco\)/);
  assert.match(scriptContent, /const\s+RenderSVG\s*=\s*\(function\(Aruco,\s*RenderDOM\)/);
  assert.match(scriptContent, /const\s+Templates\s*=\s*\(function\(\)/);
});
