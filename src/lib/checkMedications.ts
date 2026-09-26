import { fetchDrugSafetyInfo, DrugApiError, type DrugSafetyInfo } from "../services/drugApi";
import { classesFor, coreDrugName } from "./drugNames";
import { plainEffects } from "./plainLanguage";
import type { ConflictItem, LogEntry, ResultData, Severity } from "../types";

const SEVERITY_RANK: Record<Severity, number> = { major: 3, moderate: 2, minor: 1, unresolved: 0 };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// FDA label text rarely rates an interaction, so severity is read from the
// wording of the specific sentence that mentions the other drug, on top of a
// default set by which section it appeared in.
const MAJOR_SIGNALS =
  /\b(contraindicat\w*|should not be (?:used|co-?administered|given|taken)|do not (?:use|take|co-?administer)|avoid\w*|not recommended|life-threatening|fatal|death|torsades?|rhabdomyolysis|serotonin syndrome|major bleeding|serious bleeding|severe bleeding|hemorrhag\w*|increase[sd]?\s+(?:the\s+)?risk\s+of\s+(?:serious|severe|bleeding|gastrointestinal bleeding|stroke|heart attack))\b/i;
const BLEEDING_UP = /\b(?:increase[sd]?|enhance[sd]?|potentiat\w+|augment\w*)\b[^.]{0,80}\b(?:bleeding|INR|prothrombin|anticoagula\w+ effect)/i;
const ELEVATED_SIGNALS = /\b(increase[sd]?|enhance[sd]?|reduce[sd]?|decrease[sd]?|monitor\w*|dose adjust\w*|adjust\w* the dose|closely|caution|serious|severe|toxicity)\b/i;
const REDUCED_SIGNALS =
  /\b(no significant interaction|not expected to be clinically significant|minor interaction|unlikely to be clinically significant|no dosage adjustment|no clinically significant)\b/i;

function severityForSentence(base: Severity, sentence: string): Severity {
  if (MAJOR_SIGNALS.test(sentence) || BLEEDING_UP.test(sentence)) return "major";
  if (REDUCED_SIGNALS.test(sentence)) return base === "major" ? "moderate" : base === "moderate" ? "minor" : base;
  if (base === "minor" && ELEVATED_SIGNALS.test(sentence)) return "moderate";
  return base;
}

function labelSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(\[])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Label "sentences" are often a whole section run together (e.g. "Diuretics:
 * ... ( 7.1 ) NSAIDS: ... ( 7.3 )"), so the plain-language reason is read from
 * just the clause that mentions the other drug.
 */
function clauseAt(sentence: string, index: number): string {
  const boundary = /\(\s*\d+(?:\.\d+)*(?:\s*,\s*\d+(?:\.\d+)*)*\s*\)|;|\s•\s/g;
  let start = 0;
  for (const m of sentence.matchAll(boundary)) {
    const end = m.index ?? 0;
    if (end >= index) return sentence.slice(start, end);
    start = end + m[0].length;
  }
  return sentence.slice(start);
}

interface Hit {
  severity: Severity;
  sentence: string;
  /** The clause of `sentence` that mentions the other drug. */
  focus: string;
  section: string;
  via: string;
}

/** Finds the strongest sentence in `info`'s label that mentions the other drug by name, brand, or drug class. */
function findHit(info: DrugSafetyInfo, otherName: string, otherInfo: DrugSafetyInfo | null): Hit | null {
  const core = coreDrugName(otherName);
  const names = new Set<string>([core]);
  if (otherInfo?.genericName) names.add(coreDrugName(otherInfo.genericName));
  otherInfo?.brandNames.slice(0, 4).forEach((b) => names.add(coreDrugName(b)));
  const nameTerms = [...names].filter((n) => n.length >= 4);
  const classTerms = classesFor(otherName).flatMap((c) => c.terms.map((t) => ({ t, label: c.label })));
  // Avoid matching a drug's own class when the label is simply describing itself.
  const selfClasses = new Set(classesFor(info.queriedName).map((c) => c.key));

  let best: Hit | null = null;
  let bestNamed: Hit | null = null;
  for (const section of info.sections) {
    for (const sentence of labelSentences(section.text)) {
      const lower = sentence.toLowerCase();
      let via: string | null = null;
      let at = 0;
      for (const n of nameTerms) {
        const m = new RegExp(`\\b${escapeRegExp(n)}`, "i").exec(lower);
        if (m) { via = n; at = m.index; break; }
      }
      if (!via) {
        for (const { t, label } of classTerms) {
          if (t.length < 3) continue;
          const m = new RegExp(`\\b${escapeRegExp(t)}\\b`, t === t.toUpperCase() ? "" : "i").exec(sentence);
          if (m) { via = label; at = m.index; break; }
        }
      }
      if (!via) continue;
      if (selfClasses.size && classesFor(otherName).every((c) => selfClasses.has(c.key)) && !nameTerms.some((n) => lower.includes(n))) continue;
      const sev = severityForSentence(section.severity, sentence);
      const hit: Hit = { severity: sev, focus: clauseAt(sentence, at), sentence: sentence.length > 700 ? sentence.slice(0, 700).replace(/\s+\S*$/, "") + "." : sentence, section: section.label, via };
      const named = nameTerms.includes(via);
      if (named && (!bestNamed || SEVERITY_RANK[sev] > SEVERITY_RANK[bestNamed.severity])) bestNamed = hit;
      if (!best || SEVERITY_RANK[sev] > SEVERITY_RANK[best.severity]) best = hit;
    }
  }
  // A label that names the other drug directly is more specific than one that only mentions its drug class.
  return bestNamed ?? best;
}

const PROFILE_LOOKUP_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type CheckOutcome = { result: ResultData; severity: LogEntry["severity"] };

/**
 * Fetches each item's real FDA label (live openFDA, or the bundled copy of
 * the same data when offline) and reads every sentence of its interaction,
 * warning, and contraindication text for mentions of the other drugs being
 * checked, or of anything already in the patient's profile. Each pair of drugs
 * gets one result that combines what both labels say. This is an honest
 * heuristic: a real pairwise interaction database (e.g. DrugBank) isn't free
 * or keyless, so this surfaces what the FDA's own label text says rather than
 * a fabricated verdict.
 */
export async function checkMedicationsAgainstProfile(
  items: string[],
  profileNames: string[],
  /** When provided, the result offers to add every checked item not already in this list. */
  existingMedicationNames?: string[],
): Promise<CheckOutcome> {
  const seen = new Set<string>();
  const uniqueItems = items.filter((i) => {
    const k = coreDrugName(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const existingCores = existingMedicationNames?.map(coreDrugName);
  const addPromptNames = existingCores
    ? uniqueItems.filter((item) => !existingCores.includes(coreDrugName(item)))
    : undefined;

  try {
    const profileOthers = profileNames.filter((n) => !seen.has(coreDrugName(n)) && coreDrugName(n).length >= 4);
    const profileUnique = [...new Map(profileOthers.map((n) => [coreDrugName(n), n])).values()];

    const all = [...uniqueItems, ...profileUnique];
    const infoByName = new Map<string, DrugSafetyInfo | null>();
    await Promise.all(
      all.map(async (name) => {
        try {
          // A slow lookup for something already in the profile shouldn't hold
          // up the result; it's then matched by name only.
          const lookup = fetchDrugSafetyInfo(name);
          infoByName.set(name, uniqueItems.includes(name) ? await lookup : await withTimeout(lookup, PROFILE_LOOKUP_TIMEOUT_MS));
        } catch (err) {
          if (uniqueItems.includes(name)) throw err;
          infoByName.set(name, null);
        }
      }),
    );

    const checkedInfos = uniqueItems.map((item) => ({ item, info: infoByName.get(item) ?? null }));
    const promptName = (item: string) => infoByName.get(item)?.displayName ?? item;
    const missing = checkedInfos.filter((x) => x.info === null).map((x) => x.item);

    if (missing.length === uniqueItems.length) {
      return {
        severity: "unresolved",
        result: {
          outcome: "unresolved",
          title: uniqueItems.join(", "),
          subtitle: "No FDA label on file",
          note: "openFDA doesn't have a published label under this exact name. Try the generic name, or double check the spelling.",
          addPromptNames: [uniqueItems[0]],
        },
      };
    }

    let anyOffline = false;
    const displayNames: string[] = [];
    // One result per unordered pair, combining what each drug's label says.
    const pairs = new Map<string, { a: string; b: string; hits: { from: string; hit: Hit }[] }>();

    for (const { item, info } of checkedInfos) {
      if (!info) continue;
      displayNames.push(info.displayName);
      if (info.source === "offline") anyOffline = true;

      const others = [...uniqueItems.filter((i) => i !== item), ...profileUnique];
      for (const other of others) {
        const hit = findHit(info, other, infoByName.get(other) ?? null);
        if (!hit) continue;
        const otherLabel = infoByName.get(other)?.displayName ?? other;
        const key = [coreDrugName(item), coreDrugName(other)].sort().join("|");
        const entry = pairs.get(key) ?? { a: info.displayName, b: otherLabel, hits: [] };
        entry.hits.push({ from: info.displayName, hit });
        pairs.set(key, entry);
      }
    }

    const conflicts: ConflictItem[] = [...pairs.values()].map(({ a, b, hits }) => {
      const strongest = hits.reduce((x, y) => (SEVERITY_RANK[y.hit.severity] > SEVERITY_RANK[x.hit.severity] ? y : x));
      const severity = strongest.hit.severity;
      const detail = hits
        .sort((x, y) => SEVERITY_RANK[y.hit.severity] - SEVERITY_RANK[x.hit.severity])
        .map((h) => (hits.length > 1 ? `${h.from} label: ${h.hit.sentence}` : h.hit.sentence))
        .join("\n\n");
      const other = strongest.from === a ? b : a;
      // Strongest hit first, so its reason leads.
      const reasons = plainEffects(hits.map((h) => h.hit.focus).join(" "));
      return {
        pair: `${a} + ${b}`,
        severity,
        headline: `${strongest.from}'s label mentions ${strongest.hit.via === coreDrugName(other) ? other : strongest.hit.via} in its ${strongest.hit.section.toLowerCase()}`,
        detail,
        reasons,
      };
    });
    conflicts.sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);

    const title = displayNames.join(", ") || uniqueItems.join(", ");
    const sourceLabel = anyOffline
      ? "Source: openFDA drug label data, from a saved copy of the FDA labels"
      : "Source: openFDA drug label database, checked live";

    if (conflicts.length > 0) {
      const worst = conflicts.reduce<Severity>(
        (acc, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[acc] ? c.severity : acc),
        "unresolved",
      );
      return {
        severity: worst,
        result: {
          outcome: "found",
          title,
          subtitle: `${conflicts.length} potential interaction${conflicts.length > 1 ? "s" : ""} found, ${anyOffline ? "from a verified FDA source" : "live from openFDA"}`,
          conflicts,
          addPromptNames: addPromptNames?.map(promptName),
          note: missing.length ? `We couldn't find an FDA label for ${missing.join(", ")}, so it wasn't fully checked.` : undefined,
        },
      };
    }

    if (missing.length > 0) {
      return {
        severity: "unresolved",
        result: {
          outcome: "unresolved",
          title,
          subtitle: "Check is incomplete",
          note: `No interaction was found between the drugs we could look up, but we couldn't find an FDA label for ${missing.join(", ")}. Ask a pharmacist to check ${missing.length > 1 ? "them" : "it"} directly.`,
          addPromptNames: addPromptNames?.map(promptName),
        },
      };
    }

    return {
      severity: "clear",
      result: {
        outcome: "clear",
        title,
        subtitle: "No mention found in the current FDA label",
        source: sourceLabel,
        addPromptNames: addPromptNames?.map(promptName),
      },
    };
  } catch (err) {
    return {
      severity: "unresolved",
      result: {
        outcome: "unresolved",
        title: uniqueItems.join(", "),
        subtitle: "Couldn't complete the check",
        note:
          err instanceof DrugApiError
            ? `${err.message} It isn't in our small offline fallback set either. Try a common generic name (e.g. "ibuprofen" instead of a brand name).`
            : "Something went wrong reaching the live drug database. Please try again.",
      },
    };
  }
}
