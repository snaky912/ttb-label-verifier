/**
 * Browser smoke test for the bundled hosted build.
 *
 * Unit tests cover the rules engine; this covers the wiring — that the
 * bundle actually boots in a browser, that the UI mounts, that a check
 * runs end to end, and that the verdict reaches the screen. The model is
 * stubbed so the test is deterministic and costs nothing.
 *
 *   CHROMIUM_PATH=/path/to/chrome node scripts/smoke-test.js
 */

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { GOVERNMENT_WARNING } from '../src/core/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the stubbed model "reads" off each sample label. */
const STUB_EXTRACTIONS = {
  good: {
    brandName: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcoholContent: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
    countryOfOrigin: '',
    governmentWarning: GOVERNMENT_WARNING,
    warningPrefixBold: true,
    confidence: { brandName: 0.99, governmentWarning: 0.97 },
    imageQuality: { legible: true, issues: [], note: '' },
    notes: [],
  },
  titleCase: {
    brandName: 'OLD TOM DISTILLERY',
    classType: 'Kentucky Straight Bourbon Whiskey',
    alcoholContent: '45% Alc./Vol. (90 Proof)',
    netContents: '750 mL',
    bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
    countryOfOrigin: '',
    governmentWarning: GOVERNMENT_WARNING.replace('GOVERNMENT WARNING:', 'Government Warning:'),
    warningPrefixBold: true,
    confidence: { brandName: 0.99, governmentWarning: 0.96 },
    imageQuality: { legible: true, issues: [], note: '' },
    notes: [],
  },
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`  FAIL  ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${msg}`);
  }
};

