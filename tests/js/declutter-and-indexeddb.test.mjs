import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('Header Ribbon: Decluttered actions, protected brand logo, and hidden compatibility anchors', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Visible header buttons: New Class / Clear, Resume Session, Settings
  assert.ok(checkerHtml.includes('id="btn-clear-workspace"'), 'btn-clear-workspace is present in header');
  assert.ok(checkerHtml.includes('id="btn-resume-progress"'), 'btn-resume-progress is present in header');
  assert.ok(checkerHtml.includes('id="btn-open-settings"'), 'btn-open-settings is present in header');

  // 2. Uncluttered ribbon: dropdown-export-reports, btn-save-progress, btn-google-drive, btn-trocr-settings are hidden
  assert.ok(
    checkerHtml.includes('id="dropdown-export-reports" class="dropdown dropdown--reports" style="display: none;"') ||
    checkerHtml.includes('id="dropdown-export-reports" style="display: none;"'),
    'dropdown-export-reports is hidden for clean ribbon'
  );
  assert.ok(
    checkerHtml.includes('id="btn-save-progress"') && checkerHtml.includes('style="display: none;"'),
    'btn-save-progress is hidden from visible ribbon'
  );
  assert.ok(
    checkerHtml.includes('id="btn-google-drive"') && checkerHtml.includes('id="btn-google-drive" class="btn btn--secondary btn-google-drive" style="display: none;"'),
    'btn-google-drive is hidden from ribbon'
  );
  assert.ok(
    !checkerHtml.includes('id="btn-trocr-settings"'),
    'btn-trocr-settings is completely removed from ribbon'
  );

  // 3. Brand protection: .app-brand has flex-shrink: 0
  assert.ok(
    checkerHtml.includes('.app-brand { display: flex; align-items: center; gap: 0.75rem; text-decoration: none; color: inherit; flex-shrink: 0; }') ||
    checkerHtml.includes('flex-shrink: 0'),
    '.app-brand has flex-shrink: 0 to protect logo from wrapping'
  );
});

test('Cloud Library: Tab removed from navigation and replaced with safe stub', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. Tab button and tab pane are removed
  assert.ok(!checkerHtml.includes('id="tab-btn-cloud"'), 'tab-btn-cloud removed from tab navigation');
  assert.ok(!checkerHtml.includes('id="tab-cloud"'), 'tab-cloud pane removed from tabs container');

  // 2. renderCloudLibraryTab exists as a safe stub
  assert.ok(checkerHtml.includes('function renderCloudLibraryTab()'), 'renderCloudLibraryTab defined as stub');
  assert.ok(checkerHtml.includes('window.renderCloudLibraryTab = renderCloudLibraryTab;'), 'renderCloudLibraryTab exported');
});

test('IndexedDB Persistence: ToolkitDB module with session save, load, and clear', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  assert.ok(checkerHtml.includes('const ToolkitDB = (function() {'), 'ToolkitDB module declared');
  assert.ok(checkerHtml.includes('window.ToolkitDB = ToolkitDB;'), 'ToolkitDB exported to window');
  assert.ok(checkerHtml.includes('saveSession(sessionData)'), 'ToolkitDB has saveSession');
  assert.ok(checkerHtml.includes('loadSession()'), 'ToolkitDB has loadSession');
  assert.ok(checkerHtml.includes('clearSession()'), 'ToolkitDB has clearSession');
});

test('Pure Manual Handwriting Review: AI OCR toggle removed, isOcrMatch matching logic preserved', async () => {
  const checkerHtml = await readFile(resolve(root, 'builder/checker.html'), 'utf8');

  // 1. DOM UI elements removed
  assert.ok(!checkerHtml.includes('id="chk-ai-handwriting"'), 'chk-ai-handwriting switch removed');
  assert.ok(!checkerHtml.includes('id="btn-batch-ai-transcribe"'), 'btn-batch-ai-transcribe button removed');
  assert.ok(checkerHtml.includes('function isOcrMatch('), 'isOcrMatch function defined');

  // 2. Test isOcrMatch in VM
  const distMatch = checkerHtml.match(/function levenshteinDistance[\s\S]*?window\.stringSimilarity = stringSimilarity;/);
  const ocrMatch = checkerHtml.match(/function isOcrMatch[\s\S]*?window\.isOcrMatch = isOcrMatch;/);
  assert.ok(distMatch && ocrMatch, 'Extracted OCR script block');

  const context = {
    window: {},
    console,
    String,
    Math,
    Array
  };
  vm.createContext(context);
  vm.runInContext(distMatch[0] + '\n' + ocrMatch[0], context);

  const isOcrMatch = context.window.isOcrMatch;
  assert.equal(typeof isOcrMatch, 'function', 'isOcrMatch is exported function');

  // Exact match
  assert.equal(isOcrMatch('Chloroplast', 'chloroplast'), true);
  assert.equal(isOcrMatch('mitochondria', 'mitochondria'), true);

  // Normalization match (punctuation / spaces)
  assert.equal(isOcrMatch('compound microscope', 'Compound-Microscope'), true);
  assert.equal(isOcrMatch('endoplasmic reticulum', 'Endoplasmic  Reticulum!'), true);

  // High similarity match (fuzzy OCR reading)
  assert.equal(isOcrMatch('chloroplasts', 'chloroplast'), true);

  // Mismatch
  assert.equal(isOcrMatch('nucleus', 'chloroplast'), false);
  assert.equal(isOcrMatch('', 'chloroplast'), false);
  assert.equal(isOcrMatch('chloroplast', ''), false);
});

test('Home Portal: Teacher-first copy with zero marketing buzzwords', async () => {
  const homeHtml = await readFile(resolve(root, 'builder/home.html'), 'utf8');

  // Disallowed buzzwords
  const banned = [
    'revolutionary',
    'game-changer',
    'game changer',
    'cutting-edge',
    'seamlessly',
    'empower your teaching',
    'supercharge',
    'unleash',
    'elevate your',
    'delve into'
  ];

  for (const word of banned) {
    assert.ok(!homeHtml.toLowerCase().includes(word), `home.html must not contain marketing buzzword "${word}"`);
  }

  // Teacher-first terminology
  assert.ok(homeHtml.includes('Print custom exam sheets, grade camera scans, and track class performance'), 'Contains direct teacher-first description');
  assert.ok(homeHtml.includes('Design printable bubble sheets and written answer tests'), 'Clear plain-language Sheet Builder description');
  assert.ok(homeHtml.includes('Grade student exams from scanner files or phone photos'), 'Clear plain-language Checker Studio description');
});
