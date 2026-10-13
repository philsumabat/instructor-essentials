/**
 * Sheet Builder Controller.
 *
 * Provides a fluid drag-and-drop builder, form-based property inspector,
 * interactive canvas with reorder handles and live drop indicators,
 * instant Answer Key generator, and millimeter-precise physical print export.
 */
import { buildLayout, layoutStats, TemplateError, allGroups, PAPER_SIZES } from './layout-engine.js';
import { renderSheetDOM, renderStandaloneHTML, pageRule } from './render-dom.js';
import { renderSVG } from './render-svg.js';
import { SAMPLE_TEMPLATES } from './templates.js';

const STORAGE_KEY = 'sheet-builder:template';
const LEGACY_STORAGE_KEY = 'grader-studio:template';
const PX_PER_MM = 96 / 25.4; // CSS reference pixel (3.7795 px/mm)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- Unique ID generator ----
let idCounter = 1;
function uid(prefix = 'zone') {
  return `${prefix}_${Date.now().toString(36).slice(-4)}_${idCounter++}`;
}

// ---- State ----
const state = {
  template: null,
  layout: null,
  selectedZoneIndex: 0,
  activeTab: 'palette',
  zoom: 1.0,
  renderMode: 'dom', // 'dom' | 'svg'
  sheetCss: typeof window !== 'undefined' && window.__SHEET_CSS__ ? window.__SHEET_CSS__ : null,
};

// ---- DOM Elements ----
const els = {};

function initElements() {
  Object.assign(els, {
    examTitle: $('#exam-title-input'),
    paperSelect: $('#paper-select'),
    paperBtns: $$('.segmented-btn[data-paper]'),
    samplePreset: $('#sample-preset'),
    btnSaveBuild: $('#btn-save-build'),
    btnLibrary: $('#btn-library'),
    modalLibrary: $('#modal-library'),
    btnCloseLibrary: $('#btn-close-library'),
    btnModalClose: $('#btn-modal-close'),
    savedBuildsList: $('#saved-builds-list'),
    btnImportFileTrigger: $('#btn-import-file-trigger'),
    overlay: $('#overlay'),
    btnDlKey: $('#btn-dl-key'),
    btnPrint: $('#btn-print'),
    btnExportToggle: $('#btn-export-toggle'),
    exportMenu: $('#export-dropdown-content'),
    buttons: {
      svg: $('#dl-svg'),
      html: $('#dl-html'),
      layout: $('#dl-layout'),
      template: $('#dl-template'),
    },
    // Generator Dialog
    btnGenerator: $('#btn-generator'),
    modalGenerator: $('#modal-generator'),
    btnCloseGenerator: $('#btn-close-generator'),
    btnCancelGenerator: $('#btn-cancel-generator'),
    btnGenerateExam: $('#btn-generate-exam'),
    genTitle: $('#gen-exam-title'),
    genPaper: $('#gen-paper'),
    genSidMode: $('#gen-sid-mode'),
    genInstructions: $('#gen-instructions'),
    genPartsList: $('#gen-parts-list'),
    btnGenAddPart: $('#btn-gen-add-part'),
    // Tab navigation
    tabBtns: $$('.studio-tab-btn'),
    tabPanels: {
      palette: $('#panel-palette'),
      inspector: $('#panel-inspector'),
      outline: $('#panel-outline'),
    },
    // Palette & Outline & Inspector
    paletteCards: $$('.palette-card'),
    inspectorContent: $('#inspector-content'),
    outlineList: $('#outline-list'),
    // Stats
    statQuestions: $('#stat-questions'),
    statPoints: $('#stat-points'),
    statIdDigits: $('#stat-id-digits'),
    statFill: $('#stat-fill'),
    statFillBar: $('#stat-fill-bar-inner'),
    paperBadge: $('#paper-badge'),
    // Canvas
    preview: $('#preview'),
    frame: $('#frame'),
    pageRule: $('#page-rule'),
    zoomLabel: $('#zoom-label'),
    btnZoomIn: $('#btn-zoom-in'),
    btnZoomOut: $('#btn-zoom-out'),
    btnZoomFit: $('#btn-zoom-fit'),
    btnZoomReset: $('#btn-zoom-reset'),
    renderModeBtns: $$('.render-mode-btn'),
    // Advanced Drawer
    fileInput: $('#template-file-input'),
    rawJson: $('#raw-json-textarea'),
    jsonStatus: $('#json-status'),
    warningsList: $('#warnings-list'),
  });
}

// ---- File Download Utility ----
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function getSheetCss() {
  if (state.sheetCss) return state.sheetCss;
  if (typeof window !== 'undefined' && window.__SHEET_CSS__) {
    state.sheetCss = window.__SHEET_CSS__;
    return state.sheetCss;
  }
  try {
    state.sheetCss = await fetch('css/sheet.css').then((r) => r.text());
  } catch {
    state.sheetCss = '';
  }
  return state.sheetCss;
}

