/**
 * Sheet Builder Controller.
 *
 * Provides a fluid drag-and-drop builder, form-based property inspector,
 * interactive canvas with reorder handles and live drop indicators,
 * instant Answer Key generator, and millimeter-precise physical print export.
 */
import { buildLayout, layoutStats, TemplateError, allGroups, PAPER_SIZES } from './layout-engine.js';
import { renderSheetDOM, renderStandaloneHTML, pageRule, escapeHTML } from './render-dom.js';
import { renderSVG } from './render-svg.js';
import { SAMPLE_TEMPLATES } from './templates.js';

const safeEscapeHTML = typeof escapeHTML === 'function'
  ? escapeHTML
  : (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const ZONE_TYPE_NAMES = {
  student_id: 'ID no.',
  fields: 'Info & ID no.',
  mcq: 'Multiple Choice (MCQ)',
  truefalse: 'True / False',
  modified_tf: 'Modified True / False',
  text: 'Written Answer Box',
  text_short: 'Short Answer Question',
  text_essay: 'Essay / Long Answer',
  instructions: 'Instructions & Notes',
};

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
    btnNewSheet: $('#btn-new-sheet'),
    btnSaveBuild: $('#btn-save-build'),
    btnLibrary: $('#btn-library'),
    btnGoogleDrive: $('#btn-google-drive'),
    labelGoogleDrive: $('#label-google-drive'),
    googleDriveDot: $('#google-drive-dot'),
    modalLibrary: $('#modal-library'),
    btnCloseLibrary: $('#btn-close-library'),
    btnModalClose: $('#btn-modal-close'),
    savedBuildsList: $('#saved-builds-list'),
    cloudBuildsList: $('#cloud-builds-list'),
    tabBtnLibraryLocal: $('#tab-btn-library-local'),
    tabBtnLibraryCloud: $('#tab-btn-library-cloud'),
    libraryTabDesc: $('#library-tab-desc'),
    btnImportFileTrigger: $('#btn-import-file-trigger'),
    modalGoogleDrive: $('#modal-google-drive'),
    btnCloseGdrive: $('#btn-close-gdrive'),
    btnGdriveCancel: $('#btn-gdrive-cancel'),
    btnGdriveConnect: $('#btn-gdrive-connect'),
    btnGdriveSaveNow: $('#btn-gdrive-save-now'),
    btnGdriveDisconnect: $('#btn-gdrive-disconnect'),
    btnGdriveDone: $('#btn-gdrive-done'),
    inputGdriveClientId: $('#input-gdrive-client-id'),
    overlay: $('#overlay'),
    btnDlKey: $('#btn-dl-key'),
    btnPrint: $('#btn-print'),
    btnExportToggle: $('#btn-export-toggle'),
    exportMenu: $('#export-dropdown-content'),
    buttons: {
      package: $('#dl-package'),
      svg: $('#dl-svg'),
      html: $('#dl-html'),
      keySheetHtml: $('#dl-key-sheet-html'),
      keySheetSvg: $('#dl-key-sheet-svg'),
      layout: $('#dl-layout'),
      template: $('#dl-template'),
    },
    // Generator Dialog & Live Preview
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
    genPreviewPaperLabel: $('#gen-preview-paper-label'),
    genStatQuestions: $('#gen-stat-questions'),
    genStatPoints: $('#gen-stat-points'),
    genStatFill: $('#gen-stat-fill'),
    genWireframe: $('#gen-wireframe'),
    // Answer Key Modal
    modalAnswerKey: $('#modal-answer-key'),
    btnCloseAnswerKey: $('#btn-close-answer-key'),
    keyMetricCount: $('#key-metric-count'),
    keyMetricPoints: $('#key-metric-points'),
    keyPassingInput: $('#key-passing-input'),
    btnKeyFillA: $('#btn-key-fill-a'),
    btnKeyFillT: $('#btn-key-fill-t'),
    btnKeyRandom: $('#btn-key-random'),
    btnKeyClear: $('#btn-key-clear'),
    keyFileImport: $('#key-file-import'),
    keyItemsContainer: $('#key-items-container'),
    btnKeyDownload: $('#btn-key-download'),
    btnKeyDownloadCsv: $('#btn-key-download-csv'),
    btnKeySaveApply: $('#btn-key-save-apply'),
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

// Zero-dependency pure JavaScript uncompressed ZIP (PKZIP 2.0 / Store format) generator
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const parts = [];
  const centralHeaders = [];
  let offset = 0;
  const enc = new TextEncoder();
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const dataBytes = typeof file.data === 'string'
      ? enc.encode(file.data)
      : (file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data));
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes + name length)
    const lh = new Uint8Array(30 + nameBytes.length);
    const dvL = new DataView(lh.buffer);
    dvL.setUint32(0, 0x04034b50, true);
    dvL.setUint16(4, 20, true);
    dvL.setUint16(6, 0x0800, true); // bit 11: UTF-8 filename
    dvL.setUint16(8, 0, true);      // compression method: 0 (store)
    dvL.setUint16(10, time, true);
    dvL.setUint16(12, date, true);
    dvL.setUint32(14, crc, true);
    dvL.setUint32(18, size, true);  // compressed size
    dvL.setUint32(22, size, true);  // uncompressed size
    dvL.setUint16(26, nameBytes.length, true);
    dvL.setUint16(28, 0, true);     // extra field length
    lh.set(nameBytes, 30);

    // Central directory file header (46 bytes + name length)
    const ch = new Uint8Array(46 + nameBytes.length);
    const dvC = new DataView(ch.buffer);
    dvC.setUint32(0, 0x02014b50, true);
    dvC.setUint16(4, 20, true);
    dvC.setUint16(6, 20, true);
    dvC.setUint16(8, 0x0800, true); // UTF-8 filename
    dvC.setUint16(10, 0, true);     // compression: 0 (store)
    dvC.setUint16(12, time, true);
    dvC.setUint16(14, date, true);
    dvC.setUint32(16, crc, true);
    dvC.setUint32(20, size, true);
    dvC.setUint32(24, size, true);
    dvC.setUint16(28, nameBytes.length, true);
    dvC.setUint16(30, 0, true);     // extra field length
    dvC.setUint16(32, 0, true);     // file comment length
    dvC.setUint16(34, 0, true);     // disk number start
    dvC.setUint16(36, 0, true);     // internal attrs
    dvC.setUint32(38, 0, true);     // external attrs
    dvC.setUint32(42, offset, true); // relative offset of local header
    ch.set(nameBytes, 46);

    parts.push(lh, dataBytes);
    centralHeaders.push(ch);
    offset += lh.length + dataBytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const ch of centralHeaders) {
    parts.push(ch);
    cdSize += ch.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const dvE = new DataView(eocd.buffer);
  dvE.setUint32(0, 0x06054b50, true);
  dvE.setUint16(4, 0, true);
  dvE.setUint16(6, 0, true);
  dvE.setUint16(8, files.length, true);
  dvE.setUint16(10, files.length, true);
  dvE.setUint32(12, cdSize, true);
  dvE.setUint32(16, cdOffset, true);
  dvE.setUint16(20, 0, true);
  parts.push(eocd);

  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let pOffset = 0;
  for (const p of parts) {
    result.set(p, pOffset);
    pOffset += p.length;
  }
  return result;
}

const DEFAULT_SHEET_CSS = `/* Printable OMR sheet styles */
.omr-sheet { position: relative; box-sizing: border-box; overflow: hidden; background: #fff; color: #000; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: var(--omr-font-body); line-height: 1.3; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.omr-sheet *, .omr-sheet *::before, .omr-sheet *::after { box-sizing: border-box; margin: 0; }
.omr-sheet > * { position: absolute; }
.omr-fiducial { display: block; overflow: visible; }
.omr-title { display: flex; align-items: center; justify-content: center; text-align: center; font-size: var(--omr-font-title); font-weight: 700; line-height: 1.15; overflow: hidden; }
.omr-footer { display: flex; align-items: center; justify-content: center; text-align: center; font-size: var(--omr-font-small); color: #444; overflow: hidden; }
.omr-zone { border: 0.3mm solid #000; border-radius: 1.2mm; padding: 2.5mm; }
.omr-zone__title { font-size: var(--omr-font-label); font-weight: 700; line-height: 4mm; height: 5mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.omr-grid { display: grid; grid-auto-rows: 0; grid-auto-columns: 0; }
.omr-bubble { display: grid; place-items: center; align-self: start; justify-self: center; width: var(--omr-d); height: var(--omr-d); border: var(--omr-stroke) solid #000; border-radius: 50%; font-size: var(--omr-font-bubble); line-height: 1; color: #8a8a8a; }
.omr-bubble.is-keyed, .omr-bubble--keyed { background-color: #000 !important; color: #fff !important; font-weight: 700 !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
.omr-num, .omr-item-num { font-size: var(--omr-font-number) !important; font-weight: 700; font-variant-numeric: tabular-nums; }
.omr-num { align-self: start; height: var(--omr-pitch-y); display: flex; align-items: center; justify-content: flex-end; padding-right: 1.2mm; }
.omr-digit-box { justify-self: center; width: calc(100% - 0.8mm); height: 100%; border: 0.25mm solid #000; }
.omr-field-label { display: flex; align-items: center; font-size: var(--omr-font-label); font-weight: 700; }
.omr-write-box { border: 0.3mm solid #000; }
.omr-partitioned-digits { display: grid; border: 0.3mm solid #000; background: #fff; }
.omr-partitioned-digits .omr-digit-box { width: 100%; height: 100%; border: none; border-right: 0.25mm solid #000; }
.omr-partitioned-digits .omr-digit-box:last-child { border-right: none; }
.omr-correction-box { border: 0.25mm solid #000; font-size: 1.8mm; color: #888; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.omr-correction-hint { display: inline; }
.omr-prompt { font-size: var(--omr-font-label); overflow: hidden; }
.omr-points { color: #555; white-space: nowrap; }
.omr-instructions { padding: 1mm; color: #222; overflow: hidden; white-space: pre-line; }
@media print { .omr-sheet { box-shadow: none !important; break-after: page; break-inside: avoid; } .omr-correction-box { color: transparent !important; } .omr-correction-hint { display: none !important; visibility: hidden !important; } }`;

async function getSheetCss() {
  if (state.sheetCss) return state.sheetCss;
  if (typeof window !== 'undefined' && window.__SHEET_CSS__) {
    state.sheetCss = window.__SHEET_CSS__;
    return state.sheetCss;
  }
  try {
    const res = await fetch('css/sheet.css');
    if (res.ok) {
      state.sheetCss = await res.text();
      return state.sheetCss;
    }
  } catch {
    // offline or file:// protocol
  }
  state.sheetCss = DEFAULT_SHEET_CSS;
  return state.sheetCss;
}

function getExportBaseId() {
  const raw = state.layout?.templateId || state.template?.id || state.template?.title || 'exam';
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'exam';
}

function generateKeySheetSVG(layout, keyItems) {
  let svg = renderSVG(layout);
  const items = keyItems || (currentAnswerKey && currentAnswerKey.items) || {};
  const stroke = layout.bubble.stroke ?? 0.25;
  const r = (layout.bubble.diameter / 2 - stroke / 2).toFixed(3);
  const fontSize = layout.typography.bubble;

  const keyedOverlays = [];
  for (const g of allGroups(layout)) {
    const keyedAns = items[g.key]?.answer;
    if (!keyedAns) continue;
    for (const opt of g.options) {
      if (opt.value === keyedAns) {
        keyedOverlays.push(
          `<circle class="omr-bubble is-keyed" cx="${Number(opt.cx).toFixed(3)}" cy="${Number(opt.cy).toFixed(3)}" r="${r}" fill="#000" stroke="#000" stroke-width="${stroke}"/>`,
          `<text x="${Number(opt.cx).toFixed(3)}" y="${(Number(opt.cy) + 0.05).toFixed(3)}" font-size="${fontSize}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-weight="700">${safeEscapeHTML(opt.value)}</text>`
        );
      }
    }
  }
  const titleY = layout.fiducial.inset + layout.fiducial.size / 2 + 5;
  const keyLabel = `<text x="${layout.header.title.x}" y="${titleY.toFixed(3)}" font-size="3" text-anchor="middle" dominant-baseline="central" fill="#dc2626" font-weight="700">★ ANSWER KEY SHEET ★</text>`;
  return svg.replace('</svg>', `${keyedOverlays.join('\n')}\n${keyLabel}\n</svg>`);
}

function generateKeySheetHTML(layout, keyItems, css) {
  const baseHtml = renderStandaloneHTML(layout, css);
  const items = keyItems || (currentAnswerKey && currentAnswerKey.items) || {};
  const parser = new DOMParser();
  const doc = parser.parseFromString(baseHtml, 'text/html');

  const styleEl = doc.querySelector('style');
  if (styleEl) {
    styleEl.textContent += `\n.omr-bubble.is-keyed, .omr-bubble--keyed { background: #000 !important; color: #fff !important; font-weight: 700 !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }\n`;
  }

  const groups = allGroups(layout);
  for (const g of groups) {
    const keyedAns = items[g.key]?.answer;
    if (!keyedAns) continue;
    const numEls = Array.from(doc.querySelectorAll('.omr-num')).filter((el) => el.textContent.trim() === String(g.key));
    for (const numEl of numEls) {
      const parentGrid = numEl.parentElement;
      if (!parentGrid) continue;
      const numRow = numEl.style.gridRowStart || numEl.style.gridRow;
      const bubblesInRow = Array.from(parentGrid.querySelectorAll('.omr-bubble')).filter((b) => (b.style.gridRowStart || b.style.gridRow) === numRow);
      for (const b of bubblesInRow) {
        if (b.textContent.trim() === keyedAns) {
          b.classList.add('is-keyed');
          b.setAttribute('style', `${b.getAttribute('style') || ''}; background: #000 !important; color: #fff !important; font-weight: 700 !important;`);
        }
      }
    }
  }

  const titleEl = doc.querySelector('.omr-title');
  if (titleEl) {
    titleEl.innerHTML = `${escapeHTML(layout.title || layout.templateId)} <span style="color: #dc2626; font-size: 0.75em; margin-left: 0.4em;">[ANSWER KEY]</span>`;
  }

  return '<!doctype html>\n' + doc.documentElement.outerHTML;
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
        label: 'ID no.',
        digits: 8,
        shading: true,
        boxHeight: 7.5,
        w: availW,
      };

    case 'fields':
      return {
        type: 'fields',
        id: uid('info'),
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
        label: 'Modified True / False',
        count: 5,
        start: nextQ,
        choices: ['T', 'F'],
        corrWidth: 42,
        columns: 1,
        pointsPerItem: 2,
        w: availW,
      };

    case 'text':
      return {
        type: 'text',
        id: uid('q'),
        key: String(nextQ),
        label: `${nextQ}`,
        boxHeight: 12,
        points: 1,
        charset: 'any',
        w: availW,
      };

    case 'text_short':
      return {
        type: 'text_short',
        id: uid('sa'),
        label: 'Short Answer / Identification',
        count: 5,
        start: nextQ,
        columns: 2,
        boxHeight: 10,
        pointsPerItem: 1,
        w: availW,
      };

    case 'text_essay':
      return {
        type: 'text_essay',
        id: uid('essay'),
        label: 'Essay / Discussion',
        count: 1,
        start: nextQ,
        columns: 1,
        boxHeight: 35,
        pointsPerItem: 5,
        w: availW,
      };

    case 'instructions':
      return {
        type: 'instructions',
        id: uid('notes'),
        fontSize: 2.8,
        text: 'Write your ID no. clearly. Fill each bubble completely with a dark pencil or pen.\nDo not fold, staple, or write outside the designated response areas.',
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
    const svgEl = document.importNode(doc.documentElement, true);
    scaler.append(svgEl);
    attachSvgZoneInteractions(scaler, svgEl, layout);
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

// Floating action toolbar helper for selected zone
function attachFloatingToolbar(zEl, idx) {
  if (zEl.querySelector('.zone-floating-toolbar')) return;
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

  const grip = toolbar.querySelector('.zone-drag-grip');
  grip?.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-omr-reorder', String(idx));
    e.dataTransfer.effectAllowed = 'move';
  });

  zEl.append(toolbar);
}

