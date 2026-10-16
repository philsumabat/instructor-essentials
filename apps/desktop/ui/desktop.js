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
  function switchView(viewName) {
    const isCheckerPage = window.location.pathname.endsWith('checker.html');
    const isBuilderPage = !isCheckerPage;

    if (viewName === 'builder') {
      if (!isBuilderPage) {
        window.location.href = 'index.html';
      }
    } else if (viewName === 'checker') {
      if (!isCheckerPage) {
        window.location.href = 'checker.html';
      }
    } else if (viewName === 'speed') {
      if (isCheckerPage) {
        const btnWritten = document.getElementById('btn-written-deck') || document.querySelector('[onclick*="Flashcard"]');
        if (btnWritten) {
          btnWritten.click();
        } else if (typeof window.openHorizontalGradingModal === 'function') {
          window.openHorizontalGradingModal();
        } else {
          const deck = document.getElementById('horizontal-flashcard-deck');
          if (deck) {
            deck.style.display = 'block';
            deck.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
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
    // If drop was outside a specific dropzone, forward files to the scans input if on checker page
    const scansInput = document.getElementById('input-scans');
    if (scansInput && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      if (!e.target.closest('.dropzone') && !e.target.closest('input[type="file"]')) {
        e.preventDefault();
        try {
          scansInput.files = e.dataTransfer.files;
          scansInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {
          // Some browsers restrict programmatic assignment to input.files
        }
      }
    }
  });

  // ==========================================================================
  // Global Desktop Keyboard Shortcuts
  // ==========================================================================
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;

    // View switching shortcuts: Cmd+1 (Builder), Cmd+2 (Checker), Cmd+3 (Speed Grader)
    if (modifier && e.key === '1') {
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
  });

  // ==========================================================================
  // Speed Grader Deep-link Handler
  // ==========================================================================
  window.addEventListener('DOMContentLoaded', () => {
    if (window.location.hash === '#speed') {
      setTimeout(() => {
        switchView('speed');
      }, 300);
    }
  });

})();
