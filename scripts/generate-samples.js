/**
 * Generate synthetic test labels.
 *
 * The brief suggested sourcing extra labels with image generators. These
 * are drawn deterministically instead, because a test fixture whose exact
 * text you control is far more useful than a pretty one you have to
 * squint at: every sample here has a KNOWN expected verdict, which is what
 * makes `samples/manifest.json` usable as a regression set.
 *
 * Variants include the defects the discovery interviews called out:
 * a title-case warning prefix, a paraphrased warning, an ABV mismatch,
 * and photographs degraded with rotation, glare and blur.
 *
 *   node scripts/generate-samples.js
 */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOVERNMENT_WARNING } from '../src/core/rules.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

const BASE = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContent: '45% Alc./Vol. (90 Proof)',
  netContents: '750 mL',
  bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
  countryOfOrigin: '',
  warning: GOVERNMENT_WARNING,
  warningBold: true,
};

/** The label artwork, as a self-contained HTML document. */
function labelHtml(spec) {
  const warningHtml = spec.warning
    ? (() => {
        const idx = spec.warning.indexOf(':');
        const prefix = idx >= 0 ? spec.warning.slice(0, idx + 1) : '';
        const rest = idx >= 0 ? spec.warning.slice(idx + 1) : spec.warning;
        const weight = spec.warningBold ? '800' : '400';
        return `<span style="font-weight:${weight}">${esc(prefix)}</span>${esc(rest)}`;
      })()
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0 }
    body { margin:0; width:900px; height:1200px; display:flex; align-items:center; justify-content:center;
           background:#1a1410; font-family: Georgia, 'Times New Roman', serif; }
    .label { width:760px; height:1060px; background:#f4ecd8; color:#231a12; padding:48px 52px;
             box-sizing:border-box; display:flex; flex-direction:column; border:3px double #8a6a3a; }
    .rule { height:2px; background:#8a6a3a; margin:14px 0; }
    .brand { font-size:${spec.brandFontSize || 62}px; letter-spacing:2px; text-align:center;
             font-weight:700; line-height:1.05; margin-top:8px; }
    .est { text-align:center; font-size:20px; letter-spacing:6px; color:#6d573a; margin-top:10px; }
    .class { text-align:center; font-size:30px; font-style:italic; margin-top:26px; line-height:1.25; }
    .origin { text-align:center; font-size:22px; letter-spacing:3px; margin-top:14px; text-transform:uppercase; }
    .spacer { flex:1 }
    .facts { display:flex; justify-content:space-between; font-size:26px; letter-spacing:1px; margin-top:8px; }
    .addr { text-align:center; font-size:17px; margin-top:22px; line-height:1.4; color:#3b2e20; }
    .warning { font-size:${spec.warningFontSize || 15}px; line-height:1.35; margin-top:20px;
               text-align:justify; font-family: Arial, Helvetica, sans-serif; color:#231a12; }
  </style></head><body><div class="label">
    <div class="brand">${esc(spec.brandName)}</div>
    <div class="est">EST. 1897</div>
    <div class="rule"></div>
    <div class="class">${esc(spec.classType)}</div>
    ${spec.countryOfOrigin ? `<div class="origin">${esc(spec.countryOfOrigin)}</div>` : ''}
    <div class="spacer"></div>
    <div class="rule"></div>
    <div class="facts"><span>${esc(spec.netContents)}</span><span>${esc(spec.alcoholContent)}</span></div>
    <div class="addr">${esc(spec.bottlerAddress)}</div>
    <div class="warning">${warningHtml}</div>
  </div></body></html>`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The sample set. Each entry states the verdict the engine should reach. */
const SAMPLES = [
  {
    file: '01-compliant.png',
    title: 'Fully compliant bourbon',
    expect: 'pass',
    spec: {},
    application: {},
  },
  {
    file: '02-warning-title-case.png',
    title: 'Warning prefix in title case',
    expect: 'fail',
    note: 'The defect Jenny Park described catching by eye.',
    spec: { warning: GOVERNMENT_WARNING.replace('GOVERNMENT WARNING:', 'Government Warning:') },
    application: {},
  },
  {
    file: '03-warning-paraphrased.png',
    title: 'Paraphrased warning text',
    expect: 'fail',
    spec: {
      warning:
        'GOVERNMENT WARNING: (1) According to the Surgeon General, women should avoid alcoholic beverages during pregnancy due to the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.',
    },
    application: {},
  },
  {
    file: '04-warning-missing.png',
    title: 'No health warning at all',
    expect: 'fail',
    spec: { warning: '' },
    application: {},
  },
  {
    file: '05-abv-mismatch.png',
    title: 'Label ABV differs from the application',
    expect: 'fail',
    spec: { alcoholContent: '47% Alc./Vol. (94 Proof)' },
    application: { alcoholContent: '45% Alc./Vol.' },
  },
  {
    file: '06-brand-case-variant.png',
    title: "Brand case differs only — Dave Morrison's STONE'S THROW case",
    expect: 'pass',
    note: 'Should clear automatically despite not being byte-identical.',
    spec: { brandName: "Stone's Throw", classType: 'Kentucky Straight Bourbon Whiskey' },
    application: { brandName: "STONE'S THROW" },
  },
  {
    file: '07-import-scotch.png',
    title: 'Imported scotch with country of origin',
    expect: 'pass',
    spec: {
      brandName: 'GLEN CARRICK',
      classType: 'Blended Scotch Whisky',
      countryOfOrigin: 'Product of Scotland',
      alcoholContent: '43% Alc./Vol. (86 Proof)',
      bottlerAddress: 'Imported by Carrick Imports LLC, Chicago, IL',
    },
    application: {
      brandName: 'GLEN CARRICK',
      classType: 'Blended Scotch Whisky',
      alcoholContent: '43% Alc./Vol.',
      countryOfOrigin: 'Product of Scotland',
      bottlerAddress: 'Imported by Carrick Imports LLC, Chicago, IL',
    },
  },
  {
    file: '08-tiny-warning.png',
    title: 'Warning set in very small type',
    expect: 'pass',
    note: 'Text is correct; legibility of the type size is a human judgement the tool surfaces but does not score.',
    spec: { warningFontSize: 8 },
    application: {},
  },
  {
    file: '09-angled-glare.png',
    title: 'Photographed at an angle with glare',
    expect: 'pass',
    note: "Jenny Park's ask: imperfect photography should still be readable.",
    spec: {},
    application: {},
    degrade: { rotate: 9, glare: true },
  },
  {
    file: '10-blurred.png',
    title: 'Out of focus photograph',
    expect: 'review',
    note: 'Should surface low confidence rather than a confident rejection.',
    spec: {},
    application: {},
    degrade: { blur: 4 },
  },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  // Allow a preinstalled Chromium to be used instead of Playwright's own
  // download — useful on locked-down build machines (and the reason this
  // script is a dev dependency, never part of the running app).
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });

  const manifest = [];
  for (const sample of SAMPLES) {
    const spec = { ...BASE, ...sample.spec };
    await page.setContent(labelHtml(spec), { waitUntil: 'load' });
    const buf = await page.screenshot({ type: 'png' });
    const target = path.join(OUT, sample.file);
    await writeFile(target, buf);

    if (sample.degrade) await degrade(target, sample.degrade);

    manifest.push({
      file: sample.file,
      title: sample.title,
      expectedVerdict: sample.expect,
      note: sample.note || '',
      application: {
        brandName: spec.brandName,
        classType: spec.classType,
        alcoholContent: spec.alcoholContent,
        netContents: spec.netContents,
        bottlerAddress: spec.bottlerAddress,
        countryOfOrigin: spec.countryOfOrigin,
        ...sample.application,
      },
    });
    process.stdout.write(`  wrote ${sample.file}\n`);
  }

  await browser.close();
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(OUT, 'applications.csv'), toCsv(manifest));
  console.log(`\n${manifest.length} sample labels written to samples/`);
}

/** Post-process a PNG into a worse photograph, via ImageMagick. */
async function degrade(file, opts) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const args = [file];
  if (opts.rotate) args.push('-background', '#2a2018', '-rotate', String(opts.rotate));
  if (opts.blur) args.push('-blur', `0x${opts.blur}`);
  if (opts.glare) {
    args.push(
      '-fill', 'rgba(255,255,255,0.55)',
      '-draw', 'polygon 120,80 460,40 700,520 320,700',
    );
  }
  args.push(file);
  await run('convert', args);
}

function toCsv(manifest) {
  const cols = ['file', 'brandName', 'classType', 'alcoholContent', 'netContents', 'bottlerAddress', 'countryOfOrigin'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = manifest.map((m) => cols.map((c) => q(c === 'file' ? m.file : m.application[c])).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