// ---- Default Zone Creators ----
function nextQuestionNumber() {
  if (!state.layout) return 1;
  const groups = allGroups(state.layout).filter((g) => g.kind === 'mcq' || g.kind === 'tf');
  const maxGroupQ = groups.reduce((max, g) => {
    const n = parseInt(g.key, 10);
    return !Number.isNaN(n) && n > max ? n : max;
  }, 0);
  const textRois = state.layout.zones.flatMap((z) => z.rois).filter((r) => r.graded);
  const maxRoiQ = textRois.reduce((max, r) => {
    const m = r.label.match(/^(\d+)/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  return Math.max(maxGroupQ, maxRoiQ) + 1;
}

function createDefaultZone(type) {
  const nextQ = nextQuestionNumber();
  const paperW = PAPER_SIZES[state.template?.paper]?.width ?? 210;
  const availW = paperW - 2 * (state.template?.margin ?? 12);

  switch (type) {
    case 'student_id':
      return {
        type: 'student_id',
        id: uid('sid'),
        label: 'Student ID',
        digits: 8,
        shading: true,
        boxHeight: 7.5,
      };

    case 'fields':
      return {
        type: 'fields',
        id: uid('info'),
        label: '',
        w: availW,
        fieldHeight: 7.5,
        fields: [
          { id: 'name', label: 'Student Name', role: 'name', row: 0, w: 108 },
          { id: 'sid', label: 'Student ID', role: 'student_id', digits: 8, row: 0, w: 75 },
          { id: 'offer', label: 'Offer No.', row: 1, w: 48 },
          { id: 'sched', label: 'Sched', row: 1, w: 52 },
          { id: 'date', label: 'Date', row: 1, w: 43 },
          { id: 'score', label: 'Score', role: 'score', row: 1, w: 40 },
        ],
      };

    case 'mcq':
      return {
        type: 'mcq',
        id: uid('mcq'),
        label: `Part ${state.template ? state.template.zones.filter((z) => z.type === 'mcq').length + 1 : 1} — Multiple Choice`,
        count: 20,
        start: nextQ,
        choices: 'ABCD',
        columns: 2,
        pointsPerItem: 1,
        w: availW,
      };

    case 'truefalse':
      return {
        type: 'truefalse',
        id: uid('tf'),
        label: 'True / False',
        count: 10,
        start: nextQ,
        choices: ['T', 'F'],
        columns: 2,
        pointsPerItem: 1,
        w: availW,
      };

    case 'modified_tf':
      return {
        type: 'modified_tf',
        id: uid('mod_tf'),
        label: 'Modified True / False (Write correction if False)',
        count: 5,
        start: nextQ,
        choices: ['T', 'F'],
        corrWidth: 42,
        columns: 1,
        pointsPerItem: 2,
        w: availW,
      };

    case 'text':
    case 'text_short':
      return {
        type: type === 'text' ? 'text' : 'text_short',
        id: uid('q'),
        label: `${nextQ}. Short Answer Question`,
        boxHeight: 12,
        points: 2,
        charset: 'any',
        w: availW,
      };

    case 'text_essay':
      return {
        type: 'text_essay',
        id: uid('q'),
        label: `${nextQ}. Essay Question / Discussion Prompt`,
        boxHeight: 45,
        points: 5,
        charset: 'any',
        w: availW,
      };

    case 'instructions':
      return {
        type: 'instructions',
        id: uid('notes'),
        fontSize: 2.8,
        text: 'Write your Student ID clearly. Fill each bubble completely with a dark pencil or pen.\nDo not fold, staple, or write outside the designated response areas.',
        w: availW,
      };

    default:
      throw new Error(`Unknown component type: ${type}`);
  }
}

// ---- Tab Switching ----
function switchTab(tabName) {
  state.activeTab = tabName;
  for (const btn of els.tabBtns) {
    btn.classList.toggle('is-active', btn.dataset.tab === tabName);
  }
  for (const [name, panel] of Object.entries(els.tabPanels)) {
    panel.classList.toggle('is-active', name === tabName);
  }
  if (tabName === 'inspector') {
    renderInspector();
  } else if (tabName === 'outline') {
    renderOutline();
  }
}

// ---- Canvas Scaling & Fit ----
function applyZoom() {
  const layout = state.layout;
  if (!layout) return;
  const sheetW = layout.page.width * PX_PER_MM;
  const sheetH = layout.page.height * PX_PER_MM;

  const scaler = els.frame.querySelector('.preview__scaler');
  if (scaler) scaler.style.transform = `scale(${state.zoom})`;

  els.frame.style.width = `${sheetW * state.zoom}px`;
  els.frame.style.height = `${sheetH * state.zoom}px`;
  els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitPreview() {
  const layout = state.layout;
  if (!layout) return;
  const sheetW = layout.page.width * PX_PER_MM;
  const availableW = els.preview.clientWidth - 48;
  const scale = Math.min(1.25, Math.max(0.3, availableW / sheetW));
  state.zoom = Math.round(scale * 100) / 100;
  applyZoom();
}

// ---- CV Overlay Builder ----
function buildOverlay(layout) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cv-overlay');
  svg.setAttribute('viewBox', `0 0 ${layout.page.width} ${layout.page.height}`);
  svg.setAttribute('width', `${layout.page.width}mm`);
  svg.setAttribute('height', `${layout.page.height}mm`);

  const r = layout.bubble.diameter / 2;
  for (const g of allGroups(layout)) {
    for (const o of g.options) {
      const c = document.createElementNS(NS, 'circle');
      Object.entries({
        cx: o.cx,
        cy: o.cy,
        r,
        fill: 'none',
        stroke: '#e11d48',
        'stroke-width': 0.22,
      }).forEach(([k, v]) => c.setAttribute(k, v));
      svg.append(c);
    }
  }

  for (const roi of layout.zones.flatMap((z) => z.rois)) {
    const rect = document.createElementNS(NS, 'rect');
    Object.entries({
      x: roi.x,
      y: roi.y,
      width: roi.w,
      height: roi.h,
      fill: 'rgb(37 99 235 / 0.08)',
      stroke: '#2563eb',
      'stroke-width': 0.35,
      'stroke-dasharray': '1 1',
    }).forEach(([k, v]) => rect.setAttribute(k, v));
    svg.append(rect);
  }

  for (const f of layout.fiducials) {
    const [cx, cy] = f.center;
    const path = document.createElementNS(NS, 'path');
    Object.entries({
      d: `M${cx - 3.5} ${cy}h7M${cx} ${cy - 3.5}v7`,
      stroke: '#16a34a',
      'stroke-width': 0.45,
    }).forEach(([k, v]) => path.setAttribute(k, v));
    svg.append(path);
  }
  return svg;
}

// ---- Render Canvas Preview ----
function renderPreview() {
  const layout = state.layout;
  if (!layout) return;

  const scaler = document.createElement('div');
  scaler.className = 'preview__scaler';

  if (state.renderMode === 'svg') {
    const doc = new DOMParser().parseFromString(renderSVG(layout), 'image/svg+xml');
    scaler.append(document.importNode(doc.documentElement, true));
  } else {
    const sheetEl = renderSheetDOM(layout);
    scaler.append(sheetEl);
    attachCanvasZoneInteractions(sheetEl);
  }

  if (els.overlay.checked) {
    scaler.append(buildOverlay(layout));
  }

  els.frame.replaceChildren(scaler);
  els.pageRule.textContent = pageRule(layout);
  applyZoom();
}

// ---- Canvas Zone Interactive Overlays & Click Handling ----
function attachCanvasZoneInteractions(sheetEl) {
  // Find all rendered zones
  const zoneEls = sheetEl.querySelectorAll('[data-zone-index]');
  for (const zEl of zoneEls) {
    const idx = parseInt(zEl.getAttribute('data-zone-index'), 10);
    if (Number.isNaN(idx)) continue;

    if (idx === state.selectedZoneIndex) {
      zEl.classList.add('is-selected');

      // Floating toolbar on selected zone
      const toolbar = document.createElement('div');
      toolbar.className = 'zone-floating-toolbar app-chrome';
      toolbar.innerHTML = `
        <span class="zone-drag-grip" title="Drag to reorder" draggable="true" data-zone-index="${idx}">⠿</span>
        <button type="button" class="btn-zone-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn-zone-down" title="Move Down" ${idx === state.template.zones.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="btn-zone-dup" title="Duplicate">⧉</button>
        <button type="button" class="btn-zone-del is-delete" title="Delete">🗑</button>
      `;

      toolbar.querySelector('.btn-zone-up')?.addEventListener('click', (e) => {
        e.stopPropagation();
        moveZone(idx, idx - 1);
      });
      toolbar.querySelector('.btn-zone-down')?.addEventListener('click', (e) => {
        e.stopPropagation();
        moveZone(idx, idx + 1);
      });
      toolbar.querySelector('.btn-zone-dup')?.addEventListener('click', (e) => {
        e.stopPropagation();
        duplicateZone(idx);
      });
      toolbar.querySelector('.btn-zone-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteZone(idx);
      });

      // Drag reorder from floating grip
      const grip = toolbar.querySelector('.zone-drag-grip');
      grip?.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-omr-reorder', String(idx));
        e.dataTransfer.effectAllowed = 'move';
      });

      zEl.append(toolbar);
    }

    zEl.addEventListener('click', (e) => {
      e.stopPropagation();
      selectZone(idx);
    });
  }
}

// ---- Canvas Drag-and-Drop Controller ----
let dropIndicator = null;

function getDropIndicator() {
  if (!dropIndicator) {
    dropIndicator = document.createElement('div');
    dropIndicator.className = 'drop-indicator app-chrome';
  }
  return dropIndicator;
}

function removeDropIndicator() {
  if (dropIndicator && dropIndicator.parentElement) {
    dropIndicator.remove();
  }
}

function setupCanvasDragDrop() {
  const frame = els.frame;

  frame.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    const scaler = frame.querySelector('.preview__scaler');
    if (!scaler || !state.layout) return;

    // Calculate mouse Y in sheet coordinates (mm)
    const frameRect = frame.getBoundingClientRect();
    const mouseYPx = (e.clientY - frameRect.top) / state.zoom;
    const mouseYMm = mouseYPx / PX_PER_MM;

    // Find the closest zone boundary to insert at
    const zones = state.layout.zones;
    let targetIndex = zones.length;
    let targetYMm = zones.length > 0 ? zones[zones.length - 1].bbox.y + zones[zones.length - 1].bbox.h + 2 : 20;

    for (let i = 0; i < zones.length; i += 1) {
      const z = zones[i];
      const midY = z.bbox.y + z.bbox.h / 2;
      if (mouseYMm < midY) {
        targetIndex = i;
        targetYMm = Math.max(15, z.bbox.y - 1.5);
        break;
      }
    }

    const indicator = getDropIndicator();
    indicator.style.top = `${targetYMm}mm`;
    indicator.dataset.targetIndex = String(targetIndex);
    if (!indicator.parentElement) {
      const sheet = scaler.querySelector('.omr-sheet');
      if (sheet) sheet.append(indicator);
    }
  });

  frame.addEventListener('dragleave', (e) => {
    // Only remove if leaving frame
    if (!frame.contains(e.relatedTarget)) {
      removeDropIndicator();
    }
  });

  frame.addEventListener('drop', (e) => {
    e.preventDefault();
    const indicator = getDropIndicator();
    const targetIndex = indicator.dataset.targetIndex ? parseInt(indicator.dataset.targetIndex, 10) : state.template.zones.length;
    removeDropIndicator();

    const newType = e.dataTransfer.getData('application/x-omr-component');
    const reorderIdxStr = e.dataTransfer.getData('application/x-omr-reorder');

    if (newType) {
      insertNewZone(newType, targetIndex);
    } else if (reorderIdxStr) {
      const fromIdx = parseInt(reorderIdxStr, 10);
      if (!Number.isNaN(fromIdx)) {
        const destIdx = fromIdx < targetIndex ? targetIndex - 1 : targetIndex;
        moveZone(fromIdx, destIdx);
      }
    }
  });
}

// ---- Template Mutations ----
function selectZone(index) {
  if (index < 0 || index >= (state.template?.zones.length ?? 0)) return;
  state.selectedZoneIndex = index;
  renderPreview();
  renderOutline();
  if (state.activeTab !== 'inspector') {
    switchTab('inspector');
  } else {
    renderInspector();
  }
}

function insertNewZone(type, atIndex = null) {
  const newZone = createDefaultZone(type);
  if (atIndex == null || atIndex >= state.template.zones.length) {
    state.template.zones.push(newZone);
    state.selectedZoneIndex = state.template.zones.length - 1;
  } else {
    state.template.zones.splice(atIndex, 0, newZone);
    state.selectedZoneIndex = atIndex;
  }
  update();
  switchTab('inspector');
}

function deleteZone(index) {
  if (!state.template.zones[index]) return;
  state.template.zones.splice(index, 1);
  state.selectedZoneIndex = state.template.zones.length > 0
    ? Math.max(0, Math.min(index, state.template.zones.length - 1))
    : -1;
  update();
}

function duplicateZone(index) {
  const orig = state.template.zones[index];
  if (!orig) return;
  const clone = JSON.parse(JSON.stringify(orig));
  clone.id = uid(clone.type);
  if (clone.label) clone.label = `${clone.label} (Copy)`;
  if (clone.start != null && clone.count != null) {
    clone.start += clone.count;
  }
  state.template.zones.splice(index + 1, 0, clone);
  state.selectedZoneIndex = index + 1;
  update();
}