// ---- Canvas Zone Interactive Overlays & Click Handling (DOM Mode) ----
function attachCanvasZoneInteractions(sheetEl) {
  // Direct exam title editing on the paper
  const examTitleEl = sheetEl.querySelector('.omr-title');
  if (examTitleEl) {
    examTitleEl.setAttribute('contenteditable', 'true');
    examTitleEl.setAttribute('spellcheck', 'false');
    examTitleEl.setAttribute('title', 'Click to edit exam title');
    examTitleEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    examTitleEl.addEventListener('input', () => {
      state.template.title = examTitleEl.textContent;
      if (els.examTitle) {
        els.examTitle.value = state.template.title;
      }
    });
    examTitleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        examTitleEl.blur();
      }
    });
    examTitleEl.addEventListener('blur', () => {
      const trimmed = examTitleEl.textContent.trim();
      state.template.title = trimmed;
      examTitleEl.textContent = trimmed;
      update();
    });
  }

  // Find all rendered top-level zone containers
  const zoneContainers = sheetEl.querySelectorAll('.omr-zone[data-zone-index], .omr-instructions[data-zone-index]');
  for (const zEl of zoneContainers) {
    const idx = parseInt(zEl.getAttribute('data-zone-index'), 10);
    if (Number.isNaN(idx)) continue;

    // Direct section title editing on the paper
    const titleTextEl = zEl.querySelector('.omr-zone__title-text') || zEl.querySelector('.omr-zone__title');
    if (titleTextEl) {
      titleTextEl.setAttribute('contenteditable', 'true');
      titleTextEl.setAttribute('spellcheck', 'false');
      titleTextEl.setAttribute('title', 'Click to edit section title');

      const selectZoneNonDestructive = () => {
        if (state.selectedZoneIndex !== idx) {
          state.selectedZoneIndex = idx;
          for (const otherEl of zoneContainers) {
            otherEl.classList.toggle('is-selected', otherEl === zEl);
          }
          sheetEl.querySelectorAll('.zone-floating-toolbar').forEach((tb) => tb.remove());
          attachFloatingToolbar(zEl, idx);
          renderOutline();
          if (state.activeTab !== 'inspector') {
            switchTab('inspector');
          } else {
            renderInspector();
          }
        }
      };

      titleTextEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectZoneNonDestructive();
      });
      titleTextEl.addEventListener('focus', () => {
        selectZoneNonDestructive();
      });
      titleTextEl.addEventListener('input', () => {
        const zone = state.template.zones[idx];
        if (!zone) return;
        zone.label = titleTextEl.textContent;
        const inspLabel = $('#insp-label');
        if (inspLabel && state.selectedZoneIndex === idx) {
          inspLabel.value = zone.label;
        }
        const inspHeaderTitle = $('.inspector-header__title');
        if (inspHeaderTitle && state.selectedZoneIndex === idx) {
          inspHeaderTitle.textContent = zone.label || (ZONE_TYPE_NAMES[zone.type] || zone.type);
        }
        const outlineTitle = document.querySelector(`.outline-item[data-zone-index="${idx}"] .outline-item__title`);
        if (outlineTitle) {
          outlineTitle.textContent = zone.label || (ZONE_TYPE_NAMES[zone.type] || zone.type);
        }
        const serialized = JSON.stringify(state.template, null, 2);
        localStorage.setItem(STORAGE_KEY, serialized);
        if (els.rawJson && document.activeElement !== els.rawJson) {
          els.rawJson.value = serialized;
        }
      });
      titleTextEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleTextEl.blur();
        }
      });
      titleTextEl.addEventListener('blur', () => {
        const zone = state.template.zones[idx];
        if (zone) {
          const trimmed = titleTextEl.textContent.trim();
          zone.label = trimmed;
          titleTextEl.textContent = trimmed;
          update();
        }
      });
    }

    if (idx === state.selectedZoneIndex) {
      zEl.classList.add('is-selected');
      attachFloatingToolbar(zEl, idx);
    }
  }

  // Delegated click handling on canvas: selecting zones from write-boxes/grids or deselecting on background
  sheetEl.addEventListener('click', (e) => {
    const zoneTarget = e.target.closest('[data-zone-index]');
    if (!zoneTarget) {
      if (state.selectedZoneIndex !== -1) {
        state.selectedZoneIndex = -1;
        renderInspector();
        renderOutline();
        renderPreview();
      }
      return;
    }
    const idx = parseInt(zoneTarget.getAttribute('data-zone-index'), 10);
    if (!Number.isNaN(idx) && state.selectedZoneIndex !== idx) {
      selectZone(idx);
    }
  });
}

// ---- Canvas Zone Interactive Overlays & Click Handling (SVG Mode) ----
function attachSvgZoneInteractions(scaler, svgEl, layout) {
  // Exam title double-click to edit
  const titleEl = svgEl.querySelector('text.omr-title') || svgEl.querySelector('text');
  if (titleEl) {
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (els.examTitle) {
        els.examTitle.focus();
        els.examTitle.select();
      }
    });
  }

  const zoneEls = svgEl.querySelectorAll('g.omr-zone[data-zone-index]');
  for (const zEl of zoneEls) {
    const idx = parseInt(zEl.getAttribute('data-zone-index'), 10);
    if (Number.isNaN(idx)) continue;

    zEl.style.cursor = 'pointer';

    zEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      selectZone(idx);
      const inspLabel = $('#insp-label');
      if (inspLabel) {
        inspLabel.focus();
        inspLabel.select();
      }
    });

    if (idx === state.selectedZoneIndex) {
      zEl.classList.add('is-selected');

      const zone = layout.zones[idx];
      if (zone && zone.bbox) {
        // Floating action toolbar positioned directly above selected zone in scaler
        const toolbar = document.createElement('div');
        toolbar.className = 'zone-floating-toolbar app-chrome';
        toolbar.style.position = 'absolute';
        toolbar.style.top = `${zone.bbox.y * PX_PER_MM - 30}px`;
        toolbar.style.left = `${zone.bbox.x * PX_PER_MM}px`;
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

        const grip = toolbar.querySelector('.zone-drag-grip');
        grip?.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-omr-reorder', String(idx));
          e.dataTransfer.effectAllowed = 'move';
        });

        scaler.append(toolbar);
      }
    }

    zEl.addEventListener('click', (e) => {
      e.stopPropagation();
      selectZone(idx);
    });
  }

  // Click on background svg deselects
  svgEl.addEventListener('click', (e) => {
    if (e.target.closest('g.omr-zone')) return;
    state.selectedZoneIndex = -1;
    renderInspector();
    renderOutline();
    renderPreview();
  });
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
      scaler.append(indicator);
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
        <div class="empty-inspector__icon" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg>
        </div>
        <h3 class="empty-inspector__title">No Block Selected</h3>
        <p class="empty-inspector__desc">Click on any section of the exam sheet or choose a block from the <strong>Outline</strong> tab to customize its properties in the Sheet Builder inspector.</p>
      </div>
    `;
    return;
  }

  const idx = state.selectedZoneIndex;
  const totalZones = state.template.zones.length;

  let formHtml = '';
  const ZONE_SVGS = {
    student_id: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    fields: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mcq: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
    truefalse: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
    modified_tf: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    text: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    text_short: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    text_essay: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    instructions: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  const typeNames = ZONE_TYPE_NAMES;

  formHtml += `
    <div class="inspector-header">
      <div class="inspector-header__info">
        <span class="inspector-header__icon" aria-hidden="true">${ZONE_SVGS[zone.type] || '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'}</span>
        <div>
          <h3 class="inspector-header__title">${safeEscapeHTML(zone.label || typeNames[zone.type])}</h3>
          <span class="inspector-header__type">${typeNames[zone.type]}</span>
        </div>
      </div>
      <div class="zone-quick-actions">
        <button type="button" class="btn-zone-action" id="insp-btn-up" title="Move Up" ${idx === 0 ? 'disabled' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg></button>
        <button type="button" class="btn-zone-action" id="insp-btn-down" title="Move Down" ${idx === totalZones - 1 ? 'disabled' : ''}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></button>
        <button type="button" class="btn-zone-action" id="insp-btn-dup" title="Duplicate"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="13" height="13" x="9" y="9" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button type="button" class="btn-zone-action is-danger" id="insp-btn-del" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
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
        <input type="text" id="insp-label" class="form-input" value="${safeEscapeHTML(zone.label || '')}">
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
            <input type="number" id="insp-start" class="stepper-input" value="${zone.start ?? state.layout?.zones?.[idx]?.start ?? 1}" min="1" max="999">
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

      <div class="form-group" style="margin-top: -0.25rem; margin-bottom: 0.5rem;">
        <label class="field-checkbox-label">
          <input type="checkbox" id="insp-show-points" ${zone.showPoints === true ? 'checked' : ''}>
          <span>Show points on sheet</span>
        </label>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-row-gap">Item / Row Spacing (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-row-gap-minus" aria-label="Decrease item spacing">−</button>
            <input type="number" id="insp-row-gap" class="stepper-input" value="${zone.rowGap ?? 1}" min="0" max="50">
            <button type="button" class="stepper-btn" id="insp-row-gap-plus" aria-label="Increase item spacing">+</button>
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
        <input type="text" id="insp-choices-custom" class="form-input" style="display: ${!['ABCD', 'ABCDE', 'ABC'].includes(choicesStr) ? 'block' : 'none'}; margin-top: 0.35rem;" value="${safeEscapeHTML(choicesStr)}" placeholder="e.g. ABCDEFG">
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
        <button type="button" class="btn btn--secondary btn--sm" id="insp-btn-pull-vacant" style="width: 100%; margin-top: 0.4rem;" title="Switch side to fill vacant column space">
          ⇄ Move to Opposite / Vacant Side
        </button>
      </div>
    `;
  } else if (zone.type === 'modified_tf') {
    const corrW = zone.boxWidth ?? zone.correctionWidth ?? zone.corrWidth ?? 42;
    const corrH = zone.boxHeight ?? zone.fieldHeight ?? 6;

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Section Title</label>
        <input type="text" id="insp-label" class="form-input" value="${safeEscapeHTML(zone.label || '')}">
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
            <input type="number" id="insp-start" class="stepper-input" value="${zone.start ?? state.layout?.zones?.[idx]?.start ?? 1}" min="1" max="999">
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

      <div class="form-group" style="margin-top: -0.25rem; margin-bottom: 0.5rem;">
        <label class="field-checkbox-label">
          <input type="checkbox" id="insp-show-points" ${zone.showPoints === true ? 'checked' : ''}>
          <span>Show points on sheet</span>
        </label>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-corr-width">Box Width (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-corr-width-minus" aria-label="Decrease box width">−</button>
            <input type="number" id="insp-corr-width" class="stepper-input" value="${corrW}" min="15" max="120">
            <button type="button" class="stepper-btn" id="insp-corr-width-plus" aria-label="Increase box width">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-corr-height">Box Height (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-corr-height-minus" aria-label="Decrease box height">−</button>
            <input type="number" id="insp-corr-height" class="stepper-input" value="${corrH}" min="3" max="40">
            <button type="button" class="stepper-btn" id="insp-corr-height-plus" aria-label="Increase box height">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-row-gap">Row Spacing (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-row-gap-minus" aria-label="Decrease row spacing">−</button>
            <input type="number" id="insp-row-gap" class="stepper-input" value="${zone.rowGap ?? 2}" min="0" max="50">
            <button type="button" class="stepper-btn" id="insp-row-gap-plus" aria-label="Increase row spacing">+</button>
          </div>
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
        <button type="button" class="btn btn--secondary btn--sm" id="insp-btn-pull-vacant" style="width: 100%; margin-top: 0.4rem;" title="Switch side to fill vacant column space">
          ⇄ Move to Opposite / Vacant Side
        </button>
      </div>
    `;
  } else if (zone.type === 'student_id') {
    const isShading = zone.shading !== false && zone.mode !== 'ocr' && zone.mode !== 'digits';

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Zone Title</label>
        <input type="text" id="insp-label" class="form-input" value="${safeEscapeHTML(zone.label || '')}">
      </div>

      <div class="form-group">
        <label class="form-label">Recognition Mode</label>
        <div class="pills-group" id="insp-sid-mode">
          <button type="button" class="pill-btn ${isShading ? 'is-active' : ''}" data-mode="shading">Bubble Grid (OMR)</button>
          <button type="button" class="pill-btn ${!isShading ? 'is-active' : ''}" data-mode="ocr">Handwritten Digits (OCR)</button>
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
        <input type="text" id="insp-label" class="form-input" value="${safeEscapeHTML(zone.label || '')}" placeholder="(Leave blank to hide heading)">
      </div>

      <div class="form-group">
        <label class="form-label">Included Fields</label>
        <div class="checkbox-grid">
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-name" ${hasField('name') ? 'checked' : ''}>
            <span>Name</span>
          </label>
          <label class="field-checkbox-label">
            <input type="checkbox" id="field-sid" ${hasSidField ? 'checked' : ''}>
            <span>ID no. (8 Digits)</span>
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
        <div class="form-row" style="margin-top: 0.6rem;">
          <div class="form-group">
            <label class="form-label" for="insp-row-gap">Row Spacing (mm)</label>
            <div class="stepper-control">
              <button type="button" class="stepper-btn" id="insp-row-gap-minus" aria-label="Decrease row spacing">−</button>
              <input type="number" id="insp-row-gap" class="stepper-input" value="${zone.rowGap ?? zone.gapY ?? 2}" min="0" max="50">
              <button type="button" class="stepper-btn" id="insp-row-gap-plus" aria-label="Increase row spacing">+</button>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
    const defaultPts = zone.type === 'text_essay' ? 5 : 1;
    const defaultH = zone.type === 'text_essay' ? 35 : (zone.type === 'text_short' ? 10 : 12);
    const count = zone.count ?? 1;
    const cols = zone.columns ?? 1;
    const startVal = zone.start ?? state.layout?.zones?.[idx]?.start ?? state.layout?.zones?.[idx]?.items?.[0]?.q ?? 1;
    const autoW = state.layout?.zones?.[idx]?.items?.[0]?.boxW ?? state.layout?.zones?.[idx]?.rois?.[0]?.w;
    const maxBoxW = state.layout?.zones?.[idx]?.maxBoxW ?? (cols === 2 ? 84 : 176);
    const boxWidthVal = zone.boxWidth ?? '';
    const boxWidthPlaceholder = autoW ? `Auto (${Math.round(autoW)}mm)` : (zone.type === 'text_essay' ? 'Auto (176mm)' : 'Auto (83mm)');
    const ptsVal = zone.pointsPerItem ?? zone.points ?? state.layout?.zones?.[idx]?.pointsPerItem ?? defaultPts;
    const rowGapVal = zone.rowGap ?? state.layout?.zones?.[idx]?.rowGap ?? 3;

    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-label">Section Title</label>
        <input type="text" id="insp-label" class="form-input" value="${safeEscapeHTML(zone.label || '')}">
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-count">Questions</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-count-minus" aria-label="Decrease question count">−</button>
            <input type="number" id="insp-count" class="stepper-input" value="${count}" min="1" max="50">
            <button type="button" class="stepper-btn" id="insp-count-plus" aria-label="Increase question count">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-start">Start No.</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-start-minus" aria-label="Decrease start number">−</button>
            <input type="number" id="insp-start" class="stepper-input" value="${startVal}" min="1" max="999">
            <button type="button" class="stepper-btn" id="insp-start-plus" aria-label="Increase start number">+</button>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Columns</label>
        <div class="pills-group" id="insp-cols-pills">
          <button type="button" class="pill-btn ${cols === 1 ? 'is-active' : ''}" data-cols="1">1 Col</button>
          <button type="button" class="pill-btn ${cols === 2 ? 'is-active' : ''}" data-cols="2">2 Cols</button>
          <button type="button" class="pill-btn ${cols === 3 ? 'is-active' : ''}" data-cols="3">3 Cols</button>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-box-width">Box Width (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-box-width-minus" aria-label="Decrease box width">−</button>
            <input type="number" id="insp-box-width" class="stepper-input" value="${boxWidthVal}" placeholder="${boxWidthPlaceholder}" min="12" max="${maxBoxW}">
            <button type="button" class="stepper-btn" id="insp-box-width-plus" aria-label="Increase box width">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-box-height">Box Height (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-box-height-minus" aria-label="Decrease box height">−</button>
            <input type="number" id="insp-box-height" class="stepper-input" value="${zone.boxHeight ?? defaultH}" min="3" max="120">
            <button type="button" class="stepper-btn" id="insp-box-height-plus" aria-label="Increase box height">+</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="insp-points">Pts / Item</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-points-minus" aria-label="Decrease points">−</button>
            <input type="number" id="insp-points" class="stepper-input" value="${ptsVal}" min="1" max="50">
            <button type="button" class="stepper-btn" id="insp-points-plus" aria-label="Increase points">+</button>
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-top: -0.25rem; margin-bottom: 0.5rem;">
        <label class="field-checkbox-label">
          <input type="checkbox" id="insp-show-points" ${zone.showPoints !== false ? 'checked' : ''}>
          <span>Show points on sheet</span>
        </label>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="insp-row-gap">Item Spacing (mm)</label>
          <div class="stepper-control">
            <button type="button" class="stepper-btn" id="insp-row-gap-minus" aria-label="Decrease item spacing">−</button>
            <input type="number" id="insp-row-gap" class="stepper-input" value="${rowGapVal}" min="0" max="50">
            <button type="button" class="stepper-btn" id="insp-row-gap-plus" aria-label="Increase item spacing">+</button>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
        <button type="button" class="btn btn--secondary btn--sm" id="insp-btn-pull-vacant" style="width: 100%; margin-top: 0.4rem;" title="Switch side to fill vacant column space">
          ⇄ Move to Opposite / Vacant Side
        </button>
      </div>
    `;
  } else if (zone.type === 'instructions') {
    formHtml += `
      <div class="form-group">
        <label class="form-label" for="insp-text">Instructions Text</label>
        <textarea id="insp-text" class="form-textarea" rows="4">${safeEscapeHTML(zone.text || '')}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Font Size</label>
        <div class="pills-group" id="insp-font-pills">
          <button type="button" class="pill-btn ${zone.fontSize <= 2.4 ? 'is-active' : ''}" data-size="2.4">Compact (2.4mm)</button>
          <button type="button" class="pill-btn ${zone.fontSize > 2.4 && zone.fontSize <= 2.8 ? 'is-active' : ''}" data-size="2.8">Normal (2.8mm)</button>
          <button type="button" class="pill-btn ${zone.fontSize > 2.8 ? 'is-active' : ''}" data-size="3.2">Large (3.2mm)</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Module Page Placement</label>
        <div class="pills-group" id="insp-placement-pills">
          <button type="button" class="pill-btn ${(!zone.layout && !zone.side && !zone.inline) || zone.layout === 'full' ? 'is-active' : ''}" data-placement="full">Full Width</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-left' || zone.side === 'left' ? 'is-active' : ''}" data-placement="left">Side-by-Side (Left)</button>
          <button type="button" class="pill-btn ${zone.layout === 'half-right' || zone.side === 'right' || zone.inline ? 'is-active' : ''}" data-placement="right">Side-by-Side (Right)</button>
        </div>
        <button type="button" class="btn btn--secondary btn--sm" id="insp-btn-pull-vacant" style="width: 100%; margin-top: 0.4rem;" title="Switch side to fill vacant column space">
          ⇄ Move to Opposite / Vacant Side
        </button>
      </div>
    `;
  }

  els.inspectorContent.innerHTML = formHtml;
  bindInspectorEvents(zone);
}

// Sync points per item to answer key items if answer key exists
function syncZonePointsToAnswerKey(zone, pts) {
  const ptsNum = Number(pts);
  if (!Number.isFinite(ptsNum)) return;

  const updateMap = (itemsMap, key) => {
    if (!itemsMap || !key) return;
    const strKey = String(key);
    if (itemsMap[strKey]) {
      if (typeof itemsMap[strKey] === 'object' && itemsMap[strKey] !== null) {
        itemsMap[strKey].points = ptsNum;
      } else {
        itemsMap[strKey] = { answer: itemsMap[strKey], points: ptsNum };
      }
    }
  };

  const count = zone.count ?? 1;
  const start = zone.start ?? state.layout?.zones?.find((z) => z.id === zone.id)?.start ?? 1;
  const keys = [];
  for (let i = 0; i < count; i++) {
    keys.push(String(start + i));
    if (zone.id) {
      keys.push(`${zone.id}_roi_${i + 1}`);
      keys.push(`${zone.id}.${start + i}`);
    }
  }

  const targets = [
    state.template?.answerKey?.items,
    currentAnswerKey?.items,
  ];

  for (const t of targets) {
    if (!t) continue;
    for (const k of keys) {
      updateMap(t, k);
    }
  }
}

// Stepper input binding helper
function bindStepper(idPrefix, getter, setter, min = 1, max = 999) {
  const input = $(`#${idPrefix}`);
  const minus = $(`#${idPrefix}-minus`);
  const plus = $(`#${idPrefix}-plus`);
  if (!input) return;

  const getBaseVal = () => {
    const raw = parseInt(input.value, 10);
    if (!Number.isNaN(raw)) return raw;
    if (getter) {
      const g = getter();
      if (g != null && !Number.isNaN(Number(g))) return Number(g);
    }
    return min;
  };

  const clampAndSet = (val, skipInspector = true) => {
    let num = parseInt(val, 10);
    if (Number.isNaN(num)) num = getBaseVal();
    num = Math.max(min, Math.min(max, num));
    input.value = num;
    setter(num, skipInspector);
  };

  minus?.addEventListener('click', () => clampAndSet(getBaseVal() - 1, true));
  plus?.addEventListener('click', () => clampAndSet(getBaseVal() + 1, true));
  input.addEventListener('input', () => {
    if (input.value.trim() === '') {
      setter(undefined, true);
    } else {
      let num = parseInt(input.value, 10);
      if (!Number.isNaN(num)) {
        num = Math.max(min, Math.min(max, num));
        setter(num, true);
      }
    }
  });
  input.addEventListener('change', () => {
    if (input.value.trim() === '') {
      setter(undefined, false);
    } else {
      clampAndSet(input.value, false);
    }
  });
}

