/**
 * The extraction prompt, shared by both builds.
 *
 * The model is asked to do exactly one thing: transcribe what is printed
 * on the label, verbatim, with a confidence score per field. It is
 * explicitly told NOT to judge compliance — that is `src/core/verify.js`'s
 * job. Keeping the model out of the decision keeps the decision testable.
 *
 * Two instructions are doing heavy lifting:
 *   - "preserve capitalization exactly": the difference between
 *     "GOVERNMENT WARNING" and "Government Warning" is the difference
 *     between an approval and a rejection, and a model left to its own
 *     devices will happily normalize the case away.
 *   - "report what you can and cannot read": a model that guesses at a
 *     glare-obscured digit produces a confident wrong rejection, which is
 *     worse for an agent than an honest "I could not read this".
 */

export const EXTRACTION_SCHEMA_EXAMPLE = {
  brandName: 'OLD TOM DISTILLERY',
  classType: 'Kentucky Straight Bourbon Whiskey',
  alcoholContent: '45% Alc./Vol. (90 Proof)',
  netContents: '750 mL',
  bottlerAddress: 'Distilled and Bottled by Old Tom Distillery, Bardstown, KY',
  countryOfOrigin: '',
  governmentWarning: 'GOVERNMENT WARNING: (1) According to the Surgeon General, ...',
  warningPrefixBold: true,
  confidence: {
    brandName: 0.98,
    classType: 0.95,
    alcoholContent: 0.97,
    netContents: 0.99,
    bottlerAddress: 0.9,
    countryOfOrigin: 0,
    governmentWarning: 0.93,
  },
  imageQuality: {
    legible: true,
    issues: [],
    note: '',
  },
  notes: [],
};

export const EXTRACTION_PROMPT = `You are reading an alcohol beverage label for the U.S. Alcohol and Tobacco Tax and Trade Bureau (TTB).

Transcribe what is printed on the label image. Do NOT assess compliance, do not say whether anything is correct, and do not compare against any regulation — another system does that. Your only job is accurate transcription.

Rules that matter:

1. PRESERVE CAPITALIZATION EXACTLY as printed. If the label prints "Government Warning:" in title case, transcribe it in title case. Never normalize, correct, or tidy capitalization. This distinction decides real outcomes.

2. TRANSCRIBE VERBATIM, including punctuation, numbering such as "(1)" and "(2)", and abbreviations. Do not paraphrase, expand, or complete text from memory. In particular, if the government warning paragraph on the label is worded differently from the one you know, transcribe the DIFFERENT wording that is actually printed.

3. If a field does not appear on the label, return an empty string for it. Never invent a plausible value.

4. If glare, blur, an oblique angle, or a fold makes part of the label hard to read, do your best and say so honestly in the confidence score and in imageQuality. A low confidence score is far more useful than a confident guess.

5. The label may be photographed at an angle or upside down; read it anyway.

Return ONLY a JSON object with exactly these keys:

{
  "brandName": string,
  "classType": string,
  "alcoholContent": string,
  "netContents": string,
  "bottlerAddress": string,
  "countryOfOrigin": string,
  "governmentWarning": string,
  "warningPrefixBold": boolean | null,
  "confidence": {
    "brandName": number, "classType": number, "alcoholContent": number,
    "netContents": number, "bottlerAddress": number,
    "countryOfOrigin": number, "governmentWarning": number
  },
  "imageQuality": { "legible": boolean, "issues": string[], "note": string },
  "notes": string[]
}

Field guidance:
- brandName: the brand as displayed, usually the most prominent text.
- classType: the class or type designation, e.g. "Kentucky Straight Bourbon Whiskey", "Cabernet Sauvignon", "India Pale Ale".
- alcoholContent: the whole statement as printed, e.g. "45% Alc./Vol. (90 Proof)".
- netContents: the whole statement as printed, e.g. "750 mL".
- bottlerAddress: the bottler/producer/importer name and address line(s), joined with ", ".
- countryOfOrigin: only if printed (imports); otherwise "".
- governmentWarning: the ENTIRE health warning paragraph, verbatim, starting with the warning prefix as printed.
- warningPrefixBold: true if the "GOVERNMENT WARNING:" prefix appears in bold/heavier type than the rest of the paragraph, false if it does not, null if you cannot tell.
- confidence: 0 to 1 per field. Use 0 for a field that is absent.
- imageQuality.issues: any of "glare", "blur", "angle", "low_resolution", "cropped", "obstructed", "low_contrast".
- notes: anything an agent should know that does not fit above. Keep it short.

Reply with the JSON object and nothing else.`;

/** An empty extraction, used when a call fails, so callers have a stable shape. */
export function emptyExtraction(note = '') {
  return {
    brandName: '',
    classType: '',
    alcoholContent: '',
    netContents: '',
    bottlerAddress: '',
    countryOfOrigin: '',
    governmentWarning: '',
    warningPrefixBold: null,
    confidence: {},
    imageQuality: { legible: false, issues: [], note },
    notes: note ? [note] : [],
  };
}

/** Defensive coercion: the model is untrusted input like any other. */
export function coerceExtraction(raw) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
  };
  const obj = raw && typeof raw === 'object' ? raw : {};
  const conf = obj.confidence && typeof obj.confidence === 'object' ? obj.confidence : {};
  const quality = obj.imageQuality && typeof obj.imageQuality === 'object' ? obj.imageQuality : {};

  return {
    brandName: str(obj.brandName),
    classType: str(obj.classType),
    alcoholContent: str(obj.alcoholContent),
    netContents: str(obj.netContents),
    bottlerAddress: str(obj.bottlerAddress),
    countryOfOrigin: str(obj.countryOfOrigin),
    governmentWarning: str(obj.governmentWarning),
    warningPrefixBold:
      typeof obj.warningPrefixBold === 'boolean' ? obj.warningPrefixBold : null,
    confidence: {
      brandName: num(conf.brandName),
      classType: num(conf.classType),
      alcoholContent: num(conf.alcoholContent),
      netContents: num(conf.netContents),
      bottlerAddress: num(conf.bottlerAddress),
      countryOfOrigin: num(conf.countryOfOrigin),
      governmentWarning: num(conf.governmentWarning),
    },
    imageQuality: {
      legible: quality.legible !== false,
      issues: Array.isArray(quality.issues) ? quality.issues.map(str).slice(0, 8) : [],
      note: str(quality.note),
    },
    notes: Array.isArray(obj.notes) ? obj.notes.map(str).slice(0, 8) : [],
  };
}