function moveZone(fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  const zones = state.template.zones;
  if (fromIndex >= zones.length || toIndex >= zones.length) return;

  const [item] = zones.splice(fromIndex, 1);
  zones.splice(toIndex, 0, item);
  state.selectedZoneIndex = toIndex;
  update();
}

// ---- Inspector Rendering ----
function renderInspector() {
  const zone = state.template?.zones[state.selectedZoneIndex];
  if (!zone) {
    els.inspectorContent.innerHTML = `
      <div class="empty-inspector">
        <div class="empty-inspector__icon">👆</div>
        <h3 class="empty-inspector__title">No Block Selected</h3>
        <p class="empty-inspector__desc">Click on any section of the exam sheet or choose a block from the <strong>Outline</strong> tab to customize its properties in the Sheet Builder inspector.</p>
      </div>
    `;
    return;
  }

  const idx = state.selectedZoneIndex;
  const totalZones = state.template.zones.length;

  let formHtml = '';
  const typeIcons = {
    student_id: '🪪',
    fields: '📝',
    mcq: '🔘',
    truefalse: '⚖️',
    modified_tf: '📝',
    text: '✍️',
    text_short: '✏️',
    text_essay: '📄',
    instructions: 'ℹ️',
  };
  const typeNames = {
    student_id: 'Student ID',
    fields: 'Student Info & ID',
    mcq: 'Multiple Choice (MCQ)',
    truefalse: 'True / False',
    modified_tf: 'Modified True / False',
    text: 'Written Answer Box',
    text_short: 'Short Answer Question',
    text_essay: 'Essay / Long Answer',
    instructions: 'Instructions & Notes',
  };

  formHtml += `
    <div class="inspector-header">
      <div class="inspector-header__info">
        <span class="inspector-header__icon">${typeIcons[zone.type] || '📦'}</span>
        <div>
          <h3 class="inspector-header__title">${zone.label || typeNames[zone.type]}</h3>
          <span class="inspector-header__type">${typeNames[zone.type]}</span>
        </div>
      </div>
      <div class="zone-quick-actions">
        <button type="button" class="btn-zone-action" id="insp-btn-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn-zone-action" id="insp-btn-down" title="Move Down" ${idx === totalZones - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="btn-zone-action" id="insp-btn-dup" title="Duplicate">⧉</button>
        <button type="button" class="btn-zone-action is-danger" id="insp-btn-del" title="Delete">🗑</button>
      </div>
    </div>
  `;

  // Specific inspector form by zone type
  if (zone.type === 'mcq' || zone.type === 'truefalse') {
    const isTf = zone.type === 'truefalse';
    const choicesStr = Array.isArray(zone.choices) ? zone.choices.join('') : String(zone.choices ?? 'ABCD');

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Section Title</label>
        <input type="text" id="insp-label" class="form-input" value="${zone.label || ''}">
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-count">Questions</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-count-minus" aria-label="Decrease questions">−</button>
            <input type="number" id="insp-count" class="stepper-input" value="${zone.count ?? 20}" min="1" max="100">
            <button type="button" class="stepper-btn" id="insp-count-plus" aria-label="Increase questions">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-start">Start #</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-start-minus" aria-label="Decrease start number">−</button>
            <input type="number" id="insp-start" class="stepper-input" value="${zone.start ?? 1}" min="1" max="999">
            <button type="button" class="stepper-btn" id="insp-start-plus" aria-label="Increase start number">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-points">Pts / Item</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-points-minus" aria-label="Decrease points">−</button>
            <input type="number" id="insp-points" class="stepper-input" value="${zone.pointsPerItem ?? zone.points ?? 1}" min="1" max="50">
            <button type="button" class="stepper-btn" id="insp-points-plus" aria-label="Increase points">+</button>
          </div>
        </div>
      </div>

      ${!isTf ? `
      <div class="form-group">
        <label class="form-label">Choices</label>
        <div class="pills-group" id="insp-choices-pills">
          <button type="button" class="pill-btn ${choicesStr === 'ABCD' ? 'is-active' : ''}" data-choices="ABCD">A–D (4)</button>
          <button type="button" class="pill-btn ${choicesStr === 'ABCDE' ? 'is-active' : ''}" data-choices="ABCDE">A–E (5)</button>
          <button type="button" class="pill-btn ${choicesStr === 'ABC' ? 'is-active' : ''}" data-choices="ABC">A–C (3)</button>
          <button type="button" class="pill-btn ${!['ABCD', 'ABCDE', 'ABC'].includes(choicesStr) ? 'is-active' : ''}" data-choices="custom">Custom</button>
        </div>
        <input type="text" id="insp-choices-custom" class="form-input" style="display: ${!['ABCD', 'ABCDE', 'ABC'].includes(choicesStr) ? 'block' : 'none'}; margin-top: 0.35rem;" value="${choicesStr}" placeholder="e.g. ABCDEFG">
      </div>
      ` : `
      <div class="form-group">
        <label class="form-label">Choices</label>
        <div class="pills-group" id="insp-tf-pills">
          <button type="button" class="pill-btn ${choicesStr.includes('T') ? 'is-active' : ''}" data-tf="TF">T / F</button>
          <button type="button" class="pill-btn ${choicesStr.includes('Y') ? 'is-active' : ''}" data-tf="YN">Yes / No</button>
        </div>
      </div>
      `}

      <div class="form-group">
        <label class="form-label">Columns within Module</label>
        <div class="pills-group" id="insp-cols-pills">
          <button type="button" class="pill-btn ${!zone.columns ? 'is-active' : ''}" data-cols="">Auto</button>
          <button type="button" class="pill-btn ${zone.columns === 1 ? 'is-active' : ''}" data-cols="1">1 Col</button>
          <button type="button" class="pill-btn ${zone.columns === 2 ? 'is-active' : ''}" data-cols="2">2 Cols</button>
          <button type="button" class="pill-btn ${zone.columns === 3 ? 'is-active' : ''}" data-cols="3">3 Cols</button>
          <button type="button" class="pill-btn ${zone.columns === 4 ? 'is-active' : ''}" data-cols="4">4 Cols</button>
          <button type="button" class="pill-btn ${zone.columns === 5 ? 'is-active' : ''}" data-cols="5">5 Cols</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
      </div>
    `;
  } else if (zone.type === 'modified_tf') {
    const corrW = zone.correctionWidth ?? zone.corrWidth ?? 42;

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Section Title</label>
        <input type="text" id="insp-label" class="form-input" value="${zone.label || ''}">
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-count">Questions</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-count-minus" aria-label="Decrease questions">−</button>
            <input type="number" id="insp-count" class="stepper-input" value="${zone.count ?? 5}" min="1" max="100">
            <button type="button" class="stepper-btn" id="insp-count-plus" aria-label="Increase questions">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-start">Start #</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-start-minus" aria-label="Decrease start number">−</button>
            <input type="number" id="insp-start" class="stepper-input" value="${zone.start ?? 1}" min="1" max="999">
            <button type="button" class="stepper-btn" id="insp-start-plus" aria-label="Increase start number">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-points">Pts / Item</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-points-minus" aria-label="Decrease points">−</button>
            <input type="number" id="insp-points" class="stepper-input" value="${zone.pointsPerItem ?? zone.points ?? 2}" min="1" max="50">
            <button type="button" class="stepper-btn" id="insp-points-plus" aria-label="Increase points">+</button>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="insp-corr-width">Correction Box Width (mm)</label>
        <div class="stepper-control">
          <button type="button" class="stepper-btn" id="insp-corr-width-minus" aria-label="Decrease correction box width">−</button>
          <input type="number" id="insp-corr-width" class="stepper-input" value="${corrW}" min="20" max="90">
          <button type="button" class="stepper-btn" id="insp-corr-width-plus" aria-label="Increase correction box width">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Columns within Module</label>
        <div class="pills-group" id="insp-cols-pills">
          <button type="button" class="pill-btn ${(zone.columns || 1) === 1 ? 'is-active' : ''}" data-cols="1">1 Col</button>
          <button type="button" class="pill-btn ${(zone.columns || 1) === 2 ? 'is-active' : ''}" data-cols="2">2 Cols</button>
          <button type="button" class="pill-btn ${(zone.columns || 1) === 3 ? 'is-active' : ''}" data-cols="3">3 Cols</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
      </div>
    `;
  } else if (zone.type === 'student_id') {
    const isShading = zone.shading !== false && zone.mode !== 'ocr' && zone.mode !== 'digits';

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Zone Title</label>
        <input type="text" id="insp-label" class="form-input" value="${zone.label || ''}">
      </div>

      <div class="form-group">
        <label class="form-label">ID Digits</label>
        <div style="font-size: 0.82rem; font-weight: 600; color: var(--text-muted); padding: 0.35rem 0.5rem; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); display: inline-block;">8 Digits (Standardized)</div>
      </div>

      <div class="form-group">
        <label class="form-label">Recognition Mode</label>
        <div class="pills-group" id="insp-sid-mode">
          <button type="button" class="pill-btn ${isShading ? 'is-active' : ''}" data-mode="shading">🔘 Bubble Grid (OMR)</button>
          <button type="button" class="pill-btn ${!isShading ? 'is-active' : ''}" data-mode="ocr">✍️ Handwritten Digits (OCR)</button>
        </div>
      </div>
    `;
  } else if (zone.type === 'fields') {
    const currentFields = zone.fields || [];
    const hasField = (id) => currentFields.some((f) => f.id === id);
    const hasSidField = currentFields.some((f) => f.id === 'sid' || f.role === 'student_id');

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Section Title</label>
        <input type="text" id="insp-label" class="form-input" value="${zone.label || ''}" placeholder="(Leave blank to hide heading)">
      </div>

      <div class="form-group">
        <label class="form-label">Columns</label>
        <div class="pills-group" id="insp-fields-cols">
          <button type="button" class="pill-btn ${(zone.columns || 3) === 1 ? 'is-active' : ''}" data-cols="1">1 Col</button>
          <button type="button" class="pill-btn ${(zone.columns || 3) === 2 ? 'is-active' : ''}" data-cols="2">2 Cols</button>
          <button type="button" class="pill-btn ${(zone.columns || 3) === 3 ? 'is-active' : ''}" data-cols="3">3 Cols</button>
          <button type="button" class="pill-btn ${(zone.columns || 3) === 4 ? 'is-active' : ''}" data-cols="4">4 Cols</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Student ID Digits</label>
        <div style="font-size: 0.82rem; font-weight: 600; color: var(--text-muted); padding: 0.35rem 0.5rem; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); display: inline-block;">8 Digits (Standardized)</div>
      </div>

      <div class="form-group">
        <label class="form-label">Included Fields</label>
        <div class="checkbox-grid">
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-name" ${hasField('name') ? 'checked' : ''}>
            <span>Student Name</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-sid" ${hasSidField ? 'checked' : ''}>
            <span>Student ID (8 Digits)</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-offer" ${hasField('offer') || hasField('section') ? 'checked' : ''}>
            <span>Offer No.</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-sched" ${hasField('sched') || hasField('section') ? 'checked' : ''}>
            <span>Sched</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-date" ${hasField('date') ? 'checked' : ''}>
            <span>Date</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-score" ${hasField('score') ? 'checked' : ''}>
            <span>Score Box</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-sig" ${hasField('signature') ? 'checked' : ''}>
            <span>Signature</span>
          </label>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
      </div>
    `;
  } else if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
    const defaultPts = zone.type === 'text_essay' ? 5 : 2;
    const defaultH = zone.type === 'text_essay' ? 45 : (zone.type === 'text_short' ? 12 : 14);

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Question Prompt / Label</label>
        <input type="text" id="insp-label" class="form-input" value="${zone.label || ''}">
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-points">Points</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-points-minus" aria-label="Decrease points">−</button>
            <input type="number" id="insp-points" class="stepper-input" value="${zone.points ?? defaultPts}" min="1" max="50">
            <button type="button" class="stepper-btn" id="insp-points-plus" aria-label="Increase points">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-charset">Allowed Chars</label>
          <select id="insp-charset" class="form-select">
            <option value="any" ${zone.charset === 'any' ? 'selected' : ''}>Any text</option>
            <option value="digits" ${zone.charset === 'digits' ? 'selected' : ''}>Digits only (0–9)</option>
            <option value="alpha" ${zone.charset === 'alpha' ? 'selected' : ''}>Letters only (A–Z)</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="insp-box-height">Box Height (mm)</label>
        <div class="stepper-control">
          <button type="button" class="stepper-btn" id="insp-box-height-minus" aria-label="Decrease box height">−</button>
          <input type="number" id="insp-box-height" class="stepper-input" value="${zone.boxHeight ?? defaultH}" min="8" max="120">
          <button type="button" class="stepper-btn" id="insp-box-height-plus" aria-label="Increase box height">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
      </div>
    `;
  } else if (zone.type === 'instructions') {
    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-text">Instructions Text</label>
        <textarea id="insp-text" class="form-textarea" rows="4">${zone.text || ''}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Font Size</label>
        <div class="pills-group" id="insp-font-pills">
          <button type="button" class="pill-btn ${zone.fontSize <= 2.4 ? 'is-active' : ''}" data-size="2.4">Compact (2.4mm)</button>
          <button type="button" class="pill-btn ${zone.fontSize > 2.4 && zone.fontSize <= 2.8 ? 'is-active' : ''}" data-size="2.8">Normal (2.8mm)</button>
          <button type="button" class="pill-btn ${zone.fontSize > 2.8 ? 'is-active' : ''}" data-size="3.2">Large (3.2mm)</button>
        </div>
      </div>
    `;
  }

  els.inspectorContent.innerHTML = formHtml;
  bindInspectorEvents(zone);
}