function syncZoneRangeInLabel(zone, idx) {
  if (!zone || !zone.label) return;
  const count = zone.count ?? 1;
  const start = zone.start ?? state.layout?.zones?.[idx]?.start ?? 1;
  const end = start + count - 1;
  const rangePattern = /\(\s*\d+\s*[–-]\s*\d+\s*\)/;
  if (rangePattern.test(zone.label)) {
    zone.label = zone.label.replace(rangePattern, `(${start}–${end})`);
    const inspLabel = $('#insp-label');
    if (inspLabel && state.selectedZoneIndex === idx) inspLabel.value = zone.label;
    const inspHeaderTitle = $('.inspector-header__title');
    if (inspHeaderTitle && state.selectedZoneIndex === idx) inspHeaderTitle.textContent = zone.label;
    const outlineTitle = document.querySelector(`.outline-item[data-zone-index="${idx}"] .outline-item__title`);
    if (outlineTitle) outlineTitle.textContent = zone.label;
  }
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
      const inspHeaderTitle = $('.inspector-header__title');
      if (inspHeaderTitle) {
        inspHeaderTitle.textContent = zone.label || (ZONE_TYPE_NAMES[zone.type] || zone.type);
      }
      update({ skipInspector: true });
      const outlineTitle = document.querySelector(`.outline-item[data-zone-index="${idx}"] .outline-item__title`);
      if (outlineTitle) outlineTitle.textContent = zone.label || (ZONE_TYPE_NAMES[zone.type] || zone.type);
    });
    labelInput.addEventListener('change', () => {
      update();
    });
  }

  // Count & Start & Points steppers
  if (['mcq', 'truefalse', 'modified_tf', 'text_short', 'text_essay', 'text'].includes(zone.type)) {
    bindStepper(
      'insp-count',
      () => zone.count ?? 1,
      (val, skip) => {
        zone.count = val ?? 1;
        syncZoneRangeInLabel(zone, idx);
        update({ skipInspector: skip });
      },
      1,
      100,
    );
    bindStepper(
      'insp-start',
      () => zone.start ?? state.layout?.zones?.[idx]?.start ?? state.layout?.zones?.[idx]?.items?.[0]?.q ?? 1,
      (val, skip) => {
        zone.start = val ?? 1;
        syncZoneRangeInLabel(zone, idx);
        update({ skipInspector: skip });
      },
      1,
      999,
    );
    bindStepper(
      'insp-points',
      () => zone.pointsPerItem ?? zone.points ?? state.layout?.zones?.[idx]?.pointsPerItem ?? (zone.type === 'modified_tf' ? 2 : (zone.type === 'text_essay' ? 5 : 1)),
      (val, skip) => {
        const pts = val ?? 1;
        zone.pointsPerItem = pts;
        zone.points = pts;
        const count = zone.count ?? 1;
        const ptsPattern = /\(\s*\d+(\.\d+)?\s*(?:pts?|points?)(?:\s+each)?\s*\)/i;
        if (zone.label && ptsPattern.test(zone.label)) {
          const suffix = `(${pts} pt${pts === 1 ? '' : 's'}${count > 1 ? ' each' : ''})`;
          zone.label = zone.label.replace(ptsPattern, suffix);
          const inspLabel = $('#insp-label');
          if (inspLabel) inspLabel.value = zone.label;
          const inspHeaderTitle = $('.inspector-header__title');
          if (inspHeaderTitle) inspHeaderTitle.textContent = zone.label;
          const outlineTitle = document.querySelector(`.outline-item[data-zone-index="${idx}"] .outline-item__title`);
          if (outlineTitle) outlineTitle.textContent = zone.label;
        }
        syncZonePointsToAnswerKey(zone, pts);
        update({ skipInspector: skip });
      },
      1,
      50,
    );

    // Show / Hide Points per item on the paper
    const showPtsEl = $('#insp-show-points');
    if (showPtsEl) {
      showPtsEl.addEventListener('change', (e) => {
        zone.showPoints = e.target.checked;
        if (!e.target.checked && zone.label) {
          const ptsPattern = /\s*\(\s*\d+(\.\d+)?\s*(?:pts?|points?)(?:\s+each)?\s*\)/i;
          if (ptsPattern.test(zone.label)) {
            zone.label = zone.label.replace(ptsPattern, '').trim();
            const inspLabel = $('#insp-label');
            if (inspLabel) inspLabel.value = zone.label;
            const inspHeaderTitle = $('.inspector-header__title');
            if (inspHeaderTitle) inspHeaderTitle.textContent = zone.label;
            const outlineTitle = document.querySelector(`.outline-item[data-zone-index="${idx}"] .outline-item__title`);
            if (outlineTitle) outlineTitle.textContent = zone.label;
          }
        }
        update({ skipInspector: true });
      });
    }
  }

  // Spacing between items/rows stepper
  if (['mcq', 'truefalse', 'modified_tf', 'text_short', 'text_essay', 'text', 'fields'].includes(zone.type)) {
    const defaultGap = (zone.type === 'mcq' || zone.type === 'truefalse') ? 1 : (zone.type === 'modified_tf' ? 2 : (zone.type === 'fields' ? 2 : 3));
    bindStepper(
      'insp-row-gap',
      () => zone.rowGap ?? (zone.type === 'fields' ? (zone.gapY ?? defaultGap) : defaultGap),
      (val, skip) => {
        const gap = val ?? defaultGap;
        zone.rowGap = gap;
        if (zone.type === 'fields') zone.gapY = gap;
        update({ skipInspector: skip });
      },
      0,
      50,
    );
  }

  // Box dimensions & Columns for text zones
  if (['text_short', 'text_essay', 'text'].includes(zone.type)) {
    const maxBoxW = state.layout?.zones?.[idx]?.maxBoxW ?? (zone.type === 'text_essay' ? 176 : 190);
    bindStepper(
      'insp-box-width',
      () => {
        if (zone.boxWidth != null) return zone.boxWidth;
        const autoW = state.layout?.zones?.[idx]?.items?.[0]?.boxW ?? state.layout?.zones?.[idx]?.rois?.[0]?.w;
        if (autoW != null) return Math.round(autoW);
        return zone.type === 'text_essay' ? 170 : 45;
      },
      (val, skip) => {
        if (val === undefined) {
          delete zone.boxWidth;
        } else {
          zone.boxWidth = val;
        }
        update({ skipInspector: skip });
      },
      12,
      maxBoxW,
    );
    bindStepper('insp-box-height', () => zone.boxHeight ?? (zone.type === 'text_essay' ? 35 : (zone.type === 'text_short' ? 10 : 12)), (val, skip) => { zone.boxHeight = val ?? (zone.type === 'text_essay' ? 35 : 10); update({ skipInspector: skip }); }, 3, 120);

    const colsPills = $$('#insp-cols-pills .pill-btn');
    for (const pill of colsPills) {
      pill.addEventListener('click', () => {
        zone.columns = parseInt(pill.dataset.cols, 10) || 1;
        renderInspector();
        update();
      });
    }
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

  // Switch side / pull to vacant column button
  $('#insp-btn-pull-vacant')?.addEventListener('click', () => {
    if (zone.layout === 'half-left' || zone.side === 'left') {
      zone.layout = 'half-right';
      zone.side = 'right';
    } else {
      zone.layout = 'half-left';
      zone.side = 'left';
    }
    delete zone.inline;
    delete zone.w;
    renderInspector();
    update();
  });

  // Split written answer into multiple modules
  $('#insp-btn-split-modules')?.addEventListener('click', () => {
    const input = prompt('How many separate question modules would you like to create for this section?', '3');
    if (!input) return;
    const num = Math.max(2, Math.min(20, parseInt(input, 10) || 3));
    const basePts = zone.points ?? (zone.type === 'text_essay' ? 5 : 1);
    const baseH = zone.boxHeight ?? (zone.type === 'text_essay' ? 45 : 12);
    const baseCharset = zone.charset ?? 'any';
    const baseType = zone.type;

    const newZones = [];
    for (let i = 0; i < num; i++) {
      newZones.push({
        type: baseType,
        id: uid(baseType === 'text_essay' ? 'essay' : 'short'),
        label: `Question ${i + 1}`,
        boxHeight: baseH,
        points: basePts,
        charset: baseCharset,
        layout: i % 2 === 0 ? 'half-left' : 'half-right',
        side: i % 2 === 0 ? 'left' : 'right',
      });
    }
    state.template.zones.splice(idx, 1, ...newZones);
    state.selectedZoneIndex = idx;
    renderInspector();
    update();
  });

  // Modified T/F correction box width and height
  if (zone.type === 'modified_tf') {
    bindStepper(
      'insp-corr-width',
      () => zone.boxWidth ?? zone.correctionWidth ?? zone.corrWidth ?? 42,
      (val, skip) => {
        const w = val ?? 42;
        zone.boxWidth = w;
        zone.corrWidth = w;
        zone.correctionWidth = w;
        update({ skipInspector: skip });
      },
      15,
      120
    );
    bindStepper(
      'insp-corr-height',
      () => zone.boxHeight ?? zone.fieldHeight ?? 6,
      (val, skip) => {
        const h = val ?? 6;
        zone.boxHeight = h;
        zone.fieldHeight = h;
        update({ skipInspector: skip });
      },
      3,
      40
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
        update({ skipInspector: true });
      });
      customChoicesInput.addEventListener('change', () => {
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
  if (['mcq', 'truefalse', 'modified_tf'].includes(zone.type)) {
    const colPills = $$('#insp-cols-pills .pill-btn');
    for (const pill of colPills) {
      pill.addEventListener('click', () => {
        const colVal = pill.dataset.cols ? parseInt(pill.dataset.cols, 10) : null;
        if (colVal) zone.columns = colVal;
        else delete zone.columns;
        update();
      });
    }
  }

  if (zone.type === 'fields' || zone.type === 'student_id') {
    delete zone.columns;
    delete zone.layout;
    delete zone.side;
    delete zone.inline;
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
      // Row 0: Name & ID no. (always standardized to 8 digits)
      if (nameCb?.checked) fields.push({ id: 'name', label: 'Name', role: 'name', row: 0, w: 108 });
      if (sidCb?.checked) fields.push({ id: 'sid', label: 'ID no.', role: 'student_id', digits: 8, row: 0, w: 75 });
      // Row 1: Offer No., Sched, Date, Score
      if (offerCb?.checked) fields.push({ id: 'offer', label: 'Offer No.', row: 1, w: 48 });
      if (schedCb?.checked) fields.push({ id: 'sched', label: 'Sched', row: 1, w: 52 });
      if (dateCb?.checked) fields.push({ id: 'date', label: 'Date', row: 1, w: 43 });
      if (scoreCb?.checked) fields.push({ id: 'score', label: 'Score', role: 'score', row: 1, w: 40 });
      if (sigCb?.checked) fields.push({ id: 'signature', label: 'Signature', ocr: false, row: 1, w: 45 });
      if (fields.length === 0) fields.push({ id: 'name', label: 'Name', role: 'name', row: 0, w: 108 });
      zone.fields = fields;
      update();
    };

    [nameCb, sidCb, offerCb, schedCb, dateCb, scoreCb, sigCb].forEach((cb) => cb?.addEventListener('change', updateFields));
  }

  // Text / Written Answer properties (text, text_short, text_essay)
  if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
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
      update({ skipInspector: true });
    });
    textInput.addEventListener('change', () => {
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
  const ZONE_SVGS = {
    student_id: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    fields: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    mcq: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
    truefalse: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
    modified_tf: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    text: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    text_short: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    text_essay: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    instructions: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  const typeNames = ZONE_TYPE_NAMES;

  els.outlineList.innerHTML = zones
    .map((z, i) => {
      const isSel = i === state.selectedZoneIndex;
      const countMeta = z.count ? `${z.count} items` : z.digits ? `${z.digits} digits` : z.points ? `${z.points} pts` : '';
      return `
        <div class="outline-item ${isSel ? 'is-selected' : ''}" data-index="${i}" draggable="true">
          <span class="outline-item__grip" title="Drag to reorder">⠿</span>
          <span class="outline-item__icon" aria-hidden="true">${ZONE_SVGS[z.type] || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>'}</span>
          <div class="outline-item__info">
            <div class="outline-item__title">${safeEscapeHTML(z.label || typeNames[z.type])}</div>
            <div class="outline-item__meta">${safeEscapeHTML(typeNames[z.type])}${countMeta ? ` · ${countMeta}` : ''}</div>
          </div>
          <div class="outline-item__actions">
            <button type="button" class="btn-mini-arrow btn-outline-up" data-index="${i}" title="Move Up" ${i === 0 ? 'disabled' : ''}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg></button>
            <button type="button" class="btn-mini-arrow btn-outline-down" data-index="${i}" title="Move Down" ${i === zones.length - 1 ? 'disabled' : ''}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></button>
            <button type="button" class="btn-mini-arrow btn-outline-dup" data-index="${i}" title="Duplicate"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="13" height="13" x="9" y="9" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
            <button type="button" class="btn-mini-trash btn-outline-del" data-index="${i}" title="Delete"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
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

  els.outlineList.querySelectorAll('.btn-outline-dup').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      duplicateZone(idx);
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
  const totalQ = stats.totalQuestions ?? (stats.questions + (stats.textQuestions || 0));
  els.statQuestions.textContent = String(totalQ);

  // Total points calculation
  let totalPts = 0;
  for (const g of allGroups(layout)) {
    if (g.kind === 'mcq' || g.kind === 'tf') totalPts += Number(g.points != null ? g.points : 1);
  }
  for (const r of layout.zones.flatMap((z) => z.rois)) {
    if (r.graded) totalPts += Number(r.points != null ? r.points : 1);
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
function update(options = {}) {
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

  // Two-way sync to raw JSON textarea and storage (avoid disrupting active typing)
  const serialized = JSON.stringify(state.template, null, 2);
  if (els.rawJson && document.activeElement !== els.rawJson) {
    els.rawJson.value = serialized;
  }
  localStorage.setItem(STORAGE_KEY, serialized);

  // Header input sync (avoid resetting cursor while typing in exam title)
  if (els.examTitle && document.activeElement !== els.examTitle && els.examTitle.value !== state.template.title) {
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
    if (!options.skipInspector) {
      renderInspector();
    }
  } else if (state.activeTab === 'outline') {
    renderOutline();
  }
}

// ---- Modal Open/Close Utilities ----
function openModal(modalEl) {
  if (!modalEl) return;
  if (typeof modalEl.showModal === 'function') {
    try {
      if (!modalEl.open) {
        modalEl.showModal();
        return;
      }
    } catch {}
  }
  modalEl.setAttribute('open', '');
}

function closeModal(modalEl) {
  if (!modalEl) return;
  if (typeof modalEl.close === 'function') {
    try {
      if (modalEl.open) {
        modalEl.close();
        return;
      }
    } catch {}
  }
  modalEl.removeAttribute('open');
}

// ---- Bloom's Taxonomy Cognitive Domain Utilities [Anderson & Krathwohl, 2001] ----
const BLOOM_LEVELS = ['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'];

function normalizeBloom(val) {
  if (!val || typeof val !== 'string') return 'Remember';
  const clean = val.trim().toLowerCase();
  if (clean.startsWith('rem') || clean.startsWith('rec') || clean === 'knowledge' || clean === '1') return 'Remember';
  if (clean.startsWith('und') || clean.startsWith('com') || clean === 'comprehension' || clean === '2') return 'Understand';
  if (clean.startsWith('app') || clean === 'application' || clean === '3') return 'Apply';
  if (clean.startsWith('ana') || clean === 'analysis' || clean === '4') return 'Analyze';
  if (clean.startsWith('eva') || clean === 'evaluation' || clean === '5') return 'Evaluate';
  if (clean.startsWith('cre') || clean.startsWith('syn') || clean === 'synthesis' || clean === 'creation' || clean === '6') return 'Create';
  return 'Remember';
}

function defaultBloomFor(k) {
  const num = parseInt(k, 10);
  if (!isNaN(num) && num > 0) {
    return BLOOM_LEVELS[(num - 1) % BLOOM_LEVELS.length];
  }
  return 'Remember';
}

// ---- Interactive Answer Key Editor UI ----
const currentAnswerKey = {
  items: {},
  passScore: 0,
};

function getActiveAnswerKeyPayload() {
  const layout = state.layout;
  if (!layout) return null;
  let totalPoints = 0;
  const itemsPayload = {};
  for (const [key, item] of Object.entries(currentAnswerKey.items)) {
    totalPoints += Number(item.points != null ? item.points : 1);
    itemsPayload[key] = {
      ...item,
      points: Number(item.points != null ? item.points : 1),
      bloom: item.bloom || defaultBloomFor(key),
    };
  }
  return {
    title: `${layout.title || 'Exam'} Answer Key`,
    templateId: layout.templateId,
    exam_id: layout.templateId,
    total_points: totalPoints,
    pass_score: currentAnswerKey.passScore ?? Math.round(totalPoints * 0.6),
    items: itemsPayload,
  };
}

function downloadCurrentAnswerKey() {
  const payload = getActiveAnswerKeyPayload();
  if (!payload) return;
  download(`${state.layout?.templateId || 'exam'}-answer-key.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
}

function downloadCurrentAnswerKeyCSV() {
  const rows = ['Item #,Answer,Points,Bloom'];
  const sortedKeys = Object.keys(currentAnswerKey.items).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
  for (const k of sortedKeys) {
    const it = currentAnswerKey.items[k];
    const ans = String(it.answer || '');
    const formattedAns = ans.includes(',') || ans.includes('"') ? `"${ans.replace(/"/g, '""')}"` : ans;
    rows.push(`${k},${formattedAns},${it.points ?? 1},${it.bloom || defaultBloomFor(k)}`);
  }
  const baseId = state.layout?.templateId || 'exam';
  download(`${baseId}-answer-key.csv`, rows.join('\n') + '\n', 'text/csv');
}

function openAnswerKeyModal() {
  const layout = state.layout;
  if (!layout) return;

  currentAnswerKey.items = {};
  const existingKey = state.template?.answerKey?.items || {};

  // 1. MCQ and True/False bubbles
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
      const existingBloom = typeof existing === 'object' && existing !== null ? existing.bloom : null;

      currentAnswerKey.items[g.key] = {
        answer: existingAns ?? defaultAns,
        points: existingPts ?? Number(g.points != null ? g.points : 1),
        bloom: normalizeBloom(existingBloom || defaultBloomFor(g.key)),
        kind: g.kind,
        options: g.options.map((o) => o.value),
        label: g.label || g.key,
      };
    }
  }

  // 2. Graded handwriting OCR boxes (modified_tf correction, short answer, essay)
  const candidateRois = [];
  const seenRoiKeys = new Set();
  for (const r of [...layout.zones.flatMap((z) => z.rois || []), ...(layout.rois || [])]) {
    const rk = String(r.key || r.id);
    if (r.graded !== false && r.role !== 'name' && r.role !== 'student_id' && r.role !== 'score' && r.role !== 'signature' && !seenRoiKeys.has(rk)) {
      seenRoiKeys.add(rk);
      candidateRois.push(r);
    }
  }

  for (const roi of candidateRois) {
    const rKey = String(roi.key || roi.id);
    const existing = existingKey[rKey] ?? existingKey[String(roi.key)];
    const defaultAns = roi.role === 'correction' ? 'Correction' : 'Sample Answer';
    const existingAns = typeof existing === 'object' && existing !== null && existing.answer !== undefined
      ? existing.answer
      : (typeof existing === 'string' || typeof existing === 'number' ? String(existing) : null);
    const existingPts = typeof existing === 'object' && existing !== null && existing.points !== undefined
      ? Number(existing.points)
      : null;
    const existingBloom = typeof existing === 'object' && existing !== null ? existing.bloom : null;

    currentAnswerKey.items[rKey] = {
      answer: existingAns ?? defaultAns,
      points: existingPts ?? Number(roi.points != null ? roi.points : 1),
      bloom: normalizeBloom(existingBloom || defaultBloomFor(rKey)),
      kind: 'text',
      rubric: roi.charset === 'digits' ? 'exact' : 'case_insensitive',
      label: roi.label || rKey,
    };
  }

  // Discover any pre-existing text or custom items from existing key
  for (const [k, it] of Object.entries(existingKey)) {
    if (!currentAnswerKey.items[k]) {
      const ans = typeof it === 'object' && it !== null && it.answer !== undefined
        ? it.answer
        : (typeof it === 'string' || typeof it === 'number' ? String(it) : 'Sample Answer');
      const pts = typeof it === 'object' && it !== null && it.points !== undefined
        ? Number(it.points)
        : 1;
      const bloom = typeof it === 'object' && it !== null && it.bloom
        ? normalizeBloom(it.bloom)
        : defaultBloomFor(k);
      const isTF = it && (it.kind === 'tf' || it.answer === 'T' || it.answer === 'F');
      const isSingleLetter = /^[A-E]$/i.test(String(ans));
      const isText = it && (it.kind === 'text' || it.type === 'written' || it.type === 'short_answer' || it.type === 'essay' || it.correction || (!isSingleLetter && !isTF));
      currentAnswerKey.items[k] = {
        answer: ans,
        points: pts,
        bloom: normalizeBloom(bloom),
        kind: isText ? 'text' : (isTF ? 'tf' : 'mcq'),
        options: it.options || (isTF ? ['T', 'F'] : (isText ? null : ['A', 'B', 'C', 'D'])),
        label: it.label || k,
      };
    }
  }

  const totalPoints = Object.values(currentAnswerKey.items).reduce((s, it) => s + Number(it.points != null ? it.points : 1), 0);
  currentAnswerKey.passScore = state.template?.answerKey?.pass_score ?? Math.round(totalPoints * 0.6);
  if (state.template?.answerKey?.pass_score !== undefined && els.keyPassingInput) {
    els.keyPassingInput.dataset.userEdited = 'true';
  }

  renderAnswerKeyModalContent();
  openModal(els.modalAnswerKey);
}

function renderAnswerKeyModalContent() {
  if (!els.keyItemsContainer) return;
  const layout = state.layout;
  if (!layout) return;

  const totalItems = Object.keys(currentAnswerKey.items).length;
  let totalPoints = 0;
  for (const it of Object.values(currentAnswerKey.items)) {
    totalPoints += Number(it.points != null ? it.points : 1);
  }

  if (els.keyMetricCount) els.keyMetricCount.textContent = String(totalItems);
  if (els.keyMetricPoints) els.keyMetricPoints.textContent = String(totalPoints);
  if (els.keyPassingInput) {
    els.keyPassingInput.value = currentAnswerKey.passScore;
  }

  if (totalItems === 0) {
    els.keyItemsContainer.innerHTML = `
      <div class="empty-library">
        <p>No gradable questions found on the current exam sheet.</p>
        <p class="empty-sub">Add Multiple Choice, True/False, or Short Answer blocks from the palette to configure correct answers.</p>
      </div>
    `;
    return;
  }

  // Preflight discrepancy check between sheet and key
  const sheetItemKeys = new Set();
  const sheetItemsMeta = {};
  for (const zone of layout.zones) {
    for (const g of zone.groups.filter((g) => g.kind === 'mcq' || g.kind === 'tf')) {
      sheetItemKeys.add(String(g.key));
      sheetItemsMeta[String(g.key)] = { kind: g.kind, options: g.options.map((o) => o.value) };
    }
    for (const r of (zone.rois || []).filter((r) => r.graded !== false && r.role !== 'name' && r.role !== 'student_id' && r.role !== 'score' && r.role !== 'signature')) {
      sheetItemKeys.add(String(r.key));
      sheetItemsMeta[String(r.key)] = { kind: 'text', label: r.label || r.key };
    }
  }

  const missingInKey = [];
  for (const k of sheetItemKeys) {
    if (!currentAnswerKey.items[k] || !currentAnswerKey.items[k].answer) {
      missingInKey.push(k);
    }
  }

  const extraInKey = [];
  for (const k of Object.keys(currentAnswerKey.items)) {
    if (!sheetItemKeys.has(k)) {
      extraInKey.push(k);
    }
  }

  let discrepancyHtml = '';
  if (missingInKey.length > 0 || extraInKey.length > 0) {
    let msg = '';
    if (missingInKey.length > 0) {
      msg += `<strong>${missingInKey.length} questions</strong> on sheet have no answer set (${missingInKey.slice(0, 4).map(safeEscapeHTML).join(', ')}${missingInKey.length > 4 ? '...' : ''}). Unkeyed questions will score 0 pts. `;
    }
    if (extraInKey.length > 0) {
      msg += `Key contains ${extraInKey.length} extra items (${extraInKey.slice(0, 3).map(safeEscapeHTML).join(', ')}) not on current sheet. `;
    }
    discrepancyHtml = `
      <div class="key-discrepancy-banner" id="key-discrepancy-banner">
        <div>
          <span style="font-weight: 700;">⚠️ Exam Sheet &amp; Key Discrepancy:</span>
          <span>${msg}</span>
        </div>
        <button type="button" class="btn btn--secondary btn-xs" id="btn-sync-key-sheet" title="Auto-fill default answers for all sheet questions and remove orphaned items">
          Auto-Sync with Sheet
        </button>
      </div>
    `;
  }

  const renderedKeys = new Set();
  let html = discrepancyHtml;
  for (const zone of layout.zones) {
    const zoneGroups = zone.groups.filter((g) => g.kind === 'mcq' || g.kind === 'tf');
    const zoneRois = (zone.rois || []).filter((r) => r.graded !== false && r.role !== 'name' && r.role !== 'student_id' && r.role !== 'score' && r.role !== 'signature');

    if (zoneGroups.length === 0 && zoneRois.length === 0) continue;

    const defaultTitle = zone.type === 'text_essay' ? 'Essay / Discussion Questions' : (zone.type === 'text_short' || zone.type === 'text' ? 'Short Answer / Identification' : zone.type.toUpperCase());
    const zoneTitle = zone.label || defaultTitle;
    const zoneCols = Math.min(3, Math.max(1, zone.columns ? Math.min(3, zone.columns) : 2));

    html += `
      <div class="key-section-card">
        <h4 class="key-section-title">${safeEscapeHTML(zoneTitle)}</h4>
    `;

    if (zoneGroups.length > 0) {
      html += `<div class="key-matrix-grid" style="column-count: ${zoneCols};">`;
      for (const g of zoneGroups) {
        renderedKeys.add(String(g.key));
        const item = currentAnswerKey.items[g.key];
        if (!item) continue;
        const opts = item.options || ['A', 'B', 'C', 'D'];
        const currentAns = String(item.answer || '');
        const currentBloom = item.bloom || defaultBloomFor(g.key);

        html += `
          <div class="key-item-cell" data-key="${g.key}">
            <div style="display: flex; align-items: center; gap: 0.35rem; min-width: 0;">
              <span class="key-item-num">${g.key}</span>
              <div class="key-bubbles-row">
                ${opts
                  .map((opt) => `
                    <button type="button" class="key-bubble-btn ${currentAns === opt ? 'is-active' : ''}" data-key="${g.key}" data-val="${opt}">${opt}</button>
                  `)
                  .join('')}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 0.3rem; flex-shrink: 0;">
              <select class="key-bloom-select" data-key="${g.key}" title="Bloom's Cognitive Level">
                ${BLOOM_LEVELS.map((lvl) => `<option value="${lvl}" ${currentBloom === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
              </select>
              <input type="number" class="key-pts-input" data-key="${g.key}" value="${item.points}" min="0.5" max="50" step="0.5" title="Points">
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    if (zoneRois.length > 0) {
      html += `<div class="key-text-items-list" style="${zoneGroups.length > 0 ? 'margin-top: 0.6rem;' : ''}">`;
      for (const roi of zoneRois) {
        const rKey = String(roi.key || roi.id);
        renderedKeys.add(rKey);
        renderedKeys.add(String(roi.key));
        const item = currentAnswerKey.items[rKey] || currentAnswerKey.items[roi.key];
        if (!item) continue;
        const ansVal = Array.isArray(item.answer) ? item.answer.join(', ') : String(item.answer || '');
        const currentBloom = item.bloom || defaultBloomFor(rKey);

        html += `
          <div class="key-item-cell key-item-cell--text" data-key="${rKey}">
            <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;">
              <span class="key-item-num" style="min-width: 28px; font-weight: 700;">${safeEscapeHTML(item.label || rKey)}:</span>
              <input type="text" class="key-text-input" data-key="${rKey}" value="${safeEscapeHTML(ansVal)}" placeholder="Accepted answer / keywords">
            </div>
            <div style="display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0;">
              <select class="key-bloom-select" data-key="${rKey}" title="Bloom's Cognitive Level">
                ${BLOOM_LEVELS.map((lvl) => `<option value="${lvl}" ${currentBloom === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
              </select>
              <input type="number" class="key-pts-input" data-key="${rKey}" value="${item.points}" min="0.5" max="50" step="0.5" title="Points">
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    html += `
      </div>
    `;
  }

  // Render any remaining items in key (e.g. custom/extra short answer items)
  const remainingKeys = Object.keys(currentAnswerKey.items).filter((k) => !renderedKeys.has(k));
  if (remainingKeys.length > 0) {
    const remChoice = remainingKeys.filter((k) => currentAnswerKey.items[k].kind !== 'text');
    const remText = remainingKeys.filter((k) => currentAnswerKey.items[k].kind === 'text');

    html += `
      <div class="key-section-card">
        <h4 class="key-section-title">Additional / Custom Questions</h4>
    `;

    if (remChoice.length > 0) {
      html += `<div class="key-matrix-grid" style="column-count: 2;">`;
      for (const k of remChoice) {
        const item = currentAnswerKey.items[k];
        const opts = item.options || ['A', 'B', 'C', 'D'];
        const currentAns = String(item.answer || '');
        const currentBloom = item.bloom || defaultBloomFor(k);
        html += `
          <div class="key-item-cell" data-key="${k}">
            <div style="display: flex; align-items: center; gap: 0.35rem; min-width: 0;">
              <span class="key-item-num">${k}</span>
              <div class="key-bubbles-row">
                ${opts.map((opt) => `<button type="button" class="key-bubble-btn ${currentAns === opt ? 'is-active' : ''}" data-key="${k}" data-val="${opt}">${opt}</button>`).join('')}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 0.3rem; flex-shrink: 0;">
              <select class="key-bloom-select" data-key="${k}" title="Bloom's Cognitive Level">
                ${BLOOM_LEVELS.map((lvl) => `<option value="${lvl}" ${currentBloom === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
              </select>
              <input type="number" class="key-pts-input" data-key="${k}" value="${item.points}" min="0.5" max="50" step="0.5" title="Points">
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    if (remText.length > 0) {
      html += `<div class="key-text-items-list" style="${remChoice.length > 0 ? 'margin-top: 0.6rem;' : ''}">`;
      for (const k of remText) {
        const item = currentAnswerKey.items[k];
        const ansVal = Array.isArray(item.answer) ? item.answer.join(', ') : String(item.answer || '');
        const currentBloom = item.bloom || defaultBloomFor(k);
        html += `
          <div class="key-item-cell key-item-cell--text" data-key="${k}">
            <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;">
              <span class="key-item-num" style="min-width: 28px; font-weight: 700;">${safeEscapeHTML(item.label || k)}:</span>
              <input type="text" class="key-text-input" data-key="${k}" value="${safeEscapeHTML(ansVal)}" placeholder="Accepted answer / keywords">
            </div>
            <div style="display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0;">
              <select class="key-bloom-select" data-key="${k}" title="Bloom's Cognitive Level">
                ${BLOOM_LEVELS.map((lvl) => `<option value="${lvl}" ${currentBloom === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}
              </select>
              <input type="number" class="key-pts-input" data-key="${k}" value="${item.points}" min="0.5" max="50" step="0.5" title="Points">
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  els.keyItemsContainer.innerHTML = html;

  // Bind bubble clicks
  els.keyItemsContainer.querySelectorAll('.key-bubble-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      const val = btn.dataset.val;
      if (currentAnswerKey.items[k]) {
        currentAnswerKey.items[k].answer = val;
        renderAnswerKeyModalContent();
      }
    });
  });

  // Bind Bloom selectors
  els.keyItemsContainer.querySelectorAll('.key-bloom-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const k = sel.dataset.key;
      if (currentAnswerKey.items[k]) {
        currentAnswerKey.items[k].bloom = sel.value;
      }
    });
  });

  // Bind points input changes
  els.keyItemsContainer.querySelectorAll('.key-pts-input').forEach((input) => {
    input.addEventListener('input', () => {
      const k = input.dataset.key;
      const rawVal = parseFloat(input.value);
      const pts = !isNaN(rawVal) ? Math.max(0, rawVal) : 1;
      if (currentAnswerKey.items[k]) {
        currentAnswerKey.items[k].points = pts;
        let newTotal = 0;
        for (const it of Object.values(currentAnswerKey.items)) newTotal += Number(it.points != null ? it.points : 1);
        if (els.keyMetricPoints) els.keyMetricPoints.textContent = String(newTotal);
        if (!els.keyPassingInput?.dataset.userEdited) {
          currentAnswerKey.passScore = Math.round(newTotal * 0.6);
          if (els.keyPassingInput) els.keyPassingInput.value = currentAnswerKey.passScore;
        }
      }
    });
  });

  // Bind text answer changes
  els.keyItemsContainer.querySelectorAll('.key-text-input').forEach((input) => {
    input.addEventListener('input', () => {
      const k = input.dataset.key;
      if (currentAnswerKey.items[k]) {
        currentAnswerKey.items[k].answer = input.value.trim();
      }
    });
  });

  // Bind Auto-Sync with Sheet button
  els.keyItemsContainer.querySelector('#btn-sync-key-sheet')?.addEventListener('click', () => {
    for (const [k, meta] of Object.entries(sheetItemsMeta)) {
      if (!currentAnswerKey.items[k] || !currentAnswerKey.items[k].answer) {
        currentAnswerKey.items[k] = {
          answer: meta.options ? meta.options[0] : 'Answer',
          points: 1,
          bloom: defaultBloomFor(k),
          kind: meta.kind,
          options: meta.options,
          label: meta.label || k,
        };
      }
    }
    for (const k of Object.keys(currentAnswerKey.items)) {
      if (!sheetItemKeys.has(k)) {
        delete currentAnswerKey.items[k];
      }
    }
    renderAnswerKeyModalContent();
  });
}

// Pre-fill answer key download helper (for backwards compatibility)
function downloadAnswerKey() {
  openAnswerKeyModal();
}

// ---- Load Template Helper ----
async function loadTemplate(tpl) {
  state.template = tpl;
  state.selectedZoneIndex = tpl.zones?.length > 0 ? 0 : -1;
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
  // Reliable instant fallback to Blank Sheet
  await loadTemplate(JSON.parse(JSON.stringify(SAMPLE_TEMPLATES['blank'])));
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
        <div class="saved-build-card" data-build-id="${safeEscapeHTML(b.id)}">
          <div class="saved-build-card__info">
            <h4 class="saved-build-card__title">${safeEscapeHTML(b.title || 'Untitled Exam')}</h4>
            <div class="saved-build-card__meta">
              <span class="badge badge--paper">${safeEscapeHTML(b.paper || 'Folio')}</span>
              <span class="badge badge--questions">${b.questionCount || 0} Questions</span>
              <span class="saved-build-card__date">${dateStr}</span>
            </div>
          </div>
          <div class="saved-build-card__actions">
            <button type="button" class="btn btn--secondary btn-sm btn-load-build" data-build-id="${safeEscapeHTML(b.id)}" title="Load this exam build into editor">Load</button>
            <button type="button" class="btn btn--secondary btn-sm btn-export-build" data-build-id="${safeEscapeHTML(b.id)}" title="Download build file">Export .sheet.json</button>
            <button type="button" class="btn btn--secondary btn-sm is-danger btn-delete-build" data-build-id="${safeEscapeHTML(b.id)}" title="Delete this build">Delete</button>
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
        closeModal(els.modalLibrary);
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
      if (confirm('Delete this exam build from your library?')) {
        deleteBuildFromLibrary(id);
        renderSavedBuildsList();
      }
    });
  });
}

// ---- Google Drive Online Storage & Sync ----
const GOOGLE_CLIENT_ID_STORAGE_KEY = 'instructor_essentials_gdrive_client_id';
const DEFAULT_GOOGLE_CLIENT_ID = '998750275888-cbvmqvjbfopbsv0oe5pu238grrpv7chm.apps.googleusercontent.com';

const googleDriveState = {
  accessToken: null,
  tokenClient: null,
  folderId: null,
  user: null,
  isConnected: false,
};

function showToast(msg) {
  let toast = $('#app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = 'position: fixed; bottom: 24px; right: 24px; background: #0f172a; color: #f8fafc; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 10px 18px; font-size: 0.82rem; font-weight: 600; box-shadow: 0 10px 25px rgba(0,0,0,0.35); z-index: 99999; transition: opacity 0.25s ease, transform 0.25s ease; opacity: 0; transform: translateY(10px); pointer-events: none;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  if (typeof clearTimeout === 'function') clearTimeout(toast._timeout);
  if (typeof setTimeout === 'function') {
    toast._timeout = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 3500);
  }
}
window.showToast = showToast;

function getGoogleClientId() {
  try {
    return localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY) ||
           localStorage.getItem('grader_gdrive_client_id') ||
           (typeof window !== 'undefined' && window.__GOOGLE_CLIENT_ID__) ||
           DEFAULT_GOOGLE_CLIENT_ID;
  } catch {
    return DEFAULT_GOOGLE_CLIENT_ID;
  }
}

function setGoogleClientId(val) {
  try {
    if (val && val.trim() !== DEFAULT_GOOGLE_CLIENT_ID) {
      localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, val.trim());
    } else {
      localStorage.removeItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
    }
  } catch {}
}

function updateGoogleSyncStatus(status, tooltip = '') {
  const syncBadge = $('#google-drive-sync-indicator');
  if (!syncBadge) return;
  syncBadge.classList?.remove?.('is-syncing', 'is-synced', 'is-error');
  if (status === 'syncing') {
    syncBadge.style.display = 'inline-flex';
    syncBadge.classList?.add?.('is-syncing');
    syncBadge.innerHTML = '<span class="sync-pulsing-dot"></span> Syncing...';
    syncBadge.title = tooltip || 'Syncing build to Google Drive...';
  } else if (status === 'synced') {
    syncBadge.style.display = 'inline-flex';
    syncBadge.classList?.add?.('is-synced');
    syncBadge.innerHTML = 'Synced ✓';
    syncBadge.title = tooltip || `Synced to Google Drive (${new Date().toLocaleTimeString()})`;
  } else if (status === 'error') {
    syncBadge.style.display = 'inline-flex';
    syncBadge.classList?.add?.('is-error');
    syncBadge.innerHTML = 'Sync Error ⚠';
    syncBadge.title = tooltip || 'Google Drive sync failed';
  } else {
    syncBadge.style.display = 'none';
  }
}
window.updateGoogleSyncStatus = updateGoogleSyncStatus;

function loadGoogleGis(callback, onError) {
  if (window.google?.accounts?.oauth2) {
    callback();
    return;
  }
  const existing = document.querySelector('script[data-gis]');
  if (existing) {
    existing.addEventListener('load', () => callback());
    return;
  }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.setAttribute('data-gis', 'true');
  s.onload = () => callback();
  s.onerror = () => {
    if (onError) onError(new Error('Failed to load Google Identity Services library. Please check your internet connection.'));
  };
  document.head.appendChild(s);
}

function initGoogleDriveAuth() {
  const clientId = getGoogleClientId();
  if (!clientId) {
    showToast('Please enter your Google OAuth Client ID first.');
    openGoogleDriveModal();
    return;
  }

  loadGoogleGis(() => {
    try {
      if (!googleDriveState.tokenClient) {
        googleDriveState.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
          callback: (resp) => {
            if (resp && resp.error) {
              showToast('Google Sign-In failed: ' + (resp.error_description || resp.error));
              return;
            }
            if (resp && resp.access_token) {
              handleGoogleAuthSuccess(resp.access_token);
            }
          },
        });
      }
      googleDriveState.tokenClient.requestAccessToken({ prompt: '' });
    } catch (err) {
      showToast('Could not initialize Google authentication: ' + err.message);
    }
  }, (err) => {
    showToast(err.message);
  });
}

