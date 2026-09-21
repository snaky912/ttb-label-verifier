/**
 * TTB rule data.
 *
 * Everything regulatory lives in this one file so a compliance specialist
 * can review it without reading any other code. Each constant carries the
 * CFR citation it came from.
 *
 * IMPORTANT (prototype caveat): the tolerance and standard-of-fill values
 * below are encoded from published TTB regulations but have NOT been
 * verified against the current eCFR by counsel. Before any operational
 * use, a compliance SME should confirm each value and citation. They are
 * isolated here precisely so that review is a single-file task.
 */

/**
 * The health warning statement required on all alcohol beverage
 * containers. Source: 27 CFR 16.21.
 *
 * This string must match character-for-character (after typographic
 * normalization). Jenny Park's interview flagged that producers routinely
 * paraphrase it; a near-match is a rejection, not a pass.
 */
export const GOVERNMENT_WARNING =
  'GOVERNMENT WARNING: (1) According to the Surgeon General, women should not ' +
  'drink alcoholic beverages during pregnancy because of the risk of birth ' +
  'defects. (2) Consumption of alcoholic beverages impairs your ability to ' +
  'drive a car or operate machinery, and may cause health problems.';

/** The prefix that must appear in capital letters and bold type (27 CFR 16.21). */
export const WARNING_PREFIX = 'GOVERNMENT WARNING:';

/**
 * Permitted alcohol-content tolerance, in percentage points ABV, by
 * beverage class.
 *   - distilled spirits: 27 CFR 5.37(b)
 *   - wine:              27 CFR 4.36(b) — band depends on the 14% tax class
 *   - malt beverage:     27 CFR 7.65
 */
export const ABV_TOLERANCE = {
  spirits: 0.15,
  wine: 1.5, // wines over 14% ABV use WINE_TOLERANCE_ABOVE_14 instead
  malt: 0.3,
  unknown: 0.15, // strictest default when the class is not supplied
};

export const WINE_TAX_CLASS_THRESHOLD = 14.0;
export const WINE_TOLERANCE_ABOVE_14 = 1.0;

/**
 * Authorized standards of fill, in millilitres.
 *   - distilled spirits: 27 CFR 5.203
 *   - wine:              27 CFR 4.72
 * A net contents value outside these lists is flagged for review rather
 * than failed: TTB has amended these lists repeatedly and exemptions exist.
 */
export const STANDARDS_OF_FILL = {
  spirits: [50, 100, 200, 375, 500, 700, 720, 750, 1000, 1750],
  wine: [50, 100, 187, 200, 250, 375, 500, 720, 750, 1000, 1500, 3000],
  malt: [], // malt beverages have no standards of fill
  unknown: [],
};

/**
 * Similarity thresholds that separate the three verdicts.
 *
 * The three-state design is a direct response to Dave Morrison's point
 * that "you need judgment": the tool auto-clears only what is
 * unambiguous, and routes anything arguable to a human rather than
 * guessing. It never auto-rejects on a near miss.
 */
export const THRESHOLDS = {
  /** At or above this, a non-identical string is treated as the same value. */
  autoPass: 0.95,
  /** At or above this (but below autoPass), route to human review. */
  review: 0.72,
  /** Below `review`, the values are treated as genuinely different. */
};

/** Per-field confidence below which extraction is not trusted. */
export const MIN_FIELD_CONFIDENCE = 0.55;

/** Beverage classes the engine understands. */
export const BEVERAGE_CLASSES = ['spirits', 'wine', 'malt', 'unknown'];

/**
 * Infer a beverage class from a class/type designation string, so the
 * caller does not have to supply one. Conservative: anything unclear
 * returns 'unknown', which selects the strictest tolerance.
 */
export function inferBeverageClass(classType = '') {
  const s = String(classType).toLowerCase();
  if (/\b(whisk|bourbon|rye|scotch|vodka|gin|rum|tequila|mezcal|brandy|cognac|liqueur|cordial|spirit|moonshine|absinthe)/.test(s)) {
    return 'spirits';
  }
  if (/\b(wine|chardonnay|cabernet|merlot|pinot|riesling|sauvignon|zinfandel|champagne|prosecco|rose|port|sherry|vermouth|sangria|mead)/.test(s)) {
    return 'wine';
  }
  if (/\b(beer|ale|lager|stout|porter|pilsner|ipa|malt|saison|hefeweizen|kolsch|gose)/.test(s)) {
    return 'malt';
  }
  return 'unknown';
}

/** Tolerance lookup that accounts for the wine tax-class split. */
export function abvToleranceFor(beverageClass, declaredAbv) {
  if (beverageClass === 'wine' && Number(declaredAbv) > WINE_TAX_CLASS_THRESHOLD) {
    return WINE_TOLERANCE_ABOVE_14;
  }
  return ABV_TOLERANCE[beverageClass] ?? ABV_TOLERANCE.unknown;
}