// Stepper input binding helper
function bindStepper(idPrefix, getter, setter, min = 1, max = 999) {
  const input = $(`#${idPrefix}`);
  const minus = $(`#${idPrefix}-minus`);
  const plus = $(`#${idPrefix}-plus`);
  if (!input) return;

  const clampAndSet = (val) => {
    let num = parseInt(val, 10);
    if (Number.isNaN(num)) num = min;
    num = Math.max(min, Math.min(max, num));
    input.value = num;
    setter(num);
  };

  minus?.addEventListener('click', () => clampAndSet(parseInt(input.value, 10) - 1));
  plus?.addEventListener('click', () => clampAndSet(parseInt(input.value, 10) + 1));
  input.addEventListener('change', () => clampAndSet(input.value));
}

function bindInspectorEvents(zone) {
  const idx = state.selectedZoneIndex;

  // Header quick buttons
  $('#insp-btn-up')?.addEventListener('click', () => moveZone(idx, idx - 1));
  $('#insp-btn-down')?.addEventListener('click', () => moveZone(idx, idx + 1));
  $('#insp-btn-dup')?.addEventListener('click', () => duplicateZone(idx));
  $('#insp-btn-del')?.addEventListener('click', () => deleteZone(idx));

  // Label input
  const labelInput = $('#insp-label');
  if (labelInput) {
    labelInput.addEventListener('input', () => {
      zone.label = labelInput.value;
      update();
    });
  }

  // Count & Start & Points steppers (for mcq, truefalse, modified_tf)
  if (zone.type === 'mcq' || zone.type === 'truefalse' || zone.type === 'modified_tf') {
    bindStepper('insp-count', () => zone.count, (val) => { zone.count = val; update(); }, 1, 100);
    bindStepper('insp-start', () => zone.start, (val) => { zone.start = val; update(); }, 1, 999);
    bindStepper(
      'insp-points',
      () => zone.pointsPerItem ?? zone.points ?? (zone.type === 'modified_tf' ? 2 : 1),
      (val) => {
        zone.pointsPerItem = val;
        zone.points = val;
        update();
      },
      1,
      50,
    );
  }

  // Placement pills (Module page placement)
  const placementPills = $$('#insp-placement-pills .pill-btn');
  for (const pill of placementPills) {
    pill.addEventListener('click', () => {
      const mode = pill.dataset.placement;
      if (mode === 'left') {
        zone.layout = 'half-left';
        zone.side = 'left';
        delete zone.inline;
        delete zone.w;
      } else if (mode === 'right') {
        zone.layout = 'half-right';
        zone.side = 'right';
        zone.inline = true;
        delete zone.w;
      } else {
        delete zone.layout;
        delete zone.side;
        delete zone.inline;
        delete zone.w;
      }
      renderInspector();
      update();
    });
  }

  // Modified T/F correction box width
  if (zone.type === 'modified_tf') {
    bindStepper(
      'insp-corr-width',
      () => zone.correctionWidth ?? zone.corrWidth ?? 42,
      (val) => {
        zone.corrWidth = val;
        zone.correctionWidth = val;
        update();
      },
      20,
      90
    );
  }

  // Choices pills (MCQ)
  const choicesPills = $$('#insp-choices-pills .pill-btn');
  const customChoicesInput = $('#insp-choices-custom');
  if (choicesPills.length > 0) {
    for (const pill of choicesPills) {
      pill.addEventListener('click', () => {
        const choiceVal = pill.dataset.choices;
        if (choiceVal === 'custom') {
          if (customChoicesInput) customChoicesInput.style.display = 'block';
        } else {
          if (customChoicesInput) customChoicesInput.style.display = 'none';
          zone.choices = choiceVal;
          update();
        }
      });
    }
    if (customChoicesInput) {
      customChoicesInput.addEventListener('input', () => {
        zone.choices = customChoicesInput.value.toUpperCase();
        update();
      });
    }
  }

  // TF Pills
  const tfPills = $$('#insp-tf-pills .pill-btn');
  for (const pill of tfPills) {
    pill.addEventListener('click', () => {
      zone.choices = pill.dataset.tf === 'YN' ? ['Y', 'N'] : ['T', 'F'];
      update();
    });
  }

  // Columns pills (MCQ, TF, Modified TF)
  const colPills = $$('#insp-cols-pills .pill-btn');
  for (const pill of colPills) {
    pill.addEventListener('click', () => {
      const colVal = pill.dataset.cols ? parseInt(pill.dataset.cols, 10) : null;
      if (colVal) zone.columns = colVal;
      else delete zone.columns;
      update();
    });
  }

  // Fields columns selector
  const fieldsColPills = $$('#insp-fields-cols .pill-btn');
  for (const pill of fieldsColPills) {
    pill.addEventListener('click', () => {
      zone.columns = parseInt(pill.dataset.cols, 10) || 3;
      update();
    });
  }

  if (zone.type === 'student_id') {
    zone.digits = 8;
    const sidModePills = $$('#insp-sid-mode .pill-btn');
    for (const pill of sidModePills) {
      pill.addEventListener('click', () => {
        const mode = pill.dataset.mode;
        zone.shading = mode === 'shading';
        update();
      });
    }
  }

  if (zone.type === 'fields') {
    // Fields checkboxes
    const nameCb = $('#field-name');
    const sidCb = $('#field-sid');
    const offerCb = $('#field-offer');
    const schedCb = $('#field-sched');
    const dateCb = $('#field-date');
    const scoreCb = $('#field-score');
    const sigCb = $('#field-sig');

    const updateFields = () => {
      const fields = [];
      // Row 0: Student Name & Student ID (always standardized to 8 digits)
      if (nameCb?.checked) fields.push({ id: 'name', label: 'Student Name', role: 'name', row: 0, w: 108 });
      if (sidCb?.checked) fields.push({ id: 'sid', label: 'Student ID', role: 'student_id', digits: 8, row: 0, w: 75 });
      // Row 1: Offer No., Sched, Date, Score
      if (offerCb?.checked) fields.push({ id: 'offer', label: 'Offer No.', row: 1, w: 48 });
      if (schedCb?.checked) fields.push({ id: 'sched', label: 'Sched', row: 1, w: 52 });
      if (dateCb?.checked) fields.push({ id: 'date', label: 'Date', row: 1, w: 43 });
      if (scoreCb?.checked) fields.push({ id: 'score', label: 'Score', role: 'score', row: 1, w: 40 });
      if (sigCb?.checked) fields.push({ id: 'signature', label: 'Signature', ocr: false, row: 1, w: 45 });
      if (fields.length === 0) fields.push({ id: 'name', label: 'Student Name', role: 'name', row: 0, w: 108 });
      zone.fields = fields;
      update();
    };

    [nameCb, sidCb, offerCb, schedCb, dateCb, scoreCb, sigCb].forEach((cb) => cb?.addEventListener('change', updateFields));
  }

  // Text / Written Answer properties (text, text_short, text_essay)
  if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
    bindStepper('insp-points', () => zone.points ?? 1, (val) => {
      zone.points = val;
      update();
    }, 1, 50);

    bindStepper('insp-box-height', () => zone.boxHeight ?? 14, (val) => {
      zone.boxHeight = val;
      update();
    }, 8, 120);

    const charsetSelect = $('#insp-charset');
    if (charsetSelect) {
      charsetSelect.addEventListener('change', () => {
        zone.charset = charsetSelect.value;
        update();
      });
    }
  }

  // Instructions
  const textInput = $('#insp-text');
  if (textInput) {
    textInput.addEventListener('input', () => {
      zone.text = textInput.value;
      update();
    });
  }

  const fontPills = $$('#insp-font-pills .pill-btn');
  for (const pill of fontPills) {
    pill.addEventListener('click', () => {
      zone.fontSize = parseFloat(pill.dataset.size) || 2.8;
      update();
    });
  }
}