function handleGoogleAuthSuccess(token, expiresIn = 3600) {
  googleDriveState.accessToken = token;
  googleDriveState.isConnected = true;
  try {
    localStorage.setItem('instructor_google_token', token);
    localStorage.setItem('instructor_google_token_expiry', String(Date.now() + (expiresIn * 1000)));
  } catch {}

  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://www.googleapis.com/oauth2/v3/userinfo');
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        googleDriveState.user = JSON.parse(xhr.responseText);
        localStorage.setItem('instructor_google_user', JSON.stringify(googleDriveState.user));
      } catch {
        googleDriveState.user = { name: 'Google User' };
      }
    } else {
      googleDriveState.user = { name: 'Google User' };
    }
    updateGoogleUiState();
    showToast('✓ Connected to Google Drive (' + (googleDriveState.user.email || googleDriveState.user.name || 'Account') + ')');
    if (els.modalLibrary && els.modalLibrary.open && els.cloudBuildsList && els.cloudBuildsList.style.display !== 'none') {
      renderCloudBuildsList();
    }
  };
  xhr.onerror = function() {
    googleDriveState.user = { name: 'Google User' };
    updateGoogleUiState();
    showToast('✓ Connected to Google Drive');
  };
  xhr.send();
}

function restoreGoogleAuthState() {
  try {
    let token = localStorage.getItem('instructor_google_token');
    let expiry = parseInt(localStorage.getItem('instructor_google_token_expiry') || '0', 10);
    let userStr = localStorage.getItem('instructor_google_user');
    if (!token) {
      try {
        const raw = localStorage.getItem('toolkit_google_auth');
        if (raw) {
          const p = JSON.parse(raw);
          if (p.token) {
            token = p.token;
            expiry = p.expiry || 0;
            if (p.user) userStr = JSON.stringify(p.user);
          }
        }
      } catch {}
    }
    if (token && expiry > Date.now()) {
      googleDriveState.accessToken = token;
      googleDriveState.isConnected = true;
      if (userStr) {
        try {
          googleDriveState.user = JSON.parse(userStr);
        } catch {
          googleDriveState.user = { name: 'Google User' };
        }
      } else {
        googleDriveState.user = { name: 'Google User' };
      }
      updateGoogleUiState();
    } else {
      if (token && expiry <= Date.now()) {
        localStorage.removeItem('instructor_google_token');
        localStorage.removeItem('instructor_google_token_expiry');
        localStorage.removeItem('instructor_google_user');
        localStorage.removeItem('toolkit_google_auth');
      }
      googleDriveState.accessToken = null;
      googleDriveState.isConnected = false;
      googleDriveState.user = null;
      updateGoogleUiState();
    }
  } catch {}
}
window.restoreGoogleAuthState = restoreGoogleAuthState;

