import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Sheet Builder: Exam Package ZIP export & streamlined toolbar', async () => {
  const indexHtml = await readFile(resolve(root, 'builder/index.html'), 'utf8');
  const studioHtml = await readFile(resolve(root, 'builder/studio.html'), 'utf8');
  const appJs = await readFile(resolve(root, 'builder/js/app.js'), 'utf8');

  // Verify header has removed generator & answer key buttons, keeping UI clean
  assert.ok(!indexHtml.includes('id="btn-generator"'), 'btn-generator removed from index.html header');
  assert.ok(!indexHtml.includes('id="btn-dl-key"'), 'btn-dl-key removed from index.html header');
  assert.ok(!studioHtml.includes('id="btn-generator"'), 'btn-generator removed from studio.html');
  assert.ok(!studioHtml.includes('id="btn-dl-key"'), 'btn-dl-key removed from studio.html');

  // Verify export package button is present
  assert.ok(indexHtml.includes('id="dl-package"'), 'dl-package button present in index.html');
  assert.ok(studioHtml.includes('id="dl-package"'), 'dl-package button present in studio.html');

  // Verify pure JS createZip generator is defined
  assert.ok(appJs.includes('function createZip(files)'), 'createZip function defined in app.js');
  assert.ok(studioHtml.includes('function createZip(files)'), 'createZip function inlined in studio.html');

  // Sandbox test: createZip produces valid PKZIP 2.0 buffer
  const sandbox = {
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    TextDecoder,
    Date
  };
  const script = new vm.Script(`
    ${appJs.match(/const CRC_TABLE[\s\S]*?function createZip\(files\)[\s\S]*?return result;\s*\}/)[0]}
    const files = [
      { name: 'layout.json', data: '{"title":"Test Exam"}' },
      { name: 'README.txt', data: 'Exam instructions' }
    ];
    createZip(files);
  `);
  const ctx = vm.createContext(sandbox);
  const zipBytes = script.runInContext(ctx);

  assert.ok(zipBytes instanceof Uint8Array, 'createZip must return a Uint8Array');
  assert.ok(zipBytes.length > 50, 'ZIP file must have non-zero length');
  const dv = new DataView(zipBytes.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'ZIP header magic must be 0x04034b50');
});

test('Checker Studio: Direct Layout/Package upload & Psychometric Insights', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');
  const docsCheckerHtml = await readFile(resolve(root, 'docs/checker.html'), 'utf8');

  // 1. Direct layout upload components in sidebar
  assert.ok(checkerHtml.includes('id="card-layout-quick"'), 'Quick layout card present in sidebar');
  assert.ok(checkerHtml.includes('id="input-layout-direct"'), 'Direct layout upload input present');
  assert.ok(checkerHtml.includes('accept=".json,.zip"'), 'Layout upload accepts .json and .zip');
  assert.ok(docsCheckerHtml.includes('id="card-layout-quick"'), 'Quick layout card present in docs/checker.html');

  // 2. Psychometric reference guide and insights column
  assert.ok(checkerHtml.includes('id="card-psychometric-guide"'), 'Psychometric guide card present in Tab 3');
  assert.ok(checkerHtml.includes('Insights &amp; Classroom Action'), 'Insights column header in item table');
  assert.ok(checkerHtml.includes('id="analysis-stat-alpha-sub"'), 'Alpha subtitle metric card present');

  // 3. Test script functions in sandbox
  const scriptMatch = checkerHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script block must be present');

  const mockEls = {};
  const sandbox = {
    document: {
      getElementById: (id) => mockEls[id] || (mockEls[id] = { addEventListener: () => {}, style: {}, classList: { add: () => {}, remove: () => {} } }),
      querySelectorAll: () => [],
      querySelector: () => ({ textContent: '' }),
      createElement: () => ({ getContext: () => ({}), addEventListener: () => {} }),
      body: { classList: { add: () => {}, remove: () => {} } }
    },
    window: {},
    console: console,
    Uint8Array,
    Uint32Array,
    DataView,
    TextEncoder,
    TextDecoder,
    Date,
    alert: () => {},
    Image: class {},
    FileReader: class {}
  };
  sandbox.window = sandbox;

  const script = new vm.Script(scriptMatch[1]);
  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  // Verify functions exist in checker script
  const readZipFiles = vm.runInContext('readZipFiles', ctx);
  const generateItemInsights = vm.runInContext('generateItemInsights', ctx);
  const createZip = vm.runInContext('createZip', ctx);
  assert.equal(typeof readZipFiles, 'function', 'readZipFiles must be a function');
  assert.equal(typeof generateItemInsights, 'function', 'generateItemInsights must be a function');
  assert.equal(typeof createZip, 'function', 'createZip must be a function');

  // Verify readZipFiles extracts files correctly
  const testZip = createZip([
    { name: 'layout.json', data: '{"title":"Sandboxed Layout"}' },
    { name: 'README.txt', data: 'Hello from package' }
  ]);
  const extracted = readZipFiles(testZip.buffer);
  assert.equal(extracted.length, 2, 'Should extract both files from ZIP');
  assert.equal(extracted[0].name, 'layout.json');
  assert.ok(extracted[0].text().includes('Sandboxed Layout'));

  // Verify generateItemInsights generates actionable pedagogical guidance
  // 1. Negative discrimination -> Miskey Alert
  const miskeyedInsight = generateItemInsights(
    { difficulty: 0.45, discrimination: -0.15, correctAnswer: 'A', distractors: { A: 10, B: 25, C: 2, D: 1, E: 0 } },
    { kind: 'mcq' },
    38
  );
  assert.ok(miskeyedInsight.includes('Miskey Alert'), 'Must flag negative discrimination as potential miskey');
  assert.ok(miskeyedInsight.includes('Dead Distractor'), 'Must identify option E as dead distractor');
  assert.ok(miskeyedInsight.includes('Common Misconception'), 'Must identify option B as popular misconception');

  // 2. High mastery foundational item
  const easyInsight = generateItemInsights(
    { difficulty: 0.95, discrimination: 0.12, correctAnswer: 'B', distractors: { A: 1, B: 36, C: 0, D: 1, E: 0 } },
    { kind: 'mcq' },
    38
  );
  assert.ok(easyInsight.includes('Foundational'), 'Must classify >90% as foundational');

  // 3. Challenging item
  const hardInsight = generateItemInsights(
    { difficulty: 0.18, discrimination: 0.38, correctAnswer: 'C', distractors: { A: 12, B: 10, C: 7, D: 9, E: 0 } },
    { kind: 'mcq' },
    38
  );
  assert.ok(hardInsight.includes('Reteach'), 'Must recommend reteaching for very difficult items');
  assert.ok(hardInsight.includes('Strong Separator'), 'Must note strong discrimination');
});