// ---- Outline List Rendering ----
function renderOutline() {
  const zones = state.template?.zones || [];
  const typeIcons = {
    student_id: '🪪',
    fields: '📝',
    mcq: '🔘',
    truefalse: '⚖️',
    modified_tf: '📝',
    text: '✍️',
    text_short: '✏️',
    text_essay: '📄',
    instructions: 'ℹ️',
  };
  const typeNames = {
    student_id: 'Student ID',
    fields: 'Student Info & ID',
    mcq: 'Multiple Choice (MCQ)',
    truefalse: 'True / False',
    modified_tf: 'Modified True / False',
    text: 'Written Answer Box',
    text_short: 'Short Answer Question',
    text_essay: 'Essay / Long Answer',
    instructions: 'Instructions & Notes',
  };

  els.outlineList.innerHTML = zones
    .map((z, i) => {
      const isSel = i === state.selectedZoneIndex;
      const countMeta = z.count ? `${z.count} items` : z.digits ? `${z.digits} digits` : z.points ? `${z.points} pts` : '';
      return `
        <div class="outline-item ${isSel ? 'is-selected' : ''}" data-index="${i}" draggable="true">
          <span class="outline-item__grip" title="Drag to reorder">⠿</span>
          <span style="font-size: 1.1rem;">${typeIcons[z.type] || '📦'}</span>
          <div class="outline-item__info">
            <div class="outline-item__title">${z.label || typeNames[z.type]}</div>
            <div class="outline-item__meta">${typeNames[z.type]}${countMeta ? ` · ${countMeta}` : ''}</div>
          </div>
          <div class="outline-item__actions">
            <button type="button" class="btn-mini-arrow btn-outline-up" data-index="${i}" title="Move Up" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="btn-mini-arrow btn-outline-down" data-index="${i}" title="Move Down" ${i === zones.length - 1 ? 'disabled' : ''}>▼</button>
            <button type="button" class="btn-mini-trash btn-outline-del" data-index="${i}" title="Delete">🗑</button>
          </div>
        </div>
      `;
    })
    .join('');

  // Events for outline items
  const items = els.outlineList.querySelectorAll('.outline-item');
  items.forEach((item) => {
    const idx = parseInt(item.dataset.index, 10);
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectZone(idx);
    });

    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-omr-reorder', String(idx));
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      item.style.borderTop = '2px solid var(--accent)';
    });

    item.addEventListener('dragleave', () => {
      item.style.borderTop = '';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.style.borderTop = '';
      const fromStr = e.dataTransfer.getData('application/x-omr-reorder');
      if (fromStr) {
        const fromIdx = parseInt(fromStr, 10);
        moveZone(fromIdx, idx);
      }
    });
  });

  // Outline action buttons
  els.outlineList.querySelectorAll('.btn-outline-up').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      moveZone(idx, idx - 1);
    });
  });

  els.outlineList.querySelectorAll('.btn-outline-down').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      moveZone(idx, idx + 1);
    });
  });

  els.outlineList.querySelectorAll('.btn-outline-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      deleteZone(idx);
    });
  });
}