async function clearSheetWorkspace({ silent = false } = {}) {
  const blankTpl = JSON.parse(JSON.stringify(SAMPLE_TEMPLATES['blank']));
  blankTpl.title = 'General Examination';
  await loadTemplate(blankTpl);
  state.activePreset = null;
  state.selectedZoneIndex = null;
  state.answerKey = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {}
  if (!silent) {
    showToast('✓ Workspace cleared to blank exam sheet.');
  }
}
window.clearSheetWorkspace = clearSheetWorkspace;

function updateGoogleUiState() {
  const btn = $('#btn-google-drive');
  const label = $('#label-google-drive');
  const dot = $('#google-drive-dot');
  const viewDisc = $('#gdrive-view-disconnected');
  const viewConn = $('#gdrive-view-connected');
  const userName = $('#gdrive-user-name');
  const userEmail = $('#gdrive-user-email');
  const userAvatar = $('#gdrive-user-avatar');

  if (googleDriveState.isConnected && googleDriveState.user) {
    if (btn) btn.style.display = 'inline-flex';
    btn?.classList?.add('is-connected');
    if (dot) dot.style.display = 'inline-block';
    if (label) label.textContent = googleDriveState.user.name || googleDriveState.user.email || 'Drive: Connected';
    updateGoogleSyncStatus('synced');
    if (viewDisc) viewDisc.style.display = 'none';
    if (viewConn) viewConn.style.display = 'flex';
    if (userName) userName.textContent = googleDriveState.user.name || 'Google User';
    if (userEmail) userEmail.textContent = googleDriveState.user.email || 'Online Storage Active';
    if (userAvatar) {
      if (googleDriveState.user.picture) {
        userAvatar.src = googleDriveState.user.picture;
        userAvatar.style.display = 'inline-block';
      } else {
        userAvatar.style.display = 'none';
      }
    }
  } else {
    if (btn) btn.style.display = 'none';
    btn?.classList?.remove('is-connected');
    if (dot) dot.style.display = 'none';
    updateGoogleSyncStatus('hidden');
    if (label) label.textContent = 'Sign in with Google';
    if (viewDisc) viewDisc.style.display = 'flex';
    if (viewConn) viewConn.style.display = 'none';
  }
}

