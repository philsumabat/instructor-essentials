#!/usr/bin/env node
/**
 * Bundles Sheet Builder into a single zero-dependency standalone HTML file:
 * builder/studio.html
 *
 * This file can be opened directly by double-clicking in Finder/Windows Explorer
 * (file:// protocol) with ZERO CORS issues, zero web server requirement, and zero npm packages.
 */
import { readFile, writeFile, cp } from 'node:fs/promises';
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
  const { renderSheetDOM, renderStandaloneHTML, pageRule, escapeHTML } = RenderDOM;
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

  // Synchronize standalone Portal Homepage for GitHub Pages
  const homeSrc = join(builderDir, 'home.html');
  const homeDocs = join(root, 'docs', 'home.html');
  const homeHtml = await readFile(homeSrc, 'utf8');
  await writeFile(homeDocs, homeHtml, 'utf8');
  console.log(`✔ Synchronized docs/home.html for GitHub Pages: ${homeDocs}`);

  // Synchronize Desktop App Distribution (apps/desktop/ui/)
  const desktopUiDir = join(root, 'apps', 'desktop', 'ui');

  // 1. Generate Desktop Sheet Builder (apps/desktop/ui/index.html)
  let desktopIndexHtml = standaloneHtml;
  desktopIndexHtml = desktopIndexHtml.replace(
    '</head>',
    '  <link rel="stylesheet" href="desktop.css">\n</head>'
  );
  desktopIndexHtml = desktopIndexHtml.replace(
    '<header class="app-header app-chrome">',
    '<header class="app-header app-chrome window-titlebar" data-tauri-drag-region>'
  );
  const desktopNavBuilder = `      <nav class="workflow-nav segmented-control" aria-label="Workflow switcher">
        <a href="home.html" class="workflow-nav__item seg-btn" id="nav-btn-home" onclick="switchView('home', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
        <a href="index.html" class="workflow-nav__item seg-btn is-active" id="nav-btn-builder" aria-current="page" onclick="switchView('builder', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Design Exam</span>
        </a>
        <a href="checker.html" class="workflow-nav__item seg-btn" id="nav-btn-checker" onclick="switchView('checker', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>Grade Scans</span>
        </a>
        <a href="checker.html#speed" class="workflow-nav__item seg-btn" id="nav-btn-speed" onclick="switchView('speed', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <span>Speed Grader</span>
        </a>
      </nav>`;
  desktopIndexHtml = desktopIndexHtml.replace(
    /<nav class="workflow-nav" aria-label="Workflow switcher">[\s\S]*?<\/nav>/,
    () => desktopNavBuilder
  );
  desktopIndexHtml = desktopIndexHtml.replace(
    /<\/body>\s*<\/html>\s*$/i,
    '  <script src="desktop.js"></script>\n</body>\n</html>\n'
  );
  const desktopIndexPath = join(desktopUiDir, 'index.html');
  await writeFile(desktopIndexPath, desktopIndexHtml, 'utf8');
  console.log(`✔ Synchronized apps/desktop/ui/index.html for Desktop Tauri: ${desktopIndexPath}`);

  // 2. Generate Desktop Checker Studio (apps/desktop/ui/checker.html)
  let desktopCheckerHtml = checkerHtml;
  desktopCheckerHtml = desktopCheckerHtml.replace(
    '</head>',
    '  <link rel="stylesheet" href="desktop.css">\n</head>'
  );
  desktopCheckerHtml = desktopCheckerHtml.replace(
    '<header class="app-header">',
    '<header class="app-header app-chrome window-titlebar" data-tauri-drag-region>'
  );
  const desktopNavChecker = `      <nav class="workflow-nav segmented-control" aria-label="Workflow switcher">
        <a href="home.html" class="workflow-nav__item seg-btn" id="nav-btn-home" onclick="switchView('home', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
        <a href="index.html" class="workflow-nav__item seg-btn" id="nav-btn-builder" onclick="switchView('builder', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Design Exam</span>
        </a>
        <a href="checker.html" class="workflow-nav__item seg-btn is-active" id="nav-btn-checker" aria-current="page" onclick="switchView('checker', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>Grade Scans</span>
        </a>
        <a href="checker.html#speed" class="workflow-nav__item seg-btn" id="nav-btn-speed" onclick="switchView('speed', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <span>Speed Grader</span>
        </a>
      </nav>`;
  desktopCheckerHtml = desktopCheckerHtml.replace(
    /<nav class="workflow-nav" aria-label="Workflow switcher">[\s\S]*?<\/nav>/,
    () => desktopNavChecker
  );
  desktopCheckerHtml = desktopCheckerHtml.replace(
    /<\/body>\s*<\/html>\s*$/i,
    '  <script src="desktop.js"></script>\n</body>\n</html>\n'
  );
  const desktopCheckerPath = join(desktopUiDir, 'checker.html');
  await writeFile(desktopCheckerPath, desktopCheckerHtml, 'utf8');
  console.log(`✔ Synchronized apps/desktop/ui/checker.html for Desktop Tauri: ${desktopCheckerPath}`);

  // 3. Generate Desktop Home Portal (apps/desktop/ui/home.html)
  let desktopHomeHtml = homeHtml.replace(
    '</head>',
    '  <link rel="stylesheet" href="desktop.css">\n</head>'
  ).replace(
    '<header class="app-header">',
    '<header class="app-header app-chrome window-titlebar" data-tauri-drag-region>'
  ).replace(
    /<nav class="workflow-nav" aria-label="Workflow switcher">[\s\S]*?<\/nav>/,
    () => `      <nav class="workflow-nav segmented-control" aria-label="Workflow switcher">
        <a href="home.html" class="workflow-nav__item seg-btn is-active" id="nav-btn-home" aria-current="page" onclick="switchView('home', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
        <a href="index.html" class="workflow-nav__item seg-btn" id="nav-btn-builder" onclick="switchView('builder', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Design Exam</span>
        </a>
        <a href="checker.html" class="workflow-nav__item seg-btn" id="nav-btn-checker" onclick="switchView('checker', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>Grade Scans</span>
        </a>
        <a href="checker.html#speed" class="workflow-nav__item seg-btn" id="nav-btn-speed" onclick="switchView('speed', event); return false;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <span>Speed Grader</span>
        </a>
      </nav>`
  ).replace(
    /<\/body>\s*<\/html>\s*$/i,
    '  <script src="desktop.js"></script>\n</body>\n</html>\n'
  );
  const desktopHomePath = join(desktopUiDir, 'home.html');
  await writeFile(desktopHomePath, desktopHomeHtml, 'utf8');
  console.log(`✔ Synchronized apps/desktop/ui/home.html for Desktop Tauri: ${desktopHomePath}`);

  // 4. Synchronize modular assets into apps/desktop/ui/

  await cp(join(builderDir, 'js'), join(desktopUiDir, 'js'), { recursive: true });
  await cp(join(builderDir, 'css'), join(desktopUiDir, 'css'), { recursive: true });
  await cp(join(builderDir, 'templates'), join(desktopUiDir, 'templates'), { recursive: true });
  console.log('✔ Synchronized apps/desktop/ui/js/, css/, and templates/ assets');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