// ---- Header Live Stats & Warnings ----
function renderMeta(layout) {
  const stats = layoutStats(layout);
  els.statQuestions.textContent = String(stats.questions);
  els.statIdDigits.textContent = `${stats.idDigits} Digits`;

  // Total points calculation
  let totalPts = 0;
  for (const g of allGroups(layout)) {
    if (g.kind === 'mcq' || g.kind === 'tf') totalPts += (g.points || 1);
  }
  for (const r of layout.zones.flatMap((z) => z.rois)) {
    if (r.graded) totalPts += (r.points || 1);
  }
  els.statPoints.textContent = String(totalPts);

  // Vertical space fill calculation
  const maxZoneBottom = layout.zones.reduce((max, z) => Math.max(max, z.bbox.y + z.bbox.h), 0);
  const printableH = layout.page.height - 2 * layout.fiducial.inset - layout.fiducial.size;
  const fillPct = Math.min(150, Math.round((maxZoneBottom / printableH) * 100));

  els.statFill.textContent = `${fillPct}%`;
  els.statFillBar.style.width = `${Math.min(100, fillPct)}%`;
  els.statFillBar.classList.toggle('is-warning', fillPct > 95 && fillPct <= 100);
  els.statFillBar.classList.toggle('is-danger', fillPct > 100);

  els.paperBadge.textContent = `${layout.page.paper} · ${layout.page.width} × ${layout.page.height} mm`;

  // Warnings
  els.warningsList.replaceChildren(...layout.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
}

// ---- Core Update Function ----
function update() {
  if (!state.template) return;

  try {
    state.layout = buildLayout(state.template);
    els.jsonStatus.textContent = `Layout OK${state.layout.warnings.length ? ` · ${state.layout.warnings.length} warning(s)` : ''}`;
    els.jsonStatus.dataset.state = 'ok';
  } catch (err) {
    els.jsonStatus.textContent = err instanceof TemplateError ? err.message : `Error: ${err.message}`;
    els.jsonStatus.dataset.state = 'error';
    return;
  }

  // Two-way sync to raw JSON textarea and storage
  const serialized = JSON.stringify(state.template, null, 2);
  els.rawJson.value = serialized;
  localStorage.setItem(STORAGE_KEY, serialized);

  // Header input sync
  if (els.examTitle.value !== state.template.title) {
    els.examTitle.value = state.template.title || '';
  }

  // Paper dropdown & button sync
  if (els.paperSelect && state.template.paper) {
    els.paperSelect.value = state.template.paper;
  }
  for (const btn of els.paperBtns) {
    btn.classList.toggle('is-active', btn.dataset.paper === state.template.paper);
  }

  renderMeta(state.layout);
  renderPreview();

  if (state.activeTab === 'inspector') {
    renderInspector();
  } else if (state.activeTab === 'outline') {
    renderOutline();
  }
}

// ---- Generate & Download Pre-Filled Answer Key ----
function downloadAnswerKey() {
  const layout = state.layout;
  if (!layout) return;

  const items = {};
  let totalPoints = 0;

  // 1. MCQ and True/False bubbles
  for (const g of allGroups(layout)) {
    if (g.kind === 'mcq' || g.kind === 'tf') {
      const defaultAnswer = g.options[0]?.value || (g.kind === 'tf' ? 'T' : 'A');
      const pts = g.points || 1.0;
      items[g.key] = {
        answer: defaultAnswer,
        points: pts,
        kind: g.kind,
      };
      totalPoints += pts;
    }
  }

  // 2. Graded handwriting OCR boxes
  for (const roi of layout.zones.flatMap((z) => z.rois)) {
    if (roi.graded) {
      const pts = roi.points || 1.0;
      items[roi.key] = {
        answer: ['SAMPLE_ANSWER'],
        points: pts,
        kind: 'text',
        rubric: roi.charset === 'digits' ? 'exact' : 'case_insensitive',
      };
      totalPoints += pts;
    }
  }

  const answerKeyPayload = {
    title: layout.title || 'Answer Key',
    templateId: layout.templateId,
    exam_id: layout.templateId,
    total_points: totalPoints,
    pass_score: Math.round(totalPoints * 0.6),
    items,
  };

  download(`${layout.templateId}-answer-key.json`, `${JSON.stringify(answerKeyPayload, null, 2)}\n`, 'application/json');
}

// ---- Load Template Helper ----
async function loadTemplate(tpl) {
  state.template = tpl;
  state.selectedZoneIndex = 0;
  update();
  fitPreview();
}

async function loadSample(urlOrKey) {
  const match = Object.keys(SAMPLE_TEMPLATES).find((k) => String(urlOrKey).includes(k));
  if (match && SAMPLE_TEMPLATES[match]) {
    await loadTemplate(JSON.parse(JSON.stringify(SAMPLE_TEMPLATES[match])));
    return;
  }
  try {
    const res = await fetch(urlOrKey);
    if (res.ok) {
      await loadTemplate(await res.json());
      return;
    }
  } catch {}
  // Reliable instant fallback
  await loadTemplate(JSON.parse(JSON.stringify(SAMPLE_TEMPLATES['exam-50'])));
}

// ---- Saved Exam Builds Feature ----
const SAVED_BUILDS_KEY = 'sheet-builder:saved_builds';
const LEGACY_SAVED_BUILDS_KEY = 'grader:saved_builds';

function getSavedBuilds() {
  try {
    const raw = localStorage.getItem(SAVED_BUILDS_KEY) || localStorage.getItem(LEGACY_SAVED_BUILDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBuildToLibrary(entry) {
  const builds = getSavedBuilds();
  const idx = builds.findIndex((b) => b.id === entry.id);
  if (idx >= 0) {
    builds[idx] = entry;
  } else {
    builds.unshift(entry);
  }
  localStorage.setItem(SAVED_BUILDS_KEY, JSON.stringify(builds));
}

function deleteBuildFromLibrary(id) {
  const builds = getSavedBuilds().filter((b) => b.id !== id);
  localStorage.setItem(SAVED_BUILDS_KEY, JSON.stringify(builds));
}

function renderSavedBuildsList() {
  const listEl = els.savedBuildsList;
  if (!listEl) return;
  const builds = getSavedBuilds();
  if (builds.length === 0) {
    listEl.innerHTML = `
      <div class="empty-library">
        <p>No saved exam builds yet.</p>
        <p class="empty-sub">Click <strong>Save Build</strong> on the toolbar to save your current work.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = builds
    .map((b) => {
      const dateStr = b.timestamp ? new Date(b.timestamp).toLocaleString() : '';
      return `
        <div class="saved-build-card" data-build-id="${b.id}">
          <div class="saved-build-card__info">
            <h4 class="saved-build-card__title">${escapeHTML(b.title || 'Untitled Exam')}</h4>
            <div class="saved-build-card__meta">
              <span class="badge badge--paper">${escapeHTML(b.paper || 'Folio')}</span>
              <span class="badge badge--questions">${b.questionCount || 0} Questions</span>
              <span class="saved-build-card__date">${dateStr}</span>
            </div>
          </div>
          <div class="saved-build-card__actions">
            <button type="button" class="btn btn--secondary btn-sm btn-load-build" data-build-id="${b.id}" title="Load this exam build into editor">Load</button>
            <button type="button" class="btn btn--secondary btn-sm btn-export-build" data-build-id="${b.id}" title="Download build file">Export .sheet.json</button>
            <button type="button" class="btn btn--secondary btn-sm is-danger btn-delete-build" data-build-id="${b.id}" title="Delete this build">Delete</button>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.btn-load-build').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.buildId;
      const b = getSavedBuilds().find((x) => x.id === id);
      if (b && b.template) {
        await loadTemplate(JSON.parse(JSON.stringify(b.template)));
        els.modalLibrary?.close();
      }
    });
  });

  listEl.querySelectorAll('.btn-export-build').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.buildId;
      const b = getSavedBuilds().find((x) => x.id === id);
      if (b && b.template) {
        download(`${b.id || 'exam'}.sheet.json`, `${JSON.stringify(b.template, null, 2)}\n`, 'application/json');
      }
    });
  });

  listEl.querySelectorAll('.btn-delete-build').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.buildId;
      deleteBuildFromLibrary(id);
      renderSavedBuildsList();
    });
  });
}

// ---- Exam Generator Logic ----
// Dynamic Exam Generator Parts state
let generatorParts = [
  { type: 'mcq', count: 30, choices: 'ABCD', cols: 'auto', pts: 1 },
  { type: 'truefalse', count: 10, cols: 'auto', pts: 1 },
];

function renderPartFields(part) {
  if (part.type === 'mcq') {
    return `
      <div class="gen-field-inline">
        <label>Items:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 30}" min="1" max="100">
      </div>
      <div class="gen-field-inline">
        <label>Choices:</label>
        <select class="gen-select gen-select--sm part-select-choices">
          <option value="ABCD" ${(part.choices ?? 'ABCD') === 'ABCD' ? 'selected' : ''}>A–D (4)</option>
          <option value="ABCDE" ${(part.choices ?? 'ABCD') === 'ABCDE' ? 'selected' : ''}>A–E (5)</option>
        </select>
      </div>
      <div class="gen-field-inline">
        <label>Columns:</label>
        <select class="gen-select gen-select--sm part-select-cols">
          <option value="auto" ${(part.cols ?? 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="1" ${part.cols === '1' ? 'selected' : ''}>1</option>
          <option value="2" ${part.cols === '2' ? 'selected' : ''}>2</option>
          <option value="3" ${part.cols === '3' ? 'selected' : ''}>3</option>
          <option value="4" ${part.cols === '4' ? 'selected' : ''}>4</option>
          <option value="5" ${part.cols === '5' ? 'selected' : ''}>5</option>
        </select>
      </div>
      <div class="gen-field-inline">
        <label>Pts/Item:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 1}" min="1" max="10">
      </div>
    `;
  }
  if (part.type === 'truefalse') {
    return `
      <div class="gen-field-inline">
        <label>Items:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 10}" min="1" max="50">
      </div>
      <div class="gen-field-inline">
        <label>Columns:</label>
        <select class="gen-select gen-select--sm part-select-cols">
          <option value="auto" ${(part.cols ?? 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="1" ${part.cols === '1' ? 'selected' : ''}>1</option>
          <option value="2" ${part.cols === '2' ? 'selected' : ''}>2</option>
          <option value="3" ${part.cols === '3' ? 'selected' : ''}>3</option>
          <option value="4" ${part.cols === '4' ? 'selected' : ''}>4</option>
        </select>
      </div>
      <div class="gen-field-inline">
        <label>Pts/Item:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 1}" min="1" max="10">
      </div>
    `;
  }
  if (part.type === 'modified_tf') {
    return `
      <div class="gen-field-inline">
        <label>Items:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 5}" min="1" max="25">
      </div>
      <div class="gen-field-inline">
        <label>Pts/Item:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 2}" min="1" max="10">
      </div>
    `;
  }
  if (part.type === 'text_short') {
    return `
      <div class="gen-field-inline">
        <label>Questions:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 5}" min="1" max="20">
      </div>
      <div class="gen-field-inline">
        <label>Box Height:</label>
        <input type="number" class="gen-input gen-input--sm part-input-height" value="${part.boxHeight ?? 12}" min="6" max="25"> mm
      </div>
      <div class="gen-field-inline">
        <label>Pts/Question:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 2}" min="1" max="10">
      </div>
    `;
  }
  if (part.type === 'text_essay') {
    return `
      <div class="gen-field-inline">
        <label>Questions:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 1}" min="1" max="5">
      </div>
      <div class="gen-field-inline">
        <label>Box Height:</label>
        <input type="number" class="gen-input gen-input--sm part-input-height" value="${part.boxHeight ?? 36}" min="15" max="80"> mm
      </div>
      <div class="gen-field-inline">
        <label>Pts/Question:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 5}" min="1" max="50">
      </div>
    `;
  }
  return '';
}

