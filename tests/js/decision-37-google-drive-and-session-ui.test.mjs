import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function createMockEl() {
  const classListSet = new Set();
  const el = {
    addEventListener: () => {},
    classList: {
      add: (...classes) => classes.forEach(c => classListSet.add(c)),
      remove: (...classes) => classes.forEach(c => classListSet.delete(c)),
      toggle: (c) => {
        if (classListSet.has(c)) {
          classListSet.delete(c);
          return false;
        } else {
          classListSet.add(c);
          return true;
        }
      },
      contains: (c) => classListSet.has(c),
    },
    get className() {
      return Array.from(classListSet).join(' ');
    },
    set className(val) {
      classListSet.clear();
      (val || '').split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
    },
    style: {},
    dataset: {},
    getContext: () => ({
      getImageData: () => ({ data: new Uint8Array(100) }),
      measureText: () => ({ width: 10 }),
      drawImage: () => {},
    }),
    setAttribute: () => {},
    removeAttribute: () => {},
    toDataURL: () => 'data:image/jpeg;base64,mock',
    innerHTML: '',
    textContent: '',
    value: '60',
    title: '',
    showModal: () => {},
    close: () => {},
  };
  return new Proxy(el, {
    get: (t, p) => p in t ? t[p] : () => {},
    set: (t, p, v) => { t[p] = v; return true; }
  });
}

function extractCheckerFunctions(htmlContent) {
  const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) throw new Error('No script tag found in checker.html');
  const scriptContent = scriptMatch[1];

  const fakeStorage = {};
  const mockLocalStorage = {
    getItem: (k) => fakeStorage[k] || null,
    setItem: (k, v) => { fakeStorage[k] = String(v); },
    removeItem: (k) => { delete fakeStorage[k]; },
    clear: () => { Object.keys(fakeStorage).forEach(k => delete fakeStorage[k]); }
  };

  const elementMap = new Map();
  const getOrCreateEl = (id) => {
    if (!elementMap.has(id)) elementMap.set(id, createMockEl());
    return elementMap.get(id);
  };

  const context = {
    window: {},
    document: {
      getElementById: (id) => getOrCreateEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => createMockEl(),
      addEventListener: () => {},
      removeEventListener: () => {},
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
    },
    localStorage: mockLocalStorage,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    navigator: { userAgent: 'node-test' },
    XMLHttpRequest: class MockXHR {
      open() {}
      setRequestHeader() {}
      send() {}
    },
    alert: () => {},
    confirm: () => true,
    Blob: globalThis.Blob || class Blob {},
    URL: globalThis.URL || { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  };
  context.window = context;

  vm.createContext(context);
  vm.runInContext(scriptContent, context);
  context.elementMap = elementMap;
  context.getOrCreateEl = getOrCreateEl;
  return context;
}

test('Decision 37: Unobtrusive session banner and zero confirm() blockers on load', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Persistent banner is eliminated in favor of discreet header Resume button
  assert.ok(!checkerHtml.includes('id="banner-resume-session"'), 'Banner element eliminated');
  assert.ok(checkerHtml.includes('id="btn-resume-progress"'), 'Discreet header resume button exists');

  // 2. No blocking confirm() calls exist in checker.html
  assert.equal((checkerHtml.match(/confirm\(/g) || []).length, 0, 'Zero confirm() modal calls allowed in checker.html');

  // 3. Workspace uses flex min-height: 0 instead of hardcoded calc(100vh - 56px)
  assert.ok(checkerHtml.includes('min-height: 0;'), 'Workspace uses min-height: 0 for responsive non-overflow flex sizing');
  assert.ok(!checkerHtml.includes('height: calc(100vh - 56px);'), 'Legacy hardcoded calc(100vh - 56px) removed from workspace');
});

test('Decision 37: Topbar ribbon button de-duplication with backwards compatibility', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Visible header buttons removed from ribbon (.header-actions)
  assert.match(checkerHtml, /<button\s+type="button"\s+id="btn-grade-now"\s+style="display:\s*none;"/, 'btn-grade-now is hidden compatibility anchor');
  assert.match(checkerHtml, /<button\s+type="button"\s+id="btn-sample-grade"\s+style="display:\s*none;"/, 'btn-sample-grade is hidden compatibility anchor');

  // 2. Sidebar buttons are the visible triggers in Exam Scans card
  assert.ok(checkerHtml.includes('id="btn-sidebar-grade"'), 'btn-sidebar-grade is visible trigger');
  assert.ok(checkerHtml.includes('id="btn-sidebar-sample"'), 'btn-sidebar-sample is visible trigger');
});

