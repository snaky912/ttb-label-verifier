/**
 * The verification engine.
 *
 * DESIGN DECISION — the single most important one in this project:
 * the language model extracts, deterministic code decides.
 *
 * The model's only job is to read text off an image and report it
 * verbatim. Every pass/fail judgement is made here, by ordinary code that
 * is unit-tested, reads the same way twice, and can be reviewed by a
 * compliance specialist. A regulatory decision that changes between runs,
 * or that nobody can explain afterwards, is not usable evidence — and
 * "the AI said so" is not a defensible basis for rejecting an
 * application.
 *
 * This module is pure: no network, no I/O, no framework. It is shared
 * verbatim by the server build and the browser build.
 */

import { normalizeTypography, normalizeForComparison, isAllCaps } from './normalize.js';
import { bestSimilarity } from './similarity.js';
import { parseAbv, parseNetContents, formatMl } from './parse.js';
import { wordDiff, summarizeDiff } from './diff.js';
import {
  GOVERNMENT_WARNING,
  WARNING_PREFIX,
  THRESHOLDS,
  MIN_FIELD_CONFIDENCE,
  STANDARDS_OF_FILL,
  inferBeverageClass,
  abvToleranceFor,
} from './rules.js';

export const VERDICT = {
  PASS: 'pass',
  REVIEW: 'review',
  FAIL: 'fail',
};

/** Verdict precedence: the worst field result becomes the overall result. */
const SEVERITY = { pass: 0, review: 1, fail: 2 };