async function main() {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', (err) => {
    console.error('  FAIL  page error:', err.message);
    process.exitCode = 1;
  });

  // Stub the artifact runtime before any page script runs.
  await page.addInitScript((stubs) => {
    let which = 'good';
    window.__setExtraction = (key) => { which = key; };
    const sample = async () => ({ text: '' });
    sample.json = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return stubs[which];
    };
    sample.limits = async () => ({
      maxPromptBytes: 65536,
      images: { maxCount: 4, maxInputBytes: 20_000_000, mediaTypes: ['image/png', 'image/jpeg'] },
    });
    window.claude = { use: async (name) => (name === 'sample' ? sample : null) };
  }, STUB_EXTRACTIONS);

  await page.goto(pathToFileURL(path.join(ROOT, 'dist/artifact.html')).href);

  console.log('\nHosted bundle smoke test\n');

  await page.waitForSelector('#panel-single', { timeout: 5000 });
  assert(true, 'bundle boots and the interface mounts');

  assert(
    await page.getByRole('button', { name: 'Check one label' }).isVisible(),
    'single-label mode is offered',
  );
  assert(
    await page.getByRole('button', { name: 'Check many labels' }).isVisible(),
    'batch mode is offered',
  );

  // The tool should open in a working state, not as an empty shell.
  assert(
    (await page.inputValue('#app-brandName')) === 'OLD TOM DISTILLERY',
    'the form opens pre-filled with a worked example',
  );

  await page.getByRole('button', { name: 'Clear these boxes' }).click();
  assert((await page.inputValue('#app-brandName')) === '', 'the form can be cleared');

  await page.getByRole('button', { name: 'Fill in the example again' }).click();
  assert(
    (await page.inputValue('#app-brandName')) === 'OLD TOM DISTILLERY',
    'the example can be restored',
  );

  // Upload a real generated sample label.
  await page.setInputFiles('#single-file', path.join(ROOT, 'samples/01-compliant.png'));
  assert(await page.locator('.preview img').isVisible(), 'the chosen picture is previewed');

  // Compliant label -> pass
  await page.getByRole('button', { name: 'Check this label' }).click();
  await page.waitForSelector('.verdict-banner', { timeout: 10000 });
  assert(
    await page.locator('.verdict-banner.v-pass').isVisible(),
    'a compliant label reports a pass',
  );
  assert(
    (await page.locator('.check').count()) === 7,
    'all seven field checks are listed',
  );
  assert(
    /within the five-second target/.test(await page.locator('.timing').innerText()),
    'elapsed time is reported against the five-second target',
  );

  // Title-case warning -> fail, with the reason named in plain English.
  await page.evaluate(() => window.__setExtraction('titleCase'));
  await page.getByRole('button', { name: 'Check this label' }).click();
  await page.waitForSelector('.verdict-banner.v-fail', { timeout: 10000 });
  const warningCheck = await page.locator('.check', { hasText: 'Government health warning' }).innerText();
  assert(/capital letters/.test(warningCheck), 'a title-case warning prefix is caught and explained');
  assert(
    await page.locator('.check', { hasText: 'Government health warning' }).locator('.tag.v-fail').isVisible(),
    'the failing check is tagged with a word, not colour alone',
  );

  await page.screenshot({ path: path.join(ROOT, 'docs/screenshot-result.png'), fullPage: true });

  // Batch mode renders and accepts multiple files.
  await page.getByRole('button', { name: 'Check many labels' }).click();
  await page.setInputFiles('#batch-files', [
    path.join(ROOT, 'samples/01-compliant.png'),
    path.join(ROOT, 'samples/02-warning-title-case.png'),
    path.join(ROOT, 'samples/05-abv-mismatch.png'),
  ]);
  await page.getByRole('button', { name: 'Check all labels' }).click();
  await page.waitForFunction(() => document.querySelectorAll('table.batch tbody tr').length === 3, null, { timeout: 15000 });
  assert(true, 'batch mode checks several labels and fills the results table');
  assert(
    (await page.locator('.stat').count()) >= 3,
    'batch mode shows pass / review / problem counts',
  );

  await page.screenshot({ path: path.join(ROOT, 'docs/screenshot-batch.png'), fullPage: true });
  await page.close();

  // ------------------------------------------------------------------
  // Phase 2: the self-hosted build, served by server.js.
  //
  // The bundled build inlines every module, so it cannot catch a broken
  // import path in the served build. This phase loads the real module
  // graph over HTTP. /api/verify is intercepted and answered with the
  // real rules engine, so no API key or model call is needed.
  // ------------------------------------------------------------------
  console.log('\nSelf-hosted build smoke test\n');

  const { spawn } = await import('node:child_process');
  const { verifyLabel } = await import('../src/core/verify.js');
  const port = 3999;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
  });

  try {
    await waitForServer(`http://localhost:${port}/api/health`);

    const served = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const moduleErrors = [];
    served.on('pageerror', (err) => moduleErrors.push(err.message));
    served.on('response', (res) => {
      if (res.url().endsWith('.js') && res.status() >= 400) moduleErrors.push(`${res.status()} ${res.url()}`);
    });

    await served.route('**/api/verify', async (route) => {
      const result = verifyLabel({ application: {}, extracted: STUB_EXTRACTIONS.good });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });

    await served.goto(`http://localhost:${port}/`);
    await served.waitForSelector('#panel-single', { timeout: 5000 }).catch(() => {});

    assert(moduleErrors.length === 0, `every served module loads${moduleErrors.length ? ` (${moduleErrors.join('; ')})` : ''}`);
    assert(await served.locator('#panel-single').isVisible(), 'the served interface mounts');
    assert(
      // textContent, not innerText: the <details> starts collapsed, and
      // innerText omits content that isn't rendered.
      /27 CFR 16\.21/.test(await served.locator('details.rules').textContent()),
      'the served page shows the statutory warning from the shared rules module',
    );

    await served.setInputFiles('#single-file', path.join(ROOT, 'samples/01-compliant.png'));
    await served.getByRole('button', { name: 'Check this label' }).click();
    await served.waitForSelector('.verdict-banner', { timeout: 10000 });
    assert(await served.locator('.verdict-banner').isVisible(), 'a check round-trips through /api/verify');
  } finally {
    server.kill();
  }

  await browser.close();
  console.log(process.exitCode ? '\nSmoke test FAILED\n' : '\nSmoke test passed\n');
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start at ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