function openGoogleDriveModal() {
  const modal = $('#modal-google-drive');
  if (!modal) return;
  const inp = $('#input-gdrive-client-id');
  if (inp) {
    inp.value = getGoogleClientId();
  }
  updateGoogleUiState();
  openModal(modal);
}

function disconnectGoogleDrive() {
  if (googleDriveState.accessToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(googleDriveState.accessToken, () => {});
    } catch {}
  }
  googleDriveState.accessToken = null;
  googleDriveState.user = null;
  googleDriveState.folderId = null;
  googleDriveState.isConnected = false;
  try {
    localStorage.removeItem('instructor_google_token');
    localStorage.removeItem('instructor_google_token_expiry');
    localStorage.removeItem('instructor_google_user');
    localStorage.removeItem('toolkit_google_auth');
  } catch {}
  updateGoogleUiState();
  showToast('Google Drive disconnected.');
  if (els.modalLibrary && els.modalLibrary.open) {
    renderCloudBuildsList();
  }
}

function handleGoogleTokenExpired() {
  googleDriveState.accessToken = null;
  googleDriveState.isConnected = false;
  try {
    localStorage.removeItem('instructor_google_token');
    localStorage.removeItem('instructor_google_token_expiry');
    localStorage.removeItem('instructor_google_user');
    localStorage.removeItem('toolkit_google_auth');
  } catch {}
  updateGoogleUiState();
  showToast('Google session expired. Please reconnect your account.');
}


function getOrCreateDriveFolder(token, callback) {
  if (googleDriveState.folderId) {
    callback(null, googleDriveState.folderId);
    return;
  }
  const searchXhr = new XMLHttpRequest();
  const query = encodeURIComponent("(name = 'Instructors\\' Toolkit' or name = 'Instructor Essentials') and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  searchXhr.open('GET', 'https://www.googleapis.com/drive/v3/files?q=' + query + '&fields=files(id,name)');
  searchXhr.setRequestHeader('Authorization', 'Bearer ' + token);
  searchXhr.onload = function() {
    if (searchXhr.status === 401) {
      handleGoogleTokenExpired();
      if (callback) callback(new Error('Google session expired. Please reconnect your account.'));
      return;
    }
    if (searchXhr.status === 200) {
      try {
        const res = JSON.parse(searchXhr.responseText);
        if (res.files && res.files.length > 0) {
          googleDriveState.folderId = res.files[0].id;
          callback(null, googleDriveState.folderId);
          return;
        }
      } catch {}
    }
    createDriveFolder(token, callback);
  };
  searchXhr.onerror = function() {
    createDriveFolder(token, callback);
  };
  searchXhr.send();
}

function createDriveFolder(token, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://www.googleapis.com/drive/v3/files');
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function() {
    if (xhr.status === 401) {
      handleGoogleTokenExpired();
      if (callback) callback(new Error('Google session expired. Please reconnect your account.'));
      return;
    }
    if (xhr.status === 200 || xhr.status === 201) {
      try {
        const folder = JSON.parse(xhr.responseText);
        googleDriveState.folderId = folder.id;
        callback(null, folder.id);
      } catch (e) {
        callback(e);
      }
    } else {
      callback(new Error('Failed to create Instructors\' Toolkit folder in Google Drive: ' + xhr.statusText));
    }
  };
  xhr.onerror = function() {
    callback(new Error('Network error creating Google Drive folder'));
  };
  xhr.send(JSON.stringify({
    name: "Instructors' Toolkit",
    mimeType: 'application/vnd.google-apps.folder'
  }));
}

function uploadToGoogleDrive(token, fileName, mimeType, content, callback) {
  getOrCreateDriveFolder(token, (folderErr, folderId) => {
    if (folderErr) {
      callback(folderErr);
      return;
    }

    const metadata = {
      name: fileName,
      mimeType: mimeType,
      parents: [folderId]
    };

    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const closeDelim = "\r\n--" + boundary + "--";

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: ' + mimeType + '\r\n\r\n' +
      content +
      closeDelim;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
    xhr.onload = function() {
      if (xhr.status === 401) {
        handleGoogleTokenExpired();
        callback(new Error('Google session expired. Please reconnect your account.'));
        return;
      }
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          const resp = JSON.parse(xhr.responseText);
          callback(null, resp);
        } catch {
          callback(null, { name: fileName });
        }
      } else {
        callback(new Error('Drive upload failed: ' + xhr.status + ' ' + xhr.statusText));
      }
    };
    xhr.onerror = function() {
      callback(new Error('Network error during Google Drive upload'));
    };
    xhr.send(multipartRequestBody);
  });
}

