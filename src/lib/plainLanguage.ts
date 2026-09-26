// FDA label wording mapped to what it means for the person taking the
// medicines, in everyday words. Ordered roughly by how serious the effect is,
// so the most important reason is shown first.
const EFFECTS: { pattern: RegExp; text: string }[] = [
  {
    pattern: /\b(QT|torsades?|arrhythmi\w*|heart rhythm|irregular heart\w*)\b/i,
    text: "It can upset your heart's rhythm, which can be dangerous.",
  },
  {
    pattern: /\bserotonin syndrome\b/i,
    text: "Too much serotonin can build up, causing shaking, sweating, fever or a racing heart.",
  },
  {
    pattern: /\b(gastrointestinal|GI|stomach)\b[^.]{0,40}\b(bleed\w*|ulcer\w*)|\bulcer\w*\b/i,
    text: "It can irritate your stomach and cause bleeding there.",
  },
  {
    pattern: /\b(bleed\w*|hemorrhag\w*|haemorrhag\w*|coagulation|prothrombin|INR|anticoagula\w*|clotting)\b/i,
    text: "Your blood may take longer to clot, so you could bruise or bleed more easily.",
  },
  {
    pattern: /\b(respiratory depression|CNS depress\w*|sedation|drowsiness|somnolence)\b/i,
    text: "You could become very drowsy, or your breathing could slow down.",
  },
  {
    pattern: /\bseizures?\b|\bconvulsions?\b/i,
    text: "It can raise the chance of a seizure (fit).",
  },
  {
    pattern: /\bangioedema\b/i,
    text: "It can cause swelling of the face, lips or throat.",
  },
  {
    pattern: /\b(hyperkalemia|potassium)\b/i,
    text: "The potassium in your blood could rise too high, which can affect your heartbeat.",
  },
  {
    pattern: /\b(hypotension|drop in blood pressure|blood pressure)\b/i,
    text: "Your blood pressure could drop too low, so you may feel dizzy or faint.",
  },
  {
    pattern: /\b(hypoglycemi\w*|blood sugar|blood glucose)\b/i,
    text: "Your blood sugar could drop too low.",
  },
  {
    pattern: /\b(renal|kidneys?|nephrotox\w*)\b/i,
    text: "It can put extra strain on your kidneys.",
  },
  {
    pattern: /\b(hepat\w*|liver)\b/i,
    text: "It can harm your liver.",
  },
  {
    pattern: /\b(rhabdomyolysis|myopathy|muscle)\b/i,
    text: "It can cause muscle pain or damage.",
  },
  {
    pattern: /\b(concentrations?|plasma levels?|serum levels?|blood levels?|exposure|AUC|toxicity)\b/i,
    text: "One of the medicines can build up in your body to higher levels than intended.",
  },
  {
    pattern: /\b(efficacy|effectiveness|less effective|antagoni\w*)\b|\b(reduce[sd]?|decrease[sd]?|diminish\w*|loss of)\b[^.]{0,40}\beffects?\b/i,
    text: "One of the medicines may not work as well.",
  },
];

/**
 * Turns FDA label sentences into at most two short, everyday reasons (e.g.
 * "may increase coagulation times" becomes "your blood may take longer to
 * clot"). Returns an empty list when nothing recognisable is found.
 */
export function plainEffects(text: string, max = 2): string[] {
  const found: string[] = [];
  for (const { pattern, text: plain } of EFFECTS) {
    if (found.length >= max) break;
    if (pattern.test(text) && !found.includes(plain)) found.push(plain);
  }
  return found;
}

/** A one-line reason when the label wording couldn't be translated. */
export function genericReason(pair: string): string {
  const [a, b] = pair.split(" + ");
  return b
    ? `The official drug label warns about taking ${a} with ${b}.`
    : "The official drug label warns about taking these together.";
}

