/**
 * OMR layout engine (isomorphic ES module: runs in the browser and in Node).
 *
 * Converts a template JSON payload into a fully resolved geometric layout in
 * millimetres. The resolved layout is the single source of truth shared by:
 *   - the DOM / CSS Grid renderer (printable sheet),
 *   - the SVG renderer,
 *   - the Python computer-vision pipeline (layout.json).
 *
 * Because every bubble centre is computed here (not measured from the
 * browser), print output and CV sampling coordinates cannot drift apart.
 */
import { ARUCO_DICTIONARY, SUPPORTED_MARKER_IDS } from './aruco.js';

export const LAYOUT_SCHEMA = 'omr-layout/1';
export const GENERATOR = 'omr-sheet-builder/1.0.0';

export const PAPER_SIZES = Object.freeze({
  A4: Object.freeze({ width: 210, height: 297 }),
  Letter: Object.freeze({ width: 215.9, height: 279.4 }),
  Folio: Object.freeze({ width: 215.9, height: 330.2 }),
  'Half-A4': Object.freeze({ width: 148.5, height: 210 }),
  'Half-Letter': Object.freeze({ width: 139.7, height: 215.9 }),
  'Half-Folio': Object.freeze({ width: 165.1, height: 215.9 }),
});

const PAPER_ALIASES = {
  a4: 'A4',
  letter: 'Letter',
  'us-letter': 'Letter',
  usletter: 'Letter',
  folio: 'Folio',
  '8.5x13': 'Folio',
  '8.5*13': 'Folio',
  f4: 'Folio',
  'half-a4': 'Half-A4',
  halfa4: 'Half-A4',
  a5: 'Half-A4',
  'half-letter': 'Half-Letter',
  halfletter: 'Half-Letter',
  statement: 'Half-Letter',
  'half-folio': 'Half-Folio',
  halffolio: 'Half-Folio',
};

export const DEFAULTS = Object.freeze({
  paper: 'A4',
  margin: 12, // left/right content margin (mm)
  gap: 4, // vertical/horizontal gap between flowed zones (mm)
  footer: 'Use a dark pencil or black pen. Fill each bubble completely. Do not fold or staple this sheet.',
  fiducial: Object.freeze({ type: 'aruco', dictionary: ARUCO_DICTIONARY, size: 10, inset: 7, quietZone: 2, ids: [0, 1, 2, 3] }),
  bubble: Object.freeze({ diameter: 4.2, pitchX: 5.6, pitchY: 5.4, groupEvery: 5, groupGap: 1.6, stroke: 0.25 }),
  typography: Object.freeze({ title: 4.2, label: 3.0, body: 2.8, bubble: 2.1, number: 2.6, small: 2.2 }),
});

// Zone chrome constants (mm).
const PAD = 2.5;
const TITLE_H = 5;
const NUMBER_W = 7;
const FIELD_H = 8;
const FIELD_GAP = 2;
const FIELD_LABEL_W = 20;
const SID_BOX_H = 6.5;
const SID_BOX_GAP = 1.5;
const CHAR_W_EM = 0.52; // average Helvetica glyph advance in em, used for wrap estimates
const LINE_HEIGHT = 1.3;

const CORNERS = ['tl', 'tr', 'br', 'bl'];
const CHARSETS = new Set(['any', 'digits', 'alpha', 'upper', 'alnum']);

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TemplateError(`${name} must be a positive number (got ${JSON.stringify(value)})`);
  return n;
}

function positiveInt(value, name) {
  const n = positiveNumber(value, name);
  if (!Number.isInteger(n)) throw new TemplateError(`${name} must be an integer (got ${value})`);
  return n;
}