function saveCurrentBuildToDrive(silent = false) {
  if (!googleDriveState.isConnected || !googleDriveState.accessToken) {
    if (!silent) openGoogleDriveModal();
    return;
  }
  if (!state.template) return;
  const title = (state.template.title || 'Exam Build').trim();
  const safeName = title.replace(/[/\\?%*:|"<>]/g, '-');
  const fileName = `${safeName} - Exam Build.json`;
  const content = JSON.stringify(state.template, null, 2);

  updateGoogleSyncStatus('syncing');
  uploadToGoogleDrive(googleDriveState.accessToken, fileName, 'application/json', content, (err) => {
    if (err) {
      updateGoogleSyncStatus('error', err.message);
      if (!silent) showToast('Failed to save to Google Drive: ' + err.message);
    } else {
      updateGoogleSyncStatus('synced', `Synced to Google Drive (${fileName})`);
      showToast(`✓ Saved "${fileName}" to Google Drive`);
    }
  });
}

function listGoogleDriveBuilds(token, callback) {
  getOrCreateDriveFolder(token, (folderErr, folderId) => {
    if (folderErr) {
      callback(folderErr);
      return;
    }
    const query = encodeURIComponent(`trashed = false and '${folderId}' in parents and (mimeType = 'application/json' or name contains '.json' or name contains 'Build')`);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://www.googleapis.com/drive/v3/files?q=' + query + '&fields=files(id,name,mimeType,createdTime,modifiedTime,size)&orderBy=modifiedTime desc');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function() {
      if (xhr.status === 401) {
        handleGoogleTokenExpired();
        callback(new Error('Google session expired. Please reconnect your account.'));
        return;
      }
      if (xhr.status === 200) {
        try {
          const res = JSON.parse(xhr.responseText);
          callback(null, res.files || []);
        } catch (e) {
          callback(e);
        }
      } else {
        callback(new Error('Failed to list files from Google Drive'));
      }
    };
    xhr.onerror = function() {
      callback(new Error('Network error listing Google Drive files'));
    };
    xhr.send();
  });
}

function renderCloudBuildsList() {
  const cloudListEl = $('#cloud-builds-list');
  if (!cloudListEl) return;

  if (!googleDriveState.isConnected || !googleDriveState.accessToken) {
    cloudListEl.innerHTML = `
      <div style="text-align: center; padding: 2.5rem 1.5rem; background: var(--panel-alt); border-radius: var(--radius-md); border: 1px dashed var(--border);">
        <svg class="google-icon" width="36" height="36" viewBox="0 0 24 24" style="margin: 0 auto 0.75rem auto; display: block;">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
        </svg>
        <div style="font-weight: 700; font-size: 0.95rem; color: var(--text); margin-bottom: 0.35rem;">Sign in with Google</div>
        <p style="font-size: 0.8rem; margin: 0 auto 1.25rem auto; max-width: 360px; color: var(--text-muted);">Connect your personal Google Drive to 1-click restore exam builds across devices.</p>
        <button type="button" class="btn btn--primary btn--sm" id="btn-cloud-signin" style="display: inline-flex; align-items: center; gap: 0.45rem; margin: 0 auto;">
          <svg class="google-icon" width="13" height="13" viewBox="0 0 24 24"><path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
          <span>Sign in with Google</span>
        </button>
      </div>
    `;
    $('#btn-cloud-signin')?.addEventListener('click', () => {
      initGoogleDriveAuth();
    });
    return;
  }

  cloudListEl.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Loading files from Google Drive...</div>';
  listGoogleDriveBuilds(googleDriveState.accessToken, (err, files) => {
    if (err) {
      cloudListEl.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--danger);">Error: ${safeEscapeHTML(err.message)}</div>`;
      return;
    }
    if (!files || files.length === 0) {
      cloudListEl.innerHTML = `
        <div class="empty-library">
          <p>No exam builds saved in Google Drive yet.</p>
          <p class="empty-sub">Saved builds in your "Instructors' Toolkit" folder will appear here.</p>
        </div>
      `;
      return;
    }

    cloudListEl.innerHTML = files.map((f) => {
      const dateStr = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString() : '';
      return `
        <div class="saved-build-card" data-file-id="${safeEscapeHTML(f.id)}">
          <div class="saved-build-card__info">
            <h4 class="saved-build-card__title">${safeEscapeHTML(f.name)}</h4>
            <div class="saved-build-card__meta">
              <span class="badge badge--paper">Google Drive</span>
              <span class="saved-build-card__date">${dateStr}</span>
            </div>
          </div>
          <div class="saved-build-card__actions">
            <button type="button" class="btn btn--secondary btn-sm btn-cloud-load" data-file-id="${safeEscapeHTML(f.id)}" title="Load this exam build into editor">Load</button>
            <button type="button" class="btn btn--secondary btn-sm is-danger btn-cloud-delete" data-file-id="${safeEscapeHTML(f.id)}" title="Delete from Google Drive">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    cloudListEl.querySelectorAll('.btn-cloud-load').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fileId = btn.dataset.fileId;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        xhr.setRequestHeader('Authorization', 'Bearer ' + googleDriveState.accessToken);
        xhr.onload = async function() {
          if (xhr.status === 200) {
            try {
              const tpl = JSON.parse(xhr.responseText);
              await loadTemplate(tpl);
              closeModal(els.modalLibrary);
              showToast('✓ Loaded exam build from Google Drive');
            } catch (e) {
              alert('Error parsing build JSON from Google Drive: ' + e.message);
            }
          } else {
            alert('Failed to download build from Google Drive: ' + xhr.statusText);
          }
        };
        xhr.send();
      });
    });

    cloudListEl.querySelectorAll('.btn-cloud-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fileId = btn.dataset.fileId;
        if (confirm('Delete this build file from your Google Drive?')) {
          const xhr = new XMLHttpRequest();
          xhr.open('DELETE', `https://www.googleapis.com/drive/v3/files/${fileId}`);
          xhr.setRequestHeader('Authorization', 'Bearer ' + googleDriveState.accessToken);
          xhr.onload = function() {
            if (xhr.status === 204 || xhr.status === 200) {
              showToast('Deleted from Google Drive');
              renderCloudBuildsList();
            } else {
              alert('Failed to delete file from Google Drive: ' + xhr.statusText);
            }
          };
          xhr.send();
        }
      });
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
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 5}" min="1" max="25">
      </div>
      <div class="gen-field-inline">
        <label>Columns:</label>
        <select class="gen-select gen-select--sm part-select-cols">
          <option value="auto" ${(part.cols ?? 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="1" ${part.cols === '1' ? 'selected' : ''}>1</option>
          <option value="2" ${part.cols === '2' ? 'selected' : ''}>2</option>
          <option value="3" ${part.cols === '3' ? 'selected' : ''}>3</option>
        </select>
      </div>
      <div class="gen-field-inline">
        <label>Box Height:</label>
        <input type="number" class="gen-input gen-input--sm part-input-height" value="${part.boxHeight ?? 10}" min="3" max="30"> mm
      </div>
      <div class="gen-field-inline">
        <label>Pts/Item:</label>
        <input type="number" class="gen-input gen-input--sm part-input-pts" value="${part.pts ?? 1}" min="1" max="20">
      </div>
    `;
  }
  if (part.type === 'text_essay') {
    return `
      <div class="gen-field-inline">
        <label>Questions:</label>
        <input type="number" class="gen-input gen-input--sm part-input-count" value="${part.count ?? 1}" min="1" max="10">
      </div>
      <div class="gen-field-inline">
        <label>Columns:</label>
        <select class="gen-select gen-select--sm part-select-cols">
          <option value="auto" ${(part.cols ?? 'auto') === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="1" ${part.cols === '1' ? 'selected' : ''}>1</option>
          <option value="2" ${part.cols === '2' ? 'selected' : ''}>2</option>
        </select>
      </div>
      <div class="gen-field-inline">
        <label>Box Height:</label>
        <input type="number" class="gen-input gen-input--sm part-input-height" value="${part.boxHeight ?? 35}" min="3" max="80"> mm
      </div>
      <div class="gen-field-inline">
        <label>Pts/Item:</label>
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
        part.count = Math.min(Math.max(part.count || 30, 1), 100);
        part.choices = part.choices || 'ABCD';
        part.cols = part.cols || 'auto';
        part.pts = part.pts || 1;
      } else if (part.type === 'truefalse') {
        part.count = Math.min(Math.max(part.count || 10, 1), 50);
        part.cols = part.cols || 'auto';
        part.pts = part.pts || 1;
      } else if (part.type === 'modified_tf') {
        part.count = Math.min(Math.max(part.count || 5, 1), 25);
        part.pts = part.pts || 2;
      } else if (part.type === 'text_short') {
        part.count = Math.min(Math.max(part.count || 5, 1), 20);
        part.boxHeight = part.boxHeight || 12;
        part.pts = part.pts || 1;
      } else if (part.type === 'text_essay') {
        part.count = Math.min(Math.max(part.count || 1, 1), 5);
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
    if (countInput) {
      countInput.addEventListener('input', () => {
        part.count = Math.max(1, parseInt(countInput.value, 10) || 1);
        updateGeneratorLivePreview();
      });
    }

    const choicesSelect = card.querySelector('.part-select-choices');
    if (choicesSelect) {
      choicesSelect.addEventListener('change', () => {
        part.choices = choicesSelect.value;
        updateGeneratorLivePreview();
      });
    }

    const colsSelect = card.querySelector('.part-select-cols');
    if (colsSelect) {
      colsSelect.addEventListener('change', () => {
        part.cols = colsSelect.value;
        updateGeneratorLivePreview();
      });
    }

    const ptsInput = card.querySelector('.part-input-pts');
    if (ptsInput) {
      ptsInput.addEventListener('input', () => {
        part.pts = Math.max(1, parseFloat(ptsInput.value) || 1);
        updateGeneratorLivePreview();
      });
    }

    const heightInput = card.querySelector('.part-input-height');
    if (heightInput) {
      heightInput.addEventListener('input', () => {
        const fallback = part.type === 'text_essay' ? 35 : 10;
        const val = parseInt(heightInput.value, 10);
        part.boxHeight = isNaN(val) ? fallback : Math.max(2, val);
        updateGeneratorLivePreview();
      });
    }

    const splitSelect = card.querySelector('.part-select-split');
    if (splitSelect) {
      splitSelect.addEventListener('change', () => {
        part.layout = splitSelect.value;
        updateGeneratorLivePreview();
      });
    }

    els.genPartsList.appendChild(card);
  });

  updateGeneratorLivePreview();
}

// ---- Live Exam Generator Preview ----
function updateGeneratorLivePreview() {
  if (!els.genWireframe) return;
  const paper = els.genPaper?.value || 'A4';
  const paperSpec = PAPER_SIZES[paper] || PAPER_SIZES['A4'];
  const title = (els.genTitle?.value || '').trim() || 'MIDTERM EXAMINATION';
  const sidMode = els.genSidMode?.value || 'fields';
  const includeInstructions = els.genInstructions ? els.genInstructions.checked : true;

  if (els.genPreviewPaperLabel) {
    els.genPreviewPaperLabel.textContent = `${paper} · ${paperSpec.width} × ${paperSpec.height} mm`;
  }

  const toRoman = (n) => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n - 1] || String(n);

  let totalQuestions = 0;
  let totalPoints = 0;
  let estimatedHeight = 24 + 12; // margins & fiducials

  let wfHtml = `
    <div class="wf-fiducials" aria-hidden="true">
      <span class="wf-fiducial wf-fiducial--tl"></span>
      <span class="wf-fiducial wf-fiducial--tr"></span>
      <span class="wf-fiducial wf-fiducial--bl"></span>
      <span class="wf-fiducial wf-fiducial--br"></span>
    </div>
  `;

  // 1. Header wireframe
  wfHtml += `
    <div class="wf-header-block">
      <div class="wf-title-text">${safeEscapeHTML(title)}</div>
      <div class="wf-details-row">
        <span><strong>Name:</strong> ______________________</span>
        <span><strong>ID no.</strong> [ 8 Digits ]</span>
      </div>
      <div class="wf-details-row">
        <span><strong>Offer No.</strong> _______</span>
        <span><strong>Sched</strong> _______</span>
        <span><strong>Score:</strong> [____]</span>
      </div>
    </div>
  `;
  estimatedHeight += 24;

  if (sidMode === 'grid') {
    wfHtml += `
      <div class="wf-section-block">
        <div class="wf-sec-title"><span>ID no. (8 Digits)</span><span class="wf-sec-badge">OMR Shading Grid</span></div>
        <div style="font-size: 0.65rem; color: #64748b; text-align: center;">[ 8 Columns × 10 Rows Bubble Matrix ]</div>
      </div>
    `;
    estimatedHeight += 48;
  }

  // 2. Instructions wireframe
  if (includeInstructions) {
    wfHtml += `
      <div style="font-size: 0.65rem; color: #475569; border: 1px dashed #cbd5e1; border-radius: 3px; padding: 0.25rem 0.4rem; background: #f8fafc;">
        Instructions: Shade bubbles completely with dark pencil. Print write-in answers clearly.
      </div>
    `;
    estimatedHeight += 10;
  }

  // 3. Sections wireframe
  let curQ = 1;
  generatorParts.forEach((part, idx) => {
    const roman = toRoman(idx + 1);
    const count = Math.max(1, part.count || 1);
    const pts = Math.max(1, part.pts || 1);
    totalQuestions += count;
    totalPoints += count * pts;

    const startQ = curQ;
    const endQ = curQ + count - 1;
    curQ += count;

    let secTypeName = 'Multiple Choice';
    let sampleBadges = '';

    if (part.type === 'mcq') {
      secTypeName = `Multiple Choice (${part.choices || 'ABCD'})`;
      const numChoices = (part.choices || 'ABCD').length;
      estimatedHeight += Math.ceil(count / 2) * 5.4 + 10;
      sampleBadges = `
        <div class="wf-bubbles-matrix">
          <div class="wf-item-row">${startQ} ${Array(numChoices).fill('<span class="wf-dot"></span>').join('')}</div>
          ${count > 1 ? `<div class="wf-item-row">${startQ + 1} ${Array(numChoices).fill('<span class="wf-dot"></span>').join('')}</div>` : ''}
          ${count > 2 ? `<div class="wf-item-row">...</div><div class="wf-item-row">${endQ} ${Array(numChoices).fill('<span class="wf-dot"></span>').join('')}</div>` : ''}
        </div>
      `;
    } else if (part.type === 'truefalse') {
      secTypeName = 'True / False';
      estimatedHeight += Math.ceil(count / 2) * 5.4 + 10;
      sampleBadges = `
        <div class="wf-bubbles-matrix">
          <div class="wf-item-row">${startQ} <span class="wf-dot"></span> <span class="wf-dot"></span></div>
          ${count > 1 ? `<div class="wf-item-row">${startQ + 1} <span class="wf-dot"></span> <span class="wf-dot"></span></div>` : ''}
          ${count > 2 ? `<div class="wf-item-row">...</div><div class="wf-item-row">${endQ} <span class="wf-dot"></span> <span class="wf-dot"></span></div>` : ''}
        </div>
      `;
    } else if (part.type === 'modified_tf') {
      secTypeName = 'Modified True / False';
      estimatedHeight += count * 7.5 + 10;
      sampleBadges = `
        <div class="wf-bubbles-matrix">
          <div class="wf-item-row">${startQ} <span class="wf-dot"></span> <span class="wf-dot"></span> [ Correction Box ]</div>
          ${count > 1 ? `<div class="wf-item-row">... ${count} items total</div>` : ''}
        </div>
      `;
    } else if (part.type === 'text_short') {
      secTypeName = 'Short Answer';
      estimatedHeight += count * ((part.boxHeight || 12) + 4);
      sampleBadges = `
        <div class="wf-bubbles-matrix">
          <div class="wf-item-row" style="width: 100%; display: flex; flex-direction: column; gap: 0.2rem;">
            <span>${startQ}</span>
            <div class="wf-box-writein" style="height: ${Math.min(28, (part.boxHeight || 12))}px;">Write-in answer / term</div>
          </div>
          ${count > 1 ? `<div class="wf-item-row" style="font-size: 0.65rem; color: #64748b; font-style: italic;">... +${count - 1} more items (${startQ + 1}–${endQ})</div>` : ''}
        </div>
      `;
    } else if (part.type === 'text_essay') {
      secTypeName = 'Essay / Discussion';
      estimatedHeight += count * ((part.boxHeight || 36) + 4);
      sampleBadges = `
        <div class="wf-bubbles-matrix">
          <div class="wf-item-row" style="width: 100%; display: flex; flex-direction: column; gap: 0.2rem;">
            <span>${startQ}</span>
            <div class="wf-box-writein" style="height: ${Math.min(50, (part.boxHeight || 36))}px;">Extended explanation / essay response</div>
          </div>
        </div>
      `;
    }

    wfHtml += `
      <div class="wf-section-block">
        <div class="wf-sec-title">
          <span>Part ${roman} — ${secTypeName} (${count} item${count > 1 ? 's' : ''})</span>
          <span class="wf-sec-badge">${pts} pt${pts > 1 ? 's' : ''} each</span>
        </div>
        ${sampleBadges}
      </div>
    `;
  });

  const fillPct = Math.min(100, Math.round((estimatedHeight / paperSpec.height) * 100));

  if (els.genStatQuestions) els.genStatQuestions.textContent = String(totalQuestions);
  if (els.genStatPoints) els.genStatPoints.textContent = String(totalPoints);
  if (els.genStatFill) {
    els.genStatFill.textContent = `${fillPct}%`;
    els.genStatFill.style.color = fillPct > 95 ? 'var(--danger)' : fillPct > 80 ? 'var(--warning)' : 'var(--text)';
  }

  els.genWireframe.innerHTML = wfHtml;
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
        { id: 'name', label: 'Name', role: 'name', row: 0, w: 140 },
        { id: 'score', label: 'Score', role: 'score', row: 0, w: 40 },
        { id: 'offer', label: 'Offer No.', row: 1, w: 50 },
        { id: 'sched', label: 'Sched', row: 1, w: 70 },
        { id: 'date', label: 'Date', row: 1, w: 50 },
      ],
    });
    zones.push({
      type: 'student_id',
      id: uid('sid'),
      label: 'ID no.',
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
        { id: 'name', label: 'Name', role: 'name', row: 0, w: 108 },
        { id: 'sid', label: 'ID no.', role: 'student_id', digits: 8, row: 0, w: 75 },
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
      const cols = part.cols === 'auto'
        ? (count <= 10 ? 1 : count <= 20 ? (availW > 120 ? 3 : 2) : count <= 35 ? (availW > 120 ? 3 : 2) : (availW > 120 ? 4 : 2))
        : parseInt(part.cols, 10);
      const pts = Math.max(1, part.pts || 1);

      zones.push({
        type: 'mcq',
        id: uid('mcq'),
        label: `Part ${roman} — Multiple Choice`,
        count,
        start: currentQ,
        choices,
        columns: cols,
        pointsPerItem: pts,
        w: availW,
        ...(part.rowGap != null ? { rowGap: Number(part.rowGap) } : {}),
      });
      currentQ += count;
    } else if (part.type === 'truefalse') {
      const count = Math.max(1, part.count || 10);
      const cols = part.cols === 'auto'
        ? (count <= 10 ? (availW > 120 ? 3 : 2) : count <= 25 ? (availW > 120 ? 4 : 2) : 4)
        : parseInt(part.cols, 10);
      const pts = Math.max(1, part.pts || 1);

      zones.push({
        type: 'truefalse',
        id: uid('tf'),
        label: `Part ${roman} — True / False`,
        count,
        start: currentQ,
        choices: ['T', 'F'],
        columns: cols,
        pointsPerItem: pts,
        w: availW,
        ...(part.rowGap != null ? { rowGap: Number(part.rowGap) } : {}),
      });
      currentQ += count;
    } else if (part.type === 'modified_tf') {
      const count = Math.max(1, part.count || 5);
      const pts = Math.max(1, part.pts || 2);

      zones.push({
        type: 'modified_tf',
        id: uid('modtf'),
        label: `Part ${roman} — Modified True / False`,
        count,
        start: currentQ,
        choices: ['T', 'F'],
        corrWidth: Math.min(60, Math.floor(availW * 0.42)),
        columns: 1,
        pointsPerItem: pts,
        w: availW,
        ...(part.rowGap != null ? { rowGap: Number(part.rowGap) } : {}),
      });
      currentQ += count;
    } else if (part.type === 'text_short') {
      const count = Math.max(1, part.count || 5);
      const pts = Math.max(1, part.pts || 1);
      const h = part.boxHeight ?? 10;
      const cols = part.cols === 'auto' ? (count <= 4 ? 1 : 2) : (parseInt(part.cols, 10) || 1);

      zones.push({
        type: 'text_short',
        id: uid('sa'),
        label: `Part ${roman} — Short Answer`,
        count,
        start: currentQ,
        columns: cols,
        boxHeight: h,
        pointsPerItem: pts,
        w: availW,
        ...(part.rowGap != null ? { rowGap: Number(part.rowGap) } : {}),
      });
      currentQ += count;
    } else if (part.type === 'text_essay') {
      const count = Math.max(1, part.count || 1);
      const pts = Math.max(1, part.pts || 5);
      const h = part.boxHeight ?? 35;
      const cols = part.cols === 'auto' ? (count <= 2 ? 1 : 2) : (parseInt(part.cols, 10) || 1);

      zones.push({
        type: 'text_essay',
        id: uid('essay'),
        label: `Part ${roman} — Essay`,
        count,
        start: currentQ,
        columns: cols,
        boxHeight: h,
        pointsPerItem: pts,
        w: availW,
        ...(part.rowGap != null ? { rowGap: Number(part.rowGap) } : {}),
      });
      currentQ += count;
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
  closeModal(els.modalGenerator);
}

// ---- Event Listeners Setup ----
function initEvents() {
  // Global title
  els.examTitle?.addEventListener('input', () => {
    state.template.title = els.examTitle.value;
    update();
  });

  // Generator modal events
  const openGeneratorModal = () => {
    renderGeneratorParts();
    updateGeneratorLivePreview();
    openModal(els.modalGenerator);
  };
  els.btnGenerator?.addEventListener('click', openGeneratorModal);
  $('#btn-sidebar-generator')?.addEventListener('click', openGeneratorModal);

  els.btnGenAddPart?.addEventListener('click', () => {
    generatorParts.push({ type: 'mcq', count: 10, choices: 'ABCD', cols: 'auto', pts: 1 });
    renderGeneratorParts();
  });

  els.genTitle?.addEventListener('input', updateGeneratorLivePreview);
  els.genPaper?.addEventListener('change', updateGeneratorLivePreview);
  els.genSidMode?.addEventListener('change', updateGeneratorLivePreview);
  els.genInstructions?.addEventListener('change', updateGeneratorLivePreview);

  els.btnCloseGenerator?.addEventListener('click', () => closeModal(els.modalGenerator));
  els.btnCancelGenerator?.addEventListener('click', () => closeModal(els.modalGenerator));
  els.modalGenerator?.addEventListener('click', (e) => {
    if (e.target === els.modalGenerator) closeModal(els.modalGenerator);
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

  // New Exam Sheet / Clear Workspace
  els.btnNewSheet?.addEventListener('click', () => {
    clearSheetWorkspace();
  });

  // Save current build to library
  els.btnSaveBuild?.addEventListener('click', () => {

    if (!state.template || !state.layout) return;
    const currentTitle = (state.template.title || '').trim() || 'New Exam Sheet';
    const entered = window.prompt('Name this exam build:', currentTitle);
    if (entered === null) return; // user cancelled prompt
    const title = entered.trim() || currentTitle;
    state.template.title = title;
    if (els.examTitle) els.examTitle.value = title;

    // Ensure a unique ID for this saved build so it doesn't overwrite preset IDs
    const isPresetId = !state.template.id ||
      state.template.id === 'blank' ||
      state.template.id.startsWith('exam-') ||
      Object.keys(SAMPLE_TEMPLATES).includes(state.template.id) ||
      Object.values(SAMPLE_TEMPLATES).some((t) => t.id === state.template.id);
    if (isPresetId) {
      state.template.id = `build_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }

    const stats = layoutStats(state.layout);
    const entry = {
      id: state.template.id,
      title,
      paper: state.template.paper || 'Folio',
      questionCount: stats.totalQuestions ?? (stats.questions + (stats.textQuestions || 0)),
      timestamp: Date.now(),
      template: JSON.parse(JSON.stringify(state.template)),
      layout: state.layout ? JSON.parse(JSON.stringify(state.layout)) : null,
    };
    saveBuildToLibrary(entry);
    if (googleDriveState.isConnected && googleDriveState.accessToken) {
      saveCurrentBuildToDrive(true);
    }

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
    if (els.tabBtnLibraryLocal && els.tabBtnLibraryCloud) {
      els.tabBtnLibraryLocal.classList.remove('btn--secondary');
      els.tabBtnLibraryLocal.classList.add('btn--primary');
      els.tabBtnLibraryCloud.classList.remove('btn--primary');
      els.tabBtnLibraryCloud.classList.add('btn--secondary');
    }
    if (els.savedBuildsList) els.savedBuildsList.style.display = 'block';
    if (els.cloudBuildsList) els.cloudBuildsList.style.display = 'none';
    if (els.libraryTabDesc) els.libraryTabDesc.textContent = 'All exam templates saved in Sheet Builder. You can load, export, or delete them anytime.';
    renderSavedBuildsList();
    openModal(els.modalLibrary);
  });

  // Library tab buttons
  els.tabBtnLibraryLocal?.addEventListener('click', () => {
    els.tabBtnLibraryLocal.classList.remove('btn--secondary');
    els.tabBtnLibraryLocal.classList.add('btn--primary');
    els.tabBtnLibraryCloud.classList.remove('btn--primary');
    els.tabBtnLibraryCloud.classList.add('btn--secondary');
    if (els.savedBuildsList) els.savedBuildsList.style.display = 'block';
    if (els.cloudBuildsList) els.cloudBuildsList.style.display = 'none';
    if (els.libraryTabDesc) els.libraryTabDesc.textContent = 'All exam templates saved in Sheet Builder. You can load, export, or delete them anytime.';
    renderSavedBuildsList();
  });

  els.tabBtnLibraryCloud?.addEventListener('click', () => {
    els.tabBtnLibraryCloud.classList.remove('btn--secondary');
    els.tabBtnLibraryCloud.classList.add('btn--primary');
    els.tabBtnLibraryLocal.classList.remove('btn--primary');
    els.tabBtnLibraryLocal.classList.add('btn--secondary');
    if (els.savedBuildsList) els.savedBuildsList.style.display = 'none';
    if (els.cloudBuildsList) els.cloudBuildsList.style.display = 'block';
    if (els.libraryTabDesc) els.libraryTabDesc.textContent = 'Exam builds saved in your personal Google Drive ("Instructors\' Toolkit" folder).';
    renderCloudBuildsList();
  });

  // Google Drive Header Button & Modal listeners
  els.btnGoogleDrive?.addEventListener('click', () => {
    if (!googleDriveState.isConnected) {
      const clientId = getGoogleClientId();
      if (!clientId) {
        openGoogleDriveModal();
      } else {
        initGoogleDriveAuth();
      }
    } else {
      openGoogleDriveModal();
    }
  });

  els.btnCloseGdrive?.addEventListener('click', () => closeModal(els.modalGoogleDrive));
  els.btnGdriveCancel?.addEventListener('click', () => closeModal(els.modalGoogleDrive));
  els.btnGdriveDone?.addEventListener('click', () => closeModal(els.modalGoogleDrive));
  els.modalGoogleDrive?.addEventListener('click', (e) => {
    if (e.target === els.modalGoogleDrive) closeModal(els.modalGoogleDrive);
  });
  els.btnGdriveConnect?.addEventListener('click', () => {
    const val = els.inputGdriveClientId?.value;
    if (val) setGoogleClientId(val);
    initGoogleDriveAuth();
  });
  els.btnGdriveDisconnect?.addEventListener('click', () => {
    disconnectGoogleDrive();
  });
  els.btnGdriveSaveNow?.addEventListener('click', () => {
    saveCurrentBuildToDrive(false);
  });

  // Close library modal handlers
  els.btnCloseLibrary?.addEventListener('click', () => closeModal(els.modalLibrary));
  els.btnModalClose?.addEventListener('click', () => closeModal(els.modalLibrary));
  els.modalLibrary?.addEventListener('click', (e) => {
    if (e.target === els.modalLibrary) {
      closeModal(els.modalLibrary);
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
          questionCount: stats.totalQuestions ?? (stats.questions + (stats.textQuestions || 0)),
          timestamp: Date.now(),
          template: tpl,
        };
        saveBuildToLibrary(entry);
        await loadTemplate(tpl);
        renderSavedBuildsList();
        closeModal(els.modalLibrary);
      } catch (err) {
        alert(`Failed to import build file: ${err.message}`);
      }
    };
    filePicker.click();
  });

  // Presets dropdown
  els.samplePreset?.addEventListener('change', () => {
    const val = els.samplePreset.value;
    if (val === 'blank') {
      loadTemplate({
        id: `exam-${Date.now().toString(36).slice(-4)}`,
        title: 'New Exam Sheet',
        paper: 'Folio',
        bubble: { diameter: 4.2, pitchX: 5.6, pitchY: 5.4 },
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
  els.overlay?.addEventListener('change', () => state.layout && renderPreview());


  // Answer Key modal opening & controls
  els.btnDlKey?.addEventListener('click', openAnswerKeyModal);
  els.btnCloseAnswerKey?.addEventListener('click', () => closeModal(els.modalAnswerKey));
  els.modalAnswerKey?.addEventListener('click', (e) => {
    if (e.target === els.modalAnswerKey) closeModal(els.modalAnswerKey);
  });

  els.btnKeyFillA?.addEventListener('click', () => {
    for (const it of Object.values(currentAnswerKey.items)) {
      if (it.options?.includes('A')) it.answer = 'A';
    }
    renderAnswerKeyModalContent();
  });

  els.btnKeyFillT?.addEventListener('click', () => {
    for (const it of Object.values(currentAnswerKey.items)) {
      if (it.options?.includes('T')) it.answer = 'T';
    }
    renderAnswerKeyModalContent();
  });

  els.btnKeyRandom?.addEventListener('click', () => {
    for (const it of Object.values(currentAnswerKey.items)) {
      if (Array.isArray(it.options) && it.options.length > 0) {
        it.answer = it.options[Math.floor(Math.random() * it.options.length)];
      }
    }
    renderAnswerKeyModalContent();
  });

  els.btnKeyClear?.addEventListener('click', () => {
    for (const it of Object.values(currentAnswerKey.items)) {
      it.answer = '';
    }
    renderAnswerKeyModalContent();
  });

  els.keyPassingInput?.addEventListener('input', () => {
    currentAnswerKey.passScore = Math.max(0, parseInt(els.keyPassingInput.value, 10) || 0);
    els.keyPassingInput.dataset.userEdited = 'true';
  });

  els.btnKeySaveApply?.addEventListener('click', () => {
    if (state.template) {
      state.template.answerKey = getActiveAnswerKeyPayload();
      update();
    }
    closeModal(els.modalAnswerKey);
  });

  els.btnKeyDownload?.addEventListener('click', downloadCurrentAnswerKey);
  els.btnKeyDownloadCsv?.addEventListener('click', downloadCurrentAnswerKeyCSV);

  function parseCSVLine(line) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  function parseKeyCSV(csvText) {
    const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV file is empty or missing headers.');
    const header = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim().replace(/^["']|["']$/g, ''));
    const itemCol = header.findIndex((h) => h.includes('item') || h.includes('question') || h.includes('#'));
    const ansCol = header.findIndex((h) => h.includes('answer') || h.includes('key'));
    const ptsCol = header.findIndex((h) => h.includes('point') || h.includes('pts') || h.includes('score'));
    const bloomCol = header.findIndex((h) => h.includes('bloom') || h.includes('cognitive') || h.includes('taxonomy') || h.includes('level'));

    const items = {};
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      if (row.length === 0) continue;
      const itNum = itemCol !== -1 ? row[itemCol]?.trim() : String(i);
      let ans = ansCol !== -1 ? row[ansCol]?.trim() : (row[1]?.trim() || '');
      const pts = ptsCol !== -1 ? parseFloat(row[ptsCol]) : 1;
      const rawBloom = bloomCol !== -1 ? row[bloomCol]?.trim() : (row[3]?.trim() || null);
      const bloom = rawBloom ? normalizeBloom(rawBloom) : defaultBloomFor(itNum);

      if (itNum && ans !== undefined && ans !== '') {
        let normAns = ans.trim();
        const upper = normAns.toUpperCase();
        if (upper === 'TRUE') normAns = 'T';
        else if (upper === 'FALSE') normAns = 'F';
        else if (/^[A-Za-z]$/.test(normAns)) normAns = upper;

        const isTF = normAns === 'T' || normAns === 'F';
        const isSingleLetter = /^[A-E]$/i.test(normAns);
        items[itNum] = {
          answer: normAns,
          points: isNaN(pts) ? 1 : pts,
          kind: isTF ? 'tf' : (isSingleLetter ? 'mcq' : 'text'),
          bloom,
        };
      }
    }
    return items;
  }

  els.keyFileImport?.addEventListener('change', async () => {
    const file = els.keyFileImport.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const fname = file.name.toLowerCase();
      if (fname.endsWith('.csv')) {
        const importedItems = parseKeyCSV(text);
        if (Object.keys(importedItems).length === 0) {
          throw new Error('No valid question answers found in imported CSV.');
        }
        for (const [k, v] of Object.entries(importedItems)) {
          if (currentAnswerKey.items[k]) {
            currentAnswerKey.items[k].answer = v.answer;
            currentAnswerKey.items[k].kind = v.kind;
            if (v.points !== undefined) currentAnswerKey.items[k].points = v.points;
            if (v.bloom) currentAnswerKey.items[k].bloom = v.bloom;
          } else {
            currentAnswerKey.items[k] = {
              answer: v.answer,
              points: v.points ?? 1,
              bloom: v.bloom || defaultBloomFor(k),
              kind: v.kind || 'mcq',
              options: v.kind === 'tf' ? ['T', 'F'] : (v.kind === 'text' ? null : ['A', 'B', 'C', 'D']),
              label: k,
            };
          }
        }
        renderAnswerKeyModalContent();
      } else {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.items === 'object') {
          for (const [k, v] of Object.entries(parsed.items)) {
            const rawAns = typeof v === 'object' && v !== null && v.answer !== undefined ? v.answer : v;
            const ansStr = String(rawAns ?? '').trim();
            const isTF = (typeof v === 'object' && v.kind === 'tf') || ansStr === 'T' || ansStr === 'F';
            const isSingleLetter = /^[A-E]$/i.test(ansStr);
            const isText = (typeof v === 'object' && (v.kind === 'text' || v.type === 'written' || v.type === 'short_answer' || v.type === 'essay' || v.correction)) || (!isSingleLetter && !isTF);
            const kind = isText ? 'text' : (isTF ? 'tf' : 'mcq');

            if (currentAnswerKey.items[k]) {
              currentAnswerKey.items[k].answer = ansStr;
              currentAnswerKey.items[k].kind = kind;
              if (typeof v === 'object' && v.points != null) currentAnswerKey.items[k].points = Number(v.points);
              if (typeof v === 'object' && v.bloom) currentAnswerKey.items[k].bloom = normalizeBloom(v.bloom);
            } else {
              currentAnswerKey.items[k] = {
                answer: ansStr,
                points: typeof v === 'object' && v.points != null ? Number(v.points) : 1,
                bloom: normalizeBloom(typeof v === 'object' && v.bloom ? v.bloom : defaultBloomFor(k)),
                kind,
                options: typeof v === 'object' && v.options ? v.options : (isTF ? ['T', 'F'] : (isText ? null : ['A', 'B', 'C', 'D'])),
                label: (typeof v === 'object' && v.label) || k,
              };
            }
          }
          if (parsed.pass_score !== undefined) currentAnswerKey.passScore = parsed.pass_score;
          renderAnswerKeyModalContent();
        }
      }
    } catch (err) {
      alert(`Invalid Answer Key: ${err.message}`);
    } finally {
      els.keyFileImport.value = '';
    }
  });

  // Print button
  els.btnPrint?.addEventListener('click', () => window.print());

  // Export dropdown
  els.btnExportToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const parent = els.btnExportToggle.closest('.dropdown-menu');
    const isOpen = parent.classList.toggle('is-open');
    els.btnExportToggle.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown-menu')) {
      $$('.dropdown-menu').forEach((d) => d.classList.remove('is-open'));
      els.btnExportToggle?.setAttribute('aria-expanded', 'false');
    }
  });

  // Auto-close dropdown when any option inside is clicked
  els.exportMenu?.addEventListener('click', (e) => {
    if (e.target.closest('button')) {
      const parent = els.btnExportToggle?.closest('.dropdown-menu');
      parent?.classList.remove('is-open');
      els.btnExportToggle?.setAttribute('aria-expanded', 'false');
    }
  });

  // Export actions
  els.buttons.package?.addEventListener('click', async () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    const layoutJson = `${JSON.stringify(state.layout, null, 2)}\n`;
    const svgStr = renderSVG(state.layout);
    const css = await getSheetCss();
    const htmlStr = renderStandaloneHTML(state.layout, css);
    const keySvgStr = generateKeySheetSVG(state.layout, currentAnswerKey.items);
    const keyHtmlStr = generateKeySheetHTML(state.layout, currentAnswerKey.items, css);
    const templateJson = state.template ? `${JSON.stringify(state.template, null, 2)}\n` : layoutJson;

    const keyRows = ['Item #,Answer,Points,Bloom'];
    const activeKeyItems = currentAnswerKey.items || {};
    let sortedKeyItems;
    if (keyKeys.length > 0) {
      sortedKeyItems = keyKeys.sort((a, b) => {
        const na = Number(a), nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b, undefined, { numeric: true });
      });
    } else {
      const allItemKeys = new Set();
      for (const g of allGroups(state.layout)) {
        if (g.kind === 'mcq' || g.kind === 'tf') allItemKeys.add(String(g.key));
      }
      const allRois = [
        ...(Array.isArray(state.layout.rois) ? state.layout.rois : []),
        ...(Array.isArray(state.layout.zones) ? state.layout.zones.flatMap((z) => z.rois || []) : []),
      ];
      for (const r of allRois) {
        if (r && r.graded !== false && r.role !== 'name' && r.role !== 'student_id' && r.role !== 'score' && r.role !== 'signature') {
          allItemKeys.add(String(r.key || r.id));
        }
      }
      sortedKeyItems = Array.from(allItemKeys).sort((a, b) => {
        const na = Number(a), nb = Number(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b, undefined, { numeric: true });
      });
    }

    const layoutGroupsMap = new Map();
    for (const g of allGroups(state.layout)) {
      layoutGroupsMap.set(String(g.key), g);
    }
    const layoutRoisMap = new Map();
    const allRoisList = [
      ...(Array.isArray(state.layout.rois) ? state.layout.rois : []),
      ...(Array.isArray(state.layout.zones) ? state.layout.zones.flatMap((z) => z.rois || []) : []),
    ];
    for (const r of allRoisList) {
      if (r && (r.key || r.id)) layoutRoisMap.set(String(r.key || r.id), r);
    }

    for (const k of sortedKeyItems) {
      const it = activeKeyItems[k];
      const roi = layoutRoisMap.get(k);
      const grp = layoutGroupsMap.get(k);
      const defaultAns = roi ? (roi.role === 'correction' ? 'Correction' : 'Sample Answer') : (grp?.kind === 'tf' ? 'T' : 'A');
      const defaultPts = roi ? (roi.points != null ? roi.points : 1) : (grp?.points != null ? grp.points : 1);
      const ans = it ? String(it.answer ?? '') : defaultAns;
      const pts = it ? (it.points ?? 1) : defaultPts;
      const bloom = it ? (it.bloom || defaultBloomFor(k)) : defaultBloomFor(k);
      const formattedAns = ans.includes(',') || ans.includes('"') ? `"${ans.replace(/"/g, '""')}"` : ans;
      keyRows.push(`${k},${formattedAns},${pts},${bloom}`);
    }
    const keyCsv = keyRows.join('\n') + '\n';

    const readme = `EXAM PACKAGE: ${state.layout.title || baseId}
Generated by Instructors' Toolkit — Sheet Builder

CONTENTS:
1. exam_sheet.html & exam_sheet.svg
   - High-precision printable exam sheet.
   - Print at 100% scale (Do NOT select "Fit to page" so ArUco fiducials remain millimeter-accurate).

2. answer_key_sheet.html & answer_key_sheet.svg
   - Master answer key reference sheet with correct answer bubbles shaded.

3. layout.json
   - Exact fiducial marker coordinates and bubble positions.
   - In Checker Studio (checker.html), simply upload this file or this entire ZIP package to load the layout instantly!

4. template.json
   - The editable Sheet Builder blueprint. Load this back into Sheet Builder to edit questions or layout anytime.

5. answer_key_template.csv
   - Pre-populated answer key CSV template with Item #, Answer, Points, and Bloom's Taxonomy cognitive levels.
   - Upload directly into Checker Studio (checker.html) to grade completed exams!
`;

    const enc = new TextEncoder();
    const files = [
      { name: 'layout.json', data: enc.encode(layoutJson) },
      { name: 'exam_sheet.svg', data: enc.encode(svgStr) },
      { name: 'exam_sheet.html', data: enc.encode(htmlStr) },
      { name: 'answer_key_sheet.svg', data: enc.encode(keySvgStr) },
      { name: 'answer_key_sheet.html', data: enc.encode(keyHtmlStr) },
      { name: 'template.json', data: enc.encode(templateJson) },
      { name: 'answer_key_template.csv', data: enc.encode(keyCsv) },
      { name: 'README.txt', data: enc.encode(readme) },
      { name: `${baseId}.layout.json`, data: enc.encode(layoutJson) },
    ];

    const zipBytes = createZip(files);
    download(`${baseId}-exam-package.zip`, zipBytes, 'application/zip');
  });

  els.buttons.svg?.addEventListener('click', () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    download(`${baseId}.svg`, renderSVG(state.layout), 'image/svg+xml');
  });

  els.buttons.html?.addEventListener('click', async () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    download(`${baseId}.sheet.html`, renderStandaloneHTML(state.layout, await getSheetCss()), 'text/html');
  });

  els.buttons.keySheetHtml?.addEventListener('click', async () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    const css = await getSheetCss();
    const htmlStr = generateKeySheetHTML(state.layout, currentAnswerKey.items, css);
    download(`${baseId}-key-sheet.html`, htmlStr, 'text/html');
  });

  els.buttons.keySheetSvg?.addEventListener('click', () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    const svgStr = generateKeySheetSVG(state.layout, currentAnswerKey.items);
    download(`${baseId}-key-sheet.svg`, svgStr, 'image/svg+xml');
  });

  els.buttons.layout?.addEventListener('click', () => {
    if (!state.layout) return;
    const baseId = getExportBaseId();
    download(`${baseId}.layout.json`, `${JSON.stringify(state.layout, null, 2)}\n`, 'application/json');
  });

  els.buttons.template?.addEventListener('click', () => {
    if (!state.template) return;
    const baseId = getExportBaseId();
    download(`${baseId}.sheet.json`, `${JSON.stringify(state.template, null, 2)}\n`, 'application/json');
  });

  // Canvas zoom
  els.btnZoomIn?.addEventListener('click', () => {
    state.zoom = Math.min(2.0, state.zoom + 0.1);
    applyZoom();
  });

  els.btnZoomOut?.addEventListener('click', () => {
    state.zoom = Math.max(0.3, state.zoom - 0.1);
    applyZoom();
  });

  els.btnZoomReset?.addEventListener('click', () => {
    state.zoom = 1.0;
    applyZoom();
  });

  els.btnZoomFit?.addEventListener('click', fitPreview);

  // Render mode buttons (DOM vs SVG)
  for (const btn of els.renderModeBtns) {
    btn.addEventListener('click', () => {
      state.renderMode = btn.dataset.mode;
      for (const b of els.renderModeBtns) b.classList.toggle('is-active', b === btn);
      renderPreview();
    });
  }

  // Advanced drawer events
  els.rawJson?.addEventListener('input', () => {
    try {
      state.template = JSON.parse(els.rawJson.value);
      update();
    } catch (err) {
      els.jsonStatus.textContent = `JSON Error: ${err.message}`;
      els.jsonStatus.dataset.state = 'error';
    }
  });

  els.fileInput?.addEventListener('change', async () => {
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
  if (typeof ResizeObserver !== 'undefined' && els.preview) {
    new ResizeObserver(() => {
      if (state.zoom === 1.0) fitPreview();
    }).observe(els.preview);
  }
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
  restoreGoogleAuthState();

  // Cross-tab synchronization for Google Auth and Saved Builds
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e) => {
      if (e.key === 'instructor_google_token' || e.key === 'instructor_google_user') {
        restoreGoogleAuthState();
      }
    });
  }

  // Check URL query parameters: ?action=new or ?clear=1 or ?action=generate
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('action') === 'new' || urlParams.get('clear') === '1') {
      await clearSheetWorkspace({ silent: true });
      return;
    }
    if (urlParams.get('action') === 'generate') {
      setTimeout(() => openGeneratorModal(), 150);
    }
  } catch {}

  const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.zones)) {
        await loadTemplate(parsed);
        return;
      }
    } catch {}
  }

  // Guaranteed instant load: default starting template is Blank Sheet
  await loadSample('blank');
}


onReady(init);