function renderGeneratorParts() {
  if (!els.genPartsList) return;
  els.genPartsList.innerHTML = '';

  const toRoman = (n) => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] || String(n);

  generatorParts.forEach((part, index) => {
    const card = document.createElement('div');
    card.className = 'gen-part-card';
    card.dataset.index = index;

    const roman = toRoman(index + 1);

    card.innerHTML = `
      <div class="gen-part-header">
        <div class="gen-part-title-group">
          <span class="gen-part-badge">Part ${roman}</span>
          <select class="gen-part-select" data-action="change-type" aria-label="Exam Type for Part ${roman}">
            <option value="mcq" ${part.type === 'mcq' ? 'selected' : ''}>Multiple Choice (MCQ)</option>
            <option value="truefalse" ${part.type === 'truefalse' ? 'selected' : ''}>Simple True / False</option>
            <option value="modified_tf" ${part.type === 'modified_tf' ? 'selected' : ''}>Modified True / False (T/F + Write-in)</option>
            <option value="text_short" ${part.type === 'text_short' ? 'selected' : ''}>Short Answer / Identification</option>
            <option value="text_essay" ${part.type === 'text_essay' ? 'selected' : ''}>Essay / Long Answer</option>
          </select>
        </div>
        <div class="gen-part-actions">
          <button type="button" class="btn-part-action" data-action="move-up" title="Move Up" ${index === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="btn-part-action" data-action="move-down" title="Move Down" ${index === generatorParts.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="btn-part-action is-delete" data-action="delete" title="Remove Part" ${generatorParts.length <= 1 ? 'disabled' : ''}>✕</button>
        </div>
      </div>
      <div class="gen-part-body">
        ${renderPartFields(part)}
      </div>
    `;

    // Type change listener
    card.querySelector('[data-action="change-type"]').addEventListener('change', (e) => {
      part.type = e.target.value;
      if (part.type === 'mcq') {
        part.count = part.count || 30;
        part.choices = part.choices || 'ABCD';
        part.cols = part.cols || 'auto';
        part.pts = part.pts || 1;
      } else if (part.type === 'truefalse') {
        part.count = part.count || 10;
        part.cols = part.cols || 'auto';
        part.pts = part.pts || 1;
      } else if (part.type === 'modified_tf') {
        part.count = part.count || 5;
        part.pts = part.pts || 2;
      } else if (part.type === 'text_short') {
        part.count = part.count || 5;
        part.boxHeight = part.boxHeight || 12;
        part.pts = part.pts || 2;
      } else if (part.type === 'text_essay') {
        part.count = part.count || 1;
        part.boxHeight = part.boxHeight || 36;
        part.pts = part.pts || 5;
      }
      renderGeneratorParts();
    });

    // Reordering listeners
    card.querySelector('[data-action="move-up"]').addEventListener('click', () => {
      if (index > 0) {
        const temp = generatorParts[index - 1];
        generatorParts[index - 1] = generatorParts[index];
        generatorParts[index] = temp;
        renderGeneratorParts();
      }
    });

    card.querySelector('[data-action="move-down"]').addEventListener('click', () => {
      if (index < generatorParts.length - 1) {
        const temp = generatorParts[index + 1];
        generatorParts[index + 1] = generatorParts[index];
        generatorParts[index] = temp;
        renderGeneratorParts();
      }
    });

    // Delete part listener
    card.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (generatorParts.length > 1) {
        generatorParts.splice(index, 1);
        renderGeneratorParts();
      }
    });

    // Input listeners
    const countInput = card.querySelector('.part-input-count');
    if (countInput) countInput.addEventListener('input', () => { part.count = Math.max(1, parseInt(countInput.value, 10) || 1); });

    const choicesSelect = card.querySelector('.part-select-choices');
    if (choicesSelect) choicesSelect.addEventListener('change', () => { part.choices = choicesSelect.value; });

    const colsSelect = card.querySelector('.part-select-cols');
    if (colsSelect) colsSelect.addEventListener('change', () => { part.cols = colsSelect.value; });

    const ptsInput = card.querySelector('.part-input-pts');
    if (ptsInput) ptsInput.addEventListener('input', () => { part.pts = Math.max(1, parseFloat(ptsInput.value) || 1); });

    const heightInput = card.querySelector('.part-input-height');
    if (heightInput) heightInput.addEventListener('input', () => { part.boxHeight = Math.max(6, parseInt(heightInput.value, 10) || 12); });

    els.genPartsList.appendChild(card);
  });
}

// ---- Exam Generator Logic ----
function generateExamFromGeneratorModal() {
  const title = (els.genTitle?.value || '').trim() || 'General Examination';
  const paper = els.genPaper?.value || 'A4';
  const sidMode = els.genSidMode?.value || 'fields';
  const includeInstructions = els.genInstructions ? els.genInstructions.checked : true;

  const paperSpec = PAPER_SIZES[paper] || PAPER_SIZES['A4'];
  const availW = Math.round((paperSpec.width - 24) * 10) / 10; // 12mm margins each side

  const zones = [];

  // 1. Student ID & Header (Always full-width, 8 digits, separated Offer No. and Sched)
  if (sidMode === 'grid') {
    zones.push({
      type: 'fields',
      id: uid('info'),
      label: '',
      w: availW,
      fieldHeight: 7.5,
      fields: [
        { id: 'name', label: 'Student Name', role: 'name', row: 0, w: 140 },
        { id: 'score', label: 'Score', role: 'score', row: 0, w: 40 },
        { id: 'offer', label: 'Offer No.', row: 1, w: 50 },
        { id: 'sched', label: 'Sched', row: 1, w: 70 },
        { id: 'date', label: 'Date', row: 1, w: 50 },
      ],
    });
    zones.push({
      type: 'student_id',
      id: uid('sid'),
      label: 'Student ID',
      digits: 8,
      shading: true,
      w: availW,
    });
  } else {
    zones.push({
      type: 'fields',
      id: uid('info'),
      label: '',
      w: availW,
      fieldHeight: 7.5,
      fields: [
        { id: 'name', label: 'Student Name', role: 'name', row: 0, w: 108 },
        { id: 'sid', label: 'Student ID', role: 'student_id', digits: 8, row: 0, w: 75 },
        { id: 'offer', label: 'Offer No.', row: 1, w: 48 },
        { id: 'sched', label: 'Sched', row: 1, w: 52 },
        { id: 'date', label: 'Date', row: 1, w: 43 },
        { id: 'score', label: 'Score', role: 'score', row: 1, w: 40 },
      ],
    });
  }

  // 2. Instructions Banner
  if (includeInstructions) {
    zones.push({
      type: 'instructions',
      id: uid('notes'),
      w: availW,
      fontSize: 2.8,
      text: 'Read all instructions carefully. Shade bubbles completely using a dark #2 pencil or black pen. For write-in sections, print clearly inside the boxes.',
    });
  }

  // 3. Exam Sections in exact user-defined order
  const toRoman = (n) => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] || String(n);
  let currentQ = 1;

  for (let pIdx = 0; pIdx < generatorParts.length; pIdx++) {
    const part = generatorParts[pIdx];
    const roman = toRoman(pIdx + 1);

    if (part.type === 'mcq') {
      const count = Math.max(1, part.count || 30);
      const choices = part.choices || 'ABCD';
      const cols = part.cols === 'auto' ? (count <= 10 ? 1 : count <= 30 ? 2 : count <= 60 ? 3 : 4) : parseInt(part.cols, 10);
      const pts = Math.max(1, part.pts || 1);

      zones.push({
        type: 'mcq',
        id: uid('mcq'),
        label: `Part ${roman} — Multiple Choice (${currentQ}–${currentQ + count - 1})`,
        count,
        start: currentQ,
        choices,
        columns: cols,
        pointsPerItem: pts,
        w: availW,
      });
      currentQ += count;
    } else if (part.type === 'truefalse') {
      const count = Math.max(1, part.count || 10);
      const cols = part.cols === 'auto' ? (count <= 10 ? 2 : count <= 25 ? 3 : 4) : parseInt(part.cols, 10);
      const pts = Math.max(1, part.pts || 1);

      zones.push({
        type: 'truefalse',
        id: uid('tf'),
        label: `Part ${roman} — True or False (${currentQ}–${currentQ + count - 1})`,
        count,
        start: currentQ,
        choices: ['T', 'F'],
        columns: cols,
        pointsPerItem: pts,
        w: availW,
      });
      currentQ += count;
    } else if (part.type === 'modified_tf') {
      const count = Math.max(1, part.count || 5);
      const pts = Math.max(1, part.pts || 2);

      zones.push({
        type: 'modified_tf',
        id: uid('modtf'),
        label: `Part ${roman} — Modified True / False (${currentQ}–${currentQ + count - 1})`,
        count,
        start: currentQ,
        choices: ['T', 'F'],
        corrWidth: Math.min(60, Math.floor(availW * 0.42)),
        columns: 1,
        pointsPerItem: pts,
        w: availW,
      });
      currentQ += count;
    } else if (part.type === 'text_short') {
      const count = Math.max(1, part.count || 5);
      const pts = Math.max(1, part.pts || 2);
      const h = part.boxHeight || 12;

      for (let i = 0; i < count; i++) {
        zones.push({
          type: 'text_short',
          id: uid('sa'),
          label: `${currentQ}. Short Answer / Identification (${pts} pt${pts > 1 ? 's' : ''})`,
          w: availW,
          boxHeight: h,
          points: pts,
          charset: 'any',
        });
        currentQ++;
      }
    } else if (part.type === 'text_essay') {
      const count = Math.max(1, part.count || 1);
      const pts = Math.max(1, part.pts || 5);
      const h = part.boxHeight || 36;

      for (let i = 0; i < count; i++) {
        zones.push({
          type: 'text_essay',
          id: uid('essay'),
          label: `${currentQ}. Essay / Discussion (${pts} pts)`,
          w: availW,
          boxHeight: h,
          points: pts,
          charset: 'any',
        });
        currentQ++;
      }
    }
  }

  const generatedTemplate = {
    id: `exam-${Date.now().toString(36).slice(-6)}`,
    title,
    paper,
    bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
    zones,
  };

  loadTemplate(generatedTemplate);
  els.modalGenerator?.close();
}

