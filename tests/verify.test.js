import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyLabel, VERDICT } from '../src/core/verify.js';
import { GOVERNMENT_WARNING } from '../src/core/rules.js';
import { parseAbv, parseNetContents } from '../src/core/parse.js';
import { bestSimilarity } from '../src/core/similarity.js';
import { isAllCaps, normalizeForComparison } from '../src/core/normalize.js';
import { wordDiff } from '../src/core/diff.js';
import { coerceExtraction } from '../src/extract/prompt.js';

/** A fully compliant application/label pair, used as the baseline. */
const APPLICATION = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContent: '45% Alc./Vol.',
  netContents: '750 mL',
  bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
  countryOfOrigin: '',
};

const GOOD_LABEL = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContent: '45% Alc./Vol. (90 Proof)',
  netContents: '750 mL',
  bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
  countryOfOrigin: '',
  governmentWarning: GOVERNMENT_WARNING,
  warningPrefixBold: true,
  confidence: {},
  imageQuality: { legible: true, issues: [], note: '' },
};

const run = (labelOverrides = {}, appOverrides = {}) =>
  verifyLabel({
    application: { ...APPLICATION, ...appOverrides },
    extracted: { ...GOOD_LABEL, ...labelOverrides },
  });

const fieldById = (result, id) => result.fields.find((f) => f.id === id);

describe('normalization primitives', () => {
  test('curly and straight apostrophes compare equal', () => {
    assert.equal(normalizeForComparison('STONE’S THROW'), normalizeForComparison("Stone's Throw"));
  });

  test('isAllCaps ignores punctuation and digits', () => {
    assert.equal(isAllCaps('GOVERNMENT WARNING:'), true);
    assert.equal(isAllCaps('Government Warning:'), false);
    assert.equal(isAllCaps('GOVERNMENT wARNING:'), false);
    assert.equal(isAllCaps('(1) 750'), false, 'no letters means nothing is capitalized');
  });

  test('similarity rewards reordered tokens', () => {
    assert.ok(bestSimilarity('Old Tom Distillery', 'Distillery, Old Tom') > 0.9);
  });
});

describe('quantity parsing', () => {
  test('ABV from assorted label phrasings', () => {
    assert.equal(parseAbv('45% Alc./Vol. (90 Proof)').value, 45);
    assert.equal(parseAbv('ALC. 12.5% BY VOL').value, 12.5);
    assert.equal(parseAbv('40% ABV').value, 40);
    assert.equal(parseAbv('  5.5 %  ').value, 5.5);
    assert.equal(parseAbv('nothing here'), null);
  });

  test('proof alone is halved to ABV', () => {
    const p = parseAbv('90 Proof');
    assert.equal(p.value, 45);
    assert.equal(p.isProof, true);
  });

  test('net contents convert to millilitres', () => {
    assert.equal(parseNetContents('750 mL').ml, 750);
    assert.equal(parseNetContents('750ML').ml, 750);
    assert.equal(parseNetContents('0.75 L').ml, 750);
    assert.equal(parseNetContents('75 cL').ml, 750);
    assert.equal(parseNetContents('1.75L').ml, 1750);
    assert.equal(Math.round(parseNetContents('12 FL. OZ.').ml), 355);
  });
});

describe('baseline', () => {
  test('a fully compliant label passes every check', () => {
    const r = run();
    assert.equal(r.verdict, VERDICT.PASS);
    assert.equal(r.counts.fail, 0);
    assert.equal(r.counts.review, 0);
  });
});

describe('brand name — Dave Morrison\'s STONE\'S THROW case', () => {
  test('case-only difference is a pass, not a mismatch', () => {
    const r = run({ brandName: "Stone's Throw" }, { brandName: "STONE'S THROW" });
    const f = fieldById(r, 'brandName');
    assert.equal(f.verdict, VERDICT.PASS);
    assert.match(f.message, /Capitalization or punctuation differs/);
  });

  test('curly vs straight apostrophe is a pass', () => {
    const r = run({ brandName: 'STONE’S THROW' }, { brandName: "STONE'S THROW" });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.PASS);
  });

  test('a near miss goes to human review, never an automatic rejection', () => {
    const r = run({ brandName: 'Old Tomm Distillery' }, { brandName: 'Old Tom Distillery' });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.REVIEW);
    assert.equal(r.verdict, VERDICT.REVIEW);
  });

  test('a genuinely different brand fails', () => {
    const r = run({ brandName: 'Silver Creek Spirits' });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.FAIL);
    assert.equal(r.verdict, VERDICT.FAIL);
  });

  test('a brand missing from the label fails', () => {
    const r = run({ brandName: '' });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.FAIL);
  });
});

