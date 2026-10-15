/**
 * DOM renderer for resolved OMR layouts.
 *
 * The sheet is described once as a lightweight virtual-node tree and can be
 * materialised either as live DOM nodes (browser, via document.createElement)
 * or as an HTML string (Node export / standalone printable file). Bubble
 * matrices are laid out with CSS Grid using explicit millimetre track sizes
 * produced by the layout engine, so the browser's grid placement reproduces
 * the exact centres the CV pipeline samples.
 */
import { markerPath } from './aruco.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const mm = (v) => `${+Number(v).toFixed(3)}mm`;

/** Create a virtual node. */
export function h(tag, attrs = {}, ...children) {
  return { tag, attrs, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
}

function styleString(style) {
  if (!style || typeof style === 'string') return style ?? '';
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

/** Materialise a virtual node tree as real DOM nodes. */
export function toDOM(node, doc = globalThis.document, inSvg = false) {
  if (typeof node === 'string' || typeof node === 'number') return doc.createTextNode(String(node));
  const svg = inSvg || node.tag === 'svg';
  const el = svg ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, k === 'style' ? styleString(v) : String(v));
  }
  for (const child of node.children) el.appendChild(toDOM(child, doc, svg));
  return el;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Serialise a virtual node tree to an HTML string. */
export function toHTML(node) {
  if (typeof node === 'string' || typeof node === 'number') return escapeHTML(node);
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${escapeHTML(k === 'style' ? styleString(v) : v)}"`)
    .join('');
  return `<${node.tag}${attrs}>${node.children.map(toHTML).join('')}</${node.tag}>`;
}

const box = (x, y, w, hgt) => ({ left: mm(x), top: mm(y), width: mm(w), height: mm(hgt) });

function fiducialNode(f) {
  return h(
    'svg',
    {
      class: 'omr-fiducial',
      viewBox: `0 0 ${f.size} ${f.size}`,
      'shape-rendering': 'crispEdges',
      'data-aruco-id': f.id,
      'aria-label': `Registration marker ${f.corner.toUpperCase()}`,
      style: box(f.x, f.y, f.size, f.size),
    },
    h('path', { d: markerPath(f.id, f.size), fill: '#000' }),
  );
}

function gridNode(grid, layout, zone) {
  const { bubble } = layout;
  return h(
    'div',
    {
      class: 'omr-grid',
      style: {
        left: mm(grid.x),
        top: mm(grid.y),
        'grid-template-columns': grid.columns.map(mm).join(' '),
        'grid-template-rows': grid.rows.map(mm).join(' '),
      },
    },
    grid.cells.map((cell) => {
      const place = { 'grid-row': cell.row + 1, 'grid-column': cell.col + 1 };
      const curRowH = grid.rows[cell.row] ?? bubble.pitchY;
      const cellBubbleOffset = mm((curRowH - bubble.diameter) / 2);
      if (cell.kind === 'bubble') return h('span', { class: 'omr-bubble', style: { ...place, 'margin-top': cellBubbleOffset } }, cell.text);
      if (cell.kind === 'num') return h('span', { class: 'omr-num', style: { ...place, height: mm(curRowH) } }, cell.text);
      if (cell.kind === 'box') return h('span', { class: 'omr-digit-box', style: place, 'aria-label': `${zone.label} digit` });
      return null;
    }),
  );
}

function zoneNode(zone, layout, index = 0) {
  const nodes = [];
  const b = zone.bbox;
  if (zone.type === 'instructions') {
    nodes.push(h('div', {
      class: 'omr-instructions',
      'data-zone': zone.id,
      'data-zone-id': zone.id,
      'data-zone-index': index,
      'data-zone-type': zone.type,
      style: { ...box(b.x, b.y, b.w, b.h), 'font-size': mm(zone.fontSize) }
    }, zone.text));
    return nodes;
  }
  nodes.push(
    h(
      'section',
      {
        class: `omr-zone omr-zone--${zone.type}`,
        'data-zone': zone.id,
        'data-zone-id': zone.id,
        'data-zone-index': index,
        'data-zone-type': zone.type,
        style: box(b.x, b.y, b.w, b.h)
      },
      zone.label ? h('h2', { class: 'omr-zone__title' }, zone.label) : null,
    ),
  );
  for (const grid of zone.grids) nodes.push(gridNode(grid, layout, zone));
  if (zone.type === 'fields') {
    zone.rows.forEach((row, i) => {
      const roi = zone.rois[i];
      nodes.push(h('div', { class: 'omr-field-label', style: box(row.x, row.y, row.labelW, row.h) }, row.label));
      if (roi.digits > 0) {
        nodes.push(
          h(
            'div',
            {
              class: 'omr-partitioned-digits',
              'data-roi': roi.id,
              style: {
                ...box(roi.x, roi.y, roi.w, roi.h),
                display: 'grid',
                'grid-template-columns': `repeat(${roi.digits}, 1fr)`,
              },
            },
            Array.from({ length: roi.digits }, () => h('span', { class: 'omr-digit-box' })),
          ),
        );
      } else {
        nodes.push(h('div', { class: 'omr-write-box', 'data-roi': roi.id, style: box(roi.x, roi.y, roi.w, roi.h) }));
      }
    });
  }
  if (zone.type === 'modified_tf') {
    zone.rois.forEach((roi) => {
      nodes.push(
        h(
          'div',
          {
            class: 'omr-write-box omr-correction-box',
            'data-roi': roi.id,
            style: {
              ...box(roi.x, roi.y, roi.w, roi.h),
              'font-size': '1.8mm',
              color: '#888',
              display: 'flex',
              'align-items': 'center',
              'padding-left': '1mm',
            },
          },
          'if false: correction',
        ),
      );
    });
  }
  if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
    if (zone.items && zone.items.length > 0) {
      zone.items.forEach((item) => {
        nodes.push(h('div', { class: 'omr-field-label', style: box(item.labelX, item.labelY, item.labelW, item.boxH) }, item.label));
        nodes.push(h('div', { class: 'omr-write-box omr-write-box--answer', 'data-roi': item.id, style: box(item.boxX, item.boxY, item.boxW, item.boxH) }));
      });
    } else if (zone.rois && zone.rois.length > 0) {
      const roi = zone.rois[0];
      if (zone.isInline && zone.prompt) {
        nodes.push(h('div', { class: 'omr-field-label', style: box(b.x + 2.5, roi.y, zone.labelW, roi.h) }, zone.prompt));
      } else if (zone.prompt) {
        const promptH = roi.y - b.y - 2.5 - 1.5;
        nodes.push(
          h(
            'div',
            { class: 'omr-prompt', style: box(roi.x, b.y + 2.5, roi.w, Math.max(promptH, 0)) },
            zone.prompt,
          ),
        );
      }
      nodes.push(h('div', { class: 'omr-write-box omr-write-box--answer', 'data-roi': roi.id, style: box(roi.x, roi.y, roi.w, roi.h) }));
    }
  }
  return nodes;
}