// ---- Event Listeners Setup ----
function initEvents() {
  // Global title
  els.examTitle?.addEventListener('input', () => {
    state.template.title = els.examTitle.value;
    update();
  });

  // Generator modal events
  els.btnGenerator?.addEventListener('click', () => {
    if (els.modalGenerator?.showModal) {
      renderGeneratorParts();
      els.modalGenerator.showModal();
    }
  });
  els.btnGenAddPart?.addEventListener('click', () => {
    generatorParts.push({ type: 'mcq', count: 10, choices: 'ABCD', cols: 'auto', pts: 1 });
    renderGeneratorParts();
  });
  els.btnCloseGenerator?.addEventListener('click', () => els.modalGenerator?.close());
  els.btnCancelGenerator?.addEventListener('click', () => els.modalGenerator?.close());
  els.modalGenerator?.addEventListener('click', (e) => {
    if (e.target === els.modalGenerator) els.modalGenerator.close();
  });
  els.btnGenerateExam?.addEventListener('click', () => {
    generateExamFromGeneratorModal();
  });

  // Paper size dropdown (#paper-select)
  els.paperSelect?.addEventListener('change', () => {
    const newPaper = els.paperSelect.value;
    if (state.template && state.template.paper !== newPaper) {
      const oldPaper = state.template.paper;
      const oldPaperW = PAPER_SIZES[oldPaper]?.width ?? 210;
      const oldMargin = state.template.margin ?? 12;
      const oldFullW = oldPaperW - 2 * oldMargin;

      state.template.paper = newPaper;
      const newPaperW = PAPER_SIZES[newPaper]?.width ?? 210;
      const newFullW = newPaperW - 2 * (state.template.margin ?? 12);

      for (const z of state.template.zones) {
        if (z.w && Math.abs(z.w - oldFullW) < 0.5) {
          z.w = newFullW;
        }
      }
      update();
      fitPreview();
    }
  });

  // Paper size buttons (if present)
  for (const btn of els.paperBtns) {
    btn.addEventListener('click', () => {
      const paper = btn.dataset.paper;
      if (state.template.paper !== paper) {
        if (els.paperSelect) els.paperSelect.value = paper;
        els.paperSelect?.dispatchEvent(new Event('change'));
      }
    });
  }

  // Save current build to library
  els.btnSaveBuild?.addEventListener('click', () => {
    if (!state.template || !state.layout) return;
    const title = (state.template.title || '').trim() || 'General Examination';
    state.template.title = title;
    const stats = layoutStats(state.layout);
    const entry = {
      id: state.template.id || `exam_${Date.now().toString(36)}`,
      title,
      paper: state.template.paper || 'Folio',
      questionCount: stats.questions,
      timestamp: Date.now(),
      template: JSON.parse(JSON.stringify(state.template)),
    };
    saveBuildToLibrary(entry);

    // Visual feedback
    const btn = els.btnSaveBuild;
    if (btn) {
      const originalHTML = btn.innerHTML;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>Saved!</span>`;
      btn.classList.add('btn--accent');
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.classList.remove('btn--accent');
      }, 1800);
    }
  });

  // Open library modal
  els.btnLibrary?.addEventListener('click', () => {
    renderSavedBuildsList();
    if (els.modalLibrary?.showModal) {
      els.modalLibrary.showModal();
    }
  });

  // Close library modal handlers
  els.btnCloseLibrary?.addEventListener('click', () => els.modalLibrary?.close());
  els.btnModalClose?.addEventListener('click', () => els.modalLibrary?.close());
  els.modalLibrary?.addEventListener('click', (e) => {
    if (e.target === els.modalLibrary) {
      els.modalLibrary.close();
    }
  });

  // Import file trigger inside library modal
  els.btnImportFileTrigger?.addEventListener('click', () => {
    const filePicker = document.createElement('input');
    filePicker.type = 'file';
    filePicker.accept = '.json,.grader,.sheet.json,application/json';
    filePicker.onchange = async () => {
      const file = filePicker.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const tpl = JSON.parse(text);
        if (!tpl || !Array.isArray(tpl.zones)) {
          throw new Error('Selected file is missing a valid "zones" array');
        }
        const stats = layoutStats(buildLayout(tpl));
        const entry = {
          id: tpl.id || `import_${Date.now().toString(36)}`,
          title: tpl.title || 'Imported Exam',
          paper: tpl.paper || 'Folio',
          questionCount: stats.questions,
          timestamp: Date.now(),
          template: tpl,
        };
        saveBuildToLibrary(entry);
        await loadTemplate(tpl);
        renderSavedBuildsList();
        els.modalLibrary?.close();
      } catch (err) {
        alert(`Failed to import build file: ${err.message}`);
      }
    };
    filePicker.click();
  });

  // Presets dropdown
  els.samplePreset.addEventListener('change', () => {
    const val = els.samplePreset.value;
    if (val === 'blank') {
      loadTemplate({
        id: `exam-${Date.now().toString(36).slice(-4)}`,
        title: 'New Exam Sheet',
        paper: 'A4',
        zones: [],
      });
    } else if (val) {
      loadSample(val).catch((e) => alert(`Error loading sample: ${e.message}`));
    }
    els.samplePreset.value = '';
  });

  // Studio tabs
  for (const btn of els.tabBtns) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // Palette card drag and + Add click
  for (const card of els.paletteCards) {
    const type = card.dataset.type;

    card.addEventListener('dragstart', (e) => {
      card.classList.add('is-dragging');
      e.dataTransfer.setData('application/x-omr-component', type);
      e.dataTransfer.effectAllowed = 'copy';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      removeDropIndicator();
    });

    const addBtn = card.querySelector('.btn-palette-add');
    addBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      insertNewZone(type);
    });
  }

  // CV overlay toggle
  els.overlay.addEventListener('change', () => state.layout && renderPreview());

  // Top action buttons
  els.btnDlKey.addEventListener('click', downloadAnswerKey);
  els.btnPrint.addEventListener('click', () => window.print());

  // Export dropdown
  els.btnExportToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const parent = els.btnExportToggle.closest('.dropdown-menu');
    const isOpen = parent.classList.toggle('is-open');
    els.btnExportToggle.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown-menu')) {
      $$('.dropdown-menu').forEach((d) => d.classList.remove('is-open'));
      els.btnExportToggle.setAttribute('aria-expanded', 'false');
    }
  });

  // Export actions
  els.buttons.svg.addEventListener('click', () => {
    download(`${state.layout.templateId}.svg`, renderSVG(state.layout), 'image/svg+xml');
  });

  els.buttons.html.addEventListener('click', async () => {
    download(`${state.layout.templateId}.sheet.html`, renderStandaloneHTML(state.layout, await getSheetCss()), 'text/html');
  });

  els.buttons.layout.addEventListener('click', () => {
    download(`${state.layout.templateId}.layout.json`, `${JSON.stringify(state.layout, null, 2)}\n`, 'application/json');
  });

  els.buttons.template.addEventListener('click', () => {
    download(`${state.layout.templateId}.template.json`, `${JSON.stringify(state.template, null, 2)}\n`, 'application/json');
  });

  // Canvas zoom
  els.btnZoomIn.addEventListener('click', () => {
    state.zoom = Math.min(2.0, state.zoom + 0.1);
    applyZoom();
  });

  els.btnZoomOut.addEventListener('click', () => {
    state.zoom = Math.max(0.3, state.zoom - 0.1);
    applyZoom();
  });

  els.btnZoomReset.addEventListener('click', () => {
    state.zoom = 1.0;
    applyZoom();
  });

  els.btnZoomFit.addEventListener('click', fitPreview);

  // Render mode buttons (DOM vs SVG)
  for (const btn of els.renderModeBtns) {
    btn.addEventListener('click', () => {
      state.renderMode = btn.dataset.mode;
      for (const b of els.renderModeBtns) b.classList.toggle('is-active', b === btn);
      renderPreview();
    });
  }

  // Advanced drawer events
  els.rawJson.addEventListener('input', () => {
    try {
      state.template = JSON.parse(els.rawJson.value);
      update();
    } catch (err) {
      els.jsonStatus.textContent = `JSON Error: ${err.message}`;
      els.jsonStatus.dataset.state = 'error';
    }
  });

  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      await loadTemplate(parsed);
    } catch (err) {
      alert(`Invalid JSON file: ${err.message}`);
    }
  });

  // Canvas Drag & Drop
  setupCanvasDragDrop();

  // ResizeObserver for canvas fit
  new ResizeObserver(() => {
    if (state.zoom === 1.0) fitPreview();
  }).observe(els.preview);
}

// ---- Boot Guard & Initialization ----
function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    queueMicrotask(fn);
  }
}

async function init() {
  initElements();
  initEvents();

  const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.zones) && parsed.zones.length > 0) {
        await loadTemplate(parsed);
        return;
      }
    } catch {}
  }

  // Guaranteed instant load without network dependency
  await loadSample('exam-50');
}

onReady(init);