function parseGap(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function resolveChoices(zone) {
  if (zone.type === 'truefalse') {
    const c = zone.choices ?? ['T', 'F'];
    if (!Array.isArray(c) || c.length !== 2) throw new TemplateError(`Zone "${zone.id}": truefalse choices must be a 2-item array`);
    return c.map(String);
  }
  const raw = zone.choices ?? 'ABCD';
  let choices;
  if (typeof raw === 'number') choices = Array.from({ length: positiveInt(raw, `Zone "${zone.id}" choices`) }, (_, i) => String.fromCharCode(65 + i));
  else if (typeof raw === 'string') choices = [...raw];
  else if (Array.isArray(raw)) choices = raw.map(String);
  else throw new TemplateError(`Zone "${zone.id}": choices must be a string, number or array`);
  if (choices.length < 2 || choices.length > 10) throw new TemplateError(`Zone "${zone.id}": 2-10 choices are supported`);
  if (new Set(choices).size !== choices.length) throw new TemplateError(`Zone "${zone.id}": duplicate choice labels`);
  return choices;
}

/** Rough wrapped line count for a text block rendered at `fontSize` mm in `width` mm. */
export function estimateLines(text, fontSize, width) {
  const perLine = Math.max(1, Math.floor(width / (fontSize * CHAR_W_EM)));
  return String(text ?? '')
    .split('\n')
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

/** Bubble centre for a grid cell: horizontally centred, vertically centred in the first pitchY of the row. */
function bubbleCenter(grid, row, col, pitchY) {
  const effectivePitchY = pitchY ?? grid.pitchY ?? grid.rows[row];
  const cx = grid.x + sum(grid.columns.slice(0, col)) + grid.columns[col] / 2;
  const cy = grid.y + sum(grid.rows.slice(0, row)) + effectivePitchY / 2;
  return { cx: r3(cx), cy: r3(cy) };
}

function makeGrid(x, y, columns, rows, pitchY) {
  const g = { x: r3(x), y: r3(y), columns: columns.map(r3), rows: rows.map(r3), cells: [] };
  if (pitchY != null) g.pitchY = r3(pitchY);
  return g;
}

export function normalizeTemplate(input) {
  if (!isPlainObject(input)) throw new TemplateError('Template must be a JSON object');
  const tpl = deepMerge(DEFAULTS, input);
  tpl.paper = PAPER_ALIASES[String(tpl.paper).toLowerCase()] ?? tpl.paper;
  if (!PAPER_SIZES[tpl.paper]) throw new TemplateError(`Unsupported paper "${input.paper}" (use A4 or Letter)`);
  if (!tpl.id || typeof tpl.id !== 'string') throw new TemplateError('Template requires a string "id"');
  if (!Array.isArray(tpl.zones)) throw new TemplateError('Template requires a "zones" array');
  positiveNumber(tpl.margin, 'margin');
  positiveNumber(tpl.fiducial.size, 'fiducial.size');
  positiveNumber(tpl.fiducial.inset, 'fiducial.inset');
  for (const k of ['diameter', 'pitchX', 'pitchY']) positiveNumber(tpl.bubble[k], `bubble.${k}`);
  if (tpl.bubble.diameter >= Math.min(tpl.bubble.pitchX, tpl.bubble.pitchY)) {
    throw new TemplateError('bubble.diameter must be smaller than both pitches (bubbles would touch)');
  }
  if ((input.midlineFiducials === true || input.fiducials === 6) && (!input.fiducial || !input.fiducial.ids || input.fiducial.ids.length === 4)) {
    tpl.fiducial = { ...tpl.fiducial, ids: [0, 1, 4, 5, 2, 3] };
  }
  const ids = tpl.fiducial.ids;
  if (!Array.isArray(ids) || (ids.length !== 4 && ids.length !== 6) || ids.some((id) => !SUPPORTED_MARKER_IDS.includes(id)) || new Set(ids).size !== ids.length) {
    throw new TemplateError(`fiducial.ids must be 4 or 6 distinct ids from [${SUPPORTED_MARKER_IDS.join(', ')}]`);
  }
  return tpl;
}

// ---------------------------------------------------------------------------
// Zone layout functions. Each returns { bbox, grids, groups, rois, extra }.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

function layoutStudentId(zone, ctx, x, y, availW) {
  const { bubble } = ctx.tpl;
  // Student ID digits are always standardized to 8
  const digits = 8;
  const colW = Math.max(bubble.pitchX, 6);
  const titleH = zone.label === '' ? 0 : TITLE_H;
  const shading = zone.shading !== false && zone.mode !== 'ocr' && zone.mode !== 'digits';
  // Student ID is always full width across printable area
  const w = zone.w ?? availW ?? (2 * PAD + digits * colW);

  if (!shading) {
    // Pure digit write-in boxes (image number recognition, no 10-row shading matrix)
    const boxH = zone.boxHeight ?? SID_BOX_H;
    const gridW = digits * colW;
    const boxX = x + (w - gridW) / 2;
    const boxY = y + PAD + titleH;
    const grid = makeGrid(boxX, boxY, Array(digits).fill(colW), [boxH]);
    for (let d = 0; d < digits; d += 1) {
      grid.cells.push({ row: 0, col: d, kind: 'box' });
    }
    const roi = {
      id: zone.id,
      key: zone.id,
      label: zone.label || 'ID no.',
      role: 'student_id',
      x: r3(boxX),
      y: r3(boxY),
      w: r3(gridW),
      h: r3(boxH),
      charset: 'digits',
      multiline: false,
      ocr: true,
      graded: false,
      points: 0,
      digits,
    };
    const h = 2 * PAD + titleH + boxH;
    return { bbox: { x, y, w, h }, grids: [grid], groups: [], rois: [roi], extra: { digits, shading: false } };
  }

  // Shading bubble matrix mode
  const rows = [SID_BOX_H, SID_BOX_GAP, ...Array(10).fill(bubble.pitchY)];
  const gridW = digits * colW;
  const grid = makeGrid(x + (w - gridW) / 2, y + PAD + titleH, Array(digits).fill(colW), rows, bubble.pitchY);
  const groups = [];
  for (let d = 0; d < digits; d += 1) {
    grid.cells.push({ row: 0, col: d, kind: 'box' });
    const options = [];
    for (let v = 0; v <= 9; v += 1) {
      grid.cells.push({ row: v + 2, col: d, kind: 'bubble', text: String(v) });
      options.push({ value: String(v), ...bubbleCenter(grid, v + 2, d, bubble.pitchY) });
    }
    groups.push({ key: `${zone.id}[${d}]`, kind: 'sid', label: `ID digit ${d + 1}`, index: d, options });
  }
  const h = 2 * PAD + titleH + sum(rows);
  return { bbox: { x, y, w, h }, grids: [grid], groups, rois: [], extra: { digits, shading: true } };
}

function layoutChoices(zone, ctx, x, y, availW) {
  const { bubble } = ctx.tpl;
  const kind = zone.type === 'truefalse' ? 'tf' : 'mcq';
  const choices = resolveChoices(zone);
  const count = positiveInt(zone.count, `Zone "${zone.id}" count`);
  const start = zone.start == null ? ctx.nextQuestion : positiveInt(zone.start, `Zone "${zone.id}" start`);
  const numberW = zone.numberWidth ?? NUMBER_W;
  const blockW = numberW + choices.length * bubble.pitchX;
  const minBlockGap = 4;
  const titleH = zone.label ? TITLE_H : 0;

  let columns = zone.columns == null ? null : positiveInt(zone.columns, `Zone "${zone.id}" columns`);
  const targetW = zone.w ?? null;
  if (columns == null) {
    const usable = (targetW ?? availW) - 2 * PAD;
    columns = Math.max(1, Math.min(count, Math.floor((usable + minBlockGap) / (blockW + minBlockGap))));
  }
  const rowsPerCol = Math.ceil(count / columns);
  const naturalW = 2 * PAD + columns * blockW + (columns - 1) * minBlockGap;
  const w = targetW ?? naturalW;
  if (w + 0.01 < naturalW) ctx.warn(`Zone "${zone.id}": width ${w}mm is narrower than the ${r3(naturalW)}mm required for ${columns} column(s)`);

  const usable = w - 2 * PAD;
  let blockPitch = 0;
  let startColX = x + PAD;

  if (columns > 1) {
    const rawGap = (usable - columns * blockW) / (columns - 1);
    const maxAestheticGap = 24;
    const minAestheticGap = 4;
    if (rawGap > maxAestheticGap) {
      // Aesthetic optimization: clamp excessive whitespace and center column group
      const balancedGap = Math.min(maxAestheticGap, Math.max(minAestheticGap, usable * 0.08));
      const groupW = columns * blockW + (columns - 1) * balancedGap;
      startColX = x + PAD + (usable - groupW) / 2;
      blockPitch = blockW + balancedGap;
    } else {
      blockPitch = (usable - blockW) / (columns - 1);
    }
  }

  const customRowGap = parseGap(zone.rowGap ?? zone.rowSpacing ?? zone.itemSpacing);
  const basePitchY = customRowGap != null ? (bubble.diameter + customRowGap) : bubble.pitchY;
  const rowHeights = Array.from({ length: rowsPerCol }, (_, r) => {
    const groupBreak = bubble.groupEvery > 0 && (r + 1) % bubble.groupEvery === 0 && r < rowsPerCol - 1;
    return basePitchY + (groupBreak ? bubble.groupGap : 0);
  });

  const grids = [];
  const groups = [];
  for (let c = 0; c < columns; c += 1) {
    const grid = makeGrid(startColX + c * blockPitch, y + PAD + titleH, [numberW, ...choices.map(() => bubble.pitchX)], rowHeights, basePitchY);
    for (let r = 0; r < rowsPerCol; r += 1) {
      const idx = c * rowsPerCol + r; // column-major numbering, the convention on paper answer sheets
      if (idx >= count) break;
      const q = start + idx;
      grid.cells.push({ row: r, col: 0, kind: 'num', text: String(q) });
      const options = choices.map((choice, j) => {
        grid.cells.push({ row: r, col: j + 1, kind: 'bubble', text: choice });
        return { value: choice, ...bubbleCenter(grid, r, j + 1, basePitchY) };
      });
      const points = Number(zone.pointsPerItem ?? zone.points ?? 1);
      groups.push({ key: String(q), kind, label: String(q), options, points });
    }
    grids.push(grid);
  }
  ctx.nextQuestion = start + count;
  const h = 2 * PAD + titleH + sum(rowHeights);
  const pointsPerItem = Number(zone.pointsPerItem ?? zone.points ?? 1);
  return { bbox: { x, y, w, h }, grids, groups, rois: [], extra: { choices, start, count, columns, pointsPerItem, ...(zone.showPoints !== undefined ? { showPoints: zone.showPoints } : {}), ...(customRowGap != null ? { rowGap: customRowGap } : {}) } };
}

function layoutModifiedTrueFalse(zone, ctx, x, y, availW) {
  const { bubble } = ctx.tpl;
  const count = positiveInt(zone.count, `Zone "${zone.id}" count`);
  const start = zone.start == null ? ctx.nextQuestion : positiveInt(zone.start, `Zone "${zone.id}" start`);
  const numberW = zone.numberWidth ?? NUMBER_W;
  const choices = ['T', 'F'];
  const bubbleBlockW = numberW + choices.length * bubble.pitchX;
  const customBoxH = zone.boxHeight ?? zone.fieldHeight;
  const customBoxW = zone.boxWidth ?? zone.correctionWidth ?? zone.corrWidth;
  const correctionW = customBoxW ?? 45;
  const blockW = bubbleBlockW + correctionW + 2.5;
  const titleH = zone.label ? TITLE_H : 0;

  let columns = zone.columns == null ? 1 : positiveInt(zone.columns, `Zone "${zone.id}" columns`);
  const targetW = zone.w ?? availW;
  const rowsPerCol = Math.ceil(count / columns);
  const minBlockGap = 4;
  const naturalW = 2 * PAD + columns * blockW + (columns - 1) * minBlockGap;
  const w = targetW ?? naturalW;

  const usable = w - 2 * PAD;
  let blockPitch = 0;
  let startColX = x + PAD;

  if (columns > 1) {
    const rawGap = (usable - columns * blockW) / (columns - 1);
    const maxAestheticGap = 24;
    if (rawGap > maxAestheticGap) {
      const balancedGap = Math.min(maxAestheticGap, Math.max(minBlockGap, usable * 0.08));
      const groupW = columns * blockW + (columns - 1) * balancedGap;
      startColX = x + PAD + (usable - groupW) / 2;
      blockPitch = blockW + balancedGap;
    } else {
      blockPitch = (usable - blockW) / (columns - 1);
    }
  }

  const customRowGap = parseGap(zone.rowGap ?? zone.rowSpacing ?? zone.itemSpacing);
  const rowH = customRowGap != null
    ? Math.max(bubble.diameter, customBoxH ?? 5) + customRowGap
    : Math.max(bubble.pitchY, customBoxH ? customBoxH + 1.2 : 7);
  const rowHeights = Array(rowsPerCol).fill(rowH);

  const grids = [];
  const groups = [];
  const rois = [];

  for (let c = 0; c < columns; c += 1) {
    const colX = startColX + c * blockPitch;
    const grid = makeGrid(colX, y + PAD + titleH, [numberW, bubble.pitchX, bubble.pitchX], rowHeights, rowH);

    for (let r = 0; r < rowsPerCol; r += 1) {
      const idx = c * rowsPerCol + r;
      if (idx >= count) break;
      const q = start + idx;

      grid.cells.push({ row: r, col: 0, kind: 'num', text: String(q) });
      const options = choices.map((choice, j) => {
        grid.cells.push({ row: r, col: j + 1, kind: 'bubble', text: choice });
        return { value: choice, ...bubbleCenter(grid, r, j + 1, rowH) };
      });
      const points = Number(zone.pointsPerItem ?? zone.points ?? 1);
      groups.push({ key: String(q), kind: 'tf', label: String(q), options, points });

      const boxH = customBoxH ?? (rowH - (customRowGap ?? 1.2));
      const boxX = colX + bubbleBlockW + 1.5;
      const boxY = y + PAD + titleH + r * rowH + (rowH - boxH) / 2;

      rois.push({
        id: `${zone.id}.${q}.correction`,
        key: `${q}_corr`,
        label: `${q} Correction`,
        role: 'correction',
        x: r3(boxX),
        y: r3(boxY),
        w: r3(correctionW),
        h: r3(boxH),
        charset: 'any',
        multiline: false,
        ocr: true,
        graded: zone.graded !== false,
        points: zone.correctionPoints ?? 1,
      });
    }
    grids.push(grid);
  }

  ctx.nextQuestion = start + count;
  const h = 2 * PAD + titleH + sum(rowHeights);
  const pointsPerItem = Number(zone.pointsPerItem ?? zone.points ?? 1);
  return { bbox: { x, y, w, h }, grids, groups, rois, extra: { start, count, columns, isModified: true, pointsPerItem, ...(zone.showPoints !== undefined ? { showPoints: zone.showPoints } : {}), ...(customRowGap != null ? { rowGap: customRowGap } : {}) } };
}

function layoutFields(zone, ctx, x, y, availW) {
  const fields = zone.fields;
  if (!Array.isArray(fields) || fields.length === 0) throw new TemplateError(`Zone "${zone.id}": "fields" must be a non-empty array`);
  const titleH = zone.label ? TITLE_H : 0;
  // Student details always span the full available content width
  const w = availW ?? zone.w;
  const fieldH = zone.fieldHeight ?? 7.5;
  const gapY = parseGap(zone.rowGap ?? zone.rowSpacing ?? zone.gapY) ?? 2;
  const innerW = w - 2 * PAD;

  // Group fields into rows (supports explicit columns or row property)
  let rowGroups = [];
  if (zone.columns && zone.columns > 0) {
    const cols = zone.columns;
    for (let i = 0; i < fields.length; i += cols) {
      rowGroups.push(fields.slice(i, i + cols));
    }
  } else {
    const hasExplicitRows = fields.some((f) => f.row !== undefined);
    if (hasExplicitRows) {
      const map = new Map();
      for (const f of fields) {
        const r = f.row ?? 0;
        if (!map.has(r)) map.set(r, []);
        map.get(r).push(f);
      }
      const sortedKeys = [...map.keys()].sort((a, b) => a - b);
      rowGroups = sortedKeys.map((k) => map.get(k));
    } else {
      rowGroups = fields.map((f) => [f]);
    }
  }

  const rows = [];
  const rois = [];
  let curY = y + PAD + titleH;

  for (let rIdx = 0; rIdx < rowGroups.length; rIdx += 1) {
    const group = rowGroups[rIdx];
    const nFields = group.length;
    const interGap = 3;
    const totalGap = (nFields - 1) * interGap;
    const availRowW = innerW - totalGap;

    const specifiedW = group.reduce((acc, f) => acc + (f.w ?? 0), 0);
    const unspecCount = group.filter((f) => !f.w).length;
    const scale = (unspecCount === 0 && specifiedW > 0) ? (availRowW / specifiedW) : 1;
    const defaultW = unspecCount > 0 ? (availRowW - specifiedW) / unspecCount : 0;

    let curX = x + PAD;
    for (let cIdx = 0; cIdx < group.length; cIdx += 1) {
      const field = group[cIdx];
      if (!field.id) throw new TemplateError(`Zone "${zone.id}": every field needs an "id"`);
      // Last field in row absorbs sub-millimeter rounding so row is strictly full-width
      const isLastInRow = cIdx === group.length - 1;
      const fieldTotalW = isLastInRow
        ? Math.max(10, r3((x + PAD + innerW) - curX))
        : (field.w ? r3(field.w * scale) : defaultW);
      const labelW = field.labelWidth ?? Math.min(22, Math.max(10, (field.label ?? field.id).length * 2.8));
      const boxW = Math.max(10, fieldTotalW - labelW);
      const isSid = field.id === 'sid' || field.role === 'student_id' || (field.digits != null && field.digits > 0);
      const digits = isSid ? 8 : (field.digits ?? 0);

      rows.push({
        label: field.label ?? field.id,
        x: r3(curX),
        y: r3(curY),
        labelW: r3(labelW),
        h: fieldH,
        digits,
      });

      rois.push({
        id: `${zone.id}.${field.id}`,
        key: field.id,
        label: field.label ?? field.id,
        role: field.role ?? (field.id === 'name' ? 'name' : field.id === 'score' ? 'score' : isSid ? 'student_id' : null),
        x: r3(curX + labelW),
        y: r3(curY),
        w: r3(boxW),
        h: fieldH,
        charset: CHARSETS.has(field.charset) ? field.charset : isSid ? 'digits' : 'any',
        multiline: false,
        ocr: field.ocr !== false && field.role !== 'score' && field.id !== 'score',
        graded: false,
        points: 0,
        digits,
      });

      curX += fieldTotalW + interGap;
    }
    curY += fieldH + gapY;
  }

  const h = curY - gapY + PAD - y;
  const customRowGap = parseGap(zone.rowGap ?? zone.rowSpacing);
  return { bbox: { x, y, w, h }, grids: [], groups: [], rois, extra: { rows, fieldH, ...(customRowGap != null ? { rowGap: customRowGap } : (zone.gapY != null ? { rowGap: gapY } : {})) } };
}

function layoutInstructions(zone, ctx, x, y, availW) {
  const { typography } = ctx.tpl;
  const w = zone.w ?? availW;
  const fontSize = zone.fontSize ?? typography.body;
  const lines = estimateLines(zone.text, fontSize, w - 2);
  const h = 2 + lines * fontSize * LINE_HEIGHT;
  return { bbox: { x, y, w, h }, grids: [], groups: [], rois: [], extra: { text: String(zone.text ?? ''), fontSize, lines } };
}

function layoutText(zone, ctx, x, y, availW) {
  const { typography } = ctx.tpl;
  const w = zone.w ?? availW;
  const innerW = w - 2 * PAD;
  const boxH = zone.boxHeight ?? 8;
  positiveNumber(boxH, `Zone "${zone.id}" boxHeight`);
  const count = positiveInt(zone.count ?? 1, `Zone "${zone.id}" count`);
  const points = Number(zone.pointsPerItem ?? zone.points ?? 1);
  const rowGap = parseGap(zone.rowGap ?? zone.rowSpacing ?? zone.itemSpacing) ?? 3;

  // Single-item legacy prompt box (backwards-compatible: only when unnumbered prompt of type 'text' without count or start from builder)
  const isLegacyPrompt = zone.type === 'text' && zone.start == null && zone.count == null;
  if (isLegacyPrompt && count <= 1) {
    const rawPrompt = String(zone.label ?? '');
    const isNum = /^\d+[\.\)]?$/.test(rawPrompt.trim());
    const prompt = isNum ? rawPrompt.trim().replace(/[\.\)]+$/, '') : rawPrompt;
    const isInline = zone.inlineLabel ?? (prompt.length <= 10 || boxH <= 10);
    let promptH = 0;
    let boxX = x + PAD;
    let boxY = y + PAD;
    let boxW = innerW;
    let labelW = 0;
    let maxBoxW = innerW;

    if (isInline && prompt) {
      labelW = zone.labelWidth ?? Math.min(18, Math.max(5, prompt.length * 2.8));
      boxX = x + PAD + labelW;
      maxBoxW = innerW - labelW;
      boxW = zone.boxWidth != null ? Math.max(12, Math.min(maxBoxW, Number(zone.boxWidth))) : maxBoxW;
    } else if (prompt) {
      const promptLines = estimateLines(prompt, typography.label, innerW);
      promptH = promptLines * typography.label * LINE_HEIGHT;
      boxY = y + PAD + promptH + (rowGap > 0 ? rowGap : 1.5);
      maxBoxW = innerW;
      boxW = zone.boxWidth != null ? Math.max(12, Math.min(innerW, Number(zone.boxWidth))) : innerW;
    } else {
      maxBoxW = innerW;
      boxW = zone.boxWidth != null ? Math.max(12, Math.min(innerW, Number(zone.boxWidth))) : innerW;
    }

    const roi = {
      id: zone.id,
      key: zone.key ?? (zone.start != null ? String(zone.start) : zone.id),
      label: prompt || zone.id,
      role: null,
      x: r3(boxX),
      y: r3(boxY),
      w: r3(boxW),
      h: r3(boxH),
      charset: CHARSETS.has(zone.charset) ? zone.charset : 'any',
      multiline: zone.multiline ?? boxH > 15,
      ocr: true,
      graded: zone.graded !== false,
      points,
    };
    const startNum = zone.start ?? (isNum ? parseInt(prompt, 10) : ctx.nextQuestion);
    ctx.nextQuestion = startNum + 1;
    const h = (isInline ? y + PAD + boxH + PAD : boxY + boxH + PAD) - y;
    return {
      bbox: { x, y, w, h },
      grids: [],
      groups: [],
      rois: [roi],
      extra: {
        prompt,
        points,
        pointsPerItem: points,
        isInline,
        labelW,
        count: 1,
        start: startNum,
        boxWidth: zone.boxWidth,
        maxBoxW: Math.floor(maxBoxW),
        boxHeight: boxH,
        rowGap,
        ...(zone.showPoints !== undefined ? { showPoints: zone.showPoints } : {}),
      },
    };
  }

  // Multi-item / structured module (e.g. 5 or 10 short answer items in 1, 2, or 3 columns, or essay questions)
  const titleH = zone.label ? TITLE_H : 0;
  const titleGap = zone.label ? (rowGap > 0 ? rowGap : 1.5) : 0;
  const start = zone.start == null ? ctx.nextQuestion : positiveInt(zone.start, `Zone "${zone.id}" start`);
  const columns = Math.max(1, zone.columns ? positiveInt(zone.columns, `Zone "${zone.id}" columns`) : 1);
  const rowsPerCol = Math.ceil(count / columns);
  const interColGap = 4;
  const colW = (innerW - (columns - 1) * interColGap) / columns;
  let maxBoxW = colW;

  const items = [];
  const rois = [];

  for (let c = 0; c < columns; c += 1) {
    const colX = x + PAD + c * (colW + interColGap);
    for (let r = 0; r < rowsPerCol; r += 1) {
      const idx = c * rowsPerCol + r;
      if (idx >= count) break;
      const q = start + idx;
      const itemY = y + PAD + titleH + titleGap + r * (boxH + rowGap);
      const qLabel = `${q}`;
      const labelW = Math.max(5, qLabel.length * 2.8);
      const itemBoxX = colX + labelW;
      maxBoxW = colW - labelW;
      const itemBoxW = zone.boxWidth != null ? Math.max(12, Math.min(maxBoxW, Number(zone.boxWidth))) : Math.max(12, maxBoxW);

      const roi = {
        id: `${zone.id}.${q}`,
        key: String(q),
        label: qLabel,
        role: null,
        x: r3(itemBoxX),
        y: r3(itemY),
        w: r3(itemBoxW),
        h: r3(boxH),
        charset: CHARSETS.has(zone.charset) ? zone.charset : 'any',
        multiline: zone.multiline ?? boxH > 15,
        ocr: true,
        graded: zone.graded !== false,
        points,
      };
      rois.push(roi);
      items.push({
        id: roi.id,
        q,
        label: qLabel,
        labelX: r3(colX),
        labelY: r3(itemY),
        labelW: r3(labelW),
        boxX: r3(itemBoxX),
        boxY: r3(itemY),
        boxW: r3(itemBoxW),
        boxH: r3(boxH),
      });
    }
  }

  ctx.nextQuestion = start + count;
  const h = 2 * PAD + titleH + titleGap + rowsPerCol * (boxH + rowGap) - rowGap;
  return {
    bbox: { x, y, w, h },
    grids: [],
    groups: [],
    rois,
    extra: {
      count,
      start,
      columns,
      boxHeight: boxH,
      boxWidth: zone.boxWidth,
      maxBoxW: Math.floor(maxBoxW),
      pointsPerItem: points,
      items,
      rowGap,
      ...(zone.showPoints !== undefined ? { showPoints: zone.showPoints } : {}),
    },
  };
}

