/**
 * Parsers that turn free-text label values into comparable numbers.
 *
 * Labels state the same quantity many ways ("45% Alc./Vol. (90 Proof)",
 * "ALC 45% BY VOL", "90 PROOF"). Comparing those as strings produces
 * false mismatches, so every quantity is parsed to a number first and
 * compared numerically.
 */

import { normalizeTypography } from './normalize.js';

const ML_PER_US_FL_OZ = 29.5735295625;

/**
 * Extract alcohol-by-volume as a number.
 *
 * Handles: "45%", "45% Alc./Vol.", "ALC. 45% BY VOL", "45 ABV",
 * "90 Proof" (halved), "12.5% alc/vol". Returns
 * `{ value, source, isProof }` or null when nothing parses.
 */
export function parseAbv(input) {
  const s = normalizeTypography(input);
  if (!s) return null;

  // A percentage is the primary signal and wins over proof when both appear.
  const pct = s.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%/);
  if (pct) {
    const value = Number(pct[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      return { value, source: pct[0], isProof: false };
    }
  }

  // "45 ALC/VOL" or "ALC 45 BY VOL" without a percent sign.
  const alc = s.match(/alc[^0-9]{0,12}(\d{1,2}(?:\.\d{1,2})?)/i);
  if (alc) {
    const value = Number(alc[1]);
    if (Number.isFinite(value) && value <= 100) {
      return { value, source: alc[0], isProof: false };
    }
  }

  // Degrees proof — US proof is exactly twice ABV.
  const proof = s.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:degrees?\s*)?proof/i);
  if (proof) {
    const p = Number(proof[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 200) {
      return { value: p / 2, source: proof[0], isProof: true };
    }
  }

  return null;
}

/**
 * Extract net contents and convert to millilitres.
 * Handles mL, cL, dL, L / LITER / LITRE, and US fluid ounces.
 * Returns `{ ml, value, unit, source }` or null.
 */
export function parseNetContents(input) {
  const s = normalizeTypography(input);
  if (!s) return null;

  const m = s.match(
    /(\d{1,5}(?:[.,]\d{1,3})?)\s*(ml|milliliters?|millilitres?|cl|centiliters?|centilitres?|dl|l\b|lt\b|liters?|litres?|fl\.?\s*oz\.?|fluid\s*ounces?|oz\b)/i,
  );
  if (!m) return null;

  const value = Number(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const unitRaw = m[2].toLowerCase().replace(/[.\s]/g, '');
  let ml;
  if (unitRaw.startsWith('ml') || unitRaw.startsWith('milli')) ml = value;
  else if (unitRaw.startsWith('cl') || unitRaw.startsWith('centi')) ml = value * 10;
  else if (unitRaw.startsWith('dl')) ml = value * 100;
  else if (unitRaw === 'l' || unitRaw === 'lt' || unitRaw.startsWith('liter') || unitRaw.startsWith('litre')) ml = value * 1000;
  else ml = value * ML_PER_US_FL_OZ; // fl oz / oz

  return { ml: Math.round(ml * 100) / 100, value, unit: unitRaw, source: m[0] };
}

/** Format millilitres for display, preferring the unit a human would use. */
export function formatMl(ml) {
  if (ml == null) return '';
  if (ml >= 1000) return `${Number((ml / 1000).toFixed(3))} L`;
  return `${Number(ml.toFixed(2))} mL`;
}
