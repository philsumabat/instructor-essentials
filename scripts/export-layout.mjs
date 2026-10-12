#!/usr/bin/env node
/**
 * Export a template JSON payload to:
 *   layout.json  – resolved geometry consumed by the Python OMR pipeline
 *   sheet.svg    – true-scale vector sheet
 *   sheet.html   – standalone printable DOM sheet (CSS Grid + @page)
 *
 * Usage: node scripts/export-layout.mjs <template.json> [--out <dir>] [--paper A4|Letter]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildLayout, layoutStats, TemplateError } from '../builder/js/layout-engine.js';
import { renderSVG } from '../builder/js/render-svg.js';
import { renderStandaloneHTML } from '../builder/js/render-dom.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      paper: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: node scripts/export-layout.mjs <template.json> [--out <dir>] [--paper A4|Letter]');
    process.exit(values.help ? 0 : 2);
  }
  const templatePath = resolve(positionals[0]);
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  if (values.paper) template.paper = values.paper;

  const layout = buildLayout(template);
  const outDir = resolve(values.out ?? join(root, 'dist', basename(templatePath, extname(templatePath))));
  await mkdir(outDir, { recursive: true });

  const css = await readFile(join(root, 'builder', 'css', 'sheet.css'), 'utf8');
  await Promise.all([
    writeFile(join(outDir, 'layout.json'), `${JSON.stringify(layout, null, 2)}\n`),
    writeFile(join(outDir, 'sheet.svg'), renderSVG(layout)),
    writeFile(join(outDir, 'sheet.html'), renderStandaloneHTML(layout, css)),
  ]);

  const stats = layoutStats(layout);
  console.log(`✔ ${layout.templateId} (${layout.page.paper} ${layout.page.width}×${layout.page.height} mm)`);
  console.log(`  ${stats.questions} questions · ${stats.bubbles} bubbles · ${stats.idDigits} ID digits · ${stats.textRegions} graded text regions`);
  console.log(`  → ${outDir}/{layout.json, sheet.svg, sheet.html}`);
  for (const w of layout.warnings) console.warn(`  ⚠ ${w}`);
}

main().catch((err) => {
  console.error(err instanceof TemplateError ? `Template error: ${err.message}` : err);
  process.exit(1);
});