const ZONE_LAYOUTS = {
  student_id: layoutStudentId,
  mcq: layoutChoices,
  truefalse: layoutChoices,
  modified_tf: layoutModifiedTrueFalse,
  fields: layoutFields,
  instructions: layoutInstructions,
  text: layoutText,
  text_short: layoutText,
  text_essay: layoutText,
};

export const ZONE_TYPES = Object.freeze(Object.keys(ZONE_LAYOUTS));

function intersects(a, b, tolerance = 0.01) {
  return a.x + tolerance < b.x + b.w && b.x + tolerance < a.x + a.w && a.y + tolerance < b.y + b.h && b.y + tolerance < a.y + a.h;
}

/**
 * Resolve a template into absolute geometry.
 * @param {object} input template payload
 * @returns {object} resolved layout (see LAYOUT_SCHEMA)
 */
export function buildLayout(input) {
  const tpl = normalizeTemplate(input);
  const page = { paper: tpl.paper, ...PAPER_SIZES[tpl.paper] };
  const { size, inset, quietZone } = tpl.fiducial;
  const warnings = [];

  const fiducials = tpl.fiducial.ids.map((id, i) => {
    let corner;
    let fx, fy;
    if (tpl.fiducial.ids.length === 6) {
      const posMap = ['tl', 'tr', 'ml', 'mr', 'br', 'bl'];
      corner = posMap[i] || 'c';
      const midY = (page.height - size) / 2;
      if (corner === 'tl') { fx = inset; fy = inset; }
      else if (corner === 'tr') { fx = page.width - inset - size; fy = inset; }
      else if (corner === 'ml') { fx = inset; fy = midY; }
      else if (corner === 'mr') { fx = page.width - inset - size; fy = midY; }
      else if (corner === 'br') { fx = page.width - inset - size; fy = page.height - inset - size; }
      else { fx = inset; fy = page.height - inset - size; }
    } else {
      corner = CORNERS[i];
      fx = corner === 'tl' || corner === 'bl' ? inset : page.width - inset - size;
      fy = corner === 'tl' || corner === 'tr' ? inset : page.height - inset - size;
    }
    return {
      id,
      corner,
      x: r3(fx),
      y: r3(fy),
      size,
      center: [r3(fx + size / 2), r3(fy + size / 2)],
      // Marker-local corner order used by OpenCV ArUco: TL, TR, BR, BL.
      corners: [[fx, fy], [fx + size, fy], [fx + size, fy + size], [fx, fy + size]].map((p) => p.map(r3)),
    };
  });

  const hasMidlineFiducials = Array.isArray(tpl.fiducial.ids) && tpl.fiducial.ids.length === 6;
  const minLateralMargin = Math.max(21, inset + size + quietZone + 1);
  const effectiveMargin = hasMidlineFiducials ? Math.max(tpl.margin, minLateralMargin) : tpl.margin;
  const contentTop = inset + size + 3;
  const contentBottom = page.height - inset - size - 3;
  const content = { x: effectiveMargin, y: r3(contentTop), w: r3(page.width - 2 * effectiveMargin), h: r3(contentBottom - contentTop) };
  const contentRight = content.x + content.w;

  const ctx = { tpl, nextQuestion: 1, warn: (m) => warnings.push(m) };
  const zones = [];
  const seenZoneIds = new Set();
  const seenKeys = new Map();
  const halfW = r3((content.w - tpl.gap) / 2);
  let leftColBottom = content.y;
  let rightColBottom = content.y;
  let rowBottom = content.y;
  let rowTop = content.y;
  let prev = null;

  for (const raw of tpl.zones) {
    if (!isPlainObject(raw)) throw new TemplateError('Every zone must be an object');
    const layoutFn = ZONE_LAYOUTS[raw.type];
    if (!layoutFn) throw new TemplateError(`Unknown zone type "${raw.type}" (expected one of ${ZONE_TYPES.join(', ')})`);
    if (!raw.id || typeof raw.id !== 'string') throw new TemplateError(`A "${raw.type}" zone is missing a string "id"`);
    if (seenZoneIds.has(raw.id)) throw new TemplateError(`Duplicate zone id "${raw.id}"`);
    seenZoneIds.add(raw.id);

    const isFullWidthZone = raw.type === 'fields' || raw.type === 'student_id';
    let isHalfLeft = !isFullWidthZone && (raw.layout === 'half-left' || raw.side === 'left' || raw.placement === 'left');
    let isHalfRight = !isFullWidthZone && (raw.layout === 'half-right' || raw.side === 'right' || raw.placement === 'right');

    // Auto-coerce compact modules to side-by-side if placement is not explicitly 'full' and width is not locked
    const isExplicitFull = raw.layout === 'full' || raw.placement === 'full' || raw.w != null;
    if (!isFullWidthZone && !isHalfLeft && !isHalfRight && !isExplicitFull) {
      if (raw.type === 'mcq' || raw.type === 'truefalse') {
        const count = Number(raw.count || 20);
        const cols = raw.columns ? Number(raw.columns) : null;
        if (count <= 12 || (cols && cols <= 2 && count <= 16)) {
          if (rightColBottom + 0.1 < leftColBottom) {
            isHalfRight = true;
          } else {
            isHalfLeft = true;
          }
        }
      }
    }

    let x, y, availW;
    if (isHalfLeft) {
      x = raw.x ?? content.x;
      y = raw.y ?? (leftColBottom > content.y ? leftColBottom + tpl.gap : content.y);
      rowTop = y;
      availW = halfW;
    } else if (isHalfRight) {
      x = raw.x ?? r3(content.x + halfW + tpl.gap);
      if (raw.y != null) {
        y = raw.y;
      } else if (rightColBottom + 0.1 < leftColBottom) {
        y = rightColBottom > content.y ? (rightColBottom <= rowTop ? rowTop : rightColBottom + tpl.gap) : rowTop;
      } else {
        y = rightColBottom > content.y ? rightColBottom + tpl.gap : content.y;
      }
      availW = halfW;
    } else {
      const inline = Boolean(!isFullWidthZone && raw.inline && prev);
      const rowStart = Math.max(leftColBottom, rightColBottom);
      x = raw.x ?? (inline ? prev.bbox.x + prev.bbox.w + tpl.gap : content.x);
      y = raw.y ?? (inline ? prev.bbox.y : (rowStart > content.y ? rowStart + tpl.gap : content.y));
      rowTop = y;
      availW = isFullWidthZone ? content.w : (contentRight - x);
    }

    let effectiveRaw = (isHalfLeft || isHalfRight) && raw.w == null ? { ...raw, w: halfW } : raw;
    if (hasMidlineFiducials) {
      const clampedW = effectiveRaw.w != null ? Math.min(effectiveRaw.w, content.w) : null;
      const clampedX = effectiveRaw.x != null ? Math.max(effectiveRaw.x, content.x) : null;
      effectiveRaw = {
        ...effectiveRaw,
        ...(clampedW != null ? { w: clampedW } : {}),
        ...(clampedX != null ? { x: clampedX } : {})
      };
      if (x < content.x) x = content.x;
      if (availW > content.w) availW = content.w;
    }
    const res = layoutFn(effectiveRaw, ctx, x, y, availW);
    const bbox = { x: r3(res.bbox.x), y: r3(res.bbox.y), w: r3(res.bbox.w), h: r3(res.bbox.h) };

    for (const g of res.groups) {
      if (seenKeys.has(g.key)) {
        warnings.push(`Item key "${g.key}" in zone "${raw.id}" duplicates key in zone "${seenKeys.get(g.key)}"`);
      } else {
        seenKeys.set(g.key, raw.id);
      }
    }
    for (const roi of res.rois) {
      if (roi.graded && seenKeys.has(roi.key)) {
        warnings.push(`Item key "${roi.key}" in zone "${raw.id}" duplicates key in zone "${seenKeys.get(roi.key)}"`);
      } else if (roi.graded) {
        seenKeys.set(roi.key, raw.id);
      }
    }

    if (bbox.x < content.x - 0.01 || bbox.x + bbox.w > contentRight + 0.01 || bbox.y < content.y - 0.01 || bbox.y + bbox.h > contentBottom + 0.01) {
      warnings.push(`Zone "${raw.id}" extends outside the printable content area (${r3(bbox.x)},${r3(bbox.y)} ${r3(bbox.w)}x${r3(bbox.h)} mm)`);
    }
    for (const other of zones) {
      if (intersects(bbox, other.bbox)) warnings.push(`Zone "${raw.id}" overlaps zone "${other.id}"`);
    }
    for (const f of fiducials) {
      const q = { x: f.x - quietZone, y: f.y - quietZone, w: size + 2 * quietZone, h: size + 2 * quietZone };
      if (intersects(bbox, q)) warnings.push(`Zone "${raw.id}" intrudes on the quiet zone of fiducial ${f.id} (${f.corner})`);
    }

    const isLegacyPrompt = raw.type === 'text' && raw.start == null && raw.count == null;
    const isNumericPrompt = isLegacyPrompt && /^\d+[\.\)]?$/.test(String(raw.label ?? '').trim());
    const zone = {
      id: raw.id,
      type: raw.type,
      label: isNumericPrompt ? '' : String(raw.label ?? ''),
      bbox,
      grids: res.grids,
      groups: res.groups,
      rois: res.rois,
      ...res.extra,
      ...(raw.showPoints !== undefined ? { showPoints: raw.showPoints } : {}),
    };
    zones.push(zone);
    if (isHalfLeft) {
      leftColBottom = bbox.y + bbox.h;
    } else if (isHalfRight) {
      rightColBottom = bbox.y + bbox.h;
    } else {
      leftColBottom = bbox.y + bbox.h;
      rightColBottom = bbox.y + bbox.h;
    }
    rowBottom = Math.max(leftColBottom, rightColBottom);
    prev = zone;
  }

  if (zones.filter((z) => z.type === 'student_id').length > 1) warnings.push('More than one student_id zone; only the first is used for roster matching');
  const hasSid = zones.some((z) => z.type === 'student_id' || (z.rois && z.rois.some((r) => r.role === 'student_id')));
  if (!hasSid) warnings.push('No student_id zone: scans cannot be matched to the roster');

  const titleMaxW = page.width - 2 * (inset + size + 4);
  return {
    schema: LAYOUT_SCHEMA,
    generator: GENERATOR,
    templateId: tpl.id,
    title: String(tpl.title ?? ''),
    units: 'mm',
    page,
    content,
    fiducial: { type: 'aruco', dictionary: tpl.fiducial.dictionary, size, inset, quietZone },
    fiducials,
    bubble: { ...tpl.bubble },
    typography: { ...tpl.typography },
    header: {
      title: { x: r3(page.width / 2), y: r3(inset + size / 2), maxWidth: r3(titleMaxW) },
      footer: { text: `${tpl.footer} · ${tpl.id}`, x: r3(page.width / 2), y: r3(page.height - inset - size / 2), maxWidth: r3(titleMaxW) },
    },
    zones,
    warnings,
  };
}