function worst(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function field(id, label, partial) {
  return {
    id,
    label,
    verdict: VERDICT.PASS,
    applicationValue: '',
    labelValue: '',
    message: '',
    detail: null,
    confidence: null,
    ...partial,
  };
}

/**
 * Compare a free-text field (brand name, class/type, address...).
 *
 * Three outcomes, never two:
 *   exact after normalization        -> pass
 *   very close                       -> pass, with a note about presentation
 *   plausibly the same               -> review (a human decides)
 *   different                        -> fail
 *
 * "STONE'S THROW" vs "Stone's Throw" lands in the second bucket: cleared
 * automatically, but the difference is still reported so the record shows
 * what the agent's tool saw.
 */
function compareText(id, label, appValue, labelValue, opts = {}) {
  const { required = true, confidence = null } = opts;
  const app = normalizeTypography(appValue);
  const lab = normalizeTypography(labelValue);

  if (!app && !lab) {
    return field(id, label, {
      verdict: required ? VERDICT.REVIEW : VERDICT.PASS,
      message: required
        ? 'Not present in the application or on the label.'
        : 'Not applicable.',
      confidence,
    });
  }

  if (!lab) {
    return field(id, label, {
      verdict: required ? VERDICT.FAIL : VERDICT.REVIEW,
      applicationValue: app,
      message: 'Could not be found on the label.',
      confidence,
    });
  }

  if (!app) {
    return field(id, label, {
      verdict: VERDICT.REVIEW,
      labelValue: lab,
      message: 'Present on the label but missing from the application.',
      confidence,
    });
  }

  const base = { applicationValue: app, labelValue: lab, confidence };

  if (app === lab) {
    return field(id, label, { ...base, verdict: VERDICT.PASS, message: 'Exact match.' });
  }

  if (normalizeForComparison(app) === normalizeForComparison(lab)) {
    return field(id, label, {
      ...base,
      verdict: VERDICT.PASS,
      message: 'Match. Capitalization or punctuation differs, which is not a mismatch of substance.',
    });
  }

  const score = bestSimilarity(app, lab);
  if (score >= THRESHOLDS.autoPass) {
    return field(id, label, {
      ...base,
      verdict: VERDICT.PASS,
      message: `Match (${Math.round(score * 100)}% similar). Minor formatting difference.`,
      detail: { similarity: score },
    });
  }
  if (score >= THRESHOLDS.review) {
    return field(id, label, {
      ...base,
      verdict: VERDICT.REVIEW,
      message: `Close but not identical (${Math.round(score * 100)}% similar). Needs an agent's judgement.`,
      detail: { similarity: score },
    });
  }
  return field(id, label, {
    ...base,
    verdict: VERDICT.FAIL,
    message: 'Does not match the application.',
    detail: { similarity: score },
  });
}

/** Alcohol content: parsed to a number, compared against the class tolerance. */
function compareAbv(appValue, labelValue, beverageClass, confidence) {
  const app = parseAbv(appValue);
  const lab = parseAbv(labelValue);
  const base = {
    applicationValue: normalizeTypography(appValue),
    labelValue: normalizeTypography(labelValue),
    confidence,
  };

  if (!lab) {
    return field('alcoholContent', 'Alcohol content', {
      ...base,
      verdict: VERDICT.FAIL,
      message: 'No alcohol content statement could be read on the label.',
    });
  }
  if (!app) {
    return field('alcoholContent', 'Alcohol content', {
      ...base,
      verdict: VERDICT.REVIEW,
      message: 'The label states alcohol content but the application does not.',
    });
  }

  const tolerance = abvToleranceFor(beverageClass, app.value);
  const delta = Math.abs(app.value - lab.value);
  const detail = {
    applicationAbv: app.value,
    labelAbv: lab.value,
    delta: Math.round(delta * 1000) / 1000,
    tolerance,
    beverageClass,
    labelStatedAsProof: lab.isProof,
  };

  if (delta === 0) {
    return field('alcoholContent', 'Alcohol content', {
      ...base,
      verdict: VERDICT.PASS,
      message: `Exact match at ${app.value}% ABV.`,
      detail,
    });
  }
  if (delta <= tolerance) {
    return field('alcoholContent', 'Alcohol content', {
      ...base,
      verdict: VERDICT.PASS,
      message: `Within the ${tolerance}% tolerance for ${beverageClass} (application ${app.value}%, label ${lab.value}%).`,
      detail,
    });
  }
  return field('alcoholContent', 'Alcohol content', {
    ...base,
    verdict: VERDICT.FAIL,
    message: `Application says ${app.value}% ABV, label says ${lab.value}% — a difference of ${detail.delta} points, over the ${tolerance}% tolerance.`,
    detail,
  });
}

/** Net contents: converted to millilitres, then compared exactly. */
function compareNetContents(appValue, labelValue, beverageClass, confidence) {
  const app = parseNetContents(appValue);
  const lab = parseNetContents(labelValue);
  const base = {
    applicationValue: normalizeTypography(appValue),
    labelValue: normalizeTypography(labelValue),
    confidence,
  };

  if (!lab) {
    return field('netContents', 'Net contents', {
      ...base,
      verdict: VERDICT.FAIL,
      message: 'No net contents statement could be read on the label.',
    });
  }
  if (!app) {
    return field('netContents', 'Net contents', {
      ...base,
      verdict: VERDICT.REVIEW,
      message: 'The label states net contents but the application does not.',
    });
  }

  const standards = STANDARDS_OF_FILL[beverageClass] ?? [];
  const isStandard = standards.length === 0 || standards.some((s) => Math.abs(s - lab.ml) < 0.5);
  const detail = { applicationMl: app.ml, labelMl: lab.ml, isStandardOfFill: isStandard, beverageClass };

  if (Math.abs(app.ml - lab.ml) >= 0.5) {
    return field('netContents', 'Net contents', {
      ...base,
      verdict: VERDICT.FAIL,
      message: `Application says ${formatMl(app.ml)}, label says ${formatMl(lab.ml)}.`,
      detail,
    });
  }

  if (!isStandard) {
    return field('netContents', 'Net contents', {
      ...base,
      verdict: VERDICT.REVIEW,
      message: `Matches the application, but ${formatMl(lab.ml)} is not an authorized standard of fill for ${beverageClass}. Confirm an exemption applies.`,
      detail,
    });
  }

  return field('netContents', 'Net contents', {
    ...base,
    verdict: VERDICT.PASS,
    message: `Match at ${formatMl(lab.ml)}.`,
    detail,
  });
}

/**
 * The government health warning — the strictest check in the app.
 *
 * Three separate requirements, reported separately so the agent knows
 * which one failed:
 *   1. the statement is present;
 *   2. its wording matches 27 CFR 16.21 exactly;
 *   3. "GOVERNMENT WARNING:" appears in capital letters.
 * Bold type is also required by the regulation, but whether type is bold
 * is a visual judgement the model reports as advisory only — it is
 * surfaced to the agent, never used to auto-fail.
 */
function compareWarning(labelValue, meta = {}) {
  const lab = normalizeTypography(labelValue);
  const base = { applicationValue: 'Required on all containers (27 CFR 16.21)', labelValue: lab };

  if (!lab) {
    return field('governmentWarning', 'Government health warning', {
      ...base,
      verdict: VERDICT.FAIL,
      message: 'The government health warning is missing from the label.',
      detail: { present: false },
    });
  }

  const expected = normalizeTypography(GOVERNMENT_WARNING);
  const exact = lab === expected;
  const caseInsensitiveMatch = lab.toLowerCase() === expected.toLowerCase();

  // Requirement 3: the prefix must be capitalized.
  const prefixMatch = lab.match(/government\s+warning\s*:/i);
  const prefixText = prefixMatch ? prefixMatch[0] : '';
  const prefixIsCaps = prefixText ? isAllCaps(prefixText) : false;

  const detail = {
    present: true,
    textMatchesExactly: exact,
    prefixFound: Boolean(prefixText),
    prefixAsPrinted: prefixText,
    prefixIsAllCaps: prefixIsCaps,
    boldPrefixReported: meta.warningPrefixBold ?? null,
    diff: exact ? null : wordDiff(expected, lab),
  };

  if (exact) {
    return field('governmentWarning', 'Government health warning', {
      ...base,
      verdict: VERDICT.PASS,
      message: 'Present and matches the required text exactly.',
      detail,
    });
  }

  // Wording is right but the prefix is not capitalized — the exact case
  // Jenny Park described catching by eye ("Government Warning" in title case).
  if (caseInsensitiveMatch && !prefixIsCaps) {
    return field('governmentWarning', 'Government health warning', {
      ...base,
      verdict: VERDICT.FAIL,
      message: `Wording is correct, but "${prefixText}" must appear in capital letters as "${WARNING_PREFIX}" (27 CFR 16.21).`,
      detail,
    });
  }

  if (caseInsensitiveMatch) {
    return field('governmentWarning', 'Government health warning', {
      ...base,
      verdict: VERDICT.REVIEW,
      message: 'Wording matches, but capitalization differs from the statutory text elsewhere in the statement. Confirm by eye.',
      detail,
    });
  }

  const summary = summarizeDiff(detail.diff);
  return field('governmentWarning', 'Government health warning', {
    ...base,
    verdict: VERDICT.FAIL,
    message: `The warning text does not match the required wording — ${summary || 'wording differs'}.`,
    detail,
  });
}

/**
 * Verify one extracted label against one application record.
 *
 * @param {object} args
 * @param {object} args.application  Fields the applicant declared.
 * @param {object} args.extracted    Fields read off the label image.
 * @param {object} [args.options]    { isImport, beverageClass }
 * @returns {object} A structured, serializable result.
 */
export function verifyLabel({ application = {}, extracted = {}, options = {} }) {
  const confidence = extracted.confidence || {};
  const beverageClass =
    options.beverageClass ||
    inferBeverageClass(application.classType || extracted.classType || '');

  const isImport =
    options.isImport ??
    Boolean(normalizeTypography(application.countryOfOrigin) || normalizeTypography(extracted.countryOfOrigin));

  const fields = [
    compareText('brandName', 'Brand name', application.brandName, extracted.brandName, {
      confidence: confidence.brandName ?? null,
    }),
    compareText('classType', 'Class / type designation', application.classType, extracted.classType, {
      confidence: confidence.classType ?? null,
    }),
    compareAbv(application.alcoholContent, extracted.alcoholContent, beverageClass, confidence.alcoholContent ?? null),
    compareNetContents(application.netContents, extracted.netContents, beverageClass, confidence.netContents ?? null),
    compareText('bottlerAddress', 'Bottler / producer name and address', application.bottlerAddress, extracted.bottlerAddress, {
      confidence: confidence.bottlerAddress ?? null,
    }),
    compareText('countryOfOrigin', 'Country of origin', application.countryOfOrigin, extracted.countryOfOrigin, {
      required: isImport,
      confidence: confidence.countryOfOrigin ?? null,
    }),
    compareWarning(extracted.governmentWarning, {
      warningPrefixBold: extracted.warningPrefixBold,
    }),
  ];

  // Low extraction confidence must never masquerade as a compliance
  // failure. If the model was unsure it could read a field, the honest
  // answer is "a human should look", not "rejected".
  for (const f of fields) {
    if (
      f.confidence != null &&
      f.confidence < MIN_FIELD_CONFIDENCE &&
      f.verdict === VERDICT.FAIL
    ) {
      f.verdict = VERDICT.REVIEW;
      f.message = `${f.message} (The label image was hard to read here, so this is flagged for review rather than rejected.)`;
      f.detail = { ...(f.detail || {}), downgradedForLowConfidence: true };
    }
  }

  let overall = VERDICT.PASS;
  for (const f of fields) overall = worst(overall, f.verdict);

  // A poor image should send the whole application to review rather than
  // produce confident-looking results from a photograph nobody can read.
  const quality = extracted.imageQuality || {};
  if (quality.legible === false && overall === VERDICT.PASS) {
    overall = VERDICT.REVIEW;
  }

  const counts = fields.reduce(
    (acc, f) => ({ ...acc, [f.verdict]: (acc[f.verdict] || 0) + 1 }),
    { pass: 0, review: 0, fail: 0 },
  );

  return {
    verdict: overall,
    summary: summarize(overall, counts),
    counts,
    fields,
    meta: {
      beverageClass,
      isImport,
      imageQuality: quality,
      notes: extracted.notes || [],
      rulesVersion: '27 CFR parts 4, 5, 7, 16 (prototype encoding)',
    },
  };
}

function summarize(verdict, counts) {
  if (verdict === VERDICT.PASS) return 'All checks passed.';
  if (verdict === VERDICT.FAIL) {
    return `${counts.fail} problem${counts.fail === 1 ? '' : 's'} found${counts.review ? `, ${counts.review} to review` : ''}.`;
  }
  return `${counts.review} item${counts.review === 1 ? '' : 's'} need${counts.review === 1 ? 's' : ''} an agent's review.`;
}

export { GOVERNMENT_WARNING, WARNING_PREFIX };
