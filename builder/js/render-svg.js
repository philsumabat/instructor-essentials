/**
 * SVG renderer for resolved OMR layouts (isomorphic, string output).
 *
 * The SVG uses a millimetre viewBox and explicit physical width/height, so it
 * prints at true scale from any SVG-capable application and can be embedded
 * in PDFs or LMS documents without re-layout.
 */
import { markerPath } from './aruco.js';
import { escapeHTML as esc } from './render-dom.js';

const f = (v) => +Number(v).toFixed(3);

function text(x, y, content, { size, anchor = 'start', weight, fill = '#000', baseline = 'central', cls } = {}) {
  const attrs = [
    `x="${f(x)}"`,
    `y="${f(y)}"`,
    `font-size="${f(size)}"`,
    `text-anchor="${anchor}"`,
    `dominant-baseline="${baseline}"`,
    weight ? `font-weight="${weight}"` : '',
    fill !== '#000' ? `fill="${fill}"` : '',
    cls ? `class="${cls}"` : '',
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${esc(content)}</text>`;
}

/** Greedy word wrap using the same glyph-width estimate as the layout engine. */
function wrap(content, size, width) {
  const perLine = Math.max(1, Math.floor(width / (size * 0.52)));
  const lines = [];
  for (const para of String(content).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= perLine) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function parseGap(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function gridSVG(grid, layout, zone) {
  const { bubble, typography } = layout;
  const out = [];
  const colStart = (c) => grid.x + grid.columns.slice(0, c).reduce((a, b) => a + b, 0);
  const rowStart = (r) => grid.y + grid.rows.slice(0, r).reduce((a, b) => a + b, 0);
  const stroke = bubble.stroke ?? 0.25;
  const customRowGap = zone ? parseGap(zone.rowGap ?? zone.rowSpacing ?? zone.itemSpacing ?? zone.extra?.rowGap) : null;
  const basePitchY = grid.pitchY ?? (customRowGap != null ? (bubble.diameter + customRowGap) : bubble.pitchY);
  const nominalRowH = grid.pitchY ?? basePitchY;
  for (const cell of grid.cells) {
    const x0 = colStart(cell.col);
    const y0 = rowStart(cell.row);
    const cw = grid.columns[cell.col];
    if (cell.kind === 'bubble') {
      const cx = x0 + cw / 2;
      const cy = y0 + nominalRowH / 2;
      out.push(`<circle class="omr-bubble" cx="${f(cx)}" cy="${f(cy)}" r="${f(bubble.diameter / 2 - stroke / 2)}" fill="none" stroke="#000" stroke-width="${f(stroke)}"/>`);
      out.push(text(cx, cy + 0.05, cell.text, { size: typography.bubble, anchor: 'middle', fill: '#8a8a8a' }));
    } else if (cell.kind === 'num') {
      out.push(text(x0 + cw - 1.2, y0 + nominalRowH / 2, cell.text, { size: typography.number, anchor: 'end', weight: 700 }));
    } else if (cell.kind === 'box') {
      out.push(`<rect x="${f(x0 + 0.4 + 0.125)}" y="${f(y0 + 0.125)}" width="${f(cw - 0.8 - 0.25)}" height="${f(grid.rows[cell.row] - 0.25)}" fill="none" stroke="#000" stroke-width="0.25"/>`);
    }
  }
  return out.join('');
}

function zoneSVG(zone, layout, zoneIndex) {
  const { typography } = layout;
  const b = zone.bbox;
  const idxAttr = typeof zoneIndex === 'number' ? ` data-zone-index="${zoneIndex}"` : '';
  const out = [`<g class="omr-zone omr-zone--${zone.type}" data-zone="${esc(zone.id)}"${idxAttr}>`];
  if (zone.type === 'instructions') {
    out.push(`<rect x="${f(b.x + 0.15)}" y="${f(b.y + 0.15)}" width="${f(b.w - 0.3)}" height="${f(b.h - 0.3)}" rx="1.2" fill="none" stroke="none"/>`);
    const lines = wrap(zone.text, zone.fontSize, b.w - 2);
    lines.forEach((line, i) => out.push(text(b.x + 1, b.y + 1 + (i + 0.5) * zone.fontSize * 1.3, line, { size: zone.fontSize, fill: '#222' })));
    out.push('</g>');
    return out.join('');
  }
  out.push(`<rect x="${f(b.x + 0.15)}" y="${f(b.y + 0.15)}" width="${f(b.w - 0.3)}" height="${f(b.h - 0.3)}" rx="1.2" fill="none" stroke="#000" stroke-width="0.3"/>`);
  const isTextType = zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay';
  const isPointsEligible = ['mcq', 'truefalse', 'modified_tf', 'text_short', 'text_essay', 'text'].includes(zone.type);
  const rawLabel = String(zone.label ?? '').trim();
  const hasPtsInLabel = /\(\s*\d+(\.\d+)?\s*(?:pts?|points?)(?:\s+each)?\s*\)/i.test(rawLabel);
  const pts = zone.pointsPerItem ?? zone.points;
  const count = zone.count ?? (zone.items ? zone.items.length : 1);
  const ptsNum = Number(pts);

  const shouldShowPoints = zone.showPoints !== undefined
    ? Boolean(zone.showPoints)
    : isTextType;

  const displayLabel = !shouldShowPoints && hasPtsInLabel
    ? rawLabel.replace(/\s*\(\s*\d+(\.\d+)?\s*(?:pts?|points?)(?:\s+each)?\s*\)/i, '').trim()
    : rawLabel;

  const pointsSuffix = isPointsEligible && shouldShowPoints && !hasPtsInLabel && Number.isFinite(ptsNum) && ptsNum > 0
    ? `(${ptsNum} pt${ptsNum === 1 ? '' : 's'}${count > 1 ? ' each' : ''})`
    : '';
  const fullTitle = [displayLabel, pointsSuffix].filter(Boolean).join(' ');
  if (fullTitle) out.push(text(b.x + 2.5, b.y + 2.5 + 2, fullTitle, { size: typography.label, weight: 700 }));
  for (const grid of zone.grids) out.push(gridSVG(grid, layout, zone));
  if (zone.type === 'fields') {
    zone.rows.forEach((row, i) => {
      const roi = zone.rois[i];
      const maxLabelW = Math.max(4, (row.labelW ?? 14) - 0.8);
      const labelLen = Math.max(1, String(row.label ?? '').length);
      const labelSize = Math.min(typography.label, Math.max(1.6, maxLabelW / (labelLen * 0.55)));
      out.push(text(row.x, row.y + row.h / 2, row.label, { size: labelSize, weight: 700 }));
      out.push(`<rect data-roi="${esc(roi.id)}" x="${f(roi.x + 0.15)}" y="${f(roi.y + 0.15)}" width="${f(roi.w - 0.3)}" height="${f(roi.h - 0.3)}" fill="none" stroke="#000" stroke-width="0.3"/>`);
      if (roi.digits > 0) {
        const cellW = (roi.w - 0.3) / roi.digits;
        for (let d = 1; d < roi.digits; d += 1) {
          out.push(`<line x1="${f(roi.x + 0.15 + d * cellW)}" y1="${f(roi.y + 0.15)}" x2="${f(roi.x + 0.15 + d * cellW)}" y2="${f(roi.y + roi.h - 0.15)}" stroke="#000" stroke-width="0.2"/>`);
        }
      }
    });
  }
  if (zone.type === 'modified_tf') {
    zone.rois.forEach((roi) => {
      out.push(`<rect data-roi="${esc(roi.id)}" x="${f(roi.x + 0.15)}" y="${f(roi.y + 0.15)}" width="${f(roi.w - 0.3)}" height="${f(roi.h - 0.3)}" fill="none" stroke="#000" stroke-width="0.25"/>`);
    });
  }
  if (zone.type === 'text' || zone.type === 'text_short' || zone.type === 'text_essay') {
    if (zone.items && zone.items.length > 0) {
      zone.items.forEach((item) => {
        const itemLabel = String(item.label ?? '').replace(/\.+$/, '');
        const numY = item.boxH > 15 ? item.labelY + 3.5 : item.labelY + item.boxH / 2;
        out.push(text(item.labelX, numY, itemLabel, { size: typography.number, weight: 700 }));
        out.push(`<rect data-roi="${esc(item.id)}" x="${f(item.boxX + 0.15)}" y="${f(item.boxY + 0.15)}" width="${f(item.boxW - 0.3)}" height="${f(item.boxH - 0.3)}" fill="none" stroke="#000" stroke-width="0.3"/>`);
      });
    } else if (zone.rois && zone.rois.length > 0) {
      const roi = zone.rois[0];
      if (zone.isInline && zone.prompt) {
        const isNum = /^\d+[\.\)]?$/.test(zone.prompt.trim());
        const displayPrompt = isNum ? zone.prompt.trim().replace(/[\.\)]+$/, '') : zone.prompt;
        out.push(text(b.x + 2.5, roi.y + roi.h / 2, displayPrompt, { size: isNum ? typography.number : typography.label, weight: 700 }));
      } else if (zone.prompt) {
        const lines = wrap(zone.prompt, typography.label, roi.w);
        lines.forEach((line, i) => out.push(text(roi.x, b.y + 2.5 + (i + 0.5) * typography.label * 1.3, line, { size: typography.label })));
      }
      out.push(`<rect data-roi="${esc(roi.id)}" x="${f(roi.x + 0.15)}" y="${f(roi.y + 0.15)}" width="${f(roi.w - 0.3)}" height="${f(roi.h - 0.3)}" fill="none" stroke="#000" stroke-width="0.3"/>`);
    }
  }
  out.push('</g>');
  return out.join('');
}

/** Render the layout as a standalone SVG document string. */
export function renderSVG(layout) {
  const { page, header, fiducial, typography } = layout;
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}" font-family="Helvetica, Arial, sans-serif" data-template-id="${esc(layout.templateId)}">`,
    `<title>${esc(layout.title || layout.templateId)}</title>`,
    `<rect width="${page.width}" height="${page.height}" fill="#fff"/>`,
  ];
  for (const m of layout.fiducials) {
    parts.push(`<path class="omr-fiducial" data-aruco-id="${m.id}" transform="translate(${m.x} ${m.y})" d="${markerPath(m.id, m.size)}" fill="#000" shape-rendering="crispEdges"/>`);
  }
  parts.push(text(header.title.x, fiducial.inset + fiducial.size / 2, layout.title, { size: typography.title, anchor: 'middle', weight: 700 }));
  parts.push(text(header.footer.x, header.footer.y, header.footer.text, { size: typography.small, anchor: 'middle', fill: '#444' }));
  layout.zones.forEach((zone, zoneIndex) => parts.push(zoneSVG(zone, layout, zoneIndex)));
  parts.push('</svg>');
  return parts.join('\n');
}