describe('alcohol content', () => {
  test('proof-only label matches a percentage application', () => {
    const r = run({ alcoholContent: '90 Proof' });
    assert.equal(fieldById(r, 'alcoholContent').verdict, VERDICT.PASS);
  });

  test('difference beyond the spirits tolerance fails', () => {
    const r = run({ alcoholContent: '47% Alc./Vol.' });
    const f = fieldById(r, 'alcoholContent');
    assert.equal(f.verdict, VERDICT.FAIL);
    assert.equal(f.detail.delta, 2);
  });

  test('a difference inside the spirits tolerance passes', () => {
    const r = run({ alcoholContent: '45.1% Alc./Vol.' });
    assert.equal(fieldById(r, 'alcoholContent').verdict, VERDICT.PASS);
  });

  test('wine gets its wider tolerance below the 14% tax class line', () => {
    const r = verifyLabel({
      application: { ...APPLICATION, classType: 'Chardonnay', alcoholContent: '12.5% Alc./Vol.' },
      extracted: { ...GOOD_LABEL, classType: 'Chardonnay', alcoholContent: '13.5% Alc./Vol.' },
    });
    assert.equal(fieldById(r, 'alcoholContent').verdict, VERDICT.PASS);
    assert.equal(r.meta.beverageClass, 'wine');
  });

  test('missing alcohol statement on the label fails', () => {
    const r = run({ alcoholContent: '' });
    assert.equal(fieldById(r, 'alcoholContent').verdict, VERDICT.FAIL);
  });
});

describe('net contents', () => {
  test('equivalent units match', () => {
    const r = run({ netContents: '0.75 L' });
    assert.equal(fieldById(r, 'netContents').verdict, VERDICT.PASS);
  });

  test('a different volume fails', () => {
    const r = run({ netContents: '700 mL' });
    assert.equal(fieldById(r, 'netContents').verdict, VERDICT.FAIL);
  });

  test('a matching but non-standard fill is flagged for review', () => {
    const r = run({ netContents: '680 mL' }, { netContents: '680 mL' });
    const f = fieldById(r, 'netContents');
    assert.equal(f.verdict, VERDICT.REVIEW);
    assert.match(f.message, /standard of fill/);
  });
});

describe('government health warning — 27 CFR 16.21', () => {
  test('exact statutory text passes', () => {
    assert.equal(fieldById(run(), 'governmentWarning').verdict, VERDICT.PASS);
  });

  test('missing warning fails', () => {
    const r = run({ governmentWarning: '' });
    assert.equal(fieldById(r, 'governmentWarning').verdict, VERDICT.FAIL);
    assert.equal(r.verdict, VERDICT.FAIL);
  });

  test('title-case prefix fails — Jenny Park\'s rejected label', () => {
    const titleCase = GOVERNMENT_WARNING.replace('GOVERNMENT WARNING:', 'Government Warning:');
    const r = run({ governmentWarning: titleCase });
    const f = fieldById(r, 'governmentWarning');
    assert.equal(f.verdict, VERDICT.FAIL);
    assert.match(f.message, /capital letters/);
    assert.equal(f.detail.prefixIsAllCaps, false);
  });

  test('a single altered word fails and the diff names it', () => {
    const altered = GOVERNMENT_WARNING.replace('should not drink', 'should avoid');
    const r = run({ governmentWarning: altered });
    const f = fieldById(r, 'governmentWarning');
    assert.equal(f.verdict, VERDICT.FAIL);
    const changed = f.detail.diff.filter((d) => d.type !== 'same');
    assert.ok(changed.length > 0, 'diff should identify the changed words');
  });

  test('a paraphrased warning fails', () => {
    const r = run({
      governmentWarning:
        'GOVERNMENT WARNING: Drinking alcohol during pregnancy can cause birth defects, and alcohol impairs your ability to drive.',
    });
    assert.equal(fieldById(r, 'governmentWarning').verdict, VERDICT.FAIL);
  });

  test('typographic differences alone do not fail the warning', () => {
    const curly = GOVERNMENT_WARNING.replace(/ /g, ' ').replace('General,', 'General,');
    const r = run({ governmentWarning: curly });
    assert.equal(fieldById(r, 'governmentWarning').verdict, VERDICT.PASS);
  });

  test('non-bold prefix is reported but does not auto-fail', () => {
    const r = run({ warningPrefixBold: false });
    const f = fieldById(r, 'governmentWarning');
    assert.equal(f.verdict, VERDICT.PASS);
    assert.equal(f.detail.boldPrefixReported, false);
  });
});