/** Flat list of every bubble group (student ID digits + questions) in layout order. */
export function allGroups(layout) {
  return (layout.zones || []).flatMap((z) => (z.groups || []).map((g) => ({ ...g, zoneId: z.id })));
}

/** Summary counts for UI display. */
export function layoutStats(layout) {
  const groups = allGroups(layout);
  const sidZone = (layout.zones || []).find((z) => z.type === 'student_id');
  const zoneRois = (layout.zones || []).flatMap((z) => z.rois ?? []);
  const allRois = (layout.rois && Array.isArray(layout.rois))
    ? [...new Map([...zoneRois, ...layout.rois].map((r) => [r.id || r.key, r])).values()]
    : zoneRois;
  const sidRoi = allRois.find((r) => r.role === 'student_id');
  const idDigits = sidZone ? (sidZone.digits ?? groups.filter((g) => g.kind === 'sid').length) : (sidRoi?.digits ?? 0);
  const bubbleQuestions = groups.filter((g) => g.kind !== 'sid').length;
  const gradedRois = allRois.filter((r) => r && r.graded);
  const textQuestions = gradedRois.filter((r) => r.role !== 'student_id' && r.role !== 'correction').length;
  return {
    questions: bubbleQuestions,
    bubbles: groups.reduce((n, g) => n + (g.options || []).length, 0),
    textRegions: gradedRois.length,
    textQuestions,
    totalQuestions: bubbleQuestions + textQuestions,
    idDigits,
  };
}