/** Build the virtual tree for a printable sheet. */
export function buildSheetTree(layout) {
  const { page, bubble, typography, header } = layout;
  const style = {
    width: mm(page.width),
    height: mm(page.height),
    '--omr-d': mm(bubble.diameter),
    '--omr-stroke': mm(bubble.stroke ?? 0.25),
    '--omr-pitch-y': mm(bubble.pitchY),
    '--omr-font-title': mm(typography.title),
    '--omr-font-label': mm(typography.label),
    '--omr-font-body': mm(typography.body),
    '--omr-font-bubble': mm(typography.bubble),
    '--omr-font-number': mm(typography.number),
    '--omr-font-small': mm(typography.small),
  };
  const titleBox = { ...box(header.title.x - header.title.maxWidth / 2, layout.fiducial.inset, header.title.maxWidth, layout.fiducial.size) };
  const footerBox = { ...box(header.footer.x - header.footer.maxWidth / 2, page.height - layout.fiducial.inset - layout.fiducial.size, header.footer.maxWidth, layout.fiducial.size) };
  return h(
    'div',
    { class: 'omr-sheet', 'data-template-id': layout.templateId, 'data-paper': page.paper, style },
    layout.fiducials.map(fiducialNode),
    h('div', { class: 'omr-title', style: titleBox }, layout.title),
    h('div', { class: 'omr-footer', style: footerBox }, header.footer.text),
    layout.zones.map((z, i) => zoneNode(z, layout, i)),
  );
}

/** CSS rule that pins the printed page box to the sheet's physical size. */
export function pageRule(layout) {
  return `@page { size: ${layout.page.width}mm ${layout.page.height}mm; margin: 0; }`;
}

/** Render a live DOM element (browser). */
export function renderSheetDOM(layout, doc = globalThis.document) {
  return toDOM(buildSheetTree(layout), doc);
}

/** Render a self-contained printable HTML document (Node export). */
export function renderStandaloneHTML(layout, sheetCss) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(layout.title || layout.templateId)} — OMR sheet</title>
<style>
${sheetCss}
${pageRule(layout)}
html, body { margin: 0; padding: 0; background: #fff; }
</style>
</head>
<body class="omr-standalone">
${toHTML(buildSheetTree(layout))}
</body>
</html>
`;
}