describe('bottler / producer name and address', () => {
  const APP_ADDR = 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY';
  const addr = (labelValue, appValue = APP_ADDR) =>
    fieldById(run({ bottlerAddress: labelValue }, { bottlerAddress: appValue }), 'bottlerAddress');

  test('label read without the "Distilled and Bottled by" lead-in still matches', () => {
    // Regression: found in the first real-model run. Every label failed
    // here because the model transcribed only the name and address.
    assert.equal(addr('Old Tom Distillery, Bardstown, KY').verdict, VERDICT.PASS);
  });

  test('application entered without the lead-in matches a label that has it', () => {
    assert.equal(addr(APP_ADDR, 'Old Tom Distillery, Bardstown, KY').verdict, VERDICT.PASS);
  });

  test('extra words picked up from nearby text do not fail the match', () => {
    const f = addr('Old Tom Distillery, Est. 1897, Bardstown, KY');
    assert.equal(f.verdict, VERDICT.PASS);
    assert.match(f.message, /also includes/i);
  });

  test('a ZIP code on the label but not the application is fine', () => {
    assert.equal(addr('Distilled and Bottled by Old Tom Distillery, Bardstown, KY 40004').verdict, VERDICT.PASS);
  });

  test('a different qualifying phrase is flagged, because the phrase has legal meaning', () => {
    const f = addr('Bottled by Old Tom Distillery, Bardstown, KY');
    assert.equal(f.verdict, VERDICT.REVIEW);
    assert.match(f.message, /Bottled by/);
  });

  test('a different city is never cleared automatically', () => {
    assert.notEqual(addr('Distilled and Bottled by Old Tom Distillery, Louisville, KY').verdict, VERDICT.PASS);
  });

  test('a different company entirely fails', () => {
    assert.equal(addr('Bottled by Riverbend Spirits Co., Frankfort, KY').verdict, VERDICT.FAIL);
  });

  test('imported-by statements are handled the same way', () => {
    const f = fieldById(
      verifyLabel({
        application: { ...APPLICATION, bottlerAddress: 'Imported by Carrick Imports LLC, Chicago, IL' },
        extracted: { ...GOOD_LABEL, bottlerAddress: 'Carrick Imports LLC, Chicago, IL' },
      }),
      'bottlerAddress',
    );
    assert.equal(f.verdict, VERDICT.PASS);
  });
});

describe('imports', () => {
  test('country of origin is required once the application declares an import', () => {
    const r = verifyLabel({
      application: { ...APPLICATION, countryOfOrigin: 'Product of Scotland' },
      extracted: { ...GOOD_LABEL, countryOfOrigin: '' },
    });
    assert.equal(fieldById(r, 'countryOfOrigin').verdict, VERDICT.FAIL);
  });

  test('a domestic label is not penalized for omitting it', () => {
    assert.equal(fieldById(run(), 'countryOfOrigin').verdict, VERDICT.PASS);
  });
});

describe('image quality safeguards', () => {
  test('a mild misread still lands in review on similarity alone', () => {
    // Close enough that the similarity thresholds already route it to a
    // human; no confidence downgrade is needed to avoid a false rejection.
    const r = run({ brandName: 'OLD TDM DISTILLERV' });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.REVIEW);
  });

  test('low confidence downgrades an outright failure to review rather than rejecting', () => {
    // Badly misread under glare: the text is nothing like the application,
    // which would normally fail. Because the model reported it could barely
    // read the field, the agent is asked to look instead of the applicant
    // being rejected on an unreadable photograph.
    const r = run({
      brandName: 'RIVERBEND RESERVE',
      confidence: { brandName: 0.3 },
      imageQuality: { legible: true, issues: ['glare'], note: 'glare across brand area' },
    });
    const f = fieldById(r, 'brandName');
    assert.equal(f.verdict, VERDICT.REVIEW);
    assert.equal(f.detail.downgradedForLowConfidence, true);
    assert.match(f.message, /hard to read/);
  });

  test('the same mismatch read confidently is a real failure', () => {
    const r = run({ brandName: 'RIVERBEND RESERVE', confidence: { brandName: 0.97 } });
    assert.equal(fieldById(r, 'brandName').verdict, VERDICT.FAIL);
  });

  test('an illegible image never returns a clean pass', () => {
    const r = run({ imageQuality: { legible: false, issues: ['blur'], note: 'out of focus' } });
    assert.equal(r.verdict, VERDICT.REVIEW);
  });
});

describe('extraction coercion', () => {
  test('malformed model output is coerced to a safe shape', () => {
    const e = coerceExtraction({ brandName: 42, confidence: 'nope', imageQuality: null, notes: 'x' });
    assert.equal(e.brandName, '42');
    assert.equal(e.governmentWarning, '');
    assert.equal(e.confidence.brandName, null);
    assert.deepEqual(e.imageQuality.issues, []);
    assert.deepEqual(e.notes, []);
  });

  test('null input does not throw', () => {
    assert.doesNotThrow(() => coerceExtraction(null));
  });
});

describe('diff', () => {
  test('identical strings produce no changes', () => {
    assert.equal(wordDiff('a b c', 'a b c').every((p) => p.type === 'same'), true);
  });

  test('a substitution is reported as removed plus added', () => {
    const parts = wordDiff('the quick fox', 'the slow fox');
    assert.ok(parts.some((p) => p.type === 'removed' && p.value.includes('quick')));
    assert.ok(parts.some((p) => p.type === 'added' && p.value.includes('slow')));
  });
});