test('Decision 37: Real-Time visual state highlighting for Save & Resume buttons', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. CSS semantic colors verified
  assert.match(checkerHtml, /\.btn-save-progress\.is-unsaved[\s\S]*?var\(--warning/, 'Unsaved button uses warning amber variable');
  assert.match(checkerHtml, /\.badge-save-status[\s\S]*?var\(--warning/, 'Save badge uses warning amber variable');
  assert.match(checkerHtml, /\.badge-resume-dot[\s\S]*?var\(--success/, 'Resume indicator dot uses emerald success variable');

  // 2. Functional test in VM context
  const ctx = extractCheckerFunctions(checkerHtml);
  assert.equal(typeof ctx.updateSaveStatusUI, 'function', 'updateSaveStatusUI is exported');
  assert.equal(typeof ctx.updateResumeStatusUI, 'function', 'updateResumeStatusUI is exported');

  const btnSave = ctx.getOrCreateEl('btn-save-progress');
  const badgeSave = ctx.getOrCreateEl('badge-save-status');
  const btnResume = ctx.getOrCreateEl('btn-resume-progress');
  const dotResume = ctx.getOrCreateEl('badge-resume-dot');

  // Status: unsaved
  ctx.updateSaveStatusUI('unsaved');
  assert.equal(btnSave.classList.contains('is-unsaved'), true, 'btn-save-progress gains .is-unsaved');
  assert.equal(badgeSave.textContent, 'Unsaved', 'Badge shows Unsaved');
  assert.equal(badgeSave.style.display, 'inline-flex', 'Badge is visible');

  // Status: saved
  ctx.updateSaveStatusUI('saved');
  assert.equal(btnSave.classList.contains('is-unsaved'), false, 'btn-save-progress loses .is-unsaved');
  assert.equal(btnSave.classList.contains('is-saved'), true, 'btn-save-progress gains .is-saved');
  assert.equal(badgeSave.textContent, 'Saved ✓', 'Badge shows Saved ✓');

  // Resume status: true
  ctx.updateResumeStatusUI(true, { layout: { title: 'Midterm' }, results: { grades: [1, 2] } });
  assert.equal(btnResume.classList.contains('has-saved-session'), true, 'btn-resume-progress gains .has-saved-session');
  assert.equal(dotResume.style.display, 'inline-block', 'Resume dot is visible');

  // Resume status: false
  ctx.updateResumeStatusUI(false);
  assert.equal(btnResume.classList.contains('has-saved-session'), false, 'btn-resume-progress loses .has-saved-session');
  assert.equal(dotResume.style.display, 'none', 'Resume dot is hidden');
});

test('Decision 37: Auto-save keeps unsaved status when grading results exist', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');
  const ctx = extractCheckerFunctions(checkerHtml);

  ctx.state.layout = { id: 'exam-50', title: 'Test Exam' };
  ctx.state.results = {
    passThreshold: 60,
    grades: [{ studentId: '101', rawScore: 10, maxScore: 10, percentage: 100 }],
    psychometrics: {}
  };

  const btnSave = ctx.getOrCreateEl('btn-save-progress');
  const badgeSave = ctx.getOrCreateEl('badge-save-status');

  // Background auto-save (e.g. after grading run)
  ctx.saveCheckerProgress({ downloadFile: false, silent: true });
  assert.equal(btnSave.classList.contains('is-unsaved'), true, 'Auto-save marks save status as unsaved');
  assert.equal(badgeSave.textContent, 'Unsaved', 'Badge displays Unsaved');

  // Explicit user save
  ctx.saveCheckerProgress({ downloadFile: true, silent: false });
  assert.equal(btnSave.classList.contains('is-saved'), true, 'Explicit save marks save status as saved');
  assert.equal(badgeSave.textContent, 'Saved ✓', 'Badge displays Saved ✓');
});

test('Decision 37: Google Drive client-side integration and in-place updates', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Structural DOM elements present
  assert.ok(checkerHtml.includes('id="btn-google-drive"'), 'Google Drive ribbon button present');
  assert.ok(checkerHtml.includes('id="modal-google-drive"'), 'Google Drive modal present');
  assert.ok(checkerHtml.includes('id="input-gdrive-client-id"'), 'Client ID input present');
  assert.ok(checkerHtml.includes('id="btn-gdrive-connect"'), 'Connect button present');
  assert.ok(checkerHtml.includes('id="btn-gdrive-save-now"'), 'Save session button present');
  assert.ok(checkerHtml.includes('id="btn-gdrive-save-package"'), 'Save package button present');
  assert.ok(checkerHtml.includes('id="btn-gdrive-list-files"'), 'Browse files button present');
  assert.ok(checkerHtml.includes('id="btn-gdrive-disconnect"'), 'Disconnect button present');

  // 2. Functions exported to window
  const ctx = extractCheckerFunctions(checkerHtml);
  assert.equal(typeof ctx.initGoogleDriveAuth, 'function');
  assert.equal(typeof ctx.saveSessionToGoogleDrive, 'function');
  assert.equal(typeof ctx.saveExamPackageToGoogleDrive, 'function');
  assert.equal(typeof ctx.listGoogleDriveSessions, 'function');
  assert.equal(typeof ctx.restoreSessionFromGoogleDrive, 'function');
  assert.equal(typeof ctx.disconnectGoogleDrive, 'function');
  assert.equal(typeof ctx.handleGoogleTokenExpired, 'function');

  // 3. In-place update query pattern and PATCH method
  assert.match(checkerHtml, /PATCH[\s\S]*?files\/'\s*\+\s*existingFileId/, 'Uses PATCH for in-place updates to avoid duplicate files');
  assert.match(checkerHtml, /checkXhr\.status\s*===\s*401/, 'Handles 401 token expiry');
  assert.match(checkerHtml, /handleGoogleTokenExpired/, 'handleGoogleTokenExpired resets expired token');

  // 4. Zero fetch() calls and zero external script tags
  const fetchCalls = checkerHtml.match(/\bfetch\s*\(/g);
  assert.equal(fetchCalls ? fetchCalls.length : 0, 0, 'Strict zero fetch() calls rule maintained');
  const scriptTags = checkerHtml.match(/<script\s+[^>]*src=/gi);
  assert.equal(scriptTags ? scriptTags.length : 0, 0, 'Zero static external script tags in checker.html');
});

test('Decision 38: Embedded VSU Google Client ID and Synced Check Status Indicator', () => {
  const checkerHtml = fs.readFileSync(path.join(rootDir, 'builder/checker.html'), 'utf8');

  // 1. Embedded VSU Client ID is present
  assert.ok(checkerHtml.includes('998750275888-cbvmqvjbfopbsv0oe5pu238grrpv7chm.apps.googleusercontent.com'), 'Embedded VSU Google OAuth Client ID is present');
  assert.ok(checkerHtml.includes('id="google-drive-sync-indicator"'), 'Dedicated synced status indicator badge present in header');

  // 2. Functional testing in VM context
  const ctx = extractCheckerFunctions(checkerHtml);
  assert.equal(ctx.DEFAULT_GOOGLE_CLIENT_ID, '998750275888-cbvmqvjbfopbsv0oe5pu238grrpv7chm.apps.googleusercontent.com', 'DEFAULT_GOOGLE_CLIENT_ID matches VSU credentials');
  assert.equal(typeof ctx.updateGoogleSyncStatus, 'function', 'updateGoogleSyncStatus function is exported');

  const syncBadge = ctx.getOrCreateEl('google-drive-sync-indicator');

  // Status: syncing
  ctx.updateGoogleSyncStatus('syncing');
  assert.equal(syncBadge.style.display, 'inline-flex', 'Badge displays during sync');
  assert.equal(syncBadge.classList.contains('is-syncing'), true, 'Badge gains .is-syncing class');
  assert.ok(syncBadge.innerHTML.includes('Syncing...'), 'Badge shows Syncing... text');

  // Status: synced
  ctx.updateGoogleSyncStatus('synced');
  assert.equal(syncBadge.classList.contains('is-synced'), true, 'Badge gains .is-synced class');
  assert.ok(syncBadge.innerHTML.includes('Synced ✓'), 'Badge shows Synced ✓ text');

  // Status: error
  ctx.updateGoogleSyncStatus('error', 'Network failure');
  assert.equal(syncBadge.classList.contains('is-error'), true, 'Badge gains .is-error class');
  assert.ok(syncBadge.innerHTML.includes('Sync Error'), 'Badge shows Sync Error');

  // Status: hidden
  ctx.updateGoogleSyncStatus('hidden');
  assert.equal(syncBadge.style.display, 'none', 'Badge is hidden when disconnected or idle');
});
