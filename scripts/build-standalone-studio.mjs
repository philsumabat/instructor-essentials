#!/usr/bin/env node
/**
 * Bundles Sheet Builder into a single zero-dependency standalone HTML file:
 * builder/studio.html
 *
 * This file can be opened directly by double-clicking in Finder/Windows Explorer
 * (file:// protocol) with ZERO CORS issues, zero web server requirement, and zero npm packages.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builderDir = join(root, 'builder');

const stripImports = (code) => code.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '');
const stripExports = (code) => code.replace(/^export\s+(default\s+)?/gm, '');

async function main() {
  const [
    indexHtml,
    sheetCss,
    appCss,
    arucoJs,
    layoutJs,
    renderDomJs,
    renderSvgJs,
    templatesJs,
    appJs,
  ] = await Promise.all([
    readFile(join(builderDir, 'index.html'), 'utf8'),
    readFile(join(builderDir, 'css', 'sheet.css'), 'utf8'),
    readFile(join(builderDir, 'css', 'app.css'), 'utf8'),
    readFile(join(builderDir, 'js', 'aruco.js'), 'utf8'),
    readFile(join(builderDir, 'js', 'layout-engine.js'), 'utf8'),
    readFile(join(builderDir, 'js', 'render-dom.js'), 'utf8'),
    readFile(join(builderDir, 'js', 'render-svg.js'), 'utf8'),
    readFile(join(builderDir, 'js', 'templates.js'), 'utf8'),
    readFile(join(builderDir, 'js', 'app.js'), 'utf8'),
  ]);

  // Strip export/import statements for each module to prepare clean closure scopes
  const cleanAruco = stripExports(arucoJs);
  const cleanLayout = stripExports(stripImports(layoutJs));
  const cleanRenderDom = stripExports(stripImports(renderDomJs));
  const cleanRenderSvg = stripExports(stripImports(renderSvgJs));
  const cleanTemplates = stripExports(stripImports(templatesJs));
  const cleanApp = stripExports(stripImports(appJs));

  // Construct modular bundle wrapped in explicit IIFE closures.
  // This guarantees that internal identifiers (e.g. `const $ = ...`, `const PAD = ...`,
  // `const r3 = ...`) NEVER collide between files.
  const bundledJs = `
// ---- Standalone Sheet Builder Bundle ----

// Inlined Sheet CSS for zero-network/zero-CORS standalone execution
window.__SHEET_CSS__ = ${JSON.stringify(sheetCss)};

// 1. ArUco Fiducial Module
const Aruco = (function() {
${cleanAruco}
  return {
    ARUCO_DICTIONARY,
    SUPPORTED_MARKER_IDS,
    markerCells,
    markerPath,
  };
})();

// 2. Layout Engine Module
const LayoutEngine = (function(Aruco) {
  const { ARUCO_DICTIONARY, SUPPORTED_MARKER_IDS } = Aruco;
${cleanLayout}
  return {
    LAYOUT_SCHEMA,
    GENERATOR,
    PAPER_SIZES,
    DEFAULTS,
    TemplateError,
    estimateLines,
    normalizeTemplate,
    ZONE_TYPES,
    buildLayout,
    allGroups,
    layoutStats,
  };
})(Aruco);

// 3. DOM & Virtual-Node Renderer Module
const RenderDOM = (function(Aruco) {
  const { markerPath } = Aruco;
${cleanRenderDom}
  return {
    h,
    toDOM,
    escapeHTML,
    toHTML,
    buildSheetTree,
    pageRule,
    renderSheetDOM,
    renderStandaloneHTML,
  };
})(Aruco);

// 4. SVG Renderer Module
const RenderSVG = (function(Aruco, RenderDOM) {
  const { markerPath } = Aruco;
  const { escapeHTML: esc } = RenderDOM;
${cleanRenderSvg}
  return {
    renderSVG,
  };
})(Aruco, RenderDOM);

// 5. Embedded Sample Templates Module
const Templates = (function() {
${cleanTemplates}
  return {
    SAMPLE_TEMPLATES,
  };
})();

// Global references for debugging/inspection in browser console
window.Aruco = Aruco;
window.LayoutEngine = LayoutEngine;
window.RenderDOM = RenderDOM;
window.RenderSVG = RenderSVG;
window.Templates = Templates;

// 6. Sheet Builder Controller Application (IIFE Isolated)
(function(LayoutEngine, RenderDOM, RenderSVG, Templates) {
  const { buildLayout, layoutStats, TemplateError, allGroups, PAPER_SIZES } = LayoutEngine;
  const { renderSheetDOM, renderStandaloneHTML, pageRule } = RenderDOM;
  const { renderSVG } = RenderSVG;
  const { SAMPLE_TEMPLATES } = Templates;
${cleanApp}
})(LayoutEngine, RenderDOM, RenderSVG, Templates);
`;

  // Verify syntax validity of bundled JS via Node VM parser
  try {
    new vm.Script(bundledJs);
  } catch (syntaxErr) {
    console.error('❌ Bundle SyntaxError detected:', syntaxErr);
    throw syntaxErr;
  }

  // Inline CSS and JS into single standalone HTML document.
  // IMPORTANT: We use function replacements `() => ...` to prevent JavaScript from
  // interpreting special replacement patterns like `$$` into `$` (which would turn
  // `const $$ =` into `const $ =` and throw SyntaxError: Identifier '$' has already been declared).
  let standaloneHtml = indexHtml;

  // Replace external CSS links with inlined styles
  standaloneHtml = standaloneHtml.replace(
    /<link\s+rel="stylesheet"\s+href="css\/sheet\.css"\s*\/?>/i,
    () => `<style>\n/* sheet.css */\n${sheetCss}\n</style>`,
  );
  standaloneHtml = standaloneHtml.replace(
    /<link\s+rel="stylesheet"\s+href="css\/app\.css"\s*\/?>/i,
    () => `<style>\n/* app.css */\n${appCss}\n</style>`,
  );

  // Replace external script tag with inlined bundle
  standaloneHtml = standaloneHtml.replace(
    /<script\s+type="module"\s+src="js\/app\.js"\s*><\/script>/i,
    () => `<script>\n${bundledJs}\n</script>`,
  );

  // Verification checks for 100% self-contained file
  if (standaloneHtml.includes('href="css/')) {
    throw new Error('Verification failed: external CSS link still present in standalone HTML.');
  }
  if (standaloneHtml.includes('src="js/')) {
    throw new Error('Verification failed: external script tag still present in standalone HTML.');
  }
  if (!standaloneHtml.includes('bio101-midterm-50') || !standaloneHtml.includes('chem201-final-100') || !standaloneHtml.includes('hist110-quiz-tf') || !standaloneHtml.includes('quiz101-bonus-10')) {
    throw new Error('Verification failed: embedded sample templates (exam-50, exam-100, quiz-tf, quiz-bonus) missing from bundle.');
  }

  const outPath = join(builderDir, 'studio.html');
  await writeFile(outPath, standaloneHtml, 'utf8');
  console.log(`✔ Generated standalone Sheet Builder: ${outPath} (${(standaloneHtml.length / 1024).toFixed(1)} KB)`);

  const docsPath = join(root, 'docs', 'index.html');
  await writeFile(docsPath, standaloneHtml, 'utf8');
  console.log(`✔ Synchronized docs/index.html for GitHub Pages: ${docsPath}`);

  // Synchronize standalone in-browser Checker for GitHub Pages
  const checkerSrc = join(builderDir, 'checker.html');
  const checkerDocs = join(root, 'docs', 'checker.html');
  const checkerHtml = await readFile(checkerSrc, 'utf8');
  await writeFile(checkerDocs, checkerHtml, 'utf8');
  console.log(`✔ Synchronized docs/checker.html for GitHub Pages: ${checkerDocs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
