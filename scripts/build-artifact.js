/**
 * Build the single-file hosted demo.
 *
 * The hosted build and the self-hosted build must apply IDENTICAL rules —
 * a compliance tool that decides differently depending on where it runs is
 * worthless. So rather than maintaining a second copy of the logic, this
 * script inlines the same `src/core` modules and the same `public/ui.js`
 * into one HTML file and swaps only the transport: instead of posting to
 * /api/verify, the page asks Claude directly through the artifact runtime's
 * `sample` capability and then runs the very same `verifyLabel()` locally.
 *
 * It is a deliberately tiny concatenating bundler (no webpack, no rollup,
 * no node_modules) because the agency network blocks a lot of outbound
 * traffic and a build that needs nothing is a build that always works.
 *
 *   node scripts/build-artifact.js
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order matters: a module may only use what precedes it. */
const MODULES = [
  'src/core/normalize.js',
  'src/core/similarity.js',
  'src/core/parse.js',
  'src/core/diff.js',
  'src/core/rules.js',
  'src/core/verify.js',
  'src/extract/prompt.js',
  'public/downscale.js',
  'public/ui.js',
];

/**
 * Strip ES module syntax so the files can be concatenated into one scope.
 * The modules are written in a plain style (no default exports, no
 * re-export renaming, no dynamic import at module scope) specifically so
 * that this stays a safe transformation.
 */
function stripModuleSyntax(source, file) {
  let out = source;

  // Drop import statements entirely — everything is in one scope now.
  out = out.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^\s*import\s*['"][^'"]+['"];?\s*$/gm, '');

  // `export { a, b };` re-exports are redundant once concatenated.
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  // `export function f` / `export const X` -> plain declarations.
  out = out.replace(/^\s*export\s+(?=(?:async\s+)?function|const|let|class)/gm, '');

  if (/^\s*export\s/m.test(out)) {
    throw new Error(`Unhandled export syntax in ${file} — the bundler needs updating.`);
  }
  return `\n/* ===== ${file} ===== */\n${out.trim()}\n`;
}

/**
 * The transport for the hosted build: ask Claude via the artifact runtime,
 * then apply the same deterministic rules engine in the browser.
 */
const ARTIFACT_TRANSPORT = `
/* ===== hosted transport (sample capability) ===== */

async function bootstrap() {
  const root = document.getElementById('app');

  const sample = await (window.claude?.use?.('sample') ?? Promise.resolve(null));
  if (!sample) {
    mountApp({
      root,
      verifyOne: null,
      unavailableMessage:
        'This demo reads labels using Claude, and this view cannot do that. ' +
        'Open the page from your Claude artifacts list and allow it to use Claude when asked.',
    });
    return;
  }

  const limits = await sample.limits().catch(() => null);
  if (!limits || !limits.images) {
    mountApp({
      root,
      verifyOne: null,
      unavailableMessage:
        'This view cannot send pictures to be read, so label checking is unavailable here. ' +
        'Try opening the page in the Claude desktop or web app.',
    });
    return;
  }

  async function verifyOne(file, application, signal) {
    const started = performance.now();
    const prepared = await downscaleImage(file, 1600);

    const raw = await sample.json(EXTRACTION_PROMPT, {
      images: prepared,
      // 'quick' is a latency decision: Sarah Chen's five-second bar is the
      // requirement that killed the previous vendor pilot at 30-40s.
      modelTier: 'quick',
      signal,
      // Re-checking the same picture against the same prompt should not
      // cost the viewer twice during a demo.
      cache: { gcTime: 300000 },
    });

    const extraction = coerceExtraction(raw);
    const result = verifyLabel({ application, extracted: extraction });

    return {
      ...result,
      extracted: extraction,
      timing: { totalMs: Math.round(performance.now() - started), where: 'browser' },
    };
  }

  mountApp({ root, verifyOne });
}

bootstrap();
`;

async function main() {
  const css = await readFile(path.join(ROOT, 'public/styles.css'), 'utf8');

  const parts = [];
  for (const file of MODULES) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    parts.push(stripModuleSyntax(source, file));
  }

  // The Artifact host supplies <!doctype>, <html>, <head> and <body>, so
  // this file starts at <title> and contains page content only.
  const html = `<title>Label Check</title>
<style>
${css}
</style>

<a class="skip-link" href="#app">Skip to the tool</a>

<header class="masthead">
  <h1>Label Check</h1>
  <p>Compares an alcohol beverage label against what the application says. Prototype &mdash; not a system of record.</p>
</header>

<main>
  <div id="app"></div>
</main>

<footer class="foot">
  <p>
    Prototype for evaluation only. Pictures are read in your browser and are not stored anywhere.
    Results are an aid to an agent's judgement, not a decision.
  </p>
</footer>

<script>
(function () {
'use strict';
${parts.join('\n')}
${ARTIFACT_TRANSPORT}
})();
</script>
`;

  await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  const out = path.join(ROOT, 'dist/artifact.html');
  await writeFile(out, html);
  console.log(`Wrote ${out} (${(html.length / 1024).toFixed(1)} KB) from ${MODULES.length} modules.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
