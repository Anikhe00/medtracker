import type { Severity } from "../types";
import fallbackData from "../data/drugSafetyFallback.json";
import { coreDrugName } from "../lib/drugNames";

const RXNAV_BASE = "https://rxnav.nlm.nih.gov/REST";
const OPENFDA_BASE = "https://api.fda.gov/drug/label.json";

export class DrugApiError extends Error {}

interface ApproxCandidate {
  rxcui?: string;
  name?: string;
  rank?: string;
}

function cleanName(raw: string): string {
  const base =
    raw.toUpperCase() === raw ? raw.replace(/\w\S*/g, (w) => w.charAt(0) + w.slice(1).toLowerCase()) : raw;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function safeFetch(url: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new DrugApiError("Couldn't reach the live drug database.");
  }
  return res;
}

/** Live medication name lookup against the NIH's RxNorm database (no API key required). */
export async function searchMedicationNames(term: string, signal?: AbortSignal): Promise<string[]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];

  const url = `${RXNAV_BASE}/approximateTerm.json?term=${encodeURIComponent(trimmed)}&maxEntries=20`;
  const res = await safeFetch(url, signal);
  if (!res.ok) throw new DrugApiError(`RxNorm lookup failed (${res.status})`);

  const data = await res.json();
  const candidates: ApproxCandidate[] = data?.approximateGroup?.candidate ?? [];

  const byRxcui = new Map<string, { name: string; rank: number }>();
  for (const c of candidates) {
    if (!c.rxcui || !c.name) continue;
    const rank = Number(c.rank ?? 999);
    const existing = byRxcui.get(c.rxcui);
    const name = cleanName(c.name);
    if (!existing || name.length < existing.name.length) {
      byRxcui.set(c.rxcui, { name, rank: existing ? Math.min(existing.rank, rank) : rank });
    }
  }

  return Array.from(byRxcui.values())
    .sort((a, b) => a.rank - b.rank)
    .map((v) => v.name)
    .slice(0, 8);
}

export interface LabelSection {
  key: "boxed_warning" | "contraindications" | "drug_interactions" | "warnings" | "warnings_and_cautions" | "precautions" | "otc_interactions";
  label: string;
  text: string;
  severity: Severity;
}

export interface DrugSafetyInfo {
  queriedName: string;
  displayName: string;
  brandNames: string[];
  genericName?: string;
  sections: LabelSection[];
  /** Whether this came from a live openFDA call or the bundled offline snapshot. */
  source: "live" | "offline";
}

function firstNonEmpty(arr?: string[]): string | undefined {
  const text = arr?.join(" ").trim();
  return text ? text : undefined;
}

function parseLabel(queriedName: string, result: any): DrugSafetyInfo {
  const openfda = result.openfda ?? {};
  const sections: LabelSection[] = [];

  const add = (key: LabelSection["key"], label: string, text: string | undefined, severity: Severity) => {
    if (text) sections.push({ key, label, text, severity });
  };

  add("boxed_warning", "Boxed warning", firstNonEmpty(result.boxed_warning), "major");
  add("contraindications", "Contraindications", firstNonEmpty(result.contraindications), "major");
  add("drug_interactions", "Drug interactions", firstNonEmpty(result.drug_interactions), "moderate");
  add("warnings", "Warnings", firstNonEmpty(result.warnings), "minor");
  add("warnings_and_cautions", "Warnings and cautions", firstNonEmpty(result.warnings_and_cautions), "minor");
  add("precautions", "Precautions", firstNonEmpty(result.precautions), "minor");
  add(
    "otc_interactions",
    "Interaction guidance",
    firstNonEmpty(result.ask_doctor_or_pharmacist) ?? firstNonEmpty(result.do_not_use),
    "minor",
  );

  const genericName: string | undefined = openfda.generic_name?.[0];
  const brandNames: string[] = openfda.brand_name ?? [];

  return {
    queriedName,
    displayName: cleanName(genericName ?? brandNames[0] ?? queriedName),
    brandNames,
    genericName,
    sections,
    source: "live",
  };
}

interface FallbackEntry extends DrugSafetyInfo {
  aliases: string[];
}

const FALLBACK = fallbackData as unknown as Record<string, FallbackEntry>;

/**
 * A small set of ~90 common medications' real FDA label data, fetched once at
 * build time and bundled with the app (see scripts/build-drug-fallback — the
 * data itself is genuine openFDA output, not fabricated). Checked before the
 * live API, so common medications resolve instantly and still work offline.
 */
function lookupBundledFallback(name: string): DrugSafetyInfo | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const match =
    FALLBACK[key] ?? Object.values(FALLBACK).find((entry) => entry.aliases.includes(key));
  if (!match) return null;
  const { aliases: _aliases, ...info } = match;
  return { ...info, source: "offline" };
}

/**
 * openFDA text search matches substrings, so searching "lisinopril" can return
 * a combination product like "Lisinopril and Hydrochlorothiazide" ahead of
 * plain lisinopril. Prefer a result whose generic_name is a single ingredient
 * that actually matches the query, falling back progressively rather than
 * blindly taking whatever comes back first.
 */
