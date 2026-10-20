/**
 * Instructor Essentials Desktop — Native Desktop Integration Controller
 * Provides macOS native view navigation, keyboard shortcuts, Tauri Rust IPC bridge,
 * cross-tool layout synchronization, and desktop drag-and-drop.
 */

(function () {
  'use strict';

  // ==========================================================================
  // View Switching (macOS Segmented Navigation)
  // ==========================================================================
  function updateSegmentedActive(activeView) {
    const homeBtn = document.getElementById('nav-btn-home');
    const builderBtn = document.getElementById('nav-btn-builder');
    const checkerBtn = document.getElementById('nav-btn-checker');
    const speedBtn = document.getElementById('nav-btn-speed');

    if (homeBtn) {
      homeBtn.classList.toggle('is-active', activeView === 'home');
      if (activeView === 'home') homeBtn.setAttribute('aria-current', 'page');
      else homeBtn.removeAttribute('aria-current');
    }
    if (builderBtn) {
      builderBtn.classList.toggle('is-active', activeView === 'builder');
      if (activeView === 'builder') builderBtn.setAttribute('aria-current', 'page');
      else builderBtn.removeAttribute('aria-current');
    }
    if (checkerBtn) {
      checkerBtn.classList.toggle('is-active', activeView === 'checker');
      if (activeView === 'checker') checkerBtn.setAttribute('aria-current', 'page');
      else checkerBtn.removeAttribute('aria-current');
    }
    if (speedBtn) {
      speedBtn.classList.toggle('is-active', activeView === 'speed');
      if (activeView === 'speed') speedBtn.setAttribute('aria-current', 'page');
      else speedBtn.removeAttribute('aria-current');
    }
  }

  function switchView(viewName, event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const isCheckerPage = window.location.pathname.endsWith('checker.html');
    const isHomePage = window.location.pathname.endsWith('home.html');
    const isBuilderPage = !isCheckerPage && !isHomePage;

    if (viewName === 'home') {
      if (!isHomePage) {
        window.location.href = 'home.html';
      } else {
        updateSegmentedActive('home');
      }
    } else if (viewName === 'builder') {
      if (!isBuilderPage) {
        window.location.href = 'index.html';
      } else {
        updateSegmentedActive('builder');
      }
    } else if (viewName === 'checker') {
      if (!isCheckerPage) {
        window.location.href = 'checker.html';
      } else {
        if (typeof window.switchTab === 'function') {
          window.switchTab('summary');
        }
        updateSegmentedActive('checker');
      }
    } else if (viewName === 'speed') {
      if (isCheckerPage) {
        if (typeof window.switchTab === 'function') {
          window.switchTab('horizontal');
        }
        const deck = document.getElementById('horizontal-flashcard-deck');
        if (deck) {
          deck.style.display = 'block';
          deck.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        updateSegmentedActive('speed');
      } else {
        window.location.href = 'checker.html#speed';
      }
    }
  }

  window.switchView = switchView;

  // ==========================================================================
  // Tauri Rust IPC Bridge
  // ==========================================================================
  async function invokeRustGrader(payload) {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      try {
        return await window.__TAURI__.core.invoke('grade_scans', { payload });
      } catch (err) {
        console.warn('[Desktop IPC] Tauri grade_scans invoke returned error, falling back to client-side engine:', err);
        throw err;
      }
    }
    return null;
  }

  window.invokeRustGrader = invokeRustGrader;

  // ==========================================================================
  // Desktop Drag-and-Drop Forwarding
  // ==========================================================================
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    if (e.target.closest('.dropzone') || e.target.closest('input[type="file"]')) return;

    e.preventDefault();
    const files = e.dataTransfer.files;
    const firstFile = files[0];
    const isCheckerPage = window.location.pathname.endsWith('checker.html');

    if (isCheckerPage) {
      const scansInput = document.getElementById('input-scans');
      const layoutInput = document.getElementById('input-layout-direct');
      const rosterInput = document.getElementById('input-roster');

      const isImage = firstFile.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(firstFile.name);
      const isJsonOrZip = /\.(json|zip)$/i.test(firstFile.name);
      const isCsv = /\.csv$/i.test(firstFile.name);

      if (isImage && scansInput) {
        try {
          scansInput.files = files;
          scansInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      } else if (isJsonOrZip && layoutInput) {
        try {
          layoutInput.files = files;
          layoutInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      } else if (isCsv && rosterInput) {
        try {
          rosterInput.files = files;
          rosterInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }
    } else {
      // On Sheet Builder page: forward .json or .sheet.json to template-file-input
      const tplInput = document.getElementById('template-file-input');
      const isJson = /\.(json|sheet\.json|grader)$/i.test(firstFile.name);
      if (isJson && tplInput) {
        try {
          tplInput.files = files;
          tplInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }
    }
  });

  // ==========================================================================
  // Global Desktop Keyboard Shortcuts
  // ==========================================================================
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;

    // View switching shortcuts: Cmd+0 (Home), Cmd+1 (Builder), Cmd+2 (Checker), Cmd+3 (Speed Grader)
    if (modifier && e.key === '0') {
      e.preventDefault();
      switchView('home');
    } else if (modifier && e.key === '1') {
      e.preventDefault();
      switchView('builder');
    } else if (modifier && e.key === '2') {
      e.preventDefault();
      switchView('checker');
    } else if (modifier && e.key === '3') {
      e.preventDefault();
      switchView('speed');
    }

    // Cmd+P: Print Sheet if on Sheet Builder
    if (modifier && e.key.toLowerCase() === 'p') {
      const printBtn = document.getElementById('btn-print');
      if (printBtn) {
        e.preventDefault();
        printBtn.click();
      }
    }

    // Cmd+S: Save Build / Save Progress
    if (modifier && e.key.toLowerCase() === 's') {
      const saveBuildBtn = document.getElementById('btn-save-build');
      const saveProgressBtn = document.getElementById('btn-save-progress');
      if (saveBuildBtn) {
        e.preventDefault();
        saveBuildBtn.click();
      } else if (saveProgressBtn) {
        e.preventDefault();
        saveProgressBtn.click();
      }
    }

    // Cmd+O: Open Saved Builds Library
    if (modifier && e.key.toLowerCase() === 'o') {
      const libraryBtn = document.getElementById('btn-library');
      if (libraryBtn) {
        e.preventDefault();
        libraryBtn.click();
      } else if (typeof window.openSavedBuildsPicker === 'function') {
        e.preventDefault();
        window.openSavedBuildsPicker();
      }
    }

    // Escape: close open dialogs
    if (e.key === 'Escape') {
      const openDialog = document.querySelector('dialog[open]');
      if (openDialog && typeof openDialog.close === 'function') {
        openDialog.close();
      }
    }
  });

  // ==========================================================================
  // Lifecycle Initialization
  // ==========================================================================
  window.addEventListener('DOMContentLoaded', () => {
    const isCheckerPage = window.location.pathname.endsWith('checker.html');
    const isHomePage = window.location.pathname.endsWith('home.html');

    if (isHomePage) {
      updateSegmentedActive('home');
    } else if (isCheckerPage) {
      if (window.location.hash === '#speed') {
        setTimeout(() => {
          switchView('speed');
        }, 150);
      } else {
        updateSegmentedActive('checker');
      }
    } else {
      updateSegmentedActive('builder');
    }

    // Attach click listeners to segmented nav buttons
    const homeBtn = document.getElementById('nav-btn-home');
    const builderBtn = document.getElementById('nav-btn-builder');
    const checkerBtn = document.getElementById('nav-btn-checker');
    const speedBtn = document.getElementById('nav-btn-speed');

    if (homeBtn) {
      homeBtn.addEventListener('click', (e) => switchView('home', e));
    }
    if (builderBtn) {
      builderBtn.addEventListener('click', (e) => switchView('builder', e));
    }
    if (checkerBtn) {
      checkerBtn.addEventListener('click', (e) => switchView('checker', e));
    }
    if (speedBtn) {
      speedBtn.addEventListener('click', (e) => switchView('speed', e));
    }
  });

  // Re-check hash on hashchange
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#speed') {
      switchView('speed');
    }
  });

})();