function pickBestResult(results: any[], queried: string, field: string): any | null {
  const q = queried.trim().toUpperCase();
  const qFirstWord = q.split(/\s+/)[0];
  const buckets: any[][] = [[], [], [], []]; // exact, startsWith, containsWord, anySingle

  for (const r of results) {
    const names: string[] | undefined = r?.openfda?.[field];
    if (!names || names.length !== 1) continue;
    const name = names[0];
    if (/ AND | WITH |\/|,/.test(name)) continue;
    buckets[3].push(r);
    if (name === q) buckets[0].push(r);
    else if (name.startsWith(qFirstWord)) buckets[1].push(r);
    else if (name.split(/\s+/).includes(qFirstWord)) buckets[2].push(r);
  }

  for (const bucket of buckets) {
    if (bucket.length > 0) return bucket[0];
  }
  return results[0] ?? null;
}

async function fetchLabelsByField(trimmed: string, field: string, signal?: AbortSignal): Promise<any[] | null> {
  const query = `openfda.${field}:"${trimmed}"`;
  const url = `${OPENFDA_BASE}?search=${encodeURIComponent(query)}&limit=15`;
  const res = await safeFetch(url, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw new DrugApiError(`openFDA lookup failed (${res.status})`);
  const data = await res.json();
  const results = data?.results;
  return results && results.length > 0 ? results : null;
}

async function fetchFromLiveApi(trimmed: string, signal?: AbortSignal): Promise<DrugSafetyInfo | null> {
  const fields = ["generic_name", "brand_name", "substance_name"];
  // Ask for all three at once rather than one after another, so a brand name
  // like "Tylenol" doesn't wait on a failed generic-name search first. The
  // answers are still read in priority order.
  const lookups = fields.map((field) => fetchLabelsByField(trimmed, field, signal));
  lookups.forEach((p) => p.catch(() => {}));
  for (let i = 0; i < fields.length; i++) {
    const results = await lookups[i];
    if (!results) continue;
    const field = fields[i];
    const best = pickBestResult(results, trimmed, field === "substance_name" ? "generic_name" : field);
    if (!best) continue;
    return parseLabel(trimmed, best);
  }
  return null;
}

const safetyInfoCache = new Map<string, Promise<DrugSafetyInfo | null>>();

const STORED_LABELS_KEY = "medtracker.drugLabels.v1";
const STORED_LABEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredLabels = Record<string, { at: number; info: DrugSafetyInfo | null }>;

function readStoredLabels(): StoredLabels {
  try {
    return JSON.parse(localStorage.getItem(STORED_LABELS_KEY) ?? "{}") as StoredLabels;
  } catch {
    return {};
  }
}

function readStoredLabel(key: string): { info: DrugSafetyInfo | null } | undefined {
  const entry = readStoredLabels()[key];
  if (!entry || Date.now() - entry.at > STORED_LABEL_MAX_AGE_MS) return undefined;
  return entry;
}

function storeLabel(key: string, info: DrugSafetyInfo | null) {
  try {
    const all = readStoredLabels();
    for (const [k, v] of Object.entries(all)) {
      if (Date.now() - v.at > STORED_LABEL_MAX_AGE_MS) delete all[k];
    }
    all[key] = { at: Date.now(), info };
    localStorage.setItem(STORED_LABELS_KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the in-memory cache still covers this visit.
  }
}

/**
 * Drug-safety lookup: the bundled snapshot of real FDA label data for common
 * medications first, then labels saved from earlier live lookups, then the
 * FDA's openFDA drug label API (no API key required). Returns null only when
 * no source has a label on file for this name — a real, expected outcome for
 * less common names, not an error.
 */
export function fetchDrugSafetyInfo(name: string, signal?: AbortSignal): Promise<DrugSafetyInfo | null> {
  const trimmed = coreDrugName(name).replace(/"/g, "");
  if (!trimmed) return Promise.resolve(null);

  // Labels don't change while the app is open, and every check re-reads the
  // label of each medication already in the profile, so remember them.
  const key = trimmed.toLowerCase();
  const cached = safetyInfoCache.get(key);
  if (cached) return cached;
  const pending = lookupDrugSafetyInfo(trimmed, key, signal);
  safetyInfoCache.set(key, pending);
  pending.catch(() => safetyInfoCache.delete(key));
  return pending;
}

async function lookupDrugSafetyInfo(trimmed: string, key: string, signal?: AbortSignal): Promise<DrugSafetyInfo | null> {
  // The bundled copy is the same FDA label data, already on the device. Each
  // live lookup downloads up to 15 full labels, which is the slow part, so
  // only go live for names the bundle doesn't cover.
  const bundled = lookupBundledFallback(trimmed);
  if (bundled) return bundled;
  const stored = readStoredLabel(key);
  if (stored) return stored.info;

  const live = await fetchFromLiveApi(trimmed, signal);
  storeLabel(key, live);
  return live;
}
